// services/notificationService.js
// Simple in-app notification feed shown on each role's dashboard. Rows are created by staff
// actions (a maintenance request changes status, etc.) — RLS only lets staff insert, and lets
// everyone read/mark-read only their own.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    title: row.title,
    body: row.body || '',
    relatedTable: row.related_table || null,
    relatedId: row.related_id || null,
    isRead: row.is_read,
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data.map(fromRow);
}

export async function markRead(id) {
  const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id);
  if (error) throw error;
}

/** Fire-and-forget: staff notifying a specific person (by their auth user id) about something.
 *  Never throws into the caller's main flow — a failed notification shouldn't block the action
 *  that triggered it (e.g. saving a maintenance status change). */
export async function notify(authUserId, title, body, relatedTable, relatedId) {
  if (!authUserId) return;
  try {
    await supabase.from('notifications').insert({
      auth_user_id: authUserId, title, body: body || null,
      related_table: relatedTable || null, related_id: relatedId || null
    });
  } catch (_e) { /* best-effort */ }
}
