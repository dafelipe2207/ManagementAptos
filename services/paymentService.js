// services/paymentService.js
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    amount: Number(row.amount) || 0,
    date: row.payment_date,
    // 'cash' (default) is a real payment the tenant made; 'bond_deduction' means this rent
    // charge was instead settled by deducting the amount from the tenant's bond on move-out —
    // see processMoveOutBondSettlement in app.js. Never a payment the tenant actually made.
    method: row.method || 'cash',
    receiptPath: row.receipt_path || null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('payments').select('*').order('payment_date', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(p) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('payments').insert({
    user_id: userId,
    tenant_id: p.tenantId,
    amount: p.amount,
    payment_date: p.date,
    method: p.method || 'cash',
    receipt_path: p.receiptPath || null
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, p) {
  const patch = {};
  if (p.amount !== undefined) patch.amount = p.amount;
  if (p.date !== undefined) patch.payment_date = p.date;
  const { data, error } = await supabase.from('payments').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Attach (path) or clear (null) the receipt of a rent payment. */
export async function setReceipt(id, path) {
  const { data, error } = await supabase.from('payments').update({ receipt_path: path || null }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('payments').delete().eq('id', id);
  if (error) throw error;
}

