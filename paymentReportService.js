// services/paymentReportService.js
// A tenant's report that they paid their share of a bill — always starts 'pending' and can only
// ever be moved to 'confirmed'/'rejected' by staff (enforced by RLS, not just this client code).
// bill_allocations.paid remains the single source of truth for "this share is actually paid" —
// this table only ever records the reporting/reviewing history around it. See
// docs/superpowers/specs/2026-09-27-tenant-payment-reports-design.md.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    allocationId: row.allocation_id,
    billId: row.bill_id,
    tenantId: row.tenant_id,
    status: row.status,
    paymentDate: row.payment_date || null,
    paymentMethod: row.payment_method || null,
    reference: row.reference || null,
    proofPath: row.proof_path || null,
    reportedAt: row.reported_at,
    reviewedByProfileId: row.reviewed_by_profile_id || null,
    reviewedAt: row.reviewed_at || null,
    rejectionReason: row.rejection_reason || null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('payment_reports').select('*').order('reported_at', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

/** Inserts a new 'pending' report. Throws (does not swallow) — the tenant's modal needs to know
 *  if this failed, e.g. the DB's one-pending-per-allocation unique index rejecting a second
 *  report while one is already pending. */
export async function create(opts) {
  const { data, error } = await supabase.from('payment_reports').insert({
    allocation_id: opts.allocationId,
    bill_id: opts.billId,
    tenant_id: opts.tenantId,
    status: 'pending',
    payment_date: opts.paymentDate || null,
    payment_method: opts.paymentMethod || null,
    reference: opts.reference || null,
    proof_path: opts.proofPath || null
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Both confirm() and reject() only ever act on a row that is still 'pending' (the .eq('status',
 *  'pending') below) — without it, two admins acting on the same report near-simultaneously (or a
 *  stale Reject click firing after the report was already auto-confirmed elsewhere) could silently
 *  overwrite a decision. With the guard, the second write matches zero rows: .single() then throws
 *  a real error the caller can show, instead of quietly clobbering the first decision. */
export async function confirm(id, reviewedByProfileId) {
  const { data, error } = await supabase.from('payment_reports').update({
    status: 'confirmed',
    reviewed_by_profile_id: reviewedByProfileId,
    reviewed_at: new Date().toISOString()
  }).eq('id', id).eq('status', 'pending').select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function reject(id, reviewedByProfileId, reason) {
  const { data, error } = await supabase.from('payment_reports').update({
    status: 'rejected',
    reviewed_by_profile_id: reviewedByProfileId,
    reviewed_at: new Date().toISOString(),
    rejection_reason: reason
  }).eq('id', id).eq('status', 'pending').select().single();
  if (error) throw error;
  return fromRow(data);
}
