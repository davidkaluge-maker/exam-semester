// netlify/functions/submit-exam.js
const { Client } = require("pg");
const { authenticateRequest } = require("./_auth");
const { verifySebRequest } = require("./_seb");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

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

  const user = auth.sessionUser;
  if (user.role !== "student" || !user.student_id) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ message: "Hanya mahasiswa terdaftar yang dapat mengumpulkan jawaban." })
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

  const activityId = String(body.activity_id || "").trim();
  const answers = body.answers;

  if (!activityId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "activity_id wajib diisi." })
    };
  }

  if (answers === undefined || answers === null || typeof answers !== "object") {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "answers harus berupa objek/array JSON yang valid." })
    };
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    // 1. Ambil aktivitas dan pastikan mahasiswa terdaftar aktif pada kelasnya
    const actRes = await client.query(
      `SELECT
         aa.activity_id,
         aa.section_id,
         aa.rubric_id,
         aa.activity_type,
         aa.title,
         aa.start_time,
         aa.end_time,
         aa.require_seb,
         aa.seb_config_key_hash,
         aa.seb_browser_exam_key_hash,
         aa.ai_grading_enabled,
         aa.status
       FROM public.assessment_activities aa
       JOIN public.enrollments e
         ON e.section_id = aa.section_id
        AND e.student_id = $2::uuid
        AND e.status = 'active'
       WHERE aa.activity_id = $1::uuid
       LIMIT 1;`,
      [activityId, user.student_id]
    );

    if (actRes.rowCount === 0) {
      return {
        statusCode: 403,
        headers: HEADERS,
        body: JSON.stringify({
          message: "Aktivitas tidak ditemukan atau Anda tidak terdaftar aktif pada kelas ini."
        })
      };
    }

    const activity = actRes.rows[0];

    if (!["published", "ongoing"].includes(activity.status)) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({
          message: `Aktivitas berstatus '${activity.status}' dan tidak menerima pengumpulan jawaban.`
        })
      };
    }

    // 2. Cek jadwal mulai/selesai bila ditetapkan
    const now = new Date();
    if (activity.start_time && now < new Date(activity.start_time)) {
      return {
        statusCode: 403,
        headers: HEADERS,
        body: JSON.stringify({ message: "Waktu pengerjaan aktivitas belum dimulai." })
      };
    }

    let isLate = false;
    if (activity.end_time && now > new Date(activity.end_time)) {
      isLate = true;
    }

    // 3. Verifikasi resmi Safe Exam Browser bila require_seb = TRUE
    const sebCheck = verifySebRequest(event, activity);
    if (!sebCheck.ok) {
      await client.query(
        `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
         VALUES ($1::uuid, 'student', 'SUBMIT_REJECTED_SEB', 'assessment_activities', $2::uuid, $3::jsonb);`,
        [
          user.user_id,
          activityId,
          JSON.stringify({
            student_id: user.student_id,
            nim: user.nim,
            reason: sebCheck.reason
          })
        ]
      );

      return {
        statusCode: sebCheck.statusCode || 403,
        headers: HEADERS,
        body: JSON.stringify({
          ok: false,
          reason: sebCheck.reason,
          message: "Pengumpulan ditolak: verifikasi Safe Exam Browser (SEB) gagal."
        })
      };
    }

    // Cek apakah submission sebelumnya sudah dikunci (locked)
    const existingSub = await client.query(
      `SELECT submission_id, submission_status, grading_status
       FROM public.submissions
       WHERE activity_id = $1::uuid AND student_id = $2::uuid
       LIMIT 1;`,
      [activityId, user.student_id]
    );

    if (existingSub.rowCount > 0 && existingSub.rows[0].submission_status === "locked") {
      return {
        statusCode: 409,
        headers: HEADERS,
        body: JSON.stringify({ message: "Jawaban sudah dikunci (locked) dan tidak dapat dikirim ulang." })
      };
    }

    await client.query("BEGIN");

    const nextSubmissionStatus = isLate ? "late" : "submitted";
    const nextGradingStatus = activity.ai_grading_enabled ? "queued_ai" : "ungraded";

    // 4. Simpan / perbarui submissions
    const subRes = await client.query(
      `INSERT INTO public.submissions (
         activity_id, student_id, answers, seb_verified, seb_request_hash,
         submission_status, grading_status, submitted_at
       )
       VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6, $7, NOW())
       ON CONFLICT (activity_id, student_id)
       DO UPDATE SET
         answers = EXCLUDED.answers,
         seb_verified = EXCLUDED.seb_verified,
         seb_request_hash = COALESCE(EXCLUDED.seb_request_hash, public.submissions.seb_request_hash),
         submission_status = EXCLUDED.submission_status,
         grading_status = CASE
           WHEN public.submissions.grading_status = 'manual_graded' THEN 'manual_graded'
           ELSE EXCLUDED.grading_status
         END,
         submitted_at = NOW()
       RETURNING submission_id, activity_id, student_id, seb_verified, submission_status, grading_status, submitted_at;`,
      [
        activityId,
        user.student_id,
        JSON.stringify(answers),
        sebCheck.seb_verified,
        sebCheck.seb_request_hash,
        nextSubmissionStatus,
        nextGradingStatus
      ]
    );

    const submission = subRes.rows[0];

    // 5. Sinkronkan ke gradebook_entries (jaga nilai manual dosen bila sudah ada)
    await client.query(
      `INSERT INTO public.gradebook_entries (
         student_id, section_id, activity_id, submission_id, score, score_status, graded_by, change_history, updated_at
       )
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 'ungraded', 'system', $5::jsonb, NOW())
       ON CONFLICT (student_id, activity_id)
       DO UPDATE SET
         submission_id = EXCLUDED.submission_id,
         score_status = CASE
           WHEN public.gradebook_entries.graded_by = 'lecturer' AND public.gradebook_entries.score IS NOT NULL
             THEN public.gradebook_entries.score_status
           ELSE 'ungraded'
         END,
         change_history = public.gradebook_entries.change_history || $5::jsonb,
         updated_at = NOW();`,
      [
        user.student_id,
        activity.section_id,
        activityId,
        submission.submission_id,
        JSON.stringify([
          {
            at: new Date().toISOString(),
            by: "submit-exam",
            submission_id: submission.submission_id,
            submission_status: nextSubmissionStatus
          }
        ])
      ]
    );

    // 6. Masukkan ke antrean ai_assessments jika ai_grading_enabled = TRUE
    let aiQueueId = null;
    if (activity.ai_grading_enabled) {
      let rubricVersion = 1;
      if (activity.rubric_id) {
        const rubRes = await client.query(
          `SELECT version FROM public.grading_rubrics WHERE rubric_id = $1::uuid LIMIT 1;`,
          [activity.rubric_id]
        );
        if (rubRes.rowCount > 0 && rubRes.rows[0].version) {
          rubricVersion = Number(rubRes.rows[0].version);
        }
      }

      const existingAi = await client.query(
        `SELECT ai_assessment_id
         FROM public.ai_assessments
         WHERE submission_id = $1::uuid
           AND queue_status IN ('pending', 'processing')
         LIMIT 1;`,
        [submission.submission_id]
      );

      if (existingAi.rowCount > 0) {
        aiQueueId = existingAi.rows[0].ai_assessment_id;
      } else {
        const aiIns = await client.query(
          `INSERT INTO public.ai_assessments (
             submission_id, rubric_id, rubric_version, queue_status, lecturer_review_status, assessed_at
           )
           VALUES ($1::uuid, $2::uuid, $3, 'pending', 'pending_review', NOW())
           RETURNING ai_assessment_id;`,
          [submission.submission_id, activity.rubric_id, rubricVersion]
        );
        aiQueueId = aiIns.rows[0].ai_assessment_id;
      }
    }

    // 7. Catat log audit tanpa menyimpan isi jawaban sensitif berlebihan
    await client.query(
      `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
       VALUES ($1::uuid, 'student', 'SUBMIT_EXAM_ANSWER', 'submissions', $2::uuid, $3::jsonb);`,
      [
        user.user_id,
        submission.submission_id,
        JSON.stringify({
          student_id: user.student_id,
          nim: user.nim,
          activity_id: activityId,
          seb_verified: sebCheck.seb_verified,
          submission_status: nextSubmissionStatus,
          ai_queued: Boolean(aiQueueId),
          ai_assessment_id: aiQueueId
        })
      ]
    );

    await client.query("COMMIT");

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ok: true,
        submission_id: submission.submission_id,
        activity_id: activityId,
        seb_verified: sebCheck.seb_verified,
        submission_status: nextSubmissionStatus,
        grading_status: submission.grading_status,
        ai_queued: Boolean(aiQueueId),
        ai_assessment_id: aiQueueId,
        submitted_at: submission.submitted_at
      })
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal memproses pengumpulan jawaban: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};