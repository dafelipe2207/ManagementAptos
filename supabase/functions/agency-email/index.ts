import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { AiResult, Ctx, decide, InMsg, isAgencySender, keyOf, perthToday } from "./logic.ts";
import { buildPrompt, RESPONSE_SCHEMA } from "./prompt.ts";

// PUBLIC webhook (verify_jwt: false), protected by a secret token in the URL:
//   https://<project>.supabase.co/functions/v1/agency-email?token=<AGENCY_EMAIL_TOKEN>
//
// Agency emails sent hourly by the Gmail Apps Script tools/gmail-agency-emails.gs. For each message:
//   1. skipped if already processed (dedup_key 'agency-email:<gmail id>' in notifications or
//      agency_email_updates — the same key the old scheduled Claude task used),
//   2. read by Gemini (summary in Spanish, kind, deadline, continuation, invoice, link),
//   3. checked in code (logic.ts) against the database — no id from Gemini is used unchecked,
//   4. written: an Update under the original case, or a new case + one notification per admin.
// Inserts only. One agency_email_checks row (source 'app') per script run.
//
// Secrets: AGENCY_EMAIL_TOKEN (required), GEMINI_API_KEY (existing).
// Optional WhatsApp alert for urgent items: WA_ALERT_TEMPLATE (approved TEXT template with one body
//   variable {{1}}), WA_ALERT_TO (comma-separated numbers, international format), WA_ALERT_LANG
//   (default "es"), plus the existing WA_TOKEN, WA_PHONE_ID, WA_API_VERSION.
//
// Body: { runId?: string, final?: boolean, messages: InMsg[] }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TOKEN = Deno.env.get("AGENCY_EMAIL_TOKEN") || "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_MODEL = "gemini-3.6-flash";
const WA_TOKEN = Deno.env.get("WA_TOKEN") || "";
const WA_PHONE_ID = Deno.env.get("WA_PHONE_ID") || "";
const WA_API_VERSION = Deno.env.get("WA_API_VERSION") || "v23.0";
const WA_ALERT_TEMPLATE = Deno.env.get("WA_ALERT_TEMPLATE") || "";
const WA_ALERT_TO = (Deno.env.get("WA_ALERT_TO") || "").split(",").map((s) => s.replace(/[^\d]/g, "")).filter(Boolean);
const WA_ALERT_LANG = Deno.env.get("WA_ALERT_LANG") || "es";
const BUDGET_MS = 120000;
const DAY = 86400000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ context

async function loadCtx(db: SupabaseClient, superAuthId: string | null): Promise<Ctx> {
  const since60 = new Date(Date.now() - 60 * DAY).toISOString();
  const since120 = new Date(Date.now() - 120 * DAY).toISOString();
  const today = perthToday(new Date());
  const shift = (n: number) => new Date(Date.parse(today) + n * DAY).toISOString().slice(0, 10);

  const [props, notifs, cases, updates, maint, insp, bills] = await Promise.all([
    db.from("properties").select("id,name"),
    db.from("notifications").select("dedup_key,title,body,archived_at,property_id,created_at,auth_user_id")
      .eq("related_table", "agency_email").like("dedup_key", "agency-email:%").gte("created_at", since60),
    db.from("agency_email_cases").select("dedup_key,kind,property_id,invoice_number,created_at").gte("created_at", since60),
    db.from("agency_email_updates").select("dedup_key,case_dedup_key,summary,received_at").gte("created_at", since60),
    db.from("maintenance_requests").select("id,property_id,title,category,status,created_at").gte("created_at", since120),
    db.from("real_estate_inspections").select("id,property_id,inspection_date").gte("inspection_date", shift(-21)).lte("inspection_date", shift(21)),
    db.from("bills").select("id,property_id,provider,invoice_number,amount,due_date,admin_paid").gte("created_at", since120),
  ]);
  for (const r of [props, notifs, cases, updates, maint, insp, bills]) if (r.error) throw new Error("context: " + r.error.message);

  // One notification per case: prefer the Super Admin's copy (its archived state is the one shown).
  const byKey = new Map<string, Record<string, unknown>>();
  for (const n of notifs.data!) {
    const prev = byKey.get(n.dedup_key);
    if (!prev || n.auth_user_id === superAuthId) byKey.set(n.dedup_key, n);
  }
  return {
    properties: props.data!.map((p) => ({ id: p.id, name: p.name })),
    cases: cases.data!.filter((c) => byKey.has(c.dedup_key)).map((c) => {
      const n = byKey.get(c.dedup_key)!;
      return {
        dedupKey: c.dedup_key, propertyId: c.property_id ?? (n.property_id as string | null), kind: c.kind,
        title: String(n.title ?? ""), body: String(n.body ?? ""), createdAt: String(n.created_at ?? c.created_at),
        invoiceNumber: c.invoice_number, archived: !!n.archived_at,
      };
    }),
    updates: updates.data!.map((u) => ({ dedupKey: u.dedup_key, caseKey: u.case_dedup_key, summary: u.summary, receivedAt: u.received_at })),
    maintenance: maint.data!.map((m) => ({ id: m.id, propertyId: m.property_id, title: m.title ?? "", category: m.category, status: m.status, createdAt: m.created_at })),
    inspections: insp.data!.map((i) => ({ id: i.id, propertyId: i.property_id, date: i.inspection_date })),
    bills: bills.data!.map((b) => ({
      id: b.id, propertyId: b.property_id, provider: b.provider, invoiceNumber: b.invoice_number,
      amount: b.amount == null ? null : Number(b.amount), dueDate: b.due_date, adminPaid: !!b.admin_paid,
    })),
  };
}

