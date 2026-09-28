// services/entityLinkService.js
// Generic cross-module relations (e.g. "this Maintenance request was created from this
// Inspection finding") — a thin table, no trigger populates it (links are an explicit
// user action, not a side effect of a row existing). Staff-only for both read and write;
// see entity_links' RLS. Used by Phase 2's Inspection -> Create Issue flow; Phase 0
// only builds the mechanism.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    fromTable: row.from_table,
    fromId: row.from_id,
    toTable: row.to_table,
    toId: row.to_id,
    relation: row.relation,
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('entity_links').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

export async function linkEntities(fromTable, fromId, toTable, toId, relation) {
  const { data, error } = await supabase.from('entity_links').insert({
    from_table: fromTable,
    from_id: fromId,
    to_table: toTable,
    to_id: toId,
    relation: relation || 'created_from'
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function getLinksFor(table, id) {
  const { data, error } = await supabase.from('entity_links')
    .select('*')
    .or('and(from_table.eq.' + table + ',from_id.eq.' + id + '),and(to_table.eq.' + table + ',to_id.eq.' + id + ')');
  if (error) throw error;
  return data.map(fromRow);
}
