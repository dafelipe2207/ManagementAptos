import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// PUBLIC endpoint (verify_jwt: false): lets a tenant sign in with their payment reference
// (e.g. NOE105) + password instead of their phone number. The reference is looked up server-side
// and the password is checked by Supabase Auth itself (normal signInWithPassword), so the
// tenant's login email/phone is never revealed to the browser. Any failure — unknown reference,
// no login yet, inactive tenant, wrong password — returns the same generic error, so references
// can't be probed. Only a session (access/refresh token) for that tenant is returned.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
const INVALID = { error: "Invalid login credentials" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body: { reference?: string; password?: string };
  try { body = await req.json(); } catch (_e) { return json({ error: "Invalid request body." }, 400); }
  const reference = (body.reference || "").trim().toUpperCase();
  const password = body.password || "";
  if (!/^[A-Z]{2,6}\d{2,6}$/.test(reference) || !password) return json(INVALID, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: rows, error } = await admin.from("tenants")
    .select("auth_user_id, is_active").eq("payment_reference", reference).limit(1);
  if (error) { console.error("login-by-reference: lookup failed", error); return json(INVALID, 400); }
  const tenant = rows && rows[0];
  if (!tenant || !tenant.auth_user_id || tenant.is_active === false) return json(INVALID, 400);

  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(tenant.auth_user_id);
  const email = userData && userData.user && userData.user.email;
  if (userErr || !email) return json(INVALID, 400);

  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({ email, password });
  if (signErr || !signIn.session) {
    const msg = (signErr && signErr.message) || "";
    if (/rate limit|too many/i.test(msg)) return json({ error: "Too many attempts — wait a minute and try again." }, 429);
    return json(INVALID, 400);
  }
  return json({ access_token: signIn.session.access_token, refresh_token: signIn.session.refresh_token });
});
