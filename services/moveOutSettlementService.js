// services/moveOutSettlementService.js
// One row per move-out attempt for a tenant. Nothing here ever touches bill_allocations,
// payments or bonds directly — app.js's approveMoveOutSettlement does that, only after the
// admin's explicit confirm. See docs/superpowers/specs/2026-09-27-move-out-settlement-design.md.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    startedAt: row.started_at,
    startedBy: row.started_by,
    startedByRole: row.started_by_role,
    manualDeductions: Array.isArray(row.manual_deductions) ? row.manual_deductions : [],
    billsSnapshot: Array.isArray(row.bills_snapshot) ? row.bills_snapshot : null,
    calculatedAt: row.calculated_at,
    calculatedBy: row.calculated_by,
    totalDeductions: row.total_deductions != null ? Number(row.total_deductions) : null,
    bondRefund: row.bond_refund != null ? Number(row.bond_refund) : null,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    rejectedAt: row.rejected_at,
    timeline: Array.isArray(row.timeline) ? row.timeline : [],
    lockedAt: row.locked_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('move_out_settlements').select('*').order('started_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function start(tenantId, role) {
  const userId = await getCurrentUserId();
  const timeline = [{
    at: new Date().toISOString(), byUserId: userId, byRole: role,
    action: role === 'tenant' ? 'Tenant started move-out process.' : 'Admin started move-out process.',
    fromStatus: null, toStatus: 'in_progress'
  }];
  const { data, error } = await supabase.from('move_out_settlements').insert({
    tenant_id: tenantId, status: 'in_progress', started_by: userId, started_by_role: role, timeline
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function saveDraftDeductions(id, manualDeductions, timelineEntries) {
  const { data: current, error: readErr } = await supabase.from('move_out_settlements').select('timeline').eq('id', id).single();
  if (readErr) throw readErr;
  const timeline = (current.timeline || []).concat(timelineEntries || []);
  const { data, error } = await supabase.from('move_out_settlements')
    .update({ manual_deductions: manualDeductions, timeline }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function calculate(id, billsSnapshot, totals, timelineEntries) {
  const { data: current, error: readErr } = await supabase.from('move_out_settlements').select('timeline').eq('id', id).single();
  if (readErr) throw readErr;
  const timeline = (current.timeline || []).concat(timelineEntries || []);
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('move_out_settlements').update({
    status: 'pending_approval', bills_snapshot: billsSnapshot,
    total_deductions: totals.totalDeductions, bond_refund: totals.bondRefund,
    calculated_at: new Date().toISOString(), calculated_by: userId, timeline
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function revertToInProgress(id, timelineEntries) {
  const { data: current, error: readErr } = await supabase.from('move_out_settlements').select('timeline').eq('id', id).single();
  if (readErr) throw readErr;
  const timeline = (current.timeline || []).concat(timelineEntries || []);
  const { data, error } = await supabase.from('move_out_settlements').update({
    status: 'in_progress', bills_snapshot: null, total_deductions: null, bond_refund: null,
    rejected_at: new Date().toISOString(), timeline
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function approve(id, timelineEntries) {
  const { data: current, error: readErr } = await supabase.from('move_out_settlements').select('timeline').eq('id', id).single();
  if (readErr) throw readErr;
  const timeline = (current.timeline || []).concat(timelineEntries || []);
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('move_out_settlements').update({
    status: 'completed', approved_at: new Date().toISOString(), approved_by: userId,
    locked_at: new Date().toISOString(), timeline
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Append-only: used by app.js's saveBondForm hook to log a correction made after completion,
 *  without touching any of the locked financial columns (the trigger only guards those). */
export async function appendTimelineEntry(id, timelineEntry) {
  const { data: current, error: readErr } = await supabase.from('move_out_settlements').select('timeline').eq('id', id).single();
  if (readErr) throw readErr;
  const timeline = (current.timeline || []).concat([timelineEntry]);
  const { data, error } = await supabase.from('move_out_settlements').update({ timeline }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}
