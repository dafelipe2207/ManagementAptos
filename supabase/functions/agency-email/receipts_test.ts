import assertMod from "node:assert/strict";
import { looksLikeReceipt, receiptTargets, ReceiptRead } from "./receipts.ts";
const eq = (a: unknown, b: unknown) => assertMod.deepStrictEqual(a, b);

const P = "kew", Q = "bel";
const leases = [
  { id: "l1", propertyId: P, amount: 1750, paidDate: "2026-10-14", periodStart: "2026-10-09", agencyReceiptPath: null },
  { id: "l2", propertyId: P, amount: 1750, paidDate: "2026-10-22", periodStart: "2026-10-23", agencyReceiptPath: null },
  { id: "l3", propertyId: Q, amount: 1600, paidDate: "2026-10-14", periodStart: "2026-10-16", agencyReceiptPath: null },
  { id: "l4", propertyId: P, amount: 1750, paidDate: "2026-09-30", periodStart: "2026-09-25", agencyReceiptPath: "x.pdf" },
];
const bills = [
  { id: "b1", propertyId: P, invoiceNumber: "35156", amount: 63.24, dueDate: "2026-11-05", agencyReceiptPath: null },
  { id: "b2", propertyId: P, invoiceNumber: null, amount: 75.92, dueDate: "2026-09-15", agencyReceiptPath: null },
];
const r = (o: Partial<ReceiptRead>): ReceiptRead => ({ isReceipt: true, receiptNumber: "1", paidDate: "2026-10-22", total: 1750, items: [], ...o });

Deno.test("rent → closest lease payment of the property", () => {
  eq(receiptTargets(r({ items: [{ kind: "rent", amount: 1750 }] }), P, leases, bills), [{ table: "lease_payments", id: "l2" }]);
});
Deno.test("no items → total treated as rent", () => {
  eq(receiptTargets(r({ paidDate: "2026-10-15", total: 1750 }), P, leases, bills), [{ table: "lease_payments", id: "l1" }]);
});
Deno.test("other property / wrong amount / too far → nothing", () => {
  eq(receiptTargets(r({ items: [{ kind: "rent", amount: 1600 }] }), P, leases, bills), []);
  eq(receiptTargets(r({ paidDate: "2026-11-20", items: [{ kind: "rent", amount: 1750 }] }), P, leases, bills), []);
});
Deno.test("lease that already has an agency receipt is skipped", () => {
  eq(receiptTargets(r({ paidDate: "2026-09-30", items: [{ kind: "rent", amount: 1750 }] }), P, leases, bills), []);
});
Deno.test("invoice by number, and by amount + date", () => {
  eq(receiptTargets(r({ items: [{ kind: "invoice", amount: 63.24, invoiceNumber: "035156" }] }), P, leases, bills), [{ table: "bills", id: "b1" }]);
  eq(receiptTargets(r({ paidDate: "2026-09-17", items: [{ kind: "invoice", amount: 75.92 }] }), P, leases, bills), [{ table: "bills", id: "b2" }]);
});
Deno.test("rent + invoice in one receipt → both", () => {
  eq(receiptTargets(r({ total: 1813.24, items: [{ kind: "rent", amount: 1750 }, { kind: "invoice", amount: 63.24, invoiceNumber: "35156" }] }), P, leases, bills),
    [{ table: "lease_payments", id: "l2" }, { table: "bills", id: "b1" }]);
});
Deno.test("not a receipt → nothing", () => {
  eq(receiptTargets(r({ isReceipt: false, items: [{ kind: "rent", amount: 1750 }] }), P, leases, bills), []);
});
Deno.test("receipt detection", () => {
  assertMod.ok(looksLikeReceipt("Receipt For Payment to Yaran Realty Pty Ltd", ""));
  assertMod.ok(looksLikeReceipt("Receipt of payment for 6/17 Lapage Street", ""));
  assertMod.ok(!looksLikeReceipt("Tenancy Invoice For 9/160 Wright Street", "An Invoice for Water Usage"));
});
