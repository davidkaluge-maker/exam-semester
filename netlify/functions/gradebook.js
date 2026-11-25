// netlify/functions/gradebook.js
const { Client } = require("pg");
const { authenticateRequest, canLecturerAccessSection } = require("./_auth");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function mapActivityToBucket(activityType) {
  if (activityType === "quiz") return "quiz";
  if (activityType === "individual_task") return "individual_task";
  if (activityType === "group_task") return "group_task";
  if (activityType === "discussion") return "discussion";
  if (activityType === "uts") return "uts";
  if (activityType === "project") return "project";
  if (activityType === "uas") return "uas";
  return "individual_task";
}

function getBucketWeight(weightConfig, bucket) {
  const cfg = weightConfig && typeof weightConfig === "object" ? weightConfig : {};
  if (cfg[bucket] !== undefined && cfg[bucket] !== null) {
    return Math.max(0, Number(cfg[bucket]) || 0);
  }
  // Fallback jika weight_config memakai kunci gabungan "task"
  if (["individual_task", "group_task", "discussion"].includes(bucket) && cfg.task !== undefined) {
    const taskWeight = Math.max(0, Number(cfg.task) || 0);
    return Number((taskWeight / 3).toFixed(2));
  }
  return 0;
}

function scoreToLetterGrade(score) {
  if (score === null || score === undefined || Number.isNaN(Number(score))) return "-";
  const s = Number(score);
  if (s >= 85) return "A";
  if (s >= 80) return "AB";
  if (s >= 75) return "B";
  if (s >= 70) return "BC";
  if (s >= 60) return "C";
  if (s >= 50) return "D";
  return "E";
}

function computeStudentSummary(studentMeta, activities, entriesMap, weightConfig) {
  const bucketScores = {}; // bucket -> array of normalized percentages (0..100)
  const items = [];

  for (const act of activities) {
    const bucket = mapActivityToBucket(act.activity_type);
    const entry = entriesMap.get(act.activity_id) || null;
    const maxScore = Math.max(1, Number(act.max_score || 100));

    let rawScore = entry && entry.score !== null && entry.score !== undefined ? Number(entry.score) : null;
    let scoreStatus = entry ? entry.score_status : "not_submitted";

    if (scoreStatus === "absent" && rawScore === null) {
      rawScore = 0;
    }

    const isGraded =
      (scoreStatus === "graded" || scoreStatus === "absent") &&
      rawScore !== null &&
      Number.isFinite(rawScore);

    const normalizedPct = isGraded
      ? Number(Math.max(0, Math.min(100, (rawScore / maxScore) * 100)).toFixed(2))
      : null;

    if (isGraded && normalizedPct !== null) {
      if (!bucketScores[bucket]) bucketScores[bucket] = [];
      bucketScores[bucket].push(normalizedPct);
    }

    items.push({
      activity_id: act.activity_id,
      activity_type: act.activity_type,
      bucket,
      title: act.title,
      weight_percentage: Number(act.weight_percentage || 0),
      max_score: maxScore,
      score: rawScore,
      normalized_percentage: normalizedPct,
      score_status: scoreStatus,
      graded_by: entry ? entry.graded_by : null,
      lecturer_notes: entry ? entry.lecturer_notes : null,
      updated_at: entry ? entry.updated_at : null
    });
  }

  let weightedSum = 0;
  let activeWeightSum = 0;
  const categoryBreakdown = [];

  for (const [bucket, pctList] of Object.entries(bucketScores)) {
    if (!pctList.length) continue;
    const avgPct = pctList.reduce((a, b) => a + b, 0) / pctList.length;
    const weight = getBucketWeight(weightConfig, bucket);
    if (weight > 0) {
      weightedSum += avgPct * weight;
      activeWeightSum += weight;
    }
    categoryBreakdown.push({
      bucket,
      weight,
      graded_count: pctList.length,
      average_percentage: Number(avgPct.toFixed(2))
    });
  }

  const finalScore =
    activeWeightSum > 0
      ? Number((weightedSum / activeWeightSum).toFixed(2))
      : null;

  return {
    student_id: studentMeta.student_id,
    nim: studentMeta.nim,
    full_name: studentMeta.full_name,
    final_score: finalScore,
    letter_grade: scoreToLetterGrade(finalScore),
    active_weight_total: Number(activeWeightSum.toFixed(2)),
    graded_activities_count: items.filter((i) => i.score_status === "graded").length,
    total_activities_count: items.length,
    categories: categoryBreakdown,
    items
  };
}

