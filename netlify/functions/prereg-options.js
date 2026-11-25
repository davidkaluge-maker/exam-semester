// netlify/functions/prereg-options.js
const { Client } = require("pg");

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "Method not allowed" })
    };
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "DATABASE_URL belum diatur di environment Netlify." })
    };
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    const semestersRes = await client.query(`
      SELECT semester_id, code, name, is_active
      FROM public.semesters
      ORDER BY is_active DESC, created_at DESC;
    `);

    const sectionsRes = await client.query(`
      SELECT
        cs.section_id,
        cs.semester_id,
        cs.class_code,
        cs.class_type,
        c.course_code,
        c.course_name,
        c.credits
      FROM public.class_sections cs
      JOIN public.courses c ON c.course_id = cs.course_id
      JOIN public.semesters s ON s.semester_id = cs.semester_id
      ORDER BY s.is_active DESC, c.course_code ASC, cs.class_code ASC;
    `);

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ok: true,
        semesters: semestersRes.rows,
        sections: sectionsRes.rows
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "Gagal memuat opsi semester/kelas: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};