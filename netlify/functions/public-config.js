// netlify/functions/public-config.js
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=300"
};

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ message: "Method not allowed" }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      statusCode: 500,
      headers: HEADERS,
      body: JSON.stringify({ message: "Konfigurasi publik Supabase belum diatur di Netlify." })
    };
  }

  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      ok: true,
      supabase_url: supabaseUrl,
      supabase_anon_key: supabaseAnonKey
    })
  };
};