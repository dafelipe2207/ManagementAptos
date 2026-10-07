import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// PUBLIC endpoint (verify_jwt: false) — this is the one password-reset path that must work for
// someone who is completely locked out and has no session at all, including the Super Admin, so
// it can't require being signed in the way reset-password does.
//
// Unlike the standard Supabase "reset your password" email (a link to a redirect page — see
// profileService.sendPasswordReset's old flow), this generates a random temporary password,
// sets it as the account's real password right away via the Admin API, and emails that password
// directly via Resend. The user can sign in immediately with it, then change it from Settings.
//
// Tenants log in with a synthetic phone-based email (see create-user) with no real inbox behind
// it, so this only actually reaches Administrators/the Super Admin, who have real email
// addresses. A tenant who forgets their password still needs an Administrator/Super Admin to
// reset it for them from the Users page (forceSetPassword -> reset-password Edge Function),
// exactly as before — this function silently no-ops for an email that doesn't match an active
// non-tenant account, same as it does for an email that matches nothing at all.
//
// Requires the RESEND_API_KEY secret (set via the Supabase dashboard: Edge Functions -> Secrets,
// or `supabase secrets set RESEND_API_KEY=...`). Optionally FORGOT_PASSWORD_FROM to override the
// sender address once a verified domain is set up in Resend (defaults to the shared Resend
// sandbox sender, which can only deliver to the email the Resend account itself was created
// with).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const MAIL_FROM = Deno.env.get("FORGOT_PASSWORD_FROM") || "onboarding@resend.dev";

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

// 10 characters from an unambiguous alphabet (no 0/O/1/l/I), with at least one digit and one
// symbol guaranteed so it always clears typical "must contain a number/symbol" password rules.
function generateTempPassword(): string {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%*?";
  const all = letters + digits + symbols;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let pw = "";
  for (let i = 0; i < 8; i++) pw += all[bytes[i] % all.length];
  const extra = new Uint8Array(2);
  crypto.getRandomValues(extra);
  pw += digits[extra[0] % digits.length];
  pw += symbols[extra[1] % symbols.length];
  return pw;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: { email?: string };
  try {
    body = await req.json();
  } catch (_e) {
    return json({ error: "Invalid request body." }, 400);
  }
  const email = (body.email || "").trim().toLowerCase();

  // Always the same generic response whether or not the email matches an account, whether the
  // send succeeds, or whether anything internally fails — never reveal which emails exist, and
  // never let a delivery failure become a way to enumerate accounts either.
  const GENERIC_OK = { ok: true, message: "If there's an account with that email, a temporary password has been sent to it." };
  if (!email || !email.includes("@")) return json(GENERIC_OK);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // .limit(1) instead of .maybeSingle(): email has no DB-level uniqueness constraint on
  // profiles, and a stray duplicate should still let ONE of them get a working temp password
  // rather than making the whole request error out.
  const { data: profileRows, error: profileErr } = await admin
    .from("profiles")
    .select("id, auth_user_id, first_name, role, is_active")
    .eq("email", email)
    .limit(1);
  if (profileErr) {
    console.error("forgot-password: profile lookup failed:", profileErr);
    return json(GENERIC_OK);
  }
  const profile = profileRows && profileRows[0];
  // No account, a deactivated account, or (shouldn't reach here via a real email, but just in
  // case) a tenant's synthetic address — all silently no-op the same way.
  if (!profile || !profile.is_active || profile.role === "tenant") return json(GENERIC_OK);

  const tempPassword = generateTempPassword();
  const { error: updateErr } = await admin.auth.admin.updateUserById(profile.auth_user_id, { password: tempPassword });
  if (updateErr) {
    console.error("forgot-password: updateUserById failed:", updateErr);
    return json(GENERIC_OK);
  }

  const { error: savePwErr } = await admin.from("profiles").update({ current_password: tempPassword }).eq("id", profile.id);
  if (savePwErr) {
    // Password is already changed and usable — just log this, don't fail the request.
    console.error("forgot-password: could not save current_password copy:", savePwErr);
  }

  if (!RESEND_API_KEY) {
    console.error("forgot-password: RESEND_API_KEY is not configured — the password WAS reset, but no email could be sent.");
    return json(GENERIC_OK);
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: "Your temporary password — ManagementAptos",
        html:
          "<p>Hi" + (profile.first_name ? " " + profile.first_name : "") + ",</p>" +
          "<p>Here is a temporary password so you can sign back in:</p>" +
          "<p style=\"font-size:22px;font-weight:700;letter-spacing:1px;font-family:monospace;\">" + tempPassword + "</p>" +
          "<p>Sign in with this password, then change it from <strong>Settings</strong> once you're in.</p>" +
          "<p style=\"color:#666;font-size:13px;\">If you didn't request this, please contact your administrator — someone else may have entered your email by mistake.</p>"
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error("forgot-password: Resend send failed:", resp.status, errText);
    }
  } catch (sendErr) {
    console.error("forgot-password: Resend request threw:", sendErr);
  }

  return json(GENERIC_OK);
});
