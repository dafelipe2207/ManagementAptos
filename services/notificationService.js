// services/notificationService.js
// In-app notifications. Every automatic rule in app.js (ensureAutomaticNotifications) calls
// notifyOnce with a stable dedupKey; the DB's unique (auth_user_id, dedup_key) index — see the
// notifications_categories_scheduling_admin migration — is what actually prevents duplicates,
// not a client-side scan. Manual/admin-composed notifications go through notify/notifyProperty/
// notifyPortfolio with no dedupKey (never deduped against each other).
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
    createdAt: row.created_at,
    category: row.category || 'general_announcement',
    dedupKey: row.dedup_key || null,
    scheduledFor: row.scheduled_for || null,
    canceledAt: row.canceled_at || null,
    archivedAt: row.archived_at || null,
    createdByProfileId: row.created_by_profile_id || null,
    propertyId: row.property_id || null,
    tenantId: row.tenant_id || null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data.map(fromRow);
}

export async function markRead(id) {
  const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id);
  if (error) throw error;
}

function optsToRow(opts) {
  opts = opts || {};
  return {
    category: opts.category || 'general_announcement',
    dedup_key: opts.dedupKey || null,
    scheduled_for: opts.scheduledFor || null,
    created_by_profile_id: opts.createdByProfileId || null,
    property_id: opts.propertyId || null,
    tenant_id: opts.tenantId || null
  };
}

/** Fire-and-forget: never throws into the caller's main flow — a failed notification shouldn't
 *  block the action that triggered it. `opts` is optional; omitting it keeps this byte-identical
 *  to the original 5-argument call used by maintenance/cleaning-comment/inspection-comment code. */
export async function notify(authUserId, title, body, relatedTable, relatedId, opts) {
  if (!authUserId) return;
  try {
    await supabase.from('notifications').insert(Object.assign({
      auth_user_id: authUserId, title, body: body || null,
      related_table: relatedTable || null, related_id: relatedId || null
    }, optsToRow(opts)));
  } catch (_e) { /* best-effort */ }
}

/** Same insert as notify(), but THROWS on failure instead of swallowing the error — for the
 *  admin's manual compose form, where "Notification sent" must mean it actually was, not just
 *  that the fire-and-forget call didn't crash. `notify()` stays silent for every automatic/
 *  background call site (maintenance, cleaning/inspection comments, ensureAutomaticNotifications),
 *  which must never let a failed notification block the real action that triggered it. */
export async function notifyOrThrow(authUserId, title, body, relatedTable, relatedId, opts) {
  if (!authUserId) throw new Error('This resident has no account yet, so they cannot receive in-app notifications.');
  const { error } = await supabase.from('notifications').insert(Object.assign({
    auth_user_id: authUserId, title, body: body || null,
    related_table: relatedTable || null, related_id: relatedId || null
  }, optsToRow(opts)));
  if (error) throw error;
}

/** The building block for every automatic rule. Upserts on (auth_user_id, dedup_key) with
 *  ignoreDuplicates so re-running the same rule many times (every bootstrapData()) never creates
 *  a second row — Postgres enforces this, not a client-side check. Returns whether a row was
 *  actually inserted (false = the dedup key already existed). Never throws. */
export async function notifyOnce(authUserId, dedupKey, title, body, relatedTable, relatedId, opts) {
  if (!authUserId || !dedupKey) return { id: null, created: false };
  try {
    const row = Object.assign({
      auth_user_id: authUserId, title, body: body || null,
      related_table: relatedTable || null, related_id: relatedId || null
    }, optsToRow(opts), { dedup_key: dedupKey });
    const { data, error } = await supabase.from('notifications')
      .upsert(row, { onConflict: 'auth_user_id,dedup_key', ignoreDuplicates: true })
      .select();
    if (error) throw error;
    // ignoreDuplicates: true returns an empty array when the row already existed.
    return { id: data && data[0] ? data[0].id : null, created: !!(data && data.length) };
  } catch (_e) { return { id: null, created: false }; }
}

/** Sends to every tenant in `tenantsForProperty` that has an account (authUserId) — used for
 *  bins reminders and the admin's "send to a whole property"/"send to all" compose options. If
 *  `opts.dedupKeyForTenant` is a function, it's called per-tenant to build that tenant's own
 *  dedupKey (so a bins reminder can be deduped per-property-per-occurrence, per tenant).
 *  Always returns one entry per ELIGIBLE tenant (has an account), `{tenantId, sent}` — so a
 *  caller like the compose form can tell "sent to nobody" (e.g. no resident of that property has
 *  an account yet) apart from "sent successfully", which notify()'s silent fire-and-forget
 *  contract can't distinguish on its own. */
export async function notifyProperty(propertyId, tenantsForProperty, title, body, category, opts) {
  opts = Object.assign({ category: category, propertyId: propertyId }, opts || {});
  const results = [];
  for (const t of tenantsForProperty) {
    if (!t.authUserId) continue;
    const tenantOpts = Object.assign({}, opts, { tenantId: t.id });
    if (opts.dedupKeyForTenant) {
      const r = await notifyOnce(t.authUserId, opts.dedupKeyForTenant(t), title, body, opts.relatedTable, opts.relatedId, tenantOpts);
      results.push({ tenantId: t.id, sent: r.id !== null });
    } else {
      try {
        await notifyOrThrow(t.authUserId, title, body, opts.relatedTable, opts.relatedId, tenantOpts);
        results.push({ tenantId: t.id, sent: true });
      } catch (_e) {
        results.push({ tenantId: t.id, sent: false });
      }
    }
  }
  return results;
}

/** Same as notifyProperty but across every given tenant regardless of property — used for the
 *  admin's "send to all residents" compose option. */
export async function notifyPortfolio(allTenants, title, body, category, opts) {
  return notifyProperty(null, allTenants, title, body, category, opts);
}

export async function cancelScheduled(id) {
  const { error } = await supabase.from('notifications').update({ canceled_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function archive(id) {
  const { error } = await supabase.from('notifications').update({ archived_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

