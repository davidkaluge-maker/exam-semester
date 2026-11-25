// netlify/functions/activities.js
const { Client } = require("pg");
const { authenticateRequest, canLecturerAccessSection } = require("./_auth");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
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

  const sectionId = String(event.queryStringParameters?.section_id || "").trim();
  if (!sectionId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "Parameter section_id wajib disertakan." })
    };
  }

  const user = auth.sessionUser;
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    if (user.role === "student") {
      if (!user.student_id) {
        return {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({ message: "Profil mahasiswa belum terhubung." })
        };
      }
      const enrolled = await client.query(
        `SELECT 1 FROM public.enrollments
         WHERE student_id = $1::uuid AND section_id = $2::uuid AND status = 'active'
         LIMIT 1;`,
        [user.student_id, sectionId]
      );
      if (enrolled.rowCount === 0) {
        return {
          statusCode: 403,
          headers: HEADERS,
          body: JSON.stringify({ message: "Anda tidak terdaftar aktif pada kelas ini." })
        };
      }

      const res = await client.query(
        `SELECT activity_id, section_id, activity_type, title, instructions,
                weight_percentage, max_score, start_time, end_time, duration_minutes,
                require_seb, status
         FROM public.assessment_activities
         WHERE section_id = $1::uuid AND status IN ('published', 'ongoing', 'closed')
         ORDER BY created_at ASC;`,
        [sectionId]
      );

      return {
        statusCode: 200,
        headers: HEADERS,
        body: JSON.stringify({ ok: true, activities: res.rows })
      };
    }

    const allowed = await canLecturerAccessSection(dbUrl, user, sectionId);
    if (!allowed) {
      return {
        statusCode: 403,
        headers: HEADERS,
        body: JSON.stringify({ message: "Anda tidak memiliki kewenangan pada kelas ini." })
      };
    }

    const res = await client.query(
      `SELECT activity_id, section_id, rubric_id, activity_type, title, instructions,
              weight_percentage, max_score, start_time, end_time, duration_minutes,
              require_seb, ai_grading_enabled, status, created_at
       FROM public.assessment_activities
       WHERE section_id = $1::uuid
       ORDER BY created_at DESC;`,
      [sectionId]
    );

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: true, activities: res.rows })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal memuat daftar aktivitas: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};