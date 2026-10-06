// Pure extraction helpers for the analyze-bill Edge Function — no network, no Deno APIs, so they
// can be unit-tested on their own. index.ts does the HTTP calls (Azure, Gemini) and uses these to:
//   1. map Azure AI Document Intelligence "prebuilt-invoice" output to our clean bill JSON,
//   2. map the Gemini backup reader's JSON to the same shape,
//   3. merge them (Gemini only fills what Azure couldn't read reliably),
//   4. infer the service type and match the property,
//   5. validate everything and decide "ready" vs "needs_review".
// Nothing here ever invents a value: a field that isn't printed on the bill stays null and is
// reported as an issue for the administrator to fill in.

export type Source = "azure" | "gemini";
export type Severity = "error" | "warning" | "info";

export interface LineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  date: string | null;
}

export interface BillFields {
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;     // YYYY-MM-DD
  dueDate: string | null;         // YYYY-MM-DD
  periodStart: string | null;     // YYYY-MM-DD
  periodEnd: string | null;       // YYYY-MM-DD
  accountNumber: string | null;
  serviceAddress: string | null;
  subtotal: number | null;
  gst: number | null;
  total: number | null;           // total of THIS bill's new charges
  previousBalance: number | null; // unpaid balance carried over from earlier bills
  amountDue: number | null;       // what the provider asks to pay now (may include previousBalance)
}

export const FIELD_KEYS: (keyof BillFields)[] = [
  "vendorName", "invoiceNumber", "invoiceDate", "dueDate", "periodStart", "periodEnd", "accountNumber",
  "serviceAddress", "subtotal", "gst", "total", "previousBalance", "amountDue"
];

/** Fields that decide what tenants pay — low confidence on any of these needs a human check. */
export const KEY_FIELDS: (keyof BillFields)[] = ["vendorName", "invoiceDate", "dueDate", "periodStart", "periodEnd", "total"];

export interface Extraction {
  fields: BillFields;
  confidence: Partial<Record<keyof BillFields, number | null>>;
  source: Partial<Record<keyof BillFields, Source>>;
  lineItems: LineItem[];
  content: string; // full text of the document (used for type/property/regex fallbacks)
}

export interface Issue { code: string; severity: Severity; field?: string; message: string; }

export interface PropertyRef { id: string; name: string; address?: string }

export function emptyFields(): BillFields {
  return {
    vendorName: null, invoiceNumber: null, invoiceDate: null, dueDate: null, periodStart: null, periodEnd: null,
    accountNumber: null, serviceAddress: null, subtotal: null, gst: null, total: null, previousBalance: null, amountDue: null
  };
}

// ---------------------------------------------------------------- small parsers

export function round2(n: number): number { return Math.round(n * 100) / 100; }

export function cleanText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s : null;
}

/** Plain number out of "$1,234.50", "1234.5", "(12.30)" (credit), "12.30 CR". Null if not a number. */
export function parseMoney(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? round2(v) : null;
  let s = String(v).trim();
  const negative = /^\(.*\)$/.test(s) || /\bCR\b/i.test(s) || /^-/.test(s);
  s = s.replace(/[^0-9.]/g, "");
  if (!s || !/\d/.test(s)) return null;
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return round2(negative ? -n : n);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12
};

function pad(n: number): string { return n < 10 ? "0" + n : String(n); }
function validYmd(y: number, m: number, d: number): string | null {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // e.g. 31 Feb
  return y + "-" + pad(m) + "-" + pad(d);
}

/** Normalises a date to YYYY-MM-DD. Numeric dates are read DAY-FIRST (Australian bills):
 *  "05/09/2026" is 5 September. Returns null rather than guessing when it can't be read. */
export function parseDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return validYmd(y, +m[2], +m[1]); }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})$/);
  if (m) { const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith("sept") ? 4 : 3)]; let y = +m[3]; if (y < 100) y += 2000; return mo ? validYmd(y, mo, +m[1]) : null; }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) { const mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; return mo ? validYmd(+m[3], mo, +m[2]) : null; }
  return null;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

// ---------------------------------------------------------------- Azure mapping

// deno-lint-ignore no-explicit-any
type AnyObj = any;

