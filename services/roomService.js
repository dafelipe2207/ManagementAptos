// services/roomService.js
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return { id: row.id, propertyId: row.property_id, name: row.name };
}

export async function getAll() {
  const { data, error } = await supabase.from('rooms').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(r) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('rooms').insert({
    user_id: userId,
    property_id: r.propertyId,
    name: r.name
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, r) {
  const { data, error } = await supabase.from('rooms').update({ name: r.name }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('rooms').delete().eq('id', id);
  if (error) throw error;
}
