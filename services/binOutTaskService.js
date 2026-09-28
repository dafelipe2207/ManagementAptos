// services/binOutTaskService.js
// One row per pickup date that lands inside a room's weekly_duty period (see
// weeklyDutyService.js) — the tenant's Bin OUT responsibility for that date, fully independent
// from that same weekly_duty's cleaning_tasks row (see the spec's binding "no combined status"
// rule). pickup_date/bin_types are always derived from trash_schedule at generation time and are
// never hand-edited here — only status/evidence are ever written after creation, and only
// status/completed_at/completed_by_tenant_id/evidence_photo_path (see bin_out_tasks_update RLS,
// which restricts a tenant's own-room update to exactly those effects via the app layer, the same
// trust boundary cleaning_submissions already relies on).
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    weeklyDutyId: row.weekly_duty_id,
    propertyId: row.property_id,
    roomId: row.room_id,
    pickupDate: row.pickup_date,
    binTypes: Array.isArray(row.bin_types) ? row.bin_types : [],
    status: row.status,
    completedAt: row.completed_at,
    completedByTenantId: row.completed_by_tenant_id,
    evidencePhotoPath: row.evidence_photo_path || null,
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('bin_out_tasks').select('*').order('pickup_date', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

/** Bulk-creates bin_out_tasks rows — used by the generator right after it creates the
 *  weekly_duties/cleaning_tasks rows for the same period (see ensureWeeklyDutiesUpToDate). */
export async function createTasksBulk(rows) {
  const userId = await getCurrentUserId();
  const dbRows = rows.map(function(r){
    return {
      user_id: userId, weekly_duty_id: r.weeklyDutyId, property_id: r.propertyId, room_id: r.roomId,
      pickup_date: r.pickupDate, bin_types: r.binTypes
    };
  });
  const { data, error } = await supabase.from('bin_out_tasks').insert(dbRows).select();
  if (error) throw error;
  return data.map(fromRow);
}

/** Concurrency guard: completion/not-completed writes only apply while the stored status is
 *  still open. 0 rows matched (someone else already closed it) → throws a STALE_STATUS error
 *  (err.code === STALE_STATUS_CODE) so the caller can reload instead of silently overwriting. */
const OPEN_STATUSES = ['upcoming', 'due_today', 'overdue'];
export const STALE_STATUS_CODE = 'STALE_STATUS';
function staleStatusError() {
  const err = new Error('This task was already updated elsewhere.');
  err.code = STALE_STATUS_CODE;
  return err;
}

/** Tenant self-confirmation — no admin review step (unlike cleaning), per spec. */
export async function markCompleted(id, tenantId, evidencePhotoPath) {
  const { data, error } = await supabase.from('bin_out_tasks').update({
    status: 'completed', completed_at: new Date().toISOString(), completed_by_tenant_id: tenantId,
    evidence_photo_path: evidencePhotoPath || null
  }).eq('id', id).in('status', OPEN_STATUSES).select().maybeSingle();
  if (error) throw error;
  if (!data) throw staleStatusError();
  return fromRow(data);
}

/** Admin-only manual close of an overdue task — never set automatically. */
export async function markNotCompleted(id) {
  const { data, error } = await supabase.from('bin_out_tasks').update({ status: 'not_completed' })
    .eq('id', id).in('status', OPEN_STATUSES).select().maybeSingle();
  if (error) throw error;
  if (!data) throw staleStatusError();
  return fromRow(data);
}

/** Admin reassigns which room this Bin OUT task belongs to (mirrors
 *  cleaningService.reassignRoom) — resets to 'upcoming'/'due_today'/'overdue' (computed from
 *  pickup_date once status is no longer completed/not_completed) and clears any prior completion,
 *  since it's now a different tenant's responsibility. Unguarded, like reassignRoom above. */
export async function reassignRoom(id, roomId) {
  const { data, error } = await supabase.from('bin_out_tasks').update({
    room_id: roomId, status: 'upcoming', completed_at: null, completed_by_tenant_id: null, evidence_photo_path: null
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}
