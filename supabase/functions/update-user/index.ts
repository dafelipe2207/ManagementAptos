import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Lets a Super Admin edit another user's profile fields — name, phone, and (for an
// Administrator/Super Admin, i.e. an email-login account) their email address. Name/phone alone
// could go through a plain client-side `profiles` update (RLS already allows a Super Admin to
// update any profile), but an email change — or, for a phone-login Tenant, a PHONE change —
// also has to update `auth.users.email` (their real login credential, which for a Tenant is a
// synthetic address derived from the phone digits), and that needs the service role key, hence
// this Edge Function.

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
    return json({ error: "Only an active Super Admin can edit another user's account." }, 403);
  }

  let body: { profileId?: string; firstName?: string; lastName?: string; phone?: string; email?: string };
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "Invalid request body." }, 400);
  }
  const profileId = body.profileId || "";
  const firstName = (body.firstName || "").trim();
  const lastName = (body.lastName || "").trim();
  const phoneRaw = (body.phone || "").trim();
  if (!profileId) return json({ error: "Missing profileId." }, 400);
  if (!firstName) return json({ error: "First name is required." }, 400);

  const { data: target, error: targetErr } = await admin
    .from("profiles").select("auth_user_id, role, email").eq("id", profileId).maybeSingle();
  if (targetErr || !target) return json({ error: "That user was not found." }, 400);

  var newEmail = target.email;
  const isPhoneLogin = (target.role === "tenant") && (target.email || "").includes(PHONE_LOGIN_SUFFIX);

  if (isPhoneLogin) {
    // Para un tenant, el "email" real de login es un derivado sintético del teléfono — si el
    // Super Admin cambia el número, hay que regenerar ese login sintético también, si no queda
    // desincronizado (el teléfono mostrado cambia pero el tenant sigue entrando con el viejo).
    const digits = phoneDigits(phoneRaw);
    if (digits.length < 8) return json({ error: "Enter a valid phone number (with country code) — that's what this tenant logs in with." }, 400);
    const candidate = digits + PHONE_LOGIN_SUFFIX;
    if (candidate !== target.email) {
      const { error: authErr } = await admin.auth.admin.updateUserById(target.auth_user_id, { email: candidate, email_confirm: true });
      if (authErr) {
        console.error("update-user: could not update tenant login email:", authErr);
        const lower = (authErr.message || "").toLowerCase();
        return json({ error: lower.includes("already") ? "A tenant login with that phone number already exists." : (authErr.message || "Could not update the phone number.") }, 400);
      }
      newEmail = candidate;
    }
  } else if (body.email) {
    const candidate = body.email.trim().toLowerCase();
    if (!candidate.includes("@")) return json({ error: "Enter a valid email." }, 400);
    if (candidate !== target.email) {
      const { error: authErr } = await admin.auth.admin.updateUserById(target.auth_user_id, { email: candidate, email_confirm: true });
      if (authErr) {
        console.error("update-user: could not update auth email:", authErr);
        const lower = (authErr.message || "").toLowerCase();
        return json({ error: lower.includes("already") ? "A user with that email already exists." : (authErr.message || "Could not update the email.") }, 400);
      }
      newEmail = candidate;
    }
  }

  const { data: updated, error: updateErr } = await admin.from("profiles").update({
    first_name: firstName, last_name: lastName, phone: phoneRaw || null, email: newEmail
  }).eq("id", profileId).select().single();
  if (updateErr) {
    console.error("update-user: profile update failed:", updateErr);
    return json({ error: "Could not save the changes." }, 500);
  }

  return json({ profile: updated });
});