function azMoney(f: AnyObj): number | null {
  if (!f) return null;
  if (f.valueCurrency && typeof f.valueCurrency.amount === "number") return round2(f.valueCurrency.amount);
  if (typeof f.valueNumber === "number") return round2(f.valueNumber);
  return parseMoney(f.content);
}
function azDate(f: AnyObj): string | null {
  if (!f) return null;
  return parseDate(f.valueDate) || parseDate(f.content);
}
function azString(f: AnyObj): string | null {
  if (!f) return null;
  return cleanText(f.valueString ?? f.content);
}
function azAddress(f: AnyObj): string | null {
  if (!f) return null;
  return cleanText(f.content) || (f.valueAddress ? cleanText([f.valueAddress.unit, f.valueAddress.streetAddress || [f.valueAddress.houseNumber, f.valueAddress.road].filter(Boolean).join(" "), f.valueAddress.city, f.valueAddress.state, f.valueAddress.postalCode].filter(Boolean).join(" ")) : null);
}
function azNum(f: AnyObj): number | null {
  if (!f) return null;
  if (typeof f.valueNumber === "number") return f.valueNumber;
  if (f.valueCurrency && typeof f.valueCurrency.amount === "number") return f.valueCurrency.amount;
  return parseMoney(f.content);
}
function conf(f: AnyObj): number | null {
  return f && typeof f.confidence === "number" ? Math.round(f.confidence * 1000) / 1000 : null;
}

/** Maps an Azure Document Intelligence prebuilt-invoice analyzeResult to our Extraction. */
export function mapAzureInvoice(analyzeResult: AnyObj): Extraction {
  const doc = analyzeResult?.documents?.[0];
  const f: AnyObj = doc?.fields || {};
  const content: string = analyzeResult?.content || "";
  const fields = emptyFields();
  const confidence: Extraction["confidence"] = {};
  const source: Extraction["source"] = {};
  const set = (key: keyof BillFields, value: string | number | null, azField: AnyObj) => {
    if (value == null || value === "") return;
    (fields as AnyObj)[key] = value;
    confidence[key] = conf(azField);
    source[key] = "azure";
  };
  set("vendorName", azString(f.VendorName), f.VendorName);
  set("invoiceNumber", azString(f.InvoiceId), f.InvoiceId);
  set("invoiceDate", azDate(f.InvoiceDate), f.InvoiceDate);
  set("dueDate", azDate(f.DueDate), f.DueDate);
  set("periodStart", azDate(f.ServiceStartDate), f.ServiceStartDate);
  set("periodEnd", azDate(f.ServiceEndDate), f.ServiceEndDate);
  set("accountNumber", azString(f.CustomerId), f.CustomerId);
  set("serviceAddress", azAddress(f.ServiceAddress) || azAddress(f.CustomerAddress) || azAddress(f.BillingAddress),
    f.ServiceAddress || f.CustomerAddress || f.BillingAddress);
  set("subtotal", azMoney(f.SubTotal), f.SubTotal);
  set("gst", azMoney(f.TotalTax), f.TotalTax);
  set("total", azMoney(f.InvoiceTotal), f.InvoiceTotal);
  set("previousBalance", azMoney(f.PreviousUnpaidBalance), f.PreviousUnpaidBalance);
  set("amountDue", azMoney(f.AmountDue), f.AmountDue);

  const items: LineItem[] = [];
  const arr = f.Items?.valueArray || [];
  for (const it of arr) {
    const o = it?.valueObject || {};
    const description = azString(o.Description) || azString(o.ProductCode) || "";
    const amount = azMoney(o.Amount);
    if (!description && amount == null) continue;
    items.push({ description, quantity: azNum(o.Quantity), unitPrice: azMoney(o.UnitPrice), amount, date: azDate(o.Date) });
  }

  const ex: Extraction = { fields, confidence, source, lineItems: items, content };
  applyTextFallbacks(ex, "azure");
  return ex;
}

/** Fills a few fields Azure's invoice model often leaves empty on Australian utility bills —
 *  account number, the billing period ("25 June 2026 to 31 July 2026") and the total of new
 *  charges — straight from the printed text. Marked with a lower confidence (0.6) so they are
 *  always flagged for a human check. */
