// services/roomService.js
import { supabase } from '../lib/supabaseClient.js';
import { removeById } from '../lib/db.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id, propertyId: row.property_id, name: row.name,
    // What the room comes with, handed to the tenant at move-in and returned at move-out: [{ id, name, qty }]
    items: Array.isArray(row.items) ? row.items : []
  };
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
    name: r.name,
    items: Array.isArray(r.items) ? r.items : []
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, r) {
  const patch = { name: r.name };
  if (Array.isArray(r.items)) patch.items = r.items;
  const { data, error } = await supabase.from('rooms').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  return removeById('rooms', id);
}
