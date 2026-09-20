// services/rentScheduleService.js
// One schedule per tenant. The reference app looks these up purely by
// tenantId (schedule objects never carried their own id), so `upsertForTenant`
// is the main entry point used by the tenant form; getAll/create/remove are
// kept for symmetry with the other services.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return { id: row.id, tenantId: row.tenant_id, frequency: row.frequency, amount: Number(row.amount) || 0, startDate: row.start_date };
}

export async function getAll() {
  const { data, error } = await supabase.from('rent_schedules').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(s) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('rent_schedules').insert({
    user_id: userId,
    tenant_id: s.tenantId,
    frequency: s.frequency,
    amount: s.amount,
    start_date: s.startDate
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, s) {
  const { data, error } = await supabase.from('rent_schedules').update({
    frequency: s.frequency,
    amount: s.amount,
    start_date: s.startDate
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('rent_schedules').delete().eq('id', id);
  if (error) throw error;
}

export async function removeByTenant(tenantId) {
  const { error } = await supabase.from('rent_schedules').delete().eq('tenant_id', tenantId);
  if (error) throw error;
}

/** Creates the schedule if the tenant doesn't have one yet, updates it otherwise (matches the reference app's tenant-form behaviour). */
export async function upsertForTenant(existingSchedule, s) {
  if (existingSchedule) return update(existingSchedule.id, s);
  return create(s);
}
