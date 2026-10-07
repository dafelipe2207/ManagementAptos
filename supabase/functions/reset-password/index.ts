import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lets a Super Admin directly set a new password for a Tenant login (phone-based — there's no
// real email inbox to send a reset link to). Administrators/Super Admins still get the normal
// email reset-link flow (client-side, no Edge Function needed for that one).
//
// Also updates profiles.current_password with the new plaintext password, so the Users page can
// show/copy it later if the Super Admin (or the tenant) forgets it again.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) return json({ error: "Missing Authorization header." }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } }
  });
  const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerData?.user) return json({ error: "Not signed in." }, 401);

  const { data: callerProfile, error: profileErr } = await admin
    .from("profiles").select("role, is_active").eq("auth_user_id", callerData.user.id).maybeSingle();
  if (profileErr || !callerProfile || callerProfile.role !== "super_admin" || !callerProfile.is_active) {
    return json({ error: "Only an active Super Admin can reset another user's password." }, 403);
  }

  let body: { profileId?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "Invalid request body." }, 400);
  }
  const profileId = body.profileId || "";
  const newPassword = body.newPassword || "";
  if (!profileId) return json({ error: "Missing profileId." }, 400);
  if (!newPassword || newPassword.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

  const { data: targetProfile, error: targetErr } = await admin
    .from("profiles").select("auth_user_id").eq("id", profileId).maybeSingle();
  if (targetErr || !targetProfile) return json({ error: "That user was not found." }, 400);

  const { error: updateErr } = await admin.auth.admin.updateUserById(targetProfile.auth_user_id, { password: newPassword });
  if (updateErr) {
    console.error("reset-password: updateUserById failed:", updateErr);
    return json({ error: updateErr.message || "Could not update the password." }, 500);
  }

  const { error: savePwErr } = await admin.from("profiles").update({ current_password: newPassword }).eq("id", profileId);
  if (savePwErr) {
    // Password itself is already changed and usable — just log this, don't fail the request.
    console.error("reset-password: could not save current_password copy:", savePwErr);
  }

  return json({ ok: true });
});