export function applyTextFallbacks(ex: Extraction, src: Source) {
  const text = ex.content || "";
  if (!text) return;
  const F = ex.fields;
  if (!F.accountNumber) {
    const m = text.match(/(?:account|customer)\s*(?:no\.?|number|num|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9 \-]{4,22}[0-9])/i);
    if (m) { F.accountNumber = m[1].replace(/\s+/g, " ").trim(); ex.confidence.accountNumber = 0.6; ex.source.accountNumber = src; }
  }
  if (!F.periodStart || !F.periodEnd) {
    const ranges = findDateRanges(text);
    if (ranges.length) {
      const start = ranges.map((r) => r[0]).sort()[0];
      const end = ranges.map((r) => r[1]).sort().slice(-1)[0];
      if (!F.periodStart) { F.periodStart = start; ex.confidence.periodStart = 0.6; ex.source.periodStart = src; }
      if (!F.periodEnd) { F.periodEnd = end; ex.confidence.periodEnd = 0.6; ex.source.periodEnd = src; }
    }
  }
  if (F.total == null) {
    const m = text.match(/total\s+(?:new\s+)?charges[^0-9$\-]{0,30}\$?\s*([0-9,]+\.\d{2})/i);
    if (m) { F.total = parseMoney(m[1]); ex.confidence.total = 0.6; ex.source.total = src; }
  }
}

