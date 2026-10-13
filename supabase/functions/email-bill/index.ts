import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// PUBLIC webhook (verify_jwt: false), protected by a secret token in the URL:
//   https://<project>.supabase.co/functions/v1/email-bill?token=<INBOUND_EMAIL_TOKEN>
//
// A bill received by email — sent by the Gmail Apps Script in tools/gmail-bills.gs (emails
// labelled "Bills"), or by an inbound service (Postmark/CloudMailin JSON, SendGrid/Mailgun
// multipart) → every PDF/image attachment is:
//   1. skipped if the very same file was already received (SHA-256 of its bytes),
//   2. stored in the private `receipts` bucket (under the Super Admin's folder),
//   3. read by the existing analyze-bill function (Azure first, Gemini backup),
//   4. skipped if it's a bill already saved or already waiting for review (same invoice number,
//      or same provider + billing period for that property) — duplicates are never loaded,
//   5. queued in bill_extractions ("Pending review" in the app's Import bills screen),
// and the Super Admin gets an in-app notification. Nothing becomes a bill until it's reviewed.
//
// Secrets: INBOUND_EMAIL_TOKEN (required — any long random string).
//          INBOUND_ALLOWED_FROM (optional — comma-separated sender addresses/domains to accept).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("INBOUND_EMAIL_TOKEN") || "";
const ALLOWED_FROM = (Deno.env.get("INBOUND_ALLOWED_FROM") || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

type Attachment = { name: string; type: string; bytes: Uint8Array };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function guessType(name: string, type: string): string {
  if (type && type !== "application/octet-stream") return type.toLowerCase();
  if (/\.pdf$/i.test(name)) return "application/pdf";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.heic$/i.test(name)) return "image/heic";
  return type || "";
}
const isBillFile = (a: Attachment) => /^application\/pdf$|^image\/(png|jpe?g|webp|heic|tiff)$/.test(a.type) && a.bytes.length > 2000;
const safeName = (n: string) => (n || "bill").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-80);
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

