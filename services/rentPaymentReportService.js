// services/rentPaymentReportService.js
// A tenant's "I paid my rent" report with proof. Always starts 'pending'; only staff can confirm
// (which records the real payment) or reject it — enforced by RLS on rent_payment_reports.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    amount: Number(row.amount) || 0,
    paymentDate: row.payment_date,
    paymentMethod: row.payment_method || null,
    reference: row.reference || null,
    tenantReference: row.tenant_reference || null,
    proofPath: row.proof_path || null,
    periodLabel: row.period_label || null,
    status: row.status,
    paymentId: row.payment_id || null,
    reviewedByProfileId: row.reviewed_by_profile_id || null,
    reviewedAt: row.reviewed_at || null,
    rejectionReason: row.rejection_reason || null,
    reportedAt: row.reported_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('rent_payment_reports').select('*').order('reported_at', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(r) {
  const { data, error } = await supabase.from('rent_payment_reports').insert({
    tenant_id: r.tenantId, property_id: r.propertyId, amount: r.amount, payment_date: r.paymentDate,
    payment_method: r.paymentMethod || null, reference: r.reference || null, proof_path: r.proofPath || null, tenant_reference: r.tenantReference || null,
    period_label: r.periodLabel || null, status: 'pending'
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Only acts on a still-pending report (same double-review guard as paymentReportService). */
export async function confirm(id, reviewedByProfileId, paymentId) {
  const { data, error } = await supabase.from('rent_payment_reports').update({
    status: 'confirmed', payment_id: paymentId || null,
    reviewed_by_profile_id: reviewedByProfileId, reviewed_at: new Date().toISOString()
  }).eq('id', id).eq('status', 'pending').select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function reject(id, reviewedByProfileId, reason) {
  const { data, error } = await supabase.from('rent_payment_reports').update({
    status: 'rejected', rejection_reason: reason || null,
    reviewed_by_profile_id: reviewedByProfileId, reviewed_at: new Date().toISOString()
  }).eq('id', id).eq('status', 'pending').select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Detaches the proof file from a report (e.g. the wrong photo was uploaded). Staff only (RLS). */
export async function clearProof(id) {
  const { error } = await supabase.from('rent_payment_reports').update({ proof_path: null }).eq('id', id);
  if (error) throw error;
}
