// services/propertyService.js
// Maps the app's camelCase `property` shape ({id, name, address, bedrooms,
// bathrooms, notes}) to/from the `properties` table. Every create() sets
// user_id explicitly from the current session (RLS requires it).
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address || '',
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    notes: row.notes || ''
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('properties').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(p) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('properties').insert({
    user_id: userId,
    name: p.name,
    address: p.address,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    notes: p.notes || null
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, p) {
  const { data, error } = await supabase.from('properties').update({
    name: p.name,
    address: p.address,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    notes: p.notes || null
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('properties').delete().eq('id', id);
  if (error) throw error;
}
