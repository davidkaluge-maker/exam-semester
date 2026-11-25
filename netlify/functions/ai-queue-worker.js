// netlify/functions/ai-queue-worker.js
const { Client } = require("pg");
const { authenticateRequest, canLecturerAccessSection } = require("./_auth");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const TIME_BUDGET_MS = 7500;
const GEMINI_TIMEOUT_MS = 4500;

async function callGeminiRubricGrading(apiKey, modelName, payload) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const promptText = [
    "Anda adalah asisten penilai akademik yang ketat mengikuti rubrik.",
    "Nilai jawaban mahasiswa secara objektif berdasarkan rubrik dan kunci/pertanyaan berikut.",
    "Keluarkan HANYA JSON valid dengan format persis:",
    '{"suggested_score": number, "feedback": string, "criteria_breakdown": [{"criterion": string, "score": number, "max": number, "note": string}]}',
    `Skor Maksimum: ${payload.maxScore}`,
    `Rubrik (Versi ${payload.rubricVersion}): ${JSON.stringify(payload.rubricCriteria || [])}`,
    `Soal & Kunci: ${JSON.stringify(payload.questions || [])}`,
    `Jawaban Mahasiswa: ${JSON.stringify(payload.answers || {})}`
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    });

    if (resp.status === 429) {
      return { ok: false, kind: "quota", error: "HTTP 429: Kuota Gemini API habis." };
    }
    if (!resp.ok) {
      return { ok: false, kind: "error", error: `HTTP ${resp.status} dari Gemini API.` };
    }

    const data = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = JSON.parse(rawText);

    const scoreNum = Number(parsed.suggested_score);
    if (!Number.isFinite(scoreNum)) {
      return { ok: false, kind: "error", error: "Format skor dari Gemini tidak valid." };
    }

    const clampedScore = Math.max(0, Math.min(payload.maxScore, Number(scoreNum.toFixed(2))));
    return {
      ok: true,
      suggested_score: clampedScore,
      feedback: String(parsed.feedback || "").slice(0, 4000),
      criteria_breakdown: Array.isArray(parsed.criteria_breakdown) ? parsed.criteria_breakdown : []
    };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return {
      ok: false,
      kind: isAbort ? "timeout" : "error",
      error: isAbort ? "Permintaan Gemini melewati batas waktu aman." : String(err.message || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  const startedAt = Date.now();
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
    return { statusCode: auth.statusCode, headers: HEADERS, body: JSON.stringify({ message: auth.message }) };
  }

  const user = auth.sessionUser;
  if (!["admin", "lecturer"].includes(user.role)) {
    return {
      statusCode: 403,
      headers: HEADERS,
      body: JSON.stringify({ message: "Hanya dosen atau administrator yang dapat menjalankan worker antrean AI." })
    };
  }

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ message: "Format JSON tidak valid." }) };
  }

  const sectionId = body.section_id ? String(body.section_id).trim() : null;
  if (sectionId) {
    const allowed = await canLecturerAccessSection(dbUrl, user, sectionId);
    if (!allowed) {
      return { statusCode: 403, headers: HEADERS, body: JSON.stringify({ message: "Anda tidak berhak atas kelas ini." }) };
    }
  }

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  const summary = {
    processed: 0,
    completed: 0,
    failed_quota: 0,
    failed_error: 0,
    stopped_by_time_budget: false
  };

  try {
    await client.connect();

    const policyRes = await client.query(
      `SELECT setting_value FROM public.system_settings WHERE setting_key = 'ai_policy' LIMIT 1;`
    );
    const policy = policyRes.rows[0]?.setting_value || {};
    const defaultModel = String(policy.default_model || "gemini-2.5-flash");
    const maxBatch = Math.min(5, Math.max(1, Number(body.batch_size || policy.max_batch_size || 3)));

    // Ambil batch kecil pekerjaan antrean secara aman (SKIP LOCKED)
    const queueRes = await client.query(
      `SELECT
         aa.ai_assessment_id,
         aa.submission_id,
         aa.rubric_id,
         aa.rubric_version,
         aa.model_used,
         s.student_id,
         s.activity_id,
         s.answers,
         act.section_id,
         act.max_score,
         gr.version AS latest_rubric_version,
         gr.criteria AS rubric_criteria,
         pgp_sym_decrypt(sac.encrypted_api_key, $1)::text AS student_api_key,
         sac.validation_status AS key_status
       FROM public.ai_assessments aa
       JOIN public.submissions s ON s.submission_id = aa.submission_id
       JOIN public.assessment_activities act ON act.activity_id = s.activity_id
       JOIN public.class_sections cs ON cs.section_id = act.section_id
       LEFT JOIN public.courses c ON c.course_id = cs.course_id
       LEFT JOIN public.grading_rubrics gr ON gr.rubric_id = COALESCE(aa.rubric_id, act.rubric_id)
       LEFT JOIN public.student_api_credentials sac ON sac.student_id = s.student_id
       WHERE aa.queue_status IN ('pending', 'failed_quota')
         AND act.ai_grading_enabled = TRUE
         AND ($2::uuid IS NULL OR act.section_id = $2::uuid)
         AND (
           $3 = 'admin'
           OR cs.lecturer_id = $4::uuid
           OR c.lecturer_id = $4::uuid
         )
       ORDER BY
         CASE WHEN aa.queue_status = 'pending' THEN 0 ELSE 1 END,
         aa.assessed_at ASC
       LIMIT $5
       FOR UPDATE OF aa SKIP LOCKED;`,
      [encSecret, sectionId, user.role, user.user_id, maxBatch]
    );

    for (const item of queueRes.rows) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        summary.stopped_by_time_budget = true;
        break;
      }

      summary.processed += 1;
      await client.query(
        `UPDATE public.ai_assessments SET queue_status = 'processing', error_message = NULL WHERE ai_assessment_id = $1::uuid;`,
        [item.ai_assessment_id]
      );

      const qRes = await client.query(
        `SELECT question_number, question_type, question_text, answer_key, points
         FROM public.questions
         WHERE activity_id = $1::uuid
         ORDER BY question_number ASC;`,
        [item.activity_id]
      );

      const apiKeyToUse =
        (item.key_status === "valid" || item.key_status === "unverified") && item.student_api_key
          ? item.student_api_key
          : (process.env.GEMINI_FALLBACK_API_KEY || "");

      const modelUsed = item.model_used || defaultModel;
      const rubricVersion = item.latest_rubric_version || item.rubric_version || 1;
      const maxScore = Number(item.max_score || 100);

      if (!apiKeyToUse) {
        await client.query(
          `UPDATE public.ai_assessments
           SET queue_status = 'failed_quota',
               rubric_version = $2,
               error_message = 'Tidak ada API Key aktif (mahasiswa opt-out / kuota habis / tanpa fallback).'
           WHERE ai_assessment_id = $1::uuid;`,
          [item.ai_assessment_id, rubricVersion]
        );
        summary.failed_quota += 1;
        continue;
      }

      const aiResult = await callGeminiRubricGrading(apiKeyToUse, modelUsed, {
        maxScore,
        rubricVersion,
        rubricCriteria: item.rubric_criteria,
        questions: qRes.rows,
        answers: item.answers
      });

      if (!aiResult.ok) {
        const nextQueueStatus = aiResult.kind === "quota" ? "failed_quota" : "failed_error";
        await client.query(
          `UPDATE public.ai_assessments
           SET queue_status = $2,
               rubric_version = $3,
               error_message = $4,
               assessed_at = NOW()
           WHERE ai_assessment_id = $1::uuid;`,
          [item.ai_assessment_id, nextQueueStatus, rubricVersion, aiResult.error]
        );

        await client.query(
          `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
           VALUES ($1::uuid, $2, 'AI_QUEUE_FAILED', 'ai_assessments', $3::uuid, $4::jsonb);`,
          [
            user.user_id,
            user.role,
            item.ai_assessment_id,
            JSON.stringify({
              submission_id: item.submission_id,
              rubric_id: item.rubric_id,
              rubric_version: rubricVersion,
              model_used: modelUsed,
              queue_status: nextQueueStatus,
              reason: aiResult.error
            })
          ]
        );

        if (nextQueueStatus === "failed_quota") summary.failed_quota += 1;
        else summary.failed_error += 1;
        continue;
      }

      await client.query("BEGIN");
      await client.query(
        `UPDATE public.ai_assessments
         SET rubric_id = COALESCE(rubric_id, $2::uuid),
             rubric_version = $3,
             model_used = $4,
             suggested_score = $5,
             feedback = $6,
             criteria_breakdown = $7::jsonb,
             queue_status = 'completed',
             error_message = NULL,
             lecturer_review_status = 'pending_review',
             assessed_at = NOW()
         WHERE ai_assessment_id = $1::uuid;`,
        [
          item.ai_assessment_id,
          item.rubric_id,
          rubricVersion,
          modelUsed,
          aiResult.suggested_score,
          aiResult.feedback,
          JSON.stringify(aiResult.criteria_breakdown)
        ]
      );

      await client.query(
        `UPDATE public.submissions
         SET grading_status = 'ai_graded'
         WHERE submission_id = $1::uuid;`,
        [item.submission_id]
      );

      // Sinkronkan skor awal ke gradebook_entries jika belum dikunci/dinilai manual oleh dosen
      await client.query(
        `INSERT INTO public.gradebook_entries
           (student_id, section_id, activity_id, submission_id, score, score_status, graded_by, change_history, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'graded', 'ai',
                 $6::jsonb, NOW())
         ON CONFLICT (student_id, activity_id)
         DO UPDATE SET
           submission_id = COALESCE(EXCLUDED.submission_id, public.gradebook_entries.submission_id),
           score = CASE
             WHEN public.gradebook_entries.graded_by = 'lecturer' THEN public.gradebook_entries.score
             ELSE EXCLUDED.score
           END,
           score_status = 'graded',
           graded_by = CASE
             WHEN public.gradebook_entries.graded_by = 'lecturer' THEN 'lecturer'
             ELSE 'ai'
           END,
           change_history = public.gradebook_entries.change_history || $6::jsonb,
           updated_at = NOW();`,
        [
          item.student_id,
          item.section_id,
          item.activity_id,
          item.submission_id,
          aiResult.suggested_score,
          JSON.stringify([
            {
              at: new Date().toISOString(),
              by: "ai_queue_worker",
              model_used: modelUsed,
              rubric_id: item.rubric_id,
              rubric_version: rubricVersion,
              score: aiResult.suggested_score
            }
          ])
        ]
      );

      await client.query(
        `INSERT INTO public.audit_logs (actor_id, actor_role, action, target_table, target_id, details)
         VALUES ($1::uuid, $2, 'AI_RUBRIC_ASSESSED', 'ai_assessments', $3::uuid, $4::jsonb);`,
        [
          user.user_id,
          user.role,
          item.ai_assessment_id,
          JSON.stringify({
            submission_id: item.submission_id,
            rubric_id: item.rubric_id,
            rubric_version: rubricVersion,
            model_used: modelUsed,
            suggested_score: aiResult.suggested_score,
            criteria_count: aiResult.criteria_breakdown.length
          })
        ]
      );
      await client.query("COMMIT");

      summary.completed += 1;
    }

    return {
      statusCode: 200,
      headers: HEADERS,
      body: JSON.stringify({ ok: true, summary })
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Worker antrean AI gagal: " + err.message, summary })
    };
  } finally {
    await client.end().catch(() => {});
  }
};