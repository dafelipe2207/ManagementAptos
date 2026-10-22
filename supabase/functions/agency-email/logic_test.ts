import assertMod from "node:assert/strict";
const assert: (v: unknown, m?: string) => asserts v = (v, m) => assertMod.ok(v, m);
const assertEquals = (a: unknown, b: unknown) => assertMod.deepStrictEqual(a, b);
import { AiResult, Ctx, decide, InMsg, isAgencySender, isUrgent, matchBill, normalizeProperty, perthToday } from "./logic.ts";

const CARLTON = "7edc4ab4-d6fc-4fbe-831e-1e665a4704c9";
const KEWDALE = "385ccf1a-b753-4679-a0ee-3ed37eb92a46";
const MACK = "90be4335-02ac-49da-ab74-b0dda1526321";

const ctx = (): Ctx => ({
  properties: [{ id: CARLTON, name: "Carlton" }, { id: KEWDALE, name: "Kewdale" }, { id: MACK, name: "Mackenzie" }],
  cases: [
    { dedupKey: "agency-email:root1", propertyId: KEWDALE, kind: "maintenance", title: "🏢 Kewdale · Manija", body: "", createdAt: "2026-10-21", invoiceNumber: null, archived: false },
    { dedupKey: "agency-email:arch", propertyId: MACK, kind: "inspection", title: "🏢 Mackenzie · Inspección", body: "", createdAt: "2026-10-01", invoiceNumber: null, archived: true },
  ],
  updates: [{ dedupKey: "agency-email:upd1", caseKey: "agency-email:root1", summary: "x", receivedAt: "2026-10-21" }],
  maintenance: [{ id: "m1", propertyId: KEWDALE, title: "Door / window / wall damaged", category: null, status: "open", createdAt: "2026-10-15" }],
  inspections: [{ id: "i1", propertyId: MACK, date: "2026-10-21" }],
  bills: [{ id: "b1", propertyId: MACK, provider: "Water", invoiceNumber: "004317", amount: 80.1, dueDate: "2026-10-19", adminPaid: false }],
});

const msg = (over: Partial<InMsg> = {}): InMsg => ({
  messageId: "new1", threadId: "t1", date: "2026-10-22T05:00:00Z", from: "RWSouthbank@email.propertyme.com",
  subject: "Job request", body: "…", url: "https://mail.google.com/x", thread: [], ...over,
});

const ai = (over: Partial<AiResult> = {}): AiResult => ({
  relevant: true, property: "Carlton", kind: "maintenance", informational: false,
  title: "🔧 Carlton · Cocina eléctrica — trabajo #26427", summary: "Resumen.", action: true,
  deadline: null, overdueAmount: null, continuationOf: null, continuationConfidence: "low", ...over,
});

const TODAY = "2026-10-22";

Deno.test("ignores irrelevant", () => {
  assertEquals(decide(ai({ relevant: false }), msg(), ctx(), TODAY).type, "ignore");
});
Deno.test("unknown property ignored", () => {
  assertEquals(decide(ai({ property: "Narnia" }), msg(), ctx(), TODAY).type, "ignore");
});
Deno.test("normalizes property case", () => {
  assertEquals(normalizeProperty("carlton"), "Carlton");
  assertEquals(normalizeProperty("2901/33 Mackenzie St"), "Mackenzie");
  assertEquals(normalizeProperty(null), null);
});
Deno.test("new case with recipients-independent fields", () => {
  const d = decide(ai(), msg(), ctx(), TODAY);
  assert(d.type === "case");
  assertEquals(d.propertyId, CARLTON);
  assertEquals(d.category, "important_notice");
  assert(d.body.endsWith("https://mail.google.com/x"));
});
Deno.test("update key resolves to root", () => {
  const d = decide(ai({ property: "Kewdale", continuationOf: "agency-email:upd1", continuationConfidence: "high" }), msg(), ctx(), TODAY);
  assert(d.type === "update");
  assertEquals(d.caseKey, "agency-email:root1");
});
Deno.test("low confidence → case", () => {
  const d = decide(ai({ property: "Kewdale", continuationOf: "agency-email:root1", continuationConfidence: "low" }), msg(), ctx(), TODAY);
  assertEquals(d.type, "case");
});
Deno.test("continuation of another property is rejected", () => {
  const d = decide(ai({ property: "Carlton", continuationOf: "agency-email:root1", continuationConfidence: "high" }), msg(), ctx(), TODAY);
  assertEquals(d.type, "case");
});
Deno.test("same thread forces update", () => {
  const m = msg({ thread: [{ messageId: "upd1", date: "", from: "", subject: "", snippet: "" }] });
  const d = decide(ai({ property: "Kewdale" }), m, ctx(), TODAY);
  assert(d.type === "update");
  assertEquals(d.caseKey, "agency-email:root1");
});
Deno.test("archived root + new deadline → case; without action → update", () => {
  const a = ai({ property: "Mackenzie", kind: "inspection", continuationOf: "agency-email:arch", continuationConfidence: "high" });
  assertEquals(decide({ ...a, action: true, deadline: "2026-11-04" }, msg(), ctx(), TODAY).type, "case");
  assertEquals(decide({ ...a, action: false }, msg(), ctx(), TODAY).type, "update");
});
Deno.test("receipt informativo", () => {
  const d = decide(ai({ kind: "receipt", informational: true, action: false, title: "🏢 Carlton · Recibo de renta" }), msg(), ctx(), TODAY);
  assert(d.type === "case");
  assert(d.title.includes("(informativo)"));
  assertEquals(d.category, "general_announcement");
});
Deno.test("urgent arrears gets (URGENTE)", () => {
  const d = decide(ai({ property: "Mackenzie", kind: "arrears", title: "🏢 Mackenzie · Atraso de renta $2,651", overdueAmount: 2651 }), msg(), ctx(), TODAY);
  assert(d.type === "case");
  assert(d.urgent);
  assert(d.title.endsWith("(URGENTE)"));
});
Deno.test("title without property gets prefix", () => {
  const d = decide(ai({ title: "Cocina rota" }), msg(), ctx(), TODAY);
  assert(d.type === "case");
  assert(d.title.startsWith("🏢 Carlton · "));
});
Deno.test("urgency window", () => {
  assert(isUrgent("2026-10-25", null, TODAY));
  assert(!isUrgent("2026-10-26", null, TODAY));
  assert(isUrgent("2026-10-01", null, TODAY));
  assert(isUrgent(null, 10, TODAY));
  assert(!isUrgent(null, 0, TODAY));
});
Deno.test("perth date", () => {
  assertEquals(perthToday(new Date("2026-10-22T17:00:00Z")), "2026-10-23");
});
Deno.test("bill match by number and by amount+date", () => {
  const b = ctx().bills;
  assertEquals(matchBill(b, { invoiceNumber: "4317", amount: null, dueDate: null })?.id, "b1");
  assertEquals(matchBill(b, { invoiceNumber: null, amount: 80.1, dueDate: "2026-10-22" })?.id, "b1");
  assertEquals(matchBill(b, { invoiceNumber: null, amount: 80.1, dueDate: "2026-11-30" }), null);
});
Deno.test("invoice: bill status + invoice_doc has no agency data", () => {
  const d = decide(ai({
    property: "Mackenzie", kind: "invoice", title: "🏢 Mackenzie · Factura de agua", deadline: "2026-11-10",
    invoice: { invoiceNumber: "004317", amount: 80.1, dueDate: "2026-11-10", description: "Water Usage", periodStart: "2026-07-30", periodEnd: "2026-09-30" },
  }), msg(), ctx(), TODAY);
  assert(d.type === "case");
  assertEquals(d.billId, "b1");
  assert(d.body.includes("ya está en la app, sin pagar al proveedor"));
  const doc = d.invoiceDoc!;
  assertEquals(doc.addressLine1, "2901/33 Mackenzie St");
  assertEquals(doc.addressLine2, "MELBOURNE VIC 3000");
  assertEquals(doc.amountPaid, 0);
  assertEquals(Object.keys(doc).sort(), ["addressLine1", "addressLine2", "amount", "amountPaid", "description", "dueDate", "includedTax", "invoiceNumber", "periodEnd", "periodStart"]);
});
Deno.test("invoice not loaded", () => {
  const d = decide(ai({ kind: "invoice", invoice: { invoiceNumber: "999", amount: 5, dueDate: "2026-11-30" } }), msg(), ctx(), TODAY);
  assert(d.type === "case" && d.body.includes("no está cargada en la app") && d.billId === null);
});
Deno.test("link only when high + in ctx", () => {
  const base = ai({ property: "Kewdale" });
  const d1 = decide({ ...base, link: { table: "maintenance_requests", id: "m1", confidence: "high" } }, msg(), ctx(), TODAY);
  assert(d1.type === "case" && d1.linkedId === "m1" && d1.linkedTable === "maintenance_requests");
  const d2 = decide({ ...base, link: { table: "maintenance_requests", id: "m1", confidence: "low" } }, msg(), ctx(), TODAY);
  assert(d2.type === "case" && d2.linkedId === null);
  const d3 = decide({ ...base, link: { table: "maintenance_requests", id: "made-up", confidence: "high" } }, msg(), ctx(), TODAY);
  assert(d3.type === "case" && d3.linkedId === null);
});
Deno.test("agency sender filter", () => {
  assert(isAgencySender("woodproperty@email.propertyme.com", "x"));
  assert(isAgencySender("pm6.southbank@raywhite.com", "x"));
  assert(isAgencySender("someone@else.com", "Re: 9/160 Wright Street, Kewdale"));
  assert(!isAgencySender("donotreply@jobalert.indeed.com", "Cleaner jobs"));
});