async function alreadyProcessed(db: SupabaseClient, key: string): Promise<boolean> {
  const [n, u] = await Promise.all([
    db.from("notifications").select("id", { count: "exact", head: true }).eq("dedup_key", key),
    db.from("agency_email_updates").select("dedup_key", { count: "exact", head: true }).eq("dedup_key", key),
  ]);
  if (n.error || u.error) throw new Error("dedup: " + (n.error || u.error)!.message);
  return (n.count ?? 0) > 0 || (u.count ?? 0) > 0;
}

// ------------------------------------------------------------------ Gemini

async function readWithGemini(prompt: string, deadline: number): Promise<AiResult> {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
  });
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt === 1 ? 2000 : 5000);
    const left = deadline - Date.now();
    if (left < 8000) break;
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(Math.min(45000, left - 3000)) });
      if (!res.ok) { lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`; continue; }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
      const parsed = JSON.parse(text);
      if (typeof parsed?.relevant !== "boolean") { lastErr = "invalid JSON shape"; continue; }
      return parsed as AiResult;
    } catch (e) {
      lastErr = String((e as Error)?.message || e);
    }
  }
  throw new Error("gemini: " + (lastErr || "out of time"));
}

// ------------------------------------------------------------------ writes

async function recipients(db: SupabaseClient, propertyId: string): Promise<string[]> {
  const [sup, adm] = await Promise.all([
    db.from("profiles").select("auth_user_id").eq("role", "super_admin").eq("is_active", true).not("auth_user_id", "is", null),
    db.from("property_administrators").select("profiles!inner(auth_user_id,role,is_active)").eq("property_id", propertyId),
  ]);
  if (sup.error || adm.error) throw new Error("recipients: " + (sup.error || adm.error)!.message);
  const ids = new Set<string>(sup.data!.map((p) => p.auth_user_id as string));
  for (const row of adm.data! as unknown as { profiles: { auth_user_id: string | null; role: string; is_active: boolean } }[]) {
    const p = row.profiles;
    if (p && p.role === "administrator" && p.is_active && p.auth_user_id) ids.add(p.auth_user_id);
  }
  return [...ids];
}

async function sendWhatsApp(text: string): Promise<void> {
  if (!WA_ALERT_TEMPLATE || !WA_TOKEN || !WA_PHONE_ID || !WA_ALERT_TO.length) return;
  for (const to of WA_ALERT_TO) {
    try {
      const res = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", to, type: "template",
          template: { name: WA_ALERT_TEMPLATE, language: { code: WA_ALERT_LANG }, components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 900) }] }] },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) console.error("whatsapp", res.status, (await res.text()).slice(0, 300));
    } catch (e) { console.error("whatsapp", e); }
  }
}

// ------------------------------------------------------------------ handler

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const url = new URL(req.url);
  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  // Token: the AGENCY_EMAIL_TOKEN secret, or the 'webhook_token' row of the private
  // agency_email_settings table (service role only) — either one is accepted.
  const given = url.searchParams.get("token") || req.headers.get("x-agency-token") || "";
  let authorized = !!TOKEN && safeEqual(given, TOKEN);
  if (!authorized && given) {
    const { data } = await db.from("agency_email_settings").select("value").eq("key", "webhook_token").maybeSingle();
    authorized = !!data?.value && safeEqual(given, String(data.value));
  }
  if (!authorized) return json({ error: "unauthorized" }, 401);
  let payload: { runId?: string; final?: boolean; messages?: InMsg[] };
  try { payload = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (!messages) return json({ error: "messages[] required" }, 400);

  const started = Date.now();
  const deadline = started + BUDGET_MS;
  const today = perthToday(new Date());
  const counts = { found: 0, notified: 0, updates: 0, errors: 0 };
  const results: Record<string, unknown>[] = [];

  try {
    const sup = await db.from("profiles").select("auth_user_id").eq("role", "super_admin").eq("is_active", true)
      .not("auth_user_id", "is", null).limit(1).maybeSingle();
    const superAuthId = (sup.data?.auth_user_id as string) ?? null;
    let ctx: Ctx | null = null;

    for (const m of messages.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      if (!m?.messageId || typeof m.messageId !== "string") continue;
      const key = keyOf(m.messageId);
      if (!isAgencySender(m.from, m.subject)) { results.push({ key, result: "skipped: sender" }); continue; }
      if (await alreadyProcessed(db, key)) { counts.found++; results.push({ key, result: "already processed" }); continue; }
      if (Date.now() > deadline - 10000) { results.push({ key, result: "deferred: time" }); continue; }

      try {
        ctx ??= await loadCtx(db, superAuthId);
        const ai = await readWithGemini(buildPrompt(m, ctx, today), deadline);
        const d = decide(ai, m, ctx, today);

        if (d.type === "ignore") { results.push({ key, result: "ignored", reason: d.reason }); continue; }
        counts.found++;

        if (d.type === "update") {
          const { error } = await db.from("agency_email_updates").upsert({
            dedup_key: key, case_dedup_key: d.caseKey, received_at: m.date || null, summary: d.summary, action: d.action, url: m.url || null,
          }, { onConflict: "dedup_key", ignoreDuplicates: true });
          if (error) throw new Error("insert update: " + error.message);
          counts.updates++;
          ctx.updates.push({ dedupKey: key, caseKey: d.caseKey, summary: d.summary, receivedAt: m.date });
          results.push({ key, result: "update", caseKey: d.caseKey });
          if (d.urgent) await sendWhatsApp(`${d.title}: ${d.summary}`);
          continue;
        }

        const users = await recipients(db, d.propertyId);
        if (!users.length) throw new Error("no recipients");
        const { error: nErr } = await db.from("notifications").upsert(users.map((auth_user_id) => ({
          auth_user_id, title: d.title, body: d.body, category: d.category, property_id: d.propertyId,
          related_table: "agency_email", is_read: false, dedup_key: key,
        })), { onConflict: "auth_user_id,dedup_key", ignoreDuplicates: true });
        if (nErr) throw new Error("insert notifications: " + nErr.message);
        const { error: cErr } = await db.from("agency_email_cases").upsert({
          dedup_key: key, kind: d.kind, property_id: d.propertyId, invoice_number: d.invoiceNumber, amount: d.amount,
          due_date: d.dueDate, bill_id: d.billId, invoice_doc: d.invoiceDoc, linked_table: d.linkedTable,
          linked_id: d.linkedId, linked_auto: !!d.linkedId,
        }, { onConflict: "dedup_key", ignoreDuplicates: true });
        if (cErr) throw new Error("insert case: " + cErr.message);
        counts.notified++;
        ctx.cases.push({
          dedupKey: key, propertyId: d.propertyId, kind: d.kind, title: d.title, body: d.body,
          createdAt: new Date().toISOString(), invoiceNumber: d.invoiceNumber, archived: false,
        });
        results.push({ key, result: "case", title: d.title });
        if (d.urgent) await sendWhatsApp(`${d.title}: ${d.body.split("\n")[0]}`);
      } catch (e) {
        counts.errors++;
        const msg = String((e as Error)?.message || e);
        console.error(key, msg);
        results.push({ key, result: "error", error: msg });
        // Stuck for over a day → tell the Super Admin once, so nothing is silently lost.
        if (superAuthId && m.date && Date.now() - Date.parse(m.date) > DAY) {
          await db.from("notifications").upsert({
            auth_user_id: superAuthId, title: "⚠️ Correos · No se pudo procesar un correo",
            body: `La app no pudo leer el correo "${String(m.subject || "").slice(0, 150)}" (${m.from}). Revísalo en Gmail:\n${m.url || ""}`,
            category: "important_notice", related_table: "agency_email", is_read: false, dedup_key: "agency-email-error:" + m.messageId,
          }, { onConflict: "auth_user_id,dedup_key", ignoreDuplicates: true });
        }
      }
    }

    // One agency_email_checks row per script run.
    let totals = counts;
    if (payload.runId) {
      const { data, error } = await db.rpc("agency_email_run_add", {
        p_run_id: String(payload.runId).slice(0, 100), p_found: counts.found, p_notified: counts.notified, p_updates: counts.updates, p_errors: counts.errors,
      });
      if (error) throw new Error("run counters: " + error.message);
      const r = (Array.isArray(data) ? data[0] : data) as { emails_found: number; notified: number; updates: number; errors: number };
      totals = { found: r.emails_found, notified: r.notified, updates: r.updates, errors: r.errors };
    }
    if (!payload.runId || payload.final) {
      const { error } = await db.from("agency_email_checks").insert({
        emails_found: totals.found, notified: totals.notified, updates: totals.updates, errors: totals.errors, source: "app",
      });
      if (error) throw new Error("checks: " + error.message);
    }
    return json({ ok: true, ...counts, totals, results, ms: Date.now() - started });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error)?.message || e), ...counts, results }, 500);
  }
});
