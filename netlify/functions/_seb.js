// netlify/functions/_seb.js
const crypto = require("crypto");

function normalizeHexHash(val) {
  if (!val || typeof val !== "string") return "";
  return val.trim().toLowerCase();
}

function isValidSha256Hex(hash) {
  return /^[a-f0-9]{64}$/.test(hash);
}

function timingSafeEqualStr(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return crypto.timingSafeEqual(bufA, bufB);
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex").toLowerCase();
}

/**
 * Membangun URL penuh permintaan sebagaimana dilihat SEB.
 * Mendukung x-forwarded-proto & x-forwarded-host di Netlify.
 */
function reconstructRequestUrl(event) {
  const headers = event.headers || {};
  const proto = (headers["x-forwarded-proto"] || headers["X-Forwarded-Proto"] || "https")
    .split(",")[0]
    .trim();
  const host = (headers["x-forwarded-host"] || headers["X-Forwarded-Host"] || headers["host"] || headers["Host"] || "")
    .split(",")[0]
    .trim();
  const rawUrl = event.rawUrl || "";
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  const path = event.path || "/.netlify/functions/verify-seb";
  const qs = event.rawQueryString
    ? `?${event.rawQueryString}`
    : event.queryStringParameters && Object.keys(event.queryStringParameters).length > 0
      ? `?${new URLSearchParams(event.queryStringParameters).toString()}`
      : "";
  return `${proto}://${host}${path}${qs}`;
}

/**
 * Memverifikasi header SEB terhadap hash yang tersimpan pada assessment_activities.
 */
function verifySebRequest(event, activityRow) {
  if (!activityRow || !activityRow.require_seb) {
    return {
      ok: true,
      seb_verified: false,
      seb_request_hash: null,
      reason: "SEB_NOT_REQUIRED"
    };
  }

  const headers = event.headers || {};
  const ckHeader = normalizeHexHash(
    headers["x-safeexambrowser-configkeyhash"] || headers["X-SafeExamBrowser-ConfigKeyHash"]
  );
  const bekHeader = normalizeHexHash(
    headers["x-safeexambrowser-browserexamkey"] || headers["X-SafeExamBrowser-BrowserExamKey"]
  );
  const reqHashHeader = normalizeHexHash(
    headers["x-safeexambrowser-requesthash"] || headers["X-SafeExamBrowser-RequestHash"]
  );

  const expectedCk = normalizeHexHash(activityRow.seb_config_key_hash);
  const expectedBek = normalizeHexHash(activityRow.seb_browser_exam_key_hash);

  if (!expectedCk && !expectedBek) {
    return {
      ok: false,
      statusCode: 423,
      seb_verified: false,
      seb_request_hash: reqHashHeader || null,
      reason: "SEB_HASH_NOT_CONFIGURED"
    };
  }

  // 1. Validasi Config Key Hash jika dikonfigurasi pada aktivitas
  if (expectedCk) {
    if (!isValidSha256Hex(ckHeader) || !timingSafeEqualStr(ckHeader, expectedCk)) {
      return {
        ok: false,
        statusCode: 403,
        seb_verified: false,
        seb_request_hash: reqHashHeader || null,
        reason: "INVALID_CONFIG_KEY_HASH"
      };
    }
  }

  // 2. Validasi Browser Exam Key jika dikonfigurasi pada aktivitas
  if (expectedBek) {
    if (!isValidSha256Hex(bekHeader) || !timingSafeEqualStr(bekHeader, expectedBek)) {
      return {
        ok: false,
        statusCode: 403,
        seb_verified: false,
        seb_request_hash: reqHashHeader || null,
        reason: "INVALID_BROWSER_EXAM_KEY"
      };
    }
  }

  // 3. Validasi RequestHash resmi SEB: sha256(fullUrl + keyHash)
  if (!isValidSha256Hex(reqHashHeader)) {
    return {
      ok: false,
      statusCode: 403,
      seb_verified: false,
      seb_request_hash: null,
      reason: "MISSING_OR_MALFORMED_REQUEST_HASH"
    };
  }

  const fullUrl = reconstructRequestUrl(event);
  const candidates = [];
  if (ckHeader) candidates.push(sha256Hex(fullUrl + ckHeader));
  if (bekHeader) candidates.push(sha256Hex(fullUrl + bekHeader));

  const requestHashValid = candidates.some((candidate) => timingSafeEqualStr(reqHashHeader, candidate));
  if (!requestHashValid) {
    return {
      ok: false,
      statusCode: 403,
      seb_verified: false,
      seb_request_hash: reqHashHeader,
      reason: "REQUEST_HASH_MISMATCH"
    };
  }

  return {
    ok: true,
    seb_verified: true,
    seb_request_hash: reqHashHeader,
    reason: "SEB_VERIFIED"
  };
}

module.exports = {
  normalizeHexHash,
  isValidSha256Hex,
  verifySebRequest
};