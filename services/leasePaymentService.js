// services/leasePaymentService.js
// History of the admin's rent payments to the real estate — one row per period paid, with an
// optional invoice/receipt in the private `receipts` bucket. Staff only (RLS).
import { supabase } from '../lib/supabaseClient.js';

function fromRow(r) {
  return {
    id: r.id, propertyId: r.property_id, periodStart: r.period_start, periodEnd: r.period_end || null,
    amount: r.amount != null ? Number(r.amount) : null, paidDate: r.paid_date || null,
    method: r.method || null, receiptPath: r.receipt_path || null, notes: r.notes || '',
    createdAt: r.created_at
  };
}
function toRow(p) {
  return {
    property_id: p.propertyId, period_start: p.periodStart, period_end: p.periodEnd || null,
    amount: p.amount != null && p.amount !== '' ? p.amount : null, paid_date: p.paidDate || null,
    method: p.method || null, receipt_path: p.receiptPath || null, notes: p.notes || null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('lease_payments').select('*').order('period_start', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}
export async function create(p) {
  const { data, error } = await supabase.from('lease_payments').insert(toRow(p)).select().single();
  if (error) throw error;
  return fromRow(data);
}
export async function update(id, p) {
  const { data, error } = await supabase.from('lease_payments').update(toRow(p)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}
export async function remove(id) {
  const { error } = await supabase.from('lease_payments').delete().eq('id', id);
  if (error) throw error;
}
