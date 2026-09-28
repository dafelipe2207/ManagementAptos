// services/roomIncludedBillService.js
// A room's recurring costs the admin bundles into its rent and pays
// themselves (e.g. "Electricity $30/week included") — used ONLY by the
// Profits page's calculation. Never linked to the tenant-facing `bills`
// table, never shown to tenants (no tenant RLS access at all).
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    roomId: row.room_id,
    label: row.label,
    amount: Number(row.amount) || 0,
    frequency: row.frequency,
    startDate: row.start_date,
    endDate: row.end_date || null
  };
}

function toRow(e) {
  return {
    room_id: e.roomId,
    label: e.label,
    amount: e.amount,
    frequency: e.frequency,
    start_date: e.startDate,
    end_date: e.endDate || null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('room_included_bills').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(e) {
  const userId = await getCurrentUserId();
  const row = toRow(e);
  row.user_id = userId;
  const { data, error } = await supabase.from('room_included_bills').insert(row).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, e) {
  const { data, error } = await supabase.from('room_included_bills').update(toRow(e)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('room_included_bills').delete().eq('id', id);
  if (error) throw error;
}
