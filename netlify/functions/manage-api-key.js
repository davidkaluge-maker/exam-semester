// netlify/functions/manage-api-key.js
const { Client } = require("pg");
const { authenticateRequest } = require("./_auth");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

async function testGeminiApiKey(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (resp.status === 200) return { ok: true, status: "valid" };
    if (resp.status === 429) return { ok: true, status: "quota_exhausted" };
    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      return { ok: false, status: "invalid", message: "Gemini API Key tidak valid atau ditolak." };
    }
    return { ok: true, status: "unverified" };
  } catch (err) {
    return { ok: true, status: "unverified" };
  } finally {
    clearTimeout(timeoutId);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: HEADERS,
      body: JSON.stringify({ message: "Method not allowed" })
    };
  }

  const dbUrl = process.env.DATABASE_URL;
  const encSecret = process.env.API_KEY_ENCRYPTION_SECRET;

  if (!dbUrl || !encSecret) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "DATABASE_URL atau API_KEY_ENCRYPTION_SECRET belum diatur." })
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

  const optedOut = Boolean(body.opted_out);
  const consentGiven = Boolean(body.consent_given);
  const rawApiKey = body.gemini_api_key ? String(body.gemini_api_key).trim() : "";

  let targetStudentId = auth.sessionUser.student_id;
  if (auth.sessionUser.role === "admin" && body.student_id) {
    targetStudentId = String(body.student_id).trim();
  }

  if (!targetStudentId) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ message: "Identitas mahasiswa (student_id) tidak ditemukan pada sesi." })
    };
  }

  if (!optedOut) {
    if (!rawApiKey) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({
          message: "Masukkan Gemini API Key baru atau centang opsi tanpa API Key."
        })
      };
    }
    if (!consentGiven) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({
          message: "Persetujuan penggunaan API Key wajib dicentang sebelum menyimpan."
        })
      };
    }
  }

  let validationStatus = "opted_out";
  if (!optedOut) {
    const check = await testGeminiApiKey(rawApiKey);
    if (!check.ok) {
      return {
        statusCode: 400,
        headers: HEADERS,
        body: JSON.stringify({ message: check.message, validation_status: check.status })
      };
    }
    validationStatus = check.status;
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    await client.query("BEGIN");

    const stuCheck = await client.query(
      `SELECT student_id, nim FROM public.students WHERE student_id = $1::uuid;`,
      [targetStudentId]
    );
    if (stuCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return {
        statusCode: 404,
        headers: HEADERS,
        body: JSON.stringify({ message: "Data mahasiswa tidak ditemukan." })
      };
    }

    let keyHint = null;
    if (optedOut) {
      await client.query(
        `INSERT INTO public.student_api_credentials
           (student_id, encrypted_api_key, key_hint, consent_given, consent_timestamp, validation_status, last_validated_at, updated_at)
         VALUES ($1::uuid, NULL, NULL, FALSE, NULL, 'opted_out', NOW(), NOW())
         ON CONFLICT (student_id)
         DO UPDATE SET
           encrypted_api_key = NULL,
           key_hint = NULL,
           consent_given = FALSE,
           validation_status = 'opted_out',
           last_validated_at = NOW(),
           updated_at = NOW();`,
        [targetStudentId]
      );
    } else {
      keyHint = `...${rawApiKey.slice(-4)}`;
      await client.query(
        `INSERT INTO public.student_api_credentials
           (student_id, encrypted_api_key, key_hint, consent_given, consent_timestamp, validation_status, last_validated_at, updated_at)
         VALUES ($1::uuid, pgp_sym_encrypt($2, $3), $4, TRUE, NOW(), $5, NOW(), NOW())
         ON CONFLICT (student_id)
         DO UPDATE SET
           encrypted_api_key = pgp_sym_encrypt($2, $3),
           key_hint = $4,
           consent_given = TRUE,
           consent_timestamp = COALESCE(public.student_api_credentials.consent_timestamp, NOW()),
           validation_status = $5,
           last_validated_at = NOW(),
           updated_at = NOW();`,
        [targetStudentId, rawApiKey, encSecret, keyHint, validationStatus]
      );
    }

    await client.query(
      `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
       VALUES ($1::uuid, $2, $3, 'student_api_credentials', $4::uuid, $5::jsonb);`,
      [
        auth.sessionUser.user_id,
        auth.sessionUser.role,
        optedOut ? "API_KEY_OPTED_OUT" : "API_KEY_UPDATED",
        targetStudentId,
        JSON.stringify({
          student_id: targetStudentId,
          nim: stuCheck.rows[0].nim,
          key_hint: keyHint,
          validation_status: validationStatus
        })
      ]
    );

    await client.query("COMMIT");

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({
        ok: true,
        student_id_short: targetStudentId.slice(0, 8),
        key_hint: keyHint,
        validation_status: validationStatus
      })
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Gagal memperbarui API Key: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};