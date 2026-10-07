// lib/db.js — small shared database helpers for the services.
import { supabase } from './supabaseClient.js';

/** Deletes one row by id and confirms it was really deleted. Under RLS a refused DELETE returns
 *  no error and 0 rows, so without this check a delete the account isn't allowed to do would
 *  look like it worked. */
export async function removeById(table, id) {
  const { data: deleted, error } = await supabase.from(table).delete().eq('id', id).select('id');
  if (error) throw error;
  if (!deleted || deleted.length === 0) {
    throw new Error('It wasn\'t deleted — your account doesn\'t have permission to delete this. Ask the Super Admin.');
  }
}
