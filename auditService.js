// services/auditService.js
// Read-only access to the append-only audit_logs table. RLS only returns rows to a super_admin
// — anyone else gets an empty result, never an error, so the UI can call this safely.
import { supabase } from '../lib/supabaseClient.js';

export async function getRecent(limit) {
  const { data, error } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(limit || 100);
  if (error) throw error;
  return data;
}
