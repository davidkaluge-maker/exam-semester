// netlify/functions/manage-curriculum.js
const { Client } = require("pg");
const { authenticateRequest, canLecturerAccessSection } = require("./_auth");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const VALID_ACTIVITY_TYPES = new Set([
  "quiz",
  "individual_task",
  "group_task",
  "discussion",
  "uts",
  "project",
  "uas"
]);

const VALID_ACTIVITY_STATUSES = new Set([
  "draft",
  "published",
  "ongoing",
  "closed",
  "archived"
]);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ message: "Method not allowed" })
    };
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "DATABASE_URL belum diatur di Netlify." })
    };
  }

  const auth = await authenticateRequest(event, dbUrl);
  if (!auth.ok) {
    return {
      statusCode: auth.statusCode,
      headers: HEADERS,
      body: JSON.stringify({ message: auth.message })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "Format JSON tidak valid." })
    };
  }

  const action = String(body.action || "").trim();
  const user = auth.sessionUser;

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    // 1. BUAT / AKTIFKAN SEMESTER (Admin)
    if (action === "create_semester") {
      if (user.role !== "admin") {
        return {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({ message: "Hanya administrator yang dapat membuat atau mengatur semester." })
        };
      }

      const code = String(body.code || "").trim();
      const name = String(body.name || "").trim();
      const isActive = Boolean(body.is_active);
      const startDate = body.start_date ? String(body.start_date).trim() : null;
      const endDate = body.end_date ? String(body.end_date).trim() : null;

      if (!code || !name) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ message: "Kode dan nama semester wajib diisi." })
        };
      }

      await client.query("BEGIN");
      if (isActive) {
        await client.query(`UPDATE public.semesters SET is_active = FALSE WHERE is_active = TRUE;`);
      }

      const res = await client.query(
        `INSERT INTO public.semesters (code, name, is_active, start_date, end_date)
         VALUES ($1, $2, $3, $4::date, $5::date)
         ON CONFLICT (code)
         DO UPDATE SET
           name = EXCLUDED.name,
           is_active = EXCLUDED.is_active,
           start_date = COALESCE(EXCLUDED.start_date, public.semesters.start_date),
           end_date = COALESCE(EXCLUDED.end_date, public.semesters.end_date)
         RETURNING semester_id, code, name, is_active, start_date, end_date;`,
        [code, name, isActive, startDate, endDate]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
         VALUES ($1::uuid, $2, 'UPSERT_SEMESTER', 'semesters', $3::uuid, $4::jsonb);`,
        [user.user_id, user.role, res.rows[0].semester_id, JSON.stringify({ code, name, is_active: isActive })]
      );

      await client.query("COMMIT");
      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ ok: true, semester: res.rows[0] })
      };
    }

    // 2. BUAT MATA KULIAH (Admin / Dosen)
    if (action === "create_course") {
      if (!["admin", "lecturer"].includes(user.role)) {
        return {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({ message: "Akses ditolak untuk membuat mata kuliah." })
        };
      }

      const courseCode = String(body.course_code || "").trim();
      const courseName = String(body.course_name || "").trim();
      const credits = Number.isInteger(Number(body.credits)) ? Number(body.credits) : 3;
      const description = body.description ? String(body.description).trim() : null;
      const lecturerId = user.role === "lecturer" ? user.user_id : (body.lecturer_id || user.user_id);

      if (!courseCode || !courseName) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ message: "Kode mata kuliah dan nama mata kuliah wajib diisi." })
        };
      }

      const res = await client.query(
        `INSERT INTO public.courses (course_code, course_name, credits, lecturer_id, description)
         VALUES ($1, $2, $3, $4::uuid, $5)
         ON CONFLICT (course_code)
         DO UPDATE SET
           course_name = EXCLUDED.course_name,
           credits = EXCLUDED.credits,
           description = COALESCE(EXCLUDED.description, public.courses.description)
         RETURNING course_id, course_code, course_name, credits, lecturer_id;`,
        [courseCode, courseName, credits, lecturerId, description]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
         VALUES ($1::uuid, $2, 'UPSERT_COURSE', 'courses', $3::uuid, $4::jsonb);`,
        [user.user_id, user.role, res.rows[0].course_id, JSON.stringify({ course_code: courseCode, course_name: courseName })]
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ ok: true, course: res.rows[0] })
      };
    }

    // 3. BUAT KELAS / CLASS SECTION (Dosen pengampu / Admin)
    if (action === "create_class_section") {
      if (!["admin", "lecturer"].includes(user.role)) {
        return {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({ message: "Hanya dosen atau administrator yang dapat membuat kelas." })
        };
      }

      const courseId = String(body.course_id || "").trim();
      const semesterId = String(body.semester_id || "").trim();
      const classCode = String(body.class_code || "").trim();
      const classType = String(body.class_type || "Reguler").trim();
      const lecturerId = user.role === "lecturer" ? user.user_id : (body.lecturer_id || user.user_id);
      const weightConfig = body.weight_config && typeof body.weight_config === "object"
        ? body.weight_config
        : { quiz: 20, individual_task: 10, group_task: 10, uts: 20, project: 15, uas: 25 };

      if (!courseId || !semesterId || !classCode) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({ message: "course_id, semester_id, dan class_code wajib diisi." })
        };
      }

      if (user.role === "lecturer") {
        const courseOwn = await client.query(
          `SELECT 1 FROM public.courses WHERE course_id = $1::uuid AND lecturer_id = $2::uuid LIMIT 1;`,
          [courseId, user.user_id]
        );
        if (courseOwn.rowCount === 0) {
          return {
            statusCode: 403,
            headers: HEADERS,
            body: JSON.stringify({ message: "Anda tidak memiliki kewenangan pada mata kuliah ini." })
          };
        }
      }

      const res = await client.query(
        `INSERT INTO public.class_sections (course_id, semester_id, class_code, class_type, lecturer_id, weight_config)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::jsonb)
         ON CONFLICT (course_id, semester_id, class_code)
         DO UPDATE SET
           class_type = EXCLUDED.class_type,
           lecturer_id = COALESCE(public.class_sections.lecturer_id, EXCLUDED.lecturer_id),
           weight_config = EXCLUDED.weight_config
         RETURNING section_id, course_id, semester_id, class_code, class_type, lecturer_id, weight_config;`,
        [courseId, semesterId, classCode, classType, lecturerId, JSON.stringify(weightConfig)]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
         VALUES ($1::uuid, $2, 'UPSERT_CLASS_SECTION', 'class_sections', $3::uuid, $4::jsonb);`,
        [user.user_id, user.role, res.rows[0].section_id, JSON.stringify({ class_code: classCode, class_type: classType })]
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ ok: true, section: res.rows[0] })
      };
    }

    // 4. BUAT AKTIVITAS PENILAIAN (Kuis, Tugas Individual/Kelompok, Diskusi, UTS, Proyek, UAS)
    if (action === "create_activity") {
      if (!["admin", "lecturer"].includes(user.role)) {
        return {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({ message: "Hanya dosen atau administrator yang dapat membuat aktivitas penilaian." })
        };
      }

      const sectionId = String(body.section_id || "").trim();
      const activityType = String(body.activity_type || "").trim();
      const title = String(body.title || "").trim();
      const instructions = body.instructions ? String(body.instructions).trim() : null;
      const weightPercentage = Number(body.weight_percentage ?? 0);
      const maxScore = Number(body.max_score ?? 100);
      const startTime = body.start_time ? String(body.start_time).trim() : null;
      const endTime = body.end_time ? String(body.end_time).trim() : null;
      const durationMinutes = body.duration_minutes ? Number(body.duration_minutes) : null;
      const requireSeb = Boolean(body.require_seb);
      const aiGradingEnabled = body.ai_grading_enabled !== undefined ? Boolean(body.ai_grading_enabled) : true;
      const status = VALID_ACTIVITY_STATUSES.has(String(body.status || "draft"))
        ? String(body.status || "draft")
        : "draft";
      const rubricId = body.rubric_id ? String(body.rubric_id).trim() : null;

      if (!sectionId || !title || !VALID_ACTIVITY_TYPES.has(activityType)) {
        return {
          statusCode: 400,
          headers: HEADERS,
          body: JSON.stringify({
            message: "section_id, title, dan activity_type yang valid (quiz, individual_task, group_task, discussion, uts, project, uas) wajib diisi."
          })
        };
      }

      const allowed = await canLecturerAccessSection(dbUrl, user, sectionId);
      if (!allowed) {
        return {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({ message: "Anda tidak berhak membuat aktivitas pada kelas ini." })
        };
      }

      const res = await client.query(
        `INSERT INTO public.assessment_activities (
           section_id, rubric_id, activity_type, title, instructions,
           weight_percentage, max_score, start_time, end_time, duration_minutes,
           require_seb, ai_grading_enabled, status
         )
         VALUES (
           $1::uuid, $2::uuid, $3, $4, $5,
           $6, $7, $8::timestamptz, $9::timestamptz, $10,
           $11, $12, $13
         )
         RETURNING activity_id, section_id, activity_type, title, weight_percentage, max_score, require_seb, ai_grading_enabled, status, created_at;`,
        [
          sectionId,
          rubricId,
          activityType,
          title,
          instructions,
          weightPercentage,
          maxScore,
          startTime,
          endTime,
          durationMinutes,
          requireSeb,
          aiGradingEnabled,
          status
        ]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
         VALUES ($1::uuid, $2, 'CREATE_ASSESSMENT_ACTIVITY', 'assessment_activities', $3::uuid, $4::jsonb);`,
        [
          user.user_id,
          user.role,
          res.rows[0].activity_id,
          JSON.stringify({ section_id: sectionId, activity_type: activityType, title, require_seb: requireSeb })
        ]
      );

      return {
        statusCode: 201,
        headers: HEADERS,
        body: JSON.stringify({ ok: true, activity: res.rows[0] })
      };
    }

    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "Aksi tidak dikenali." })
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal memproses permintaan manajemen kurikulum: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};