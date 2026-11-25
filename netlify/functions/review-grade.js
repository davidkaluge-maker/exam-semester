// netlify/functions/review-grade.js
const { Client } = require("pg");
const { authenticateRequest, canLecturerAccessSection } = require("./_auth");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
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
  if (!["admin", "lecturer"].includes(user.role)) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ message: "Hanya dosen pengampu atau administrator yang dapat menilai atau mengoreksi nilai." })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ message: "Format JSON tidak valid." }) };
  }

  const mode = String(body.mode || "manual_grade").trim(); // 'approve_ai' | 'modify_ai' | 'manual_grade'
  const studentId = String(body.student_id || "").trim();
  const activityId = String(body.activity_id || "").trim();
  const lecturerNotes = body.lecturer_notes !== undefined ? String(body.lecturer_notes).trim() : null;
  const scoreStatus = ["graded", "absent", "excused"].includes(String(body.score_status || "graded"))
    ? String(body.score_status || "graded")
    : "graded";

  if (!studentId || !activityId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "student_id dan activity_id wajib diisi." })
    };
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    const actRes = await client.query(
      `SELECT activity_id, section_id, max_score, rubric_id
       FROM public.assessment_activities
       WHERE activity_id = $1::uuid
       LIMIT 1;`,
      [activityId]
    );
    if (actRes.rowCount === 0) {
      return { statusCode: 404, headers: HEADERS, body: JSON.stringify({ message: "Aktivitas tidak ditemukan." }) };
    }

    const act = actRes.rows[0];
    const allowed = await canLecturerAccessSection(dbUrl, user, act.section_id);
    if (!allowed) {
      return {
        statusCode: 403,
        headers: HEADERS,
        body: JSON.stringify({ message: "Anda tidak memiliki kewenangan menilai aktivitas di kelas ini." })
      };
    }

    const maxScore = Number(act.max_score || 100);
    const subRes = await client.query(
      `SELECT submission_id FROM public.submissions
       WHERE activity_id = $1::uuid AND student_id = $2::uuid LIMIT 1;`,
      [activityId, studentId]
    );
    const submissionId = subRes.rows[0]?.submission_id || null;

    let finalScore = body.score !== undefined && body.score !== null && body.score !== ""
      ? Number(body.score)
      : null;

    if (finalScore !== null) {
      if (!Number.isFinite(finalScore) || finalScore < 0 || finalScore > maxScore) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ message: `Skor harus berada di antara 0 dan ${maxScore}.` })
        };
      }
      finalScore = Number(finalScore.toFixed(2));
    }

    await client.query("BEGIN");

    let aiId = null;
    if (submissionId) {
      const aiRes = await client.query(
        `SELECT ai_assessment_id, suggested_score, rubric_id, rubric_version
         FROM public.ai_assessments
         WHERE submission_id = $1::uuid
         ORDER BY assessed_at DESC
         LIMIT 1;`,
        [submissionId]
      );

      if (aiRes.rowCount > 0) {
        const aiRow = aiRes.rows[0];
        aiId = aiRow.ai_assessment_id;

        if (mode === "approve_ai") {
          finalScore = finalScore ?? Number(aiRow.suggested_score ?? 0);
          await client.query(
            `UPDATE public.ai_assessments
             SET lecturer_review_status = 'approved'
             WHERE ai_assessment_id = $1::uuid;`,
            [aiId]
          );
        } else if (mode === "modify_ai") {
          if (finalScore === null) {
            await client.query("ROLLBACK");
            return {
              statusCode: 400,
              headers: HEADERS,
              body: JSON.stringify({ message: "Skor koreksi (score) wajib diisi untuk mode modify_ai." })
            };
          }
          await client.query(
            `UPDATE public.ai_assessments
             SET lecturer_review_status = 'modified',
                 feedback = COALESCE($2, feedback)
             WHERE ai_assessment_id = $1::uuid;`,
            [aiId, lecturerNotes]
          );
        }
      }

      await client.query(
        `UPDATE public.submissions
         SET grading_status = 'manual_graded'
         WHERE submission_id = $1::uuid;`,
        [submissionId]
      );
    }

    const historyEntry = {
      at: new Date().toISOString(),
      by_user_id: user.user_id,
      by_role: user.role,
      mode,
      score: finalScore,
      score_status: scoreStatus,
      notes: lecturerNotes
    };

    const gbRes = await client.query(
      `INSERT INTO public.gradebook_entries
         (student_id, section_id, activity_id, submission_id, score, score_status, graded_by, lecturer_notes, change_history, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'lecturer', $7, $8::jsonb, NOW())
       ON CONFLICT (student_id, activity_id)
       DO UPDATE SET
         submission_id = COALESCE(EXCLUDED.submission_id, public.gradebook_entries.submission_id),
         score = COALESCE(EXCLUDED.score, public.gradebook_entries.score),
         score_status = EXCLUDED.score_status,
         graded_by = 'lecturer',
         lecturer_notes = COALESCE(EXCLUDED.lecturer_notes, public.gradebook_entries.lecturer_notes),
         change_history = public.gradebook_entries.change_history || $8::jsonb,
         updated_at = NOW()
       RETURNING entry_id, student_id, activity_id, score, score_status, graded_by, lecturer_notes, updated_at;`,
      [
        studentId,
        act.section_id,
        activityId,
        submissionId,
        finalScore,
        scoreStatus,
        lecturerNotes,
        JSON.stringify([historyEntry])
      ]
    );

    await client.query(
      `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
       VALUES ($1::uuid, $2, 'LECTURER_GRADE_REVIEW', 'gradebook_entries', $3::uuid, $4::jsonb);`,
      [
        user.user_id,
        user.role,
        gbRes.rows[0].entry_id,
        JSON.stringify({
          student_id: studentId,
          activity_id: activityId,
          ai_assessment_id: aiId,
          rubric_id: act.rubric_id,
          mode,
          score: finalScore,
          score_status: scoreStatus
        })
      ]
    );

    await client.query("COMMIT");

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: true, grade_entry: gbRes.rows[0] })
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal menyimpan penilaian/koreksi dosen: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};