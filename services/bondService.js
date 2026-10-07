// services/bondService.js
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    amountRequired: Number(row.amount_required) || 0,
    amountPaid: Number(row.amount_paid) || 0,
    amountReturned: Number(row.amount_returned) || 0,
    deduction: Number(row.deduction) || 0,
    // Itemized discounts/deductions applied to this bond (e.g. "Cleaning", "Carpet damage") —
    // each { label, amount }. `deduction` above is kept in sync as their sum (for anything
    // that only reads the single total) but discounts is the source of truth.
    discounts: Array.isArray(row.discounts) ? row.discounts : [],
    status: row.status,
    heldBy: row.held_by || ''
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('bonds').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(b) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('bonds').insert({
    user_id: userId,
    tenant_id: b.tenantId,
    amount_required: b.amountRequired,
    amount_paid: b.amountPaid,
    amount_returned: b.amountReturned,
    deduction: b.deduction,
    discounts: b.discounts || [],
    status: b.status,
    held_by: b.heldBy || null
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, b) {
  const patch = {
    amount_required: b.amountRequired,
    amount_paid: b.amountPaid,
    amount_returned: b.amountReturned,
    deduction: b.deduction,
    discounts: b.discounts || [],
    status: b.status
  };
  // Only touch "held by" when the caller passes it (the move-out settlement updates amounts only).
  if (b.heldBy !== undefined) patch.held_by = b.heldBy || null;
  const { data, error } = await supabase.from('bonds').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