exports.handler = async (event) => {
  if (!["GET", "POST"].includes(event.httpMethod)) {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ message: "DATABASE_URL belum diatur." }) };
  }

  const auth = await authenticateRequest(event, dbUrl);
  if (!auth.ok) {
    return { statusCode: auth.statusCode, headers: HEADERS, body: JSON.stringify({ message: auth.message }) };
  }

  const user = auth.sessionUser;
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    // Update bobot kelas oleh dosen/admin
    if (event.httpMethod === "POST") {
      if (!["admin", "lecturer"].includes(user.role)) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ message: "Akses ditolak." }) };
      }

      const body = JSON.parse(event.body || "{}");
      const sectionId = String(body.section_id || "").trim();
      const weightConfig = body.weight_config;

      if (!sectionId || !weightConfig || typeof weightConfig !== "object") {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ message: "section_id dan weight_config (objek) wajib diisi." })
        };
      }

      const allowed = await canLecturerAccessSection(dbUrl, user, sectionId);
      if (!allowed) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ message: "Anda tidak berhak atas kelas ini." }) };
      }

      const upd = await client.query(
        `UPDATE public.class_sections
         SET weight_config = $2::jsonb
         WHERE section_id = $1::uuid
         RETURNING section_id, weight_config;`,
        [sectionId, JSON.stringify(weightConfig)]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
         VALUES ($1::uuid, $2, 'UPDATE_WEIGHT_CONFIG', 'class_sections', $3::uuid, $4::jsonb);`,
        [user.user_id, user.role, sectionId, JSON.stringify({ weight_config: weightConfig })]
      );

      return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ ok: true, section: upd.rows[0] }) };
    }

    // GET Grade Book & Rekapitulasi
    const sectionId = String(event.queryStringParameters?.section_id || "").trim();
    if (!sectionId) {
      return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ message: "Parameter section_id wajib diisi." }) };
    }

    const secRes = await client.query(
      `SELECT cs.section_id, cs.class_code, cs.class_type, cs.weight_config,
              c.course_code, c.course_name, c.credits,
              s.code AS semester_code, s.name AS semester_name
       FROM public.class_sections cs
       JOIN public.courses c ON c.course_id = cs.course_id
       JOIN public.semesters s ON s.semester_id = cs.semester_id
       WHERE cs.section_id = $1::uuid
       LIMIT 1;`,
      [sectionId]
    );

    if (secRes.rowCount === 0) {
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ message: "Kelas tidak ditemukan." }) };
    }

    const sectionInfo = secRes.rows[0];
    const weightConfig = sectionInfo.weight_config || {};

    if (user.role === "student") {
      if (!user.student_id) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ message: "Profil mahasiswa belum terhubung." }) };
      }

      const enrRes = await client.query(
        `SELECT st.student_id, st.nim, st.full_name
         FROM public.enrollments e
         JOIN public.students st ON st.student_id = e.student_id
         WHERE e.section_id = $1::uuid AND e.student_id = $2::uuid AND e.status = 'active'
         LIMIT 1;`,
        [sectionId, user.student_id]
      );

      if (enrRes.rowCount === 0) {
        return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ message: "Anda tidak terdaftar aktif pada kelas ini." }) };
      }

      const actsRes = await client.query(
        `SELECT activity_id, activity_type, title, weight_percentage, max_score
         FROM public.assessment_activities
         WHERE section_id = $1::uuid AND status IN ('published', 'ongoing', 'closed')
         ORDER BY created_at ASC;`,
        [sectionId]
      );

      const gbRes = await client.query(
        `SELECT activity_id, score, score_status, graded_by, lecturer_notes, updated_at
         FROM public.gradebook_entries
         WHERE section_id = $1::uuid AND student_id = $2::uuid;`,
        [sectionId, user.student_id]
      );

      const entriesMap = new Map();
      for (const row of gbRes.rows) {
        entriesMap.set(row.activity_id, row);
      }

      const summary = computeStudentSummary(enrRes.rows[0], actsRes.rows, entriesMap, weightConfig);

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({
          ok: true,
          role: "student",
          section: sectionInfo,
          student_summary: summary
        })
      };
    }

    // Dosen atau Admin
    const allowed = await canLecturerAccessSection(dbUrl, user, sectionId);
    if (!allowed) {
      return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ message: "Anda tidak memiliki kewenangan pada kelas ini." }) };
    }

    const studentsRes = await client.query(
      `SELECT st.student_id, st.nim, st.full_name
       FROM public.enrollments e
       JOIN public.students st ON st.student_id = e.student_id
       WHERE e.section_id = $1::uuid AND e.status = 'active'
       ORDER BY st.nim ASC;`,
      [sectionId]
    );

    const actsRes = await client.query(
      `SELECT activity_id, activity_type, title, weight_percentage, max_score, status
       FROM public.assessment_activities
       WHERE section_id = $1::uuid
       ORDER BY created_at ASC;`,
      [sectionId]
    );

    const gbRes = await client.query(
      `SELECT student_id, activity_id, score, score_status, graded_by, lecturer_notes, updated_at
       FROM public.gradebook_entries
       WHERE section_id = $1::uuid;`,
      [sectionId]
    );

    const byStudent = new Map();
    for (const row of gbRes.rows) {
      if (!byStudent.has(row.student_id)) byStudent.set(row.student_id, new Map());
      byStudent.get(row.student_id).set(row.activity_id, row);
    }

    const roster = studentsRes.rows.map((st) =>
      computeStudentSummary(st, actsRes.rows, byStudent.get(st.student_id) || new Map(), weightConfig)
    );

    const gradedFinals = roster
      .map((r) => r.final_score)
      .filter((s) => s !== null && Number.isFinite(Number(s)));

    const classAverage =
      gradedFinals.length > 0
        ? Number((gradedFinals.reduce((a, b) => a + b, 0) / gradedFinals.length).toFixed(2))
        : null;

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ok: true,
        role: user.role,
        section: sectionInfo,
        activities: actsRes.rows,
        class_average: classAverage,
        total_students: roster.length,
        students: roster
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal memuat Grade Book: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};