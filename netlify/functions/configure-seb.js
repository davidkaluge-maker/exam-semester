// netlify/functions/configure-seb.js
const { Client } = require("pg");
const { authenticateRequest, canLecturerAccessSection } = require("./_auth");
const { normalizeHexHash, isValidSha256Hex } = require("./_seb");

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
  if (!["admin", "lecturer"].includes(user.role)) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ message: "Hanya dosen pengampu atau administrator yang dapat mengatur SEB." })
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
  const requireSeb = Boolean(body.require_seb);
  const ckHash = body.seb_config_key_hash ? normalizeHexHash(body.seb_config_key_hash) : null;
  const bekHash = body.seb_browser_exam_key_hash ? normalizeHexHash(body.seb_browser_exam_key_hash) : null;

  if (!activityId) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "activity_id wajib diisi." })
    };
  }

  if (ckHash && !isValidSha256Hex(ckHash)) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "seb_config_key_hash harus berupa 64 karakter heksadesimal SHA-256." })
    };
  }

  if (bekHash && !isValidSha256Hex(bekHash)) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({ message: "seb_browser_exam_key_hash harus berupa 64 karakter heksadesimal SHA-256." })
    };
  }

  if (requireSeb && !ckHash && !bekHash) {
    return {
      statusCode: 400,
      headers: HEADERS,
      body: JSON.stringify({
        message: "Aktifkan minimal satu hash (seb_config_key_hash atau seb_browser_exam_key_hash) saat require_seb = true."
      })
    };
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    const actRes = await client.query(
      `SELECT activity_id, section_id, title
       FROM public.assessment_activities
       WHERE activity_id = $1::uuid
       LIMIT 1;`,
      [activityId]
    );

    if (actRes.rowCount === 0) {
      return {
        statusCode: 404,
        headers: HEADERS,
        body: JSON.stringify({ message: "Aktivitas ujian tidak ditemukan." })
      };
    }

    const act = actRes.rows[0];
    const allowed = await canLecturerAccessSection(dbUrl, user, act.section_id);
    if (!allowed) {
      return {
        statusCode: 403,
        headers: HEADERS,
        body: JSON.stringify({ message: "Anda tidak memiliki kewenangan atas kelas dari aktivitas ini." })
      };
    }

    const upd = await client.query(
      `UPDATE public.assessment_activities
       SET require_seb = $1,
           seb_config_key_hash = $2,
           seb_browser_exam_key_hash = $3
       WHERE activity_id = $4::uuid
       RETURNING activity_id, section_id, title, require_seb,
                 (seb_config_key_hash IS NOT NULL) AS has_config_key_hash,
                 (seb_browser_exam_key_hash IS NOT NULL) AS has_browser_exam_key_hash;`,
      [requireSeb, ckHash, bekHash, activityId]
    );

    await client.query(
      `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
       VALUES ($1::uuid, $2, 'CONFIGURE_SEB_POLICY', 'assessment_activities', $3::uuid, $4::jsonb);`,
      [
        user.user_id,
        user.role,
        activityId,
        JSON.stringify({
          require_seb: requireSeb,
          has_config_key_hash: Boolean(ckHash),
          has_browser_exam_key_hash: Boolean(bekHash)
        })
      ]
    );

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: true, activity: upd.rows[0] })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal menyimpan konfigurasi SEB: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};