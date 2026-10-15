import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Sends an image straight to a tenant's WhatsApp through the WhatsApp Business Cloud API (Meta),
// so the admin doesn't have to open WhatsApp and pick the chat. Staff only.
//
// Secrets (set in Supabase → Edge Functions → Secrets):
//   WA_TOKEN         permanent access token of the Meta system user
//   WA_PHONE_ID      "Phone number ID" of the sending number (WhatsApp Manager → API setup)
//   WA_TEMPLATE      name of an APPROVED template with an IMAGE header and one body variable
//                    ({{1}} = first name). Needed to message someone who hasn't written in 24 h.
//                    Without it, a plain image is sent (only works inside the 24-hour window).
//   WA_TEMPLATE_LANG template language code (default "en")
//   WA_API_VERSION   Graph API version (default "v23.0")
//
// Body: { action: "status" } → { configured } ; or { to, imageBase64, firstName, caption }.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const WA_TOKEN = Deno.env.get("WA_TOKEN") || "";
const WA_PHONE_ID = Deno.env.get("WA_PHONE_ID") || "";
const WA_TEMPLATE = Deno.env.get("WA_TEMPLATE") || "";
const WA_TEMPLATE_LANG = Deno.env.get("WA_TEMPLATE_LANG") || "en";
const WA_API_VERSION = Deno.env.get("WA_API_VERSION") || "v23.0";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

/** Australian mobiles are often stored as 04xx xxx xxx — WhatsApp needs 614xx xxx xxx. */
function normalizePhone(raw: string): string {
  let d = String(raw || "").replace(/[^0-9]/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("0")) d = "61" + d.slice(1);
  return d;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing Authorization header." }, 401);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const caller = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: u, error: uErr } = await caller.auth.getUser();
  if (uErr || !u?.user) return json({ error: "Not signed in." }, 401);
  const { data: prof } = await admin.from("profiles").select("role, is_active").eq("auth_user_id", u.user.id).maybeSingle();
  const isStaff = !!prof && prof.is_active && (prof.role === "super_admin" || prof.role === "administrator");
  if (!isStaff) return json({ error: "Only administrators can send WhatsApp messages." }, 403);

  let body: { action?: string; to?: string; imageBase64?: string; firstName?: string; caption?: string };
  try { body = await req.json(); } catch (_e) { return json({ error: "Invalid request body." }, 400); }

  const configured = !!(WA_TOKEN && WA_PHONE_ID);
  if (body.action === "status") return json({ configured, template: !!WA_TEMPLATE });
  if (!configured) return json({ error: "WhatsApp sending isn't set up yet (WA_TOKEN / WA_PHONE_ID).", notConfigured: true }, 400);

  const to = normalizePhone(body.to || "");
  if (to.length < 10) return json({ error: "The tenant's phone number isn't valid for WhatsApp." }, 400);
  if (!body.imageBase64) return json({ error: "Missing image." }, 400);

  const graph = `https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}`;
  const auth = { Authorization: `Bearer ${WA_TOKEN}` };

  // 1) Upload the image to WhatsApp's media store.
  const bytes = Uint8Array.from(atob(body.imageBase64), (c) => c.charCodeAt(0));
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "image/png");
  form.append("file", new Blob([bytes], { type: "image/png" }), "statement.png");
  const up = await fetch(`${graph}/media`, { method: "POST", headers: auth, body: form });
  const upJson = await up.json().catch(() => ({}));
  if (!up.ok || !upJson.id) {
    console.error("whatsapp-send: media upload failed", upJson);
    return json({ error: "WhatsApp didn't accept the image. " + (upJson?.error?.message || "") }, 502);
  }

  // 2) Send it — as the approved template (works any time) or as a plain image (24-hour window).
  const msg = WA_TEMPLATE
    ? { messaging_product: "whatsapp", to, type: "template", template: { name: WA_TEMPLATE, language: { code: WA_TEMPLATE_LANG }, components: [
        { type: "header", parameters: [{ type: "image", image: { id: upJson.id } }] },
        { type: "body", parameters: [{ type: "text", text: (body.firstName || "there").slice(0, 60) }] }
      ] } }
    : { messaging_product: "whatsapp", to, type: "image", image: { id: upJson.id, caption: (body.caption || "").slice(0, 1000) } };
  const send = await fetch(`${graph}/messages`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(msg) });
  const sendJson = await send.json().catch(() => ({}));
  if (!send.ok) {
    console.error("whatsapp-send: send failed", sendJson);
    const code = sendJson?.error?.code;
    const hint = code === 131047 ? " The tenant hasn't written in the last 24 hours — an approved template (WA_TEMPLATE) is needed." : "";
    return json({ error: "WhatsApp couldn't send it. " + (sendJson?.error?.message || "") + hint }, 502);
  }
  return json({ ok: true, messageId: sendJson?.messages?.[0]?.id || null, to });
});
