// netlify/functions/preregister.js
const { Client } = require("pg");

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

async function validateGeminiKey(apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 200) return "valid";
    if (res.status === 429) return "quota_exhausted";
    return "invalid";
  } catch (_) {
    return "unverified";
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "Method not allowed" })
    };
  }

  const dbUrl = process.env.DATABASE_URL;
  const encSecret = process.env.API_KEY_ENCRYPTION_SECRET;

  if (!dbUrl || !encSecret) {
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        message: "Environment variable DATABASE_URL atau API_KEY_ENCRYPTION_SECRET belum lengkap."
      })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "Format JSON tidak valid." })
    };
  }

  const fullName = String(body.full_name || "").trim();
  const nim = String(body.nim || "").trim();
  const sectionId = String(body.section_id || "").trim();
  const rawKey = body.gemini_api_key ? String(body.gemini_api_key).trim() : "";
  const consentGiven = Boolean(body.consent_given);
  const optedOut = Boolean(body.opted_out);

  if (!fullName || !nim || !sectionId) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "Nama lengkap, NIM, dan pilihan kelas wajib diisi." })
    };
  }

  if (!optedOut && rawKey && !consentGiven) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        message: "Centang persetujuan penggunaan API Key terlebih dahulu atau pilih opsi tanpa API Key."
      })
    };
  }

  let validationStatus = "opted_out";
  if (!optedOut && rawKey) {
    validationStatus = await validateGeminiKey(rawKey);
    if (validationStatus === "invalid") {
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: "Gemini API Key tidak valid. Periksa kembali kunci Anda." })
      };
    }
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    await client.query("BEGIN");

    const secCheck = await client.query(
      `SELECT section_id FROM public.class_sections WHERE section_id = $1::uuid;`,
      [sectionId]
    );
    if (secCheck.rowCount === 0) {
      await client.query("ROLLBACK");
      return {
        statusCode: 400,
        headers: JSON_HEADERS,
        body: JSON.stringify({ message: "Kelas yang dipilih tidak ditemukan." })
      };
    }

    const studentRes = await client.query(
      `INSERT INTO public.students (nim, full_name)
       VALUES ($1, $2)
       ON CONFLICT (nim)
       DO UPDATE SET full_name = EXCLUDED.full_name, updated_at = NOW()
       RETURNING student_id, nim;`,
      [nim, fullName]
    );
    const studentId = studentRes.rows[0].student_id;

    await client.query(
      `INSERT INTO public.enrollments (student_id, section_id, status)
       VALUES ($1, $2::uuid, 'active')
       ON CONFLICT (student_id, section_id)
       DO UPDATE SET status = 'active';`,
      [studentId, sectionId]
    );

    if (optedOut || !rawKey) {
      await client.query(
        `INSERT INTO public.student_api_credentials
           (student_id, encrypted_api_key, key_hint, consent_given, consent_timestamp, validation_status, last_validated_at, updated_at)
         VALUES ($1, NULL, NULL, FALSE, NULL, 'opted_out', NOW(), NOW())
         ON CONFLICT (student_id)
         DO UPDATE SET
           encrypted_api_key = NULL,
           key_hint = NULL,
           consent_given = FALSE,
           validation_status = 'opted_out',
           last_validated_at = NOW(),
           updated_at = NOW();`,
        [studentId]
      );
    } else {
      const keyHint = `...${rawKey.slice(-4)}`;
      await client.query(
        `INSERT INTO public.student_api_credentials
           (student_id, encrypted_api_key, key_hint, consent_given, consent_timestamp, validation_status, last_validated_at, updated_at)
         VALUES ($1, pgp_sym_encrypt($2, $3), $4, TRUE, NOW(), $5, NOW(), NOW())
         ON CONFLICT (student_id)
         DO UPDATE SET
           encrypted_api_key = pgp_sym_encrypt($2, $3),
           key_hint = $4,
           consent_given = TRUE,
           consent_timestamp = COALESCE(public.student_api_credentials.consent_timestamp, NOW()),
           validation_status = $5,
           last_validated_at = NOW(),
           updated_at = NOW();`,
        [studentId, rawKey, encSecret, keyHint, validationStatus]
      );
    }

    await client.query(
      `INSERT INTO public.audit_logs (actor_role, action, target_table, target_id, details)
       VALUES ('student', 'PREREGISTER_UPSERT', 'students', $1, $2::jsonb);`,
      [
        studentId,
        JSON.stringify({
          nim,
          section_id: sectionId,
          api_key_status: validationStatus
        })
      ]
    );

    await client.query("COMMIT");

    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        ok: true,
        nim,
        student_id_short: studentId.slice(0, 8),
        api_key_status: validationStatus
      })
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ message: "Gagal menyimpan pra-registrasi: " + err.message })
    };
  } finally {
    await client.end().catch(() => {});
  }
};