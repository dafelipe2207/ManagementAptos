// Pure rules for turning one agency email (+ Gemini's reading of it) into what gets written.
// Same rules the scheduled Claude task followed. Gemini's answer is treated as data: every id it
// returns is checked against the database context before it is used. No I/O in this file.

export type PropName = "Belmont" | "Kewdale" | "Carlton" | "Footscray" | "Mackenzie";
export type Kind = "invoice" | "arrears" | "receipt" | "inspection" | "maintenance" | "strata" | "lease" | "other";
const KINDS: Kind[] = ["invoice", "arrears", "receipt", "inspection", "maintenance", "strata", "lease", "other"];

export const PROPERTIES: Record<PropName, { line1: string; line2: string; agency: string; keys: string[] }> = {
  Belmont: { line1: "6/17 Lapage St", line2: "BELMONT WA 6104", agency: "SFR Property Group (PropertyMe)", keys: ["belmont", "lapage"] },
  Kewdale: { line1: "9/160 Wright St", line2: "KEWDALE WA 6105", agency: "Yaran Realty (PropertyTree / Bricks + Agent)", keys: ["kewdale", "wright st"] },
  Carlton: { line1: "2007/28 Bouverie St", line2: "CARLTON VIC 3053", agency: "Ray White Southbank (PropertyMe)", keys: ["carlton", "bouverie"] },
  Footscray: { line1: "U4C 904 Tannery Walk", line2: "FOOTSCRAY VIC 3011", agency: "—", keys: ["footscray", "tannery"] },
  Mackenzie: { line1: "2901/33 Mackenzie St", line2: "MELBOURNE VIC 3000", agency: "Wood Property (PropertyMe / Inspection Express)", keys: ["mackenzie"] },
};

export const AGENCY_DOMAINS = [
  "propertyme.com", "propertytree.com", "ipropertyexpress.com", "yaran.com.au", "woodproperty.com.au",
  "raywhite", "sfrproperty", "bricksandagent", "inspectrealestate",
];
const ADDRESS_HINTS = ["lapage", "wright st", "bouverie", "tannery walk", "mackenzie st"];

export interface ThreadMsg { messageId: string; date: string; from: string; subject: string; snippet: string }
export interface InMsg {
  messageId: string; threadId: string; date: string; from: string; to?: string;
  subject: string; body: string; url: string; thread: ThreadMsg[];
}
export interface AiInvoice {
  invoiceNumber?: string | null; amount?: number | null; dueDate?: string | null;
  description?: string | null; periodStart?: string | null; periodEnd?: string | null;
}
export interface AiResult {
  relevant: boolean; ignoreReason?: string | null;
  property: string | null; kind: string; informational: boolean;
  title: string; summary: string; action: boolean;
  deadline: string | null; overdueAmount: number | null;
  continuationOf: string | null; continuationConfidence: "high" | "low";
  invoice?: AiInvoice | null;
  link?: { table: string; id: string; confidence: "high" | "low" } | null;
}
export interface CtxCase {
  dedupKey: string; propertyId: string | null; kind: string | null; title: string; body: string;
  createdAt: string; invoiceNumber: string | null; archived: boolean;
}
export interface CtxBill {
  id: string; propertyId: string; provider: string | null; invoiceNumber: string | null;
  amount: number | null; dueDate: string | null; adminPaid: boolean;
}
export interface Ctx {
  properties: { id: string; name: string }[];
  cases: CtxCase[];
  updates: { dedupKey: string; caseKey: string; summary: string; receivedAt: string | null }[];
  maintenance: { id: string; propertyId: string; title: string; category: string | null; status: string | null; createdAt: string }[];
  inspections: { id: string; propertyId: string; date: string }[];
  bills: CtxBill[];
}
export interface InvoiceDoc {
  invoiceNumber: string | null; dueDate: string | null; amount: number | null; amountPaid: number; includedTax: number;
  description: string | null; periodStart: string | null; periodEnd: string | null; addressLine1: string; addressLine2: string;
}
export type Decision =
  | { type: "ignore"; reason: string }
  | { type: "update"; caseKey: string; summary: string; action: boolean; urgent: boolean; title: string }
  | {
    type: "case"; propertyId: string; propertyName: PropName; kind: Kind; title: string; body: string;
    category: "important_notice" | "general_announcement"; invoiceNumber: string | null; amount: number | null;
    dueDate: string | null; billId: string | null; invoiceDoc: InvoiceDoc | null;
    linkedTable: "maintenance_requests" | "real_estate_inspections" | null; linkedId: string | null; urgent: boolean;
  };

export const keyOf = (messageId: string) => "agency-email:" + messageId;

export function normalizeProperty(s: string | null | undefined): PropName | null {
  if (!s) return null;
  const t = s.toLowerCase();
  for (const [name, p] of Object.entries(PROPERTIES) as [PropName, typeof PROPERTIES[PropName]][]) {
    if (p.keys.some((k) => t.includes(k))) return name;
  }
  return null;
}

export function isAgencySender(from: string, subject: string): boolean {
  const f = (from || "").toLowerCase();
  if (AGENCY_DOMAINS.some((d) => f.includes(d))) return true;
  const s = (subject || "").toLowerCase();
  return ADDRESS_HINTS.some((h) => s.includes(h)) || Object.values(PROPERTIES).some((p) => s.includes(p.line1.toLowerCase()));
}

export function perthToday(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Australia/Perth" });
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function isUrgent(deadline: string | null, overdue: number | null, today: string): boolean {
  if (overdue != null && overdue > 0) return true;
  return isDate(deadline) && deadline <= addDays(today, 3);
}

const normInv = (s: string | null | undefined) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^0+/, "");

