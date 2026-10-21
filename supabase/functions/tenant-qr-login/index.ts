import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// One-tap tenant login by QR code / link (verify_jwt: false — the caller is checked here).
//
//  { action: "create", tenantId }  — staff only (Super Admin, or an Administrator of the tenant's
//     property). Revokes the tenant's previous QR and returns a new random token (valid 30 days,
//     up to 3 devices). Only its SHA-256 hash is stored.
//  { action: "redeem", token }     — public. If the token is valid and the tenant's login is
//     active, returns a normal session for that tenant (a magic link is generated and verified
//     server-side, so no password or email ever reaches the browser). The app then keeps the
//     session on the device like any other sign-in. Any failure returns the same generic error.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const VALID_DAYS = 30;
const MAX_USES = 3;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
const INVALID = { error: "This login QR code is no longer valid. Ask your house admin for a new one." };

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  let body: { action?: string; tenantId?: string; token?: string };
  try { body = await req.json(); } catch (_e) { return json({ error: "Invalid request body." }, 400); }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  if (body.action === "create") {
    const callerToken = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!callerToken) return json({ error: "Not signed in." }, 401);
    const { data: callerData, error: callerErr } = await admin.auth.getUser(callerToken);
    if (callerErr || !callerData?.user) return json({ error: "Not signed in." }, 401);
    const { data: caller } = await admin.from("profiles").select("id, role, is_active")
      .eq("auth_user_id", callerData.user.id).maybeSingle();
    if (!caller || caller.is_active === false || !["super_admin", "administrator"].includes(caller.role)) {
      return json({ error: "Only an admin can make login QR codes." }, 403);
    }
    const { data: tenant } = await admin.from("tenants").select("id, auth_user_id, property_id")
      .eq("id", body.tenantId || "").maybeSingle();
    if (!tenant) return json({ error: "Tenant not found." }, 404);
    if (!tenant.auth_user_id) return json({ error: "This tenant has no login yet — create it in Users first." }, 400);
    if (caller.role === "administrator") {
      const { data: pa } = await admin.from("property_administrators").select("id")
        .eq("profile_id", caller.id).eq("property_id", tenant.property_id).limit(1);
      if (!pa || !pa.length) return json({ error: "You don't manage this tenant's property." }, 403);
    }
    await admin.from("tenant_login_tokens").update({ revoked_at: new Date().toISOString() })
      .eq("tenant_id", tenant.id).is("revoked_at", null);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + VALID_DAYS * 86400000).toISOString();
    const { error: insErr } = await admin.from("tenant_login_tokens").insert({
      token_hash: await sha256(token), tenant_id: tenant.id, auth_user_id: tenant.auth_user_id,
      created_by_profile_id: caller.id, expires_at: expiresAt, max_uses: MAX_USES
    });
    if (insErr) { console.error("tenant-qr-login: insert failed", insErr); return json({ error: "Could not make the QR code." }, 500); }
    return json({ token, expiresAt, maxUses: MAX_USES });
  }

  if (body.action === "redeem") {
    const token = (body.token || "").trim();
    if (!/^[A-Za-z0-9_-]{30,64}$/.test(token)) return json(INVALID, 400);
    const { data: row } = await admin.from("tenant_login_tokens").select("*")
      .eq("token_hash", await sha256(token)).maybeSingle();
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now() || row.uses >= row.max_uses) return json(INVALID, 400);
    const { data: tenant } = await admin.from("tenants").select("auth_user_id, is_active").eq("id", row.tenant_id).maybeSingle();
    if (!tenant || tenant.is_active === false || tenant.auth_user_id !== row.auth_user_id) return json(INVALID, 400);
    const { data: prof } = await admin.from("profiles").select("is_active").eq("auth_user_id", row.auth_user_id).maybeSingle();
    if (!prof) return json(INVALID, 400);
    if (prof.is_active === false) return json({ error: "Your login isn't switched on yet. Ask your house admin to activate it, then scan again." }, 400);
    const { data: u } = await admin.auth.admin.getUserById(row.auth_user_id);
    const email = u?.user?.email;
    if (!email) return json(INVALID, 400);
    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const hashed = link?.properties?.hashed_token;
    if (linkErr || !hashed) { console.error("tenant-qr-login: generateLink failed", linkErr); return json(INVALID, 400); }
    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const { data: v, error: vErr } = await anon.auth.verifyOtp({ token_hash: hashed, type: "magiclink" });
    if (vErr || !v?.session) { console.error("tenant-qr-login: verifyOtp failed", vErr); return json(INVALID, 400); }
    await admin.from("tenant_login_tokens").update({ uses: row.uses + 1, last_used_at: new Date().toISOString() }).eq("id", row.id);
    return json({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  }

  return json({ error: "Unknown action." }, 400);
});