/** "25 June 2026 to 31 July 2026", "01/08/2026 - 24/08/2026", "1 Aug 26 – 24 Aug 26". */
export function findDateRanges(text: string): [string, string][] {
  const D = "(\\d{1,2}(?:st|nd|rd|th)?\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{2,4}|\\d{1,2}[\\/.\\-]\\d{1,2}[\\/.\\-]\\d{2,4})";
  const re = new RegExp(D + "\\s*(?:to|until|-|–|—)\\s*" + D, "gi");
  const out: [string, string][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const a = parseDate(m[1]), b = parseDate(m[2]);
    if (a && b && b >= a && daysBetween(a, b) <= 200) out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------- Gemini mapping

/** Maps the Gemini backup reader's JSON (see GEMINI_PROMPT in index.ts) to an Extraction.
 *  Gemini gives no per-field confidence, so every value it supplies is flagged for review. */
export function mapGemini(g: AnyObj): Extraction {
  const fields = emptyFields();
  const source: Extraction["source"] = {};
  const confidence: Extraction["confidence"] = {};
  const put = (key: keyof BillFields, value: string | number | null) => {
    if (value == null || value === "") return;
    (fields as AnyObj)[key] = value; source[key] = "gemini"; confidence[key] = null;
  };
  put("vendorName", cleanText(g?.vendorName ?? g?.provider));
  put("invoiceNumber", cleanText(g?.invoiceNumber));
  put("invoiceDate", parseDate(g?.invoiceDate ?? g?.issueDate));
  put("dueDate", parseDate(g?.dueDate));
  put("periodStart", parseDate(g?.periodStart ?? g?.billingPeriodStart));
  put("periodEnd", parseDate(g?.periodEnd ?? g?.billingPeriodEnd));
  put("accountNumber", cleanText(g?.accountNumber));
  put("serviceAddress", cleanText(g?.serviceAddress));
  put("subtotal", parseMoney(g?.subtotal));
  put("gst", parseMoney(g?.gst));
  put("total", parseMoney(g?.total ?? g?.amount));
  put("previousBalance", parseMoney(g?.previousBalance));
  put("amountDue", parseMoney(g?.amountDue));
  const lineItems: LineItem[] = Array.isArray(g?.lineItems) ? g.lineItems.map((it: AnyObj) => ({
    description: cleanText(it?.description) || "",
    quantity: typeof it?.quantity === "number" ? it.quantity : parseMoney(it?.quantity),
    unitPrice: parseMoney(it?.unitPrice),
    amount: parseMoney(it?.amount),
    date: parseDate(it?.date)
  })).filter((it: LineItem) => it.description || it.amount != null) : [];
  // The printed service type ("Hot water", "Electricity"…) and address feed the type/property
  // detection, which otherwise works from the full document text Azure provides.
  const content = [cleanText(g?.serviceType), cleanText(g?.serviceAddress), cleanText(g?.rawText)].filter(Boolean).join(" \n ");
  return { fields, confidence, source, lineItems, content };
}

// ---------------------------------------------------------------- merge

/** Does Azure's result need the backup reader? True when a required field is missing or a key
 *  field was read with very low confidence. */
export function needsBackup(ex: Extraction): boolean {
  const F = ex.fields;
  if (!F.vendorName || F.total == null) return true;
  if (!F.invoiceDate && !(F.periodStart && F.periodEnd)) return true;
  if (!F.periodStart || !F.periodEnd || !F.dueDate) return true;
  return KEY_FIELDS.some((k) => {
    const c = ex.confidence[k];
    return typeof c === "number" && c < 0.6;
  });
}

/** Gemini only fills fields Azure left empty. Where Azure read a value with low confidence and
 *  Gemini read a DIFFERENT one, Azure's value is kept but the disagreement is reported. */
export function mergeBackup(primary: Extraction, backup: Extraction): { merged: Extraction; disagreements: Issue[] } {
  const merged: Extraction = {
    fields: { ...primary.fields }, confidence: { ...primary.confidence }, source: { ...primary.source },
    lineItems: primary.lineItems.length ? primary.lineItems : backup.lineItems,
    content: primary.content || backup.content
  };
  const disagreements: Issue[] = [];
  for (const k of FIELD_KEYS) {
    const a = primary.fields[k], b = backup.fields[k];
    if (b == null || b === "") continue;
    if (a == null || a === "") {
      (merged.fields as AnyObj)[k] = b; merged.source[k] = "gemini"; merged.confidence[k] = null;
      continue;
    }
    const c = primary.confidence[k];
    const differs = typeof a === "number" ? Math.abs(a - (b as number)) > 0.009 : String(a).toLowerCase() !== String(b).toLowerCase();
    if (differs && typeof c === "number" && c < 0.8 && KEY_FIELDS.indexOf(k) >= 0) {
      disagreements.push({ code: "readers_disagree", severity: "warning", field: k,
        message: LABELS[k] + ": the two readers disagree (" + fmt(a) + " vs " + fmt(b as string | number) + "). Check it on the bill." });
    }
  }
  return { merged, disagreements };
}

// ---------------------------------------------------------------- bill type & property

export function inferBillType(ex: Extraction): { billType: string; confident: boolean } {
  const hay = [ex.fields.vendorName || "", ex.content || "", ...ex.lineItems.map((i) => i.description)].join(" \n ").toLowerCase();
  const score: Record<string, number> = { hot_water: 0, gas: 0, electricity: 0, water: 0, internet: 0 };
  const count = (re: RegExp) => (hay.match(re) || []).length;
  score.hot_water = count(/hot\s*water/g) * 3;
  score.gas = count(/\bgas\b(?!\s*(?:emissions|offset))/g) * 2 + count(/\bmj\b|megajoule/g) * 2;
  score.electricity = count(/electricity|\bkwh\b|kilowatt/g) * 2;
  score.water = Math.max(0, count(/\bwater\b/g) - count(/hot\s*water/g)) + count(/\bkl\b|kilolitre/g) * 2 + count(/sewerage/g) * 2;
  score.internet = count(/internet|\bnbn\b|broadband|\bwi-?fi\b|mbps/g) * 2;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) return { billType: "other", confident: false };
  const confident = ranked[0][1] >= 3 && ranked[0][1] >= (ranked[1][1] * 2 || 1);
  return { billType: ranked[0][0], confident };
}

function normAddr(s: string): string {
  return (s || "").toLowerCase()
    .replace(/\bstreet\b/g, "st").replace(/\broad\b/g, "rd").replace(/\bavenue\b/g, "ave").replace(/\bparade\b/g, "pde")
    .replace(/\bdrive\b/g, "dr").replace(/\bplace\b/g, "pl").replace(/\bterrace\b/g, "tce").replace(/\bcourt\b/g, "ct")
    .replace(/\bboulevard\b/g, "blvd").replace(/\bhighway\b/g, "hwy").replace(/\bunit\b|\bapartment\b|\bapt\b/g, "u")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Picks the property this bill is for by comparing its printed address with each property's
 *  address/name: street name + street number + unit number. "high" only when the street name,
 *  street number AND (if the property has one) the unit all match, and no other property does. */
export function matchProperty(ex: Extraction, properties: PropertyRef[]): { propertyId: string; confidence: "high" | "low" | "none"; guessText: string } {
  const sources = [ex.fields.serviceAddress || "", ex.content || ""];
  const hay = normAddr(sources.join(" "));
  const scored = properties.map((p) => {
    const a = normAddr(p.address || "");
    const tokens = a.split(" ");
    const nums = tokens.filter((t) => /\d/.test(t)).map((t) => t.replace(/^u/, ""));
    const words = tokens.filter((t) => /^[a-z]{3,}$/.test(t) && ["st", "rd", "ave", "u"].indexOf(t) < 0);
    let s = 0, allNums = nums.length > 0, wordHit = false;
    for (const w of words) if (new RegExp("\\b" + w + "\\b").test(hay)) { s += 2; wordHit = true; }
    for (const n of nums) { if (new RegExp("(^|\\D)" + n + "(\\D|$)").test(hay)) s += 2; else allNums = false; }
    const nameHit = p.name && new RegExp("\\b" + normAddr(p.name) + "\\b").test(hay);
    if (nameHit) s += 1;
    return { p, s, strong: wordHit && allNums };
  }).sort((a, b) => b.s - a.s);
  const best = scored[0];
  const guessText = ex.fields.serviceAddress || "";
  if (!best || best.s === 0) return { propertyId: "", confidence: "none", guessText };
  const tie = scored[1] && scored[1].s === best.s;
  if (best.strong && !tie) return { propertyId: best.p.id, confidence: "high", guessText: "" };
  return { propertyId: tie ? "" : best.p.id, confidence: "low", guessText };
}

// ---------------------------------------------------------------- validation

export const LABELS: Record<string, string> = {
  vendorName: "Provider", invoiceNumber: "Invoice number", invoiceDate: "Invoice date", dueDate: "Due date",
  periodStart: "Period start", periodEnd: "Period end", accountNumber: "Account number", serviceAddress: "Service address",
  subtotal: "Subtotal", gst: "GST", total: "Total", previousBalance: "Previous balance", amountDue: "Amount due"
};
function fmt(v: string | number | null): string { return typeof v === "number" ? "$" + v.toFixed(2) : String(v ?? ""); }

/** Every check that must pass before a bill is split among tenants. "error" = can't be saved
 *  as is; "warning" = the admin must confirm it against the bill; "info" = shown only. */
export function validateExtraction(ex: Extraction, today: string, extra?: { billType?: string; billTypeConfident?: boolean; propertyId?: string; propertyConfidence?: string }): Issue[] {
  const F = ex.fields;
  const issues: Issue[] = [];
  const add = (code: string, severity: Severity, message: string, field?: string) => issues.push({ code, severity, message, field });

  // Required — never guessed.
  if (!F.vendorName) add("missing", "error", "Provider not found on the bill.", "vendorName");
  if (F.total == null) add("missing", "error", "Total of the bill's charges not found.", "total");
  if (!F.periodStart) add("missing", "error", "Billing period start not found.", "periodStart");
  if (!F.periodEnd) add("missing", "error", "Billing period end not found.", "periodEnd");
  if (!F.dueDate) add("missing", "error", "Due date not found on the bill — enter it from the bill (it's not guessed).", "dueDate");
  if (!F.invoiceDate) add("missing", "warning", "Invoice date not found.", "invoiceDate");
  if (!F.invoiceNumber) add("missing", "info", "Invoice number not found.", "invoiceNumber");
  if (!F.accountNumber) add("missing", "info", "Account number not found.", "accountNumber");

  // Amounts.
  if (F.total != null && F.total <= 0) add("amount_not_positive", "error", "The total is " + fmt(F.total) + " — a bill to split must be more than $0.", "total");
  if (F.subtotal != null && F.gst != null && F.total != null && Math.abs(F.subtotal + F.gst - F.total) > 0.05) {
    add("subtotal_gst_mismatch", "warning", "Subtotal " + fmt(F.subtotal) + " + GST " + fmt(F.gst) + " = " + fmt(round2(F.subtotal + F.gst)) + ", but the total is " + fmt(F.total) + ".", "total");
  }
  if (F.gst != null && F.total != null && F.total > 0 && F.gst > F.total * 0.2) {
    add("gst_too_high", "warning", "GST " + fmt(F.gst) + " is more than 20% of the total " + fmt(F.total) + " — probably misread.", "gst");
  }
  if (F.previousBalance != null && Math.abs(F.previousBalance) > 0.004) {
    if (F.total != null && F.amountDue != null && Math.abs(F.amountDue - F.total) < 0.01) {
      add("total_may_include_balance", "warning", "There's a previous balance of " + fmt(F.previousBalance) + " and the total equals the amount due — make sure the amount to split is only THIS bill's new charges.", "total");
    } else {
      add("previous_balance", "info", "Previous balance of " + fmt(F.previousBalance) + " is not included in the amount split among tenants.", "previousBalance");
    }
  }
  if (F.amountDue != null && F.total != null && F.previousBalance == null && Math.abs(F.amountDue - F.total) > 0.05) {
    add("amount_due_differs", "warning", "Amount due " + fmt(F.amountDue) + " differs from the bill total " + fmt(F.total) + " (previous balance, credit or discount?). Check which one applies.", "total");
  }
  const itemSum = round2(ex.lineItems.reduce((s, i) => s + (i.amount || 0), 0));
  if (ex.lineItems.some((i) => i.amount != null) && F.total != null) {
    const okTotal = Math.abs(itemSum - F.total) <= 0.1;
    const okSub = F.subtotal != null && Math.abs(itemSum - F.subtotal) <= 0.1;
    if (!okTotal && !okSub) add("items_mismatch", "info", "Line items add up to " + fmt(itemSum) + ", not the total " + fmt(F.total) + " (some lines may not have been read).");
  }

  // Dates.
  if (F.periodStart && F.periodEnd) {
    if (F.periodEnd < F.periodStart) add("period_reversed", "error", "The period ends before it starts.", "periodEnd");
    else {
      const len = daysBetween(F.periodStart, F.periodEnd) + 1;
      if (len > 190) add("period_long", "warning", "The period is " + len + " days long — check the dates.", "periodStart");
    }
  }
  if (F.invoiceDate && F.dueDate && F.dueDate < F.invoiceDate) add("due_before_issue", "warning", "The due date is before the invoice date.", "dueDate");
  if (F.invoiceDate && daysBetween(today, F.invoiceDate) > 7) add("future_invoice", "warning", "The invoice date is in the future.", "invoiceDate");
  if (F.periodEnd && daysBetween(today, F.periodEnd) > 45) add("future_period", "warning", "The period ends well in the future — check the year.", "periodEnd");
  if (F.periodStart && daysBetween(F.periodStart, today) > 730) add("old_period", "warning", "The period started more than 2 years ago — check the year.", "periodStart");

  // How it was read.
  const lowConf = KEY_FIELDS.filter((k) => typeof ex.confidence[k] === "number" && (ex.confidence[k] as number) < 0.8 && F[k] != null);
  if (lowConf.length) add("low_confidence", "warning", "Read with low confidence: " + lowConf.map((k) => LABELS[k]).join(", ") + ".");
  const fromBackup = KEY_FIELDS.filter((k) => ex.source[k] === "gemini");
  if (fromBackup.length) add("backup_reader", "warning", "Read by the backup reader (Gemini), which gives no confidence score: " + fromBackup.map((k) => LABELS[k]).join(", ") + ".");

  if (extra) {
    if (!extra.propertyId) add("property_unmatched", "error", "Couldn't tell which property this bill is for — pick it.", "propertyId");
    else if (extra.propertyConfidence && extra.propertyConfidence !== "high") add("property_low", "warning", "Property matched with low confidence — check it's the right one.", "propertyId");
    if (extra.billType && !extra.billTypeConfident) add("type_unsure", "warning", "Service type not clear from the bill — check it.", "billType");
  }
  return issues;
}

export function overallConfidence(ex: Extraction): number | null {
  const vals = KEY_FIELDS.map((k) => ex.confidence[k]).filter((c) => typeof c === "number") as number[];
  if (!vals.length) return null;
  const missingOrBackup = KEY_FIELDS.some((k) => ex.fields[k] == null || ex.source[k] === "gemini");
  const min = Math.min(...vals);
  return Math.round((missingOrBackup ? Math.min(min, 0.5) : min) * 1000) / 1000;
}

export function statusFrom(issues: Issue[]): "ready" | "needs_review" {
  return issues.some((i) => i.severity === "error" || i.severity === "warning") ? "needs_review" : "ready";
}
