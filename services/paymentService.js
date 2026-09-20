// services/paymentService.js
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return { id: row.id, tenantId: row.tenant_id, amount: Number(row.amount) || 0, date: row.payment_date };
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
    payment_date: p.date
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('payments').delete().eq('id', id);
  if (error) throw error;
}

export async function removeByTenant(tenantId) {
  const { error } = await supabase.from('payments').delete().eq('tenant_id', tenantId);
  if (error) throw error;
}
