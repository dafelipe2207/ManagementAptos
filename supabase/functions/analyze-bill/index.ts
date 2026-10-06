import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  applyTextFallbacks, Extraction, FIELD_KEYS, inferBillType, Issue, mapAzureInvoice, mapGemini, matchProperty,
  mergeBackup, needsBackup, overallConfidence, PropertyRef, statusFrom, validateExtraction
} from "./extract.ts";

// Reads a bill photo/PDF and returns its details as clean, validated JSON.
//
//   PRIMARY  Azure AI Document Intelligence, model "prebuilt-invoice" (locale en-AU, so numeric
//            dates are read day-first). Gives a confidence score for every field.
//   BACKUP   Gemini — used ONLY when Azure isn't configured, fails, or couldn't read a required
//            field (provider, total, period, due date) reliably. Gemini fills just the gaps; every
//            field it supplies is recorded as coming from Gemini and flagged for review.
//
// Nothing is guessed: a value that isn't on the bill comes back null and is listed in `issues`.
// `status` is "needs_review" whenever there's an error/warning — the app then won't split the
// bill among tenants until the administrator has checked those points against the bill.
//
// Secrets (Supabase > Project Settings > Edge Functions > Secrets) — never sent to the browser:
//   AZURE_DI_ENDPOINT  e.g. https://<resource>.cognitiveservices.azure.com
//   AZURE_DI_KEY       Key 1 of that Document Intelligence resource
//   GEMINI_API_KEY     backup reader (already in use)
//
// Response: the original top-level fields (billType, provider, amount, dates, propertyId…) so an
// older copy of the app keeps working, plus `extraction` with the full detail.

const AZURE_ENDPOINT = (Deno.env.get("AZURE_DI_ENDPOINT") || "").replace(/\/+$/, "");
const AZURE_KEY = Deno.env.get("AZURE_DI_KEY") || "";
const AZURE_API_VERSION = "2024-11-30";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL = "gemini-3.6-flash";
const MAX_ATTEMPTS = 3;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ------------------------------------------------------------------ Azure

async function analyzeWithAzure(base64: string): Promise<Extraction> {
  const url = AZURE_ENDPOINT + "/documentintelligence/documentModels/prebuilt-invoice:analyze?api-version=" +
    AZURE_API_VERSION + "&locale=en-AU";
  let start: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    start = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": AZURE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ base64Source: base64 })
    });
    if (start.status === 429 || start.status === 503) {
      const wait = Math.min(parseInt(start.headers.get("retry-after") || "2", 10) * 1000 || 2000, 10000);
      await start.body?.cancel();
      if (attempt < MAX_ATTEMPTS) { await sleep(wait); continue; }
    }
    break;
  }
  if (!start || start.status !== 202) {
    const txt = start ? await start.text() : "";
    throw new Error("Azure returned " + (start ? start.status : "no response") + ": " + txt.slice(0, 300));
  }
  const opUrl = start.headers.get("operation-location");
  await start.body?.cancel();
  if (!opUrl) throw new Error("Azure did not return an operation to poll.");

  const deadline = Date.now() + 60000;
  let wait = 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    const res = await fetch(opUrl, { headers: { "Ocp-Apim-Subscription-Key": AZURE_KEY } });
    if (res.status === 429) { await res.body?.cancel(); wait = 2000; continue; }
    if (!res.ok) throw new Error("Azure polling failed (" + res.status + "): " + (await res.text()).slice(0, 300));
    const body = await res.json();
    if (body.status === "succeeded") return mapAzureInvoice(body.analyzeResult);
    if (body.status === "failed") throw new Error("Azure could not analyze the document: " + JSON.stringify(body.error || {}).slice(0, 300));
    const ra = parseInt(res.headers.get("retry-after") || "", 10);
    wait = isFinite(ra) ? Math.min(Math.max(ra * 1000, 500), 3000) : 1000;
  }
  throw new Error("Azure took too long to analyze the document.");
}

// ------------------------------------------------------------------ Gemini (backup)

function geminiPrompt(today: string): string {
  return `You are reading a photo or PDF of an Australian utility/service bill (electricity, gas, water, hot water, internet...).
Extract ONLY what is printed on the document. If a value is not printed, return "" (or [] for lists). NEVER estimate, calculate or invent a value.
Return STRICT JSON with exactly these keys:
{
  "vendorName": provider/company name,
  "invoiceNumber": invoice or bill number for THIS bill,
  "invoiceDate": issue date, YYYY-MM-DD,
  "dueDate": payment due date, YYYY-MM-DD,
  "periodStart": first day of the billing/usage period this bill covers, YYYY-MM-DD,
  "periodEnd": last day of that period, YYYY-MM-DD,
  "accountNumber": the customer/account number (stays the same bill after bill; NOT the invoice number),
  "serviceAddress": the supply/service address,
  "subtotal": charges before GST, number,
  "gst": GST amount, number,
  "total": total of THIS bill's new charges (NOT including any previous unpaid balance), number,
  "previousBalance": unpaid balance carried over from previous bills, number,
  "amountDue": total amount the bill asks to pay now, number,
  "serviceType": the service billed as printed (e.g. "Electricity", "Gas", "Water", "Hot water", "Internet"),
  "lineItems": [{ "description": text, "quantity": number, "unitPrice": number, "amount": number }]
}
Dates on Australian bills are day-first (05/09/2026 = 5 September 2026). Today is ${today}; if a year is missing, use the most recent plausible past date.
Amounts are plain numbers without "$" or thousands separators; credits are negative. Return ONLY the JSON object.`;
}