async function readEmail(req: Request): Promise<{ from: string; subject: string; attachments: Attachment[] }> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    // Postmark inbound: { From, FromFull:{Email}, Subject, Attachments:[{Name, Content(base64), ContentType}] }
    const body = await req.json();
    if (Array.isArray(body.attachments)) {
      // Our own Gmail Apps Script ({from, subject, attachments:[{name, type, contentBase64}]}) and
      // CloudMailin JSON ({headers:{from,subject}, attachments:[{file_name, content_type, content}]}).
      return {
        from: String(body.from || body.headers?.from || body.envelope?.from || ""),
        subject: String(body.subject || body.headers?.subject || ""),
        attachments: body.attachments.map((a: Record<string, string>) => {
          const name = a.name || a.file_name || "bill";
          return { name, type: guessType(name, a.type || a.content_type || ""), bytes: b64ToBytes(a.contentBase64 || a.content || "") };
        })
      };
    }
    const atts = Array.isArray(body.Attachments) ? body.Attachments : [];
    return {
      from: (body.FromFull?.Email || body.From || "").toString(),
      subject: (body.Subject || "").toString(),
      attachments: atts.map((a: { Name?: string; Content?: string; ContentType?: string }) => ({
        name: a.Name || "bill", type: guessType(a.Name || "", a.ContentType || ""), bytes: b64ToBytes(a.Content || "")
      }))
    };
  }
  // Multipart (SendGrid Inbound Parse, Mailgun, …): every uploaded file part is an attachment.
  const form = await req.formData();
  const attachments: Attachment[] = [];
  for (const [, v] of form.entries()) {
    if (v instanceof File) attachments.push({ name: v.name, type: guessType(v.name, v.type), bytes: new Uint8Array(await v.arrayBuffer()) });
  }
  return { from: String(form.get("from") || form.get("sender") || ""), subject: String(form.get("subject") || ""), attachments };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const url = new URL(req.url);
  if (!TOKEN || url.searchParams.get("token") !== TOKEN) return json({ error: "Not allowed." }, 401);

  let mail;
  try { mail = await readEmail(req); } catch (e) { console.error("email-bill: unreadable request", e); return json({ error: "Unreadable email." }, 400); }
  const fromLc = mail.from.toLowerCase();
  if (ALLOWED_FROM.length && !ALLOWED_FROM.some((a) => fromLc.includes(a))) {
    console.warn("email-bill: sender not allowed:", mail.from);
    return json({ ok: true, skipped: "sender not allowed" }); // 200 so the provider doesn't retry
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: owners } = await admin.from("profiles").select("auth_user_id").eq("role", "super_admin").eq("is_active", true).limit(1);
  const ownerId = owners?.[0]?.auth_user_id;
  if (!ownerId) return json({ error: "No active Super Admin." }, 500);
  const { data: props } = await admin.from("properties").select("id, name, address");
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // Perth date

  const files = mail.attachments.filter(isBillFile);
  const results: Array<{ file: string; result: string }> = [];
  for (const a of files) {
    try {
      const hash = await sha256(a.bytes);
      const { data: sameFile } = await admin.from("bill_extractions").select("id").eq("extracted->>sourceHash", hash).limit(1);
      if (sameFile && sameFile.length) { results.push({ file: a.name, result: "duplicate file" }); continue; }

      const path = ownerId + "/email-" + Date.now() + "-" + safeName(a.name);
      const up = await admin.storage.from("receipts").upload(path, a.bytes, { contentType: a.type, upsert: false });
      if (up.error) throw up.error;

      const res = await fetch(SUPABASE_URL + "/functions/v1/analyze-bill", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + SERVICE_ROLE_KEY, apikey: SERVICE_ROLE_KEY },
        body: JSON.stringify({ imageBase64: bytesToB64(a.bytes), mimeType: a.type, properties: props || [], today })
      });
      const data = await res.json().catch(() => ({}));
      const x = data?.extraction;
      const f = x?.fields || {};
      const propertyId = x?.propertyId || data?.propertyId || null;

      // Already saved as a bill, or already waiting for review → don't load it again.
      if (x && propertyId) {
        const inv = norm(f.invoiceNumber), prov = norm(f.vendorName);
        const { data: existing } = await admin.from("bills")
          .select("id, provider, invoice_number, billing_period_start, billing_period_end").eq("property_id", propertyId);
        const dupBill = (existing || []).find((b) =>
          (inv && norm(b.invoice_number) === inv) ||
          (prov && norm(b.provider) === prov && f.periodStart && b.billing_period_start === f.periodStart && b.billing_period_end === f.periodEnd));
        const { data: open } = await admin.from("bill_extractions").select("id, extracted").eq("property_id", propertyId).in("status", ["needs_review", "ready"]);
        const dupOpen = (open || []).find((r) => {
          const of = r.extracted?.extraction?.fields || {};
          return (inv && norm(of.invoiceNumber) === inv) ||
            (prov && norm(of.vendorName) === prov && f.periodStart && of.periodStart === f.periodStart && of.periodEnd === f.periodEnd);
        });
        if (dupBill || dupOpen) {
          await admin.storage.from("receipts").remove([path]);
          results.push({ file: a.name, result: dupBill ? "already saved as a bill" : "already waiting for review" });
          continue;
        }
      }

      const ok = res.ok && !!x;
      const { error: insErr } = await admin.from("bill_extractions").insert({
        user_id: ownerId, property_id: propertyId, storage_path: path, file_name: a.name, mime_type: a.type,
        extractor: ok ? (x.extractor || "azure") : "failed",
        extracted: Object.assign({}, ok ? data : { error: data?.error || "Couldn't read the bill automatically." },
          { sourceHash: hash, source: "email", emailFrom: mail.from, emailSubject: mail.subject }),
        confidence: ok ? x.confidence : null,
        status: ok ? (x.status === "ready" ? "ready" : "needs_review") : "needs_review",
        issues: ok ? (x.issues || []) : [{ code: "read_failed", severity: "error", message: data?.error || "Couldn't read the bill automatically." }]
      });
      if (insErr) throw insErr;
      results.push({ file: a.name, result: ok ? "queued" : "queued (read failed — enter by hand)" });
    } catch (e) {
      console.error("email-bill: attachment failed", a.name, e);
      results.push({ file: a.name, result: "error" });
    }
  }

  const queued = results.filter((r) => r.result.startsWith("queued")).length;
  const skipped = results.filter((r) => r.result.startsWith("already") || r.result === "duplicate file").length;
  if (queued || skipped) {
    await admin.from("notifications").insert({
      auth_user_id: ownerId,
      title: queued ? "New bill by email — review it" : "Bill email skipped (duplicate)",
      body: (queued ? queued + " bill" + (queued === 1 ? "" : "s") + " from \"" + (mail.subject || mail.from).slice(0, 80) + "\" waiting in Bills → Import. " : "") +
        (skipped ? skipped + " already loaded, not added again." : ""),
      related_table: "bill_extractions", category: "bills"
    });
  }
  return json({ ok: true, attachments: files.length, results });
});
