// emma-sheet — reads a *privately shared* Google Sheet via a service account.
// The SA JSON key lives ONLY in the Supabase secret GOOGLE_SA_KEY_B64 (base64 of the
// key file). Nothing sensitive is in client JS or the repo. Returns parsed rows.
//
// Request (GET or POST):
//   ?sheetId=<id>        required — the spreadsheet id
//   ?tab=<sheet title>   optional — which tab; defaults to the first tab
// Response: { titles: string[], tab: string, values: string[][] }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Verify the caller is a *signed-in household member*, not just anyone holding
// the public anon key. Supabase's gateway accepts the anon key as a valid JWT,
// so JWT-verify alone doesn't gate this — we must resolve the bearer token to a
// real user (the anon token resolves to none) and confirm household membership.
// Returns the user id on success, or a Response to return on failure.
async function requireMember(req: Request): Promise<string | Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  // 1) Resolve the token to a real user. The anon key carries role=anon and
  //    returns no user here, so this rejects anon/unauthenticated callers.
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) return json({ error: "unauthorized" }, 401);
  const user = await userRes.json();
  if (!user?.id) return json({ error: "unauthorized" }, 401);

  // 2) Confirm the user belongs to a household (service role bypasses RLS).
  const memRes = await fetch(
    `${SUPABASE_URL}/rest/v1/household_memberships?user_id=eq.${user.id}&select=household_id&limit=1`,
    { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } },
  );
  const mem = memRes.ok ? await memRes.json() : [];
  if (!Array.isArray(mem) || mem.length === 0) return json({ error: "forbidden" }, 403);

  return user.id;
}

// base64url of a string or ArrayBuffer
function b64url(input: string | ArrayBuffer): string {
  let bin: string;
  if (typeof input === "string") {
    bin = btoa(unescape(encodeURIComponent(input)));
  } else {
    const bytes = new Uint8Array(input);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    bin = btoa(s);
  }
  return bin.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function getAccessToken(sa: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: sa.token_uri,
    exp: now + 3600,
    iat: now,
  }));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const gate = await requireMember(req);
    if (gate instanceof Response) return gate;

    const url = new URL(req.url);
    let sheetId = url.searchParams.get("sheetId") ?? "";
    let tab = url.searchParams.get("tab") ?? "";
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      sheetId = body.sheetId ?? sheetId;
      tab = body.tab ?? tab;
    }
    if (!sheetId) return json({ error: "sheetId required" }, 400);

    const b64key = Deno.env.get("GOOGLE_SA_KEY_B64");
    if (!b64key) return json({ error: "GOOGLE_SA_KEY_B64 not set" }, 500);
    const sa = JSON.parse(atob(b64key.replace(/\s+/g, "")));

    const token = await getAccessToken(sa);
    const authHeader = { Authorization: `Bearer ${token}` };

    // discover tabs
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
      { headers: authHeader },
    );
    const meta = await metaRes.json();
    if (!metaRes.ok) return json({ error: "sheets metadata failed", detail: meta }, metaRes.status);
    const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties.title);
    const useTab = tab || titles[0];

    // read values of the chosen tab (used range)
    const valRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(useTab)}`,
      { headers: authHeader },
    );
    const vals = await valRes.json();
    if (!valRes.ok) return json({ error: "sheets values failed", detail: vals }, valRes.status);

    return json({ titles, tab: useTab, values: vals.values ?? [] });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