function geminiBackoff(status: number, attempt: number, errText: string): number {
  if (status === 429) {
    const m = errText.match(/"retryDelay"\s*:\s*"([\d.]+)s"/) || errText.match(/retry in ([\d.]+)s/i);
    return m ? Math.min(Math.max(Math.ceil(parseFloat(m[1]) * 1000) + 800, 3000), 25000) : 20000;
  }
  return attempt * 2500;
}

async function analyzeWithGemini(base64: string, mimeType: string, today: string): Promise<Extraction> {
  if (!GEMINI_API_KEY) throw new Error("The backup reader (Gemini) is not configured.");
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: geminiPrompt(today) }, { inlineData: { mimeType, data: base64 } }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json" }
  });
  let res: Response | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: requestBody });
    if (res.ok) break;
    if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS) {
      const t = await res.text();
      await sleep(geminiBackoff(res.status, attempt, t));
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const t = res ? await res.text() : "";
    throw new Error(res && res.status === 429 ? "Gemini is over its usage limit — try again in a minute." : "Gemini error (" + (res ? res.status : "no response") + "): " + t.slice(0, 200));
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no data.");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (_e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Gemini's answer could not be read.");
    parsed = JSON.parse(m[0]);
  }
  const ex = mapGemini(parsed);
  applyTextFallbacks(ex, "gemini");
  return ex;
}

// ------------------------------------------------------------------ handler

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  let body: { imageBase64?: string; mimeType?: string; properties?: PropertyRef[]; today?: string };
  try { body = await req.json(); } catch (_e) { return json({ error: "Invalid request body." }, 400); }
  const { imageBase64, mimeType } = body;
  if (!imageBase64 || !mimeType) return json({ error: "Missing document data." }, 400);
  const properties = Array.isArray(body.properties) ? body.properties : [];
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today || "") ? body.today! : new Date().toISOString().slice(0, 10);

  const azureConfigured = !!(AZURE_ENDPOINT && AZURE_KEY);
  let ex: Extraction | null = null;
  let extractor = "";
  let azureError: string | null = azureConfigured ? null : "Azure Document Intelligence is not configured on the server.";
  let geminiError: string | null = null;
  const extraIssues: Issue[] = [];

  if (azureConfigured) {
    try { ex = await analyzeWithAzure(imageBase64); extractor = "azure"; }
    catch (e) { azureError = (e as Error).message; console.error("analyze-bill: Azure failed:", azureError); }
  }

  if (!ex || needsBackup(ex)) {
    try {
      const g = await analyzeWithGemini(imageBase64, mimeType, today);
      if (ex) {
        const { merged, disagreements } = mergeBackup(ex, g);
        const filled = FIELD_KEYS.some((k) => merged.source[k] === "gemini");
        ex = merged; extractor = filled ? "azure+gemini" : "azure";
        extraIssues.push(...disagreements);
      } else {
        ex = g; extractor = "gemini";
      }
    } catch (e) {
      geminiError = (e as Error).message;
      console.error("analyze-bill: Gemini failed:", geminiError);
    }
  }

  if (!ex) {
    return json({ error: "Couldn't read this bill" + (azureError ? " — Azure: " + azureError : "") + (geminiError ? " — backup: " + geminiError : "") + ". Enter the details by hand." }, 502);
  }

  const type = inferBillType(ex);
  const prop = matchProperty(ex, properties);
  const issues = extraIssues.concat(validateExtraction(ex, today, {
    billType: type.billType, billTypeConfident: type.confident, propertyId: prop.propertyId, propertyConfidence: prop.confidence
  }));
  if (azureConfigured && azureError) issues.push({ code: "azure_failed", severity: "warning", message: "The main reader (Azure) failed, so the backup reader was used: " + azureError.slice(0, 160) });
  const F = ex.fields;

  return json({
    // Original shape (kept for older copies of the app). No value here is guessed.
    billType: type.billType,
    provider: F.vendorName || "",
    accountNumber: F.accountNumber || "",
    invoiceNumber: F.invoiceNumber || "",
    issueDate: F.invoiceDate || "",
    dueDate: F.dueDate || "",
    billingPeriodStart: F.periodStart || "",
    billingPeriodEnd: F.periodEnd || "",
    amount: F.total ?? "",
    propertyId: prop.propertyId,
    propertyMatchConfidence: prop.confidence,
    propertyGuessText: prop.guessText,
    // Full detail.
    extraction: {
      version: 1,
      extractor,
      status: statusFrom(issues),
      confidence: overallConfidence(ex),
      fields: F,
      fieldConfidence: ex.confidence,
      fieldSource: ex.source,
      lineItems: ex.lineItems,
      billType: type.billType,
      billTypeConfident: type.confident,
      propertyId: prop.propertyId,
      propertyMatchConfidence: prop.confidence,
      propertyGuessText: prop.guessText,
      issues,
      azureConfigured,
      azureError,
      geminiError
    }
  });
});
