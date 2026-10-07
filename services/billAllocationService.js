// services/billAllocationService.js
// Per-tenant shares of a bill. Includes bulk-create (for auto-allocation on
// confirm and re-allocation) and markPaid/unmarkPaid matching the reference
// app's markAllocationPaid/unmarkAllocationPaid semantics.
// A row can also represent the ADMIN absorbing a share on behalf of tenants
// excluded from that bill type (see tenant.excludedBillTypes) — those rows
// have isAdmin:true and tenantId:null instead of a real tenant.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    billId: row.bill_id,
    tenantId: row.tenant_id,
    isAdmin: !!row.is_admin,
    amount: Number(row.amount) || 0,
    daysOccupied: row.days_occupied,
    paid: !!row.paid,
    paidDate: row.paid_date || null,
    receiptPath: row.receipt_path || null,
    // 'cash' (default) is the tenant's own payment; 'bond_deduction' means this share was
    // instead settled by deducting it from the tenant's bond on move-out — never a separate
    // payment the tenant made. See processMoveOutBondSettlement in app.js.
    paidVia: row.paid_via || 'cash',
    // Snapshot of the tenant's occupancy factor (and the bill's total factor that day) at the
    // moment this row was allocated by the 'occupancy' method — null for every other method.
    // See computeOccupancyFactorAllocationRows in app.js.
    occupancyFactor: row.occupancy_factor != null ? Number(row.occupancy_factor) : null,
    totalOccupancyFactor: row.total_occupancy_factor != null ? Number(row.total_occupancy_factor) : null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('bill_allocations').select('*');
  if (error) throw error;
  return data.map(fromRow);
}

export async function getForBill(billId) {
  const { data, error } = await supabase.from('bill_allocations').select('*').eq('bill_id', billId);
  if (error) throw error;
  return data.map(fromRow);
}

/** Replaces every allocation row for a bill in one go (used by confirmAllocation / auto-allocate-on-import). */
export async function replaceForBill(billId, rows) {
  const userId = await getCurrentUserId();
  const { error: delErr } = await supabase.from('bill_allocations').delete().eq('bill_id', billId);
  if (delErr) throw delErr;
  if (!rows.length) return [];
  const payload = rows.map(function (r) {
    return {
      user_id: userId,
      bill_id: billId,
      tenant_id: r.isAdmin ? null : r.tenantId,
      is_admin: !!r.isAdmin,
      amount: r.amount,
      days_occupied: typeof r.daysOccupied === 'number' ? r.daysOccupied : null,
      paid: !!r.paid,
      paid_date: r.paidDate || null,
      receipt_path: r.receiptPath || null,
      paid_via: r.paidVia || 'cash',
      occupancy_factor: (typeof r.occupancyFactor === 'number') ? r.occupancyFactor : null,
      total_occupancy_factor: (typeof r.totalOccupancyFactor === 'number') ? r.totalOccupancyFactor : null
    };
  });
  const { data, error } = await supabase.from('bill_allocations').insert(payload).select();
  if (error) throw error;
  return data.map(fromRow);
}

export async function markPaid(id, paidDate, paidVia) {
  const { data, error } = await supabase.from('bill_allocations')
    .update({ paid: true, paid_date: paidDate, paid_via: paidVia || 'cash' }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function unmarkPaid(id) {
  const { data, error } = await supabase.from('bill_allocations')
    .update({ paid: false, paid_date: null, paid_via: 'cash' }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Attaches (or replaces) the tenant's proof-of-payment file for their share of a bill. */
export async function setReceipt(id, path) {
  const { data, error } = await supabase.from('bill_allocations').update({ receipt_path: path }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