export function matchBill(
  bills: CtxBill[], inv: { invoiceNumber: string | null | undefined; amount: number | null | undefined; dueDate: string | null | undefined },
): CtxBill | null {
  const n = normInv(inv.invoiceNumber);
  if (n) {
    const byNum = bills.find((b) => normInv(b.invoiceNumber) === n);
    if (byNum) return byNum;
  }
  if (inv.amount != null && isDate(inv.dueDate)) {
    const t = new Date(inv.dueDate).getTime();
    return bills.find((b) => b.amount != null && Math.abs(Number(b.amount) - Number(inv.amount)) <= 0.01 &&
      isDate(b.dueDate) && Math.abs(new Date(b.dueDate).getTime() - t) <= 7 * 86400000) || null;
  }
  return null;
}

function fmtDate(iso: string): string {
  const m = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const [y, mo, d] = iso.split("-");
  return `${d} ${m[Number(mo) - 1]} ${y}`;
}

// The root case this message continues, or null. Same Gmail thread wins; otherwise Gemini's pick,
// only when confident and only if it's a real case (or an update → its root) of the same property.
function findRoot(ai: AiResult, msg: InMsg, ctx: Ctx, propertyId: string): CtxCase | null {
  const rootOf = (key: string): CtxCase | null => {
    const upd = ctx.updates.find((u) => u.dedupKey === key);
    const c = ctx.cases.find((x) => x.dedupKey === (upd ? upd.caseKey : key));
    return c && c.propertyId === propertyId ? c : null;
  };
  for (const t of msg.thread || []) {
    if (t.messageId === msg.messageId) continue;
    const c = rootOf(keyOf(t.messageId));
    if (c) return c;
  }
  if (ai.continuationOf && ai.continuationConfidence === "high") return rootOf(ai.continuationOf);
  return null;
}

export function decide(ai: AiResult, msg: InMsg, ctx: Ctx, today: string): Decision {
  if (!ai || !ai.relevant) return { type: "ignore", reason: ai?.ignoreReason || "not relevant" };
  const propertyName = normalizeProperty(ai.property);
  const prop = propertyName && ctx.properties.find((p) => p.name.toLowerCase() === propertyName.toLowerCase());
  if (!propertyName || !prop) return { type: "ignore", reason: "unknown property: " + (ai.property ?? "null") };

  const kind: Kind = (KINDS as string[]).includes(ai.kind) ? ai.kind as Kind : "other";
  const deadline = isDate(ai.deadline) ? ai.deadline : null;
  const urgent = isUrgent(deadline, ai.overdueAmount, today);
  const action = !!ai.action || !!deadline;
  const summary = (ai.summary || "").trim();

  let title = (ai.title || "").trim() || `${kind}`;
  if (!title.toLowerCase().includes(propertyName.toLowerCase())) title = `🏢 ${propertyName} · ${title}`;
  const informational = kind === "receipt" || (!!ai.informational && !action);
  if (informational && !/informativo/i.test(title)) title += " (informativo)";
  if (urgent && !title.includes("🚨") && !/URGENTE/i.test(title)) title += " (URGENTE)";

  const root = findRoot(ai, msg, ctx, prop.id);
  if (root && !(root.archived && action && deadline)) {
    return { type: "update", caseKey: root.dedupKey, summary, action, urgent, title };
  }

  // Bills: invoice / arrears
  let billId: string | null = null, invoiceNumber: string | null = null, amount: number | null = null, dueDate: string | null = null;
  let billLine = "";
  let invoiceDoc: InvoiceDoc | null = null;
  if (kind === "invoice" || kind === "arrears") {
    const inv = ai.invoice || {};
    invoiceNumber = inv.invoiceNumber ? String(inv.invoiceNumber) : null;
    amount = inv.amount != null && isFinite(Number(inv.amount)) ? Number(inv.amount) : (ai.overdueAmount ?? null);
    dueDate = isDate(inv.dueDate) ? inv.dueDate : deadline;
    if (kind === "invoice") {
      const bill = matchBill(ctx.bills.filter((b) => b.propertyId === prop.id), { invoiceNumber, amount, dueDate });
      billId = bill?.id ?? null;
      billLine = bill ? (bill.adminPaid ? "ya está en la app y pagada al proveedor" : "ya está en la app, sin pagar al proveedor") : "no está cargada en la app";
      const p = PROPERTIES[propertyName];
      invoiceDoc = {
        invoiceNumber, dueDate, amount, amountPaid: 0, includedTax: 0,
        description: inv.description || null,
        periodStart: isDate(inv.periodStart) ? inv.periodStart : null,
        periodEnd: isDate(inv.periodEnd) ? inv.periodEnd : null,
        addressLine1: p.line1, addressLine2: p.line2,
      };
    }
  }

  let linkedTable: "maintenance_requests" | "real_estate_inspections" | null = null, linkedId: string | null = null;
  const l = ai.link;
  if (l && l.confidence === "high") {
    const ok = l.table === "maintenance_requests"
      ? ctx.maintenance.some((m) => m.id === l.id && m.propertyId === prop.id)
      : l.table === "real_estate_inspections" && ctx.inspections.some((i) => i.id === l.id && i.propertyId === prop.id);
    if (ok) { linkedTable = l.table as "maintenance_requests" | "real_estate_inspections"; linkedId = l.id; }
  }

  const parts = [summary];
  if (deadline) parts.push(`Fecha límite: ${fmtDate(deadline)}.`);
  if (billLine) parts.push(`Factura: ${billLine}.`);
  parts.push(msg.url);
  return {
    type: "case", propertyId: prop.id, propertyName, kind, title, body: parts.filter(Boolean).join("\n"),
    category: action && !informational ? "important_notice" : "general_announcement",
    invoiceNumber, amount, dueDate, billId, invoiceDoc, linkedTable, linkedId, urgent,
  };
}
