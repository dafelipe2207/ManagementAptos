import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lets a Super Admin permanently delete another user's login. Needs the service role key
// (deleting from auth.users, and profiles isn't declared as a FK to it, so this also has to
// clean up references by hand): unlinks the tenant record if this was a tenant login (keeps the
// tenant and their history, just removes their ability to sign in), deletes the profiles row
// (property_administrators cascades; maintenance_requests.assigned_to sets to null on its own),
// then deletes the auth.users row itself.

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


/** An Administrator may manage the logins of tenants in the properties assigned to them. */
async function adminManagesTenantLogin(admin: any, callerProfileId: string, targetAuthUserId: string): Promise<boolean> {
  const { data: t } = await admin.from("tenants").select("property_id").eq("auth_user_id", targetAuthUserId).limit(1);
  const propertyId = t && t[0] && t[0].property_id;
  if (!propertyId) return false;
  const { data: pa } = await admin.from("property_administrators").select("id")
    .eq("profile_id", callerProfileId).eq("property_id", propertyId).limit(1);
  return !!(pa && pa.length);
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
    .from("profiles").select("id, role, is_active").eq("auth_user_id", callerData.user.id).maybeSingle();
  const callerIsAdmin = !!callerProfile && callerProfile.role === "administrator";
  if (profileErr || !callerProfile || !callerProfile.is_active || (callerProfile.role !== "super_admin" && !callerIsAdmin)) {
    return json({ error: "Only an active Super Admin or Administrator can delete another user's account." }, 403);
  }

  let body: { profileId?: string };
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "Invalid request body." }, 400);
  }
  const profileId = body.profileId || "";
  if (!profileId) return json({ error: "Missing profileId." }, 400);
  if (profileId === callerProfile.id) return json({ error: "You can't delete your own account." }, 400);

  const { data: target, error: targetErr } = await admin
    .from("profiles").select("auth_user_id, role").eq("id", profileId).maybeSingle();
  if (targetErr || !target) return json({ error: "That user was not found." }, 400);
  if (callerIsAdmin && !(target.role === "tenant" && await adminManagesTenantLogin(admin, callerProfile.id, target.auth_user_id))) {
    return json({ error: "An Administrator can only manage the logins of tenants in their own properties." }, 403);
  }
  if (target.role === "tenant") {
    const { error: unlinkErr } = await admin.from("tenants").update({ auth_user_id: null }).eq("auth_user_id", target.auth_user_id);
    if (unlinkErr) console.error("delete-user: could not unlink tenant record:", unlinkErr);
  }

  const { error: deleteProfileErr } = await admin.from("profiles").delete().eq("id", profileId);
  if (deleteProfileErr) {
    console.error("delete-user: could not delete profile row:", deleteProfileErr);
    return json({ error: "Could not delete the profile record." }, 500);
  }

  const { error: deleteAuthErr } = await admin.auth.admin.deleteUser(target.auth_user_id);
  if (deleteAuthErr) {
    console.error("delete-user: could not delete auth user (profile already removed):", deleteAuthErr);
    return json({ warning: "The profile was removed, but the login itself could not be deleted — it may already be gone." });
  }

  return json({ ok: true });
});
