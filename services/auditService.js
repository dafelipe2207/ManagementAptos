// services/auditService.js
// Read-only access to the append-only audit_logs table. RLS only returns rows to a super_admin
// — anyone else gets an empty result, never an error, so the UI can call this safely.
import { supabase } from '../lib/supabaseClient.js';

export async function getRecent(limit) {
  const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(limit || 100);
  if (error) throw error;
  return data;
}

/** One "signed in" entry per user per 30 minutes (the database function de-duplicates). */
export async function logLogin(device) {
  const { error } = await supabase.rpc('log_app_login', { p_device: device || null });
  if (error) throw error;
}
