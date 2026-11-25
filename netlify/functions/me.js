// netlify/functions/me.js
const { Client } = require("pg");
const { authenticateRequest } = require("./_auth");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
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

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const u = auth.sessionUser;
    let sections = [];
    let apiKeyMeta = null;

    if (u.role === "student" && u.student_id) {
      const secRes = await client.query(
        `SELECT cs.section_id, cs.class_code, cs.class_type, c.course_code, c.course_name, s.code AS semester_code, s.name AS semester_name
         FROM public.enrollments e
         JOIN public.class_sections cs ON cs.section_id = e.section_id
         JOIN public.courses c ON c.course_id = cs.course_id
         JOIN public.semesters s ON s.semester_id = cs.semester_id
         WHERE e.student_id = $1::uuid AND e.status = 'active'
         ORDER BY s.is_active DESC, c.course_code ASC;`,
        [u.student_id]
      );
      sections = secRes.rows;

      // Tidak pernah mengembalikan encrypted_api_key atau kunci utuh
      const keyRes = await client.query(
        `SELECT key_hint, consent_given, validation_status, last_validated_at
         FROM public.student_api_credentials
         WHERE student_id = $1::uuid
         LIMIT 1;`,
        [u.student_id]
      );
      apiKeyMeta = keyRes.rows[0] || {
        key_hint: null,
        consent_given: false,
        validation_status: "unverified",
        last_validated_at: null
      };
    } else if (u.role === "lecturer") {
      const secRes = await client.query(
        `SELECT cs.section_id, cs.class_code, cs.class_type, c.course_code, c.course_name, s.code AS semester_code, s.name AS semester_name
         FROM public.class_sections cs
         JOIN public.courses c ON c.course_id = cs.course_id
         JOIN public.semesters s ON s.semester_id = cs.semester_id
         LEFT JOIN public.courses co ON co.course_id = cs.course_id
         WHERE cs.lecturer_id = $1::uuid OR co.lecturer_id = $1::uuid
         ORDER BY s.is_active DESC, c.course_code ASC;`,
        [u.user_id]
      );
      sections = secRes.rows;
    } else if (u.role === "admin") {
      const secRes = await client.query(
        `SELECT cs.section_id, cs.class_code, cs.class_type, c.course_code, c.course_name, s.code AS semester_code, s.name AS semester_name
         FROM public.class_sections cs
         JOIN public.courses c ON c.course_id = cs.course_id
         JOIN public.semesters s ON s.semester_id = cs.semester_id
         ORDER BY s.is_active DESC, c.course_code ASC
         LIMIT 100;`
      );
      sections = secRes.rows;
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ok: true,
        user: u,
        sections,
        api_key_meta: apiKeyMeta
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal memuat profil pengguna: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};