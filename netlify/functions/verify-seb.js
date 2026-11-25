// netlify/functions/verify-seb.js
const { Client } = require("pg");
const { authenticateRequest } = require("./_auth");
const { verifySebRequest } = require("./_seb");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

exports.handler = async (event) => {
  if (!["GET", "POST"].includes(event.httpMethod)) {
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
      body: JSON.stringify({ message: "Endpoint ini khusus untuk verifikasi sesi ujian mahasiswa." })
    };
  }

  let activityId = String(event.queryStringParameters?.activity_id || "").trim();
  if (!activityId && event.body) {
    try {
      const parsed = JSON.parse(event.body);
      activityId = String(parsed.activity_id || "").trim();
    } catch (_) {}
  }

  if (!activityId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "activity_id wajib disertakan." })
    };
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    const actRes = await client.query(
      `SELECT aa.activity_id, aa.section_id, aa.title, aa.activity_type,
              aa.require_seb, aa.seb_config_key_hash, aa.seb_browser_exam_key_hash, aa.status
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
          message: "Aktivitas ujian tidak ditemukan atau Anda tidak terdaftar aktif pada kelas ini."
        })
      };
    }

    const activity = actRes.rows[0];
    const sebCheck = verifySebRequest(event, activity);

    if (!sebCheck.ok) {
      await client.query(
        `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
         VALUES ($1::uuid, 'student', 'SEB_VERIFICATION_REJECTED', 'assessment_activities', $2::uuid, $3::jsonb);`,
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
          seb_verified: false,
          reason: sebCheck.reason,
          message: "Akses ujian ditolak: gunakan Safe Exam Browser (SEB) resmi sesuai konfigurasi ujian."
        })
      };
    }

    // Jika mahasiswa sudah memiliki baris submission, perbarui status verifikasi SEB
    await client.query(
      `UPDATE public.submissions
       SET seb_verified = $1,
           seb_request_hash = COALESCE($2, seb_request_hash)
       WHERE activity_id = $3::uuid AND student_id = $4::uuid;`,
      [sebCheck.seb_verified, sebCheck.seb_request_hash, activityId, user.student_id]
    );

    await client.query(
      `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
       VALUES ($1::uuid, 'student', 'SEB_VERIFICATION_PASSED', 'assessment_activities', $2::uuid, $3::jsonb);`,
      [
        user.user_id,
        activityId,
        JSON.stringify({
          student_id: user.student_id,
          nim: user.nim,
          seb_verified: sebCheck.seb_verified,
          reason: sebCheck.reason
        })
      ]
    );

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ok: true,
        activity_id: activity.activity_id,
        title: activity.title,
        require_seb: activity.require_seb,
        seb_verified: sebCheck.seb_verified,
        reason: sebCheck.reason
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal memverifikasi sesi SEB: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};