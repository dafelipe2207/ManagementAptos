import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lets a Super Admin create a new login (Administrator, Viewer or Tenant) without ever touching their
// own session — supabase-js's normal client-side auth.signUp() would SWITCH the caller's
// session to the newly created user, which is exactly wrong here. The only safe way to create
// another user's account is server-side with the service role key, which is why this has to be
// an Edge Function: the service role key never reaches the browser (it lives only as this
// function's environment — Supabase injects SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY into every
// Edge Function automatically, nothing to configure).
//
// Tenants don't have email addresses available, so a Tenant logs in with their PHONE NUMBER
// instead — Supabase Auth itself only offers email, or a real SMS-OTP phone flow (which needs a
// paid SMS provider), so instead we give Supabase Auth a synthetic, internal-only "email"
// derived deterministically from the phone number (its digits + a fixed suffix that will never
// collide with a real address). The tenant never sees or types this — the app's login screen
// does the same phone -> synthetic-email conversion (see app.js) before calling
// signInWithPassword. Administrators, Viewers and Super Admins still use a real email, unchanged.
//
// We also stash a plaintext copy of the password the Super Admin chose into
// profiles.current_password, so they can look it back up later (Users page) if they forget to
// write it down — tenants have no email inbox for a normal "forgot password" flow, so this is
// the only way the Super Admin can re-tell them their password without generating a brand new
// one every time. RLS on that column only allows the Super Admin or the profile's own owner to
// read it.
//
// New tenant logins are created DEACTIVATED (is_active: false) by default — the admin already
// has everything needed to create the login ahead of time, but the tenant shouldn't start
// getting notifications until the admin is ready for them to; the Super Admin turns it on from
// the Users page (Activate) whenever that is. Administrators/Viewers/Super Admins are still created
// active, as before — an explicit `isActive` in the request can override either default.
//
// "viewer" is the read-only role: it sees its assigned properties like an Administrator but
// the database only grants it SELECT access.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PHONE_LOGIN_SUFFIX = "@tenant.belmontmanager.internal";

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

function phoneDigits(raw: string): string {
  return (raw || "").replace(/[^0-9]/g, "");
}

const ALLOWED_ROLES = ["super_admin", "administrator", "viewer", "tenant"];

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
    .from("profiles")
    .select("role, is_active")
    .eq("auth_user_id", callerData.user.id)
    .maybeSingle();
  if (profileErr) {
    console.error("create-user: could not load caller profile:", profileErr);
    return json({ error: "Could not verify your permissions." }, 500);
  }
  if (!callerProfile || callerProfile.role !== "super_admin" || !callerProfile.is_active) {
    return json({ error: "Only an active Super Admin can create new users." }, 403);
  }

  let body: {
    email?: string; password?: string; firstName?: string; lastName?: string;
    phone?: string; role?: string; tenantId?: string; isActive?: boolean;
  };
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "Invalid request body." }, 400);
  }

  const password = body.password || "";
  const firstName = (body.firstName || "").trim();
  const lastName = (body.lastName || "").trim();
  const phoneRaw = (body.phone || "").trim();
  const role = body.role || "";
  const tenantId = body.tenantId || null;

  if (!password || password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);
  if (!firstName) return json({ error: "First name is required." }, 400);
  if (!ALLOWED_ROLES.includes(role)) return json({ error: "Invalid role." }, 400);

  // Tenants start deactivated unless the caller explicitly says otherwise; other roles default
  // to active, same as before.
  const isActive = typeof body.isActive === "boolean" ? body.isActive : role !== "tenant";

  let email: string;
  let isPhoneLogin = false;
  if (role === "tenant") {
    const digits = phoneDigits(phoneRaw);
    if (digits.length < 8) return json({ error: "Enter a valid phone number (with country code) for this tenant to log in with." }, 400);
    email = digits + PHONE_LOGIN_SUFFIX;
    isPhoneLogin = true;
  } else {
    email = (body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return json({ error: "Enter a valid email." }, 400);
  }

  if (role === "tenant" && tenantId) {
    const { data: tenantRow, error: tenantErr } = await admin
      .from("tenants").select("id, auth_user_id").eq("id", tenantId).maybeSingle();
    if (tenantErr || !tenantRow) return json({ error: "That tenant record was not found." }, 400);
    if (tenantRow.auth_user_id) return json({ error: "That tenant already has a login." }, 400);
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true
  });
  if (createErr || !created?.user) {
    console.error("create-user: auth.admin.createUser failed:", createErr);
    const lower = (createErr?.message || "").toLowerCase();
    const msg = lower.includes("already")
      ? (isPhoneLogin ? "A tenant login with that phone number already exists." : "A user with that email already exists.")
      : (createErr?.message || "Could not create the user.");
    return json({ error: msg }, 400);
  }

  const newUserId = created.user.id;

  const { error: insertProfileErr } = await admin.from("profiles").insert({
    auth_user_id: newUserId, first_name: firstName, last_name: lastName,
    email, phone: phoneRaw || null, role, is_active: isActive, current_password: password
  });
  if (insertProfileErr) {
    console.error("create-user: profile insert failed, rolling back auth user:", insertProfileErr);
    await admin.auth.admin.deleteUser(newUserId);
    return json({ error: "Could not create the profile record. Nothing was created." }, 500);
  }

  if (role === "tenant" && tenantId) {
    const { error: linkErr } = await admin.from("tenants").update({ auth_user_id: newUserId }).eq("id", tenantId);
    if (linkErr) {
      console.error("create-user: could not link tenant:", linkErr);
      return json({ warning: "User created, but could not link them to that tenant record — link it manually.", userId: newUserId }, 200);
    }
  }

  return json({ userId: newUserId, email, isPhoneLogin, isActive });
});
