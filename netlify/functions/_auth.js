// netlify/functions/_auth.js
const { Client } = require("pg");

async function authenticateRequest(event, dbUrl) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return { ok: false, statusCode: 401, message: "Token autentikasi tidak ditemukan." };
  }

  const accessToken = match[1].trim();
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const anonKey = process.env.SUPABASE_ANON_KEY || "";

  if (!supabaseUrl || !anonKey) {
    return {
      ok: false,
      statusCode: 500,
      message: "SUPABASE_URL atau SUPABASE_ANON_KEY belum dikonfigurasi di Netlify."
    };
  }

  let authUser;
  try {
    const resp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: anonKey
      }
    });
    if (!resp.ok) {
      return { ok: false, statusCode: 401, message: "Sesi login tidak valid atau sudah kedaluwarsa." };
    }
    authUser = await resp.json();
  } catch (_) {
    return { ok: false, statusCode: 503, message: "Gagal memverifikasi sesi dengan layanan autentikasi." };
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    const userRes = await client.query(
      `SELECT user_id, auth_uid, email, full_name, role, is_active
       FROM public.users
       WHERE auth_uid = $1::uuid OR LOWER(email) = LOWER($2)
       LIMIT 1;`,
      [authUser.id, authUser.email || ""]
    );

    if (userRes.rowCount === 0) {
      return { ok: false, statusCode: 403, message: "Profil pengguna belum terdaftar di sistem." };
    }

    const profile = userRes.rows[0];
    if (!profile.is_active) {
      return { ok: false, statusCode: 403, message: "Akun pengguna sedang dinonaktifkan." };
    }

    let student = null;
    if (profile.role === "student") {
      const stuRes = await client.query(
        `SELECT student_id, nim, full_name
         FROM public.students
         WHERE user_id = $1::uuid OR LOWER(email) = LOWER($2)
         LIMIT 1;`,
        [profile.user_id, profile.email]
      );
      if (stuRes.rowCount > 0) {
        student = stuRes.rows[0];
        // Pastikan user_id tersambung jika sebelumnya baru pra-registrasi via NIM
        if (!student.user_id) {
          await client.query(
            `UPDATE public.students SET user_id = $1::uuid WHERE student_id = $2::uuid;`,
            [profile.user_id, student.student_id]
          );
        }
      }
    }

    return {
      ok: true,
      sessionUser: {
        user_id: profile.user_id,
        auth_uid: authUser.id,
        email: profile.email,
        full_name: profile.full_name,
        role: profile.role,
        student_id: student ? student.student_id : null,
        nim: student ? student.nim : null
      }
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function canLecturerAccessSection(dbUrl, sessionUser, sectionId) {
  if (sessionUser.role === "admin") return true;
  if (sessionUser.role !== "lecturer") return false;

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const res = await client.query(
      `SELECT 1
       FROM public.class_sections cs
       LEFT JOIN public.courses c ON c.course_id = cs.course_id
       WHERE cs.section_id = $1::uuid
         AND (cs.lecturer_id = $2::uuid OR c.lecturer_id = $2::uuid)
       LIMIT 1;`,
      [sectionId, sessionUser.user_id]
    );
    return res.rowCount > 0;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  authenticateRequest,
  canLecturerAccessSection
};