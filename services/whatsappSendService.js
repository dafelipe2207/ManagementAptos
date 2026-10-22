// services/whatsappSendService.js
// WhatsApp sends of bills / owed statements (table public.whatsapp_sends), so every admin sees who
// already sent what — and the app can warn before sending the same thing twice.
// One row per bill per send; kind 'tenant' (to a tenant, tenant_id set) or 'group' (property group).
// A statement with rent only is logged as one row with bill_id null.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(r) {
  return { id: r.id, kind: r.kind, billId: r.bill_id || null, tenantId: r.tenant_id || null,
    sentByProfileId: r.sent_by_profile_id || null, sentAt: r.sent_at };
}

/** Sends of the last 180 days, newest first. */
export async function getAll() {
  const since = new Date(Date.now() - 180 * 864e5).toISOString();
  const { data, error } = await supabase.from('whatsapp_sends').select('*').gte('sent_at', since)
    .order('sent_at', { ascending: false }).limit(5000);
  if (error) throw error;
  return data.map(fromRow);
}

/** rows: [{ kind, billId|null, tenantId|null }] — all stamped with the same sender and time. */
export async function log(rows, profileId) {
  if (!rows.length) return [];
  const payload = rows.map((r) => ({ kind: r.kind, bill_id: r.billId || null, tenant_id: r.tenantId || null, sent_by_profile_id: profileId || null }));
  const { data, error } = await supabase.from('whatsapp_sends').insert(payload).select();
  if (error) throw error;
  return data.map(fromRow);
}
