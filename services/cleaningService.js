// services/cleaningService.js
// The cleaning organizer: cleaning_tasks (which room's turn it is, on which date), each
// optionally followed by one cleaning_submissions row (the tenant's photos of how it turned
// out) and any number of cleaning_comments (the admin's observations on those photos). RLS
// scopes a tenant's session to just their own room's tasks/submissions/comments — see the
// add_cleaning_and_trash_schedule migration.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function taskFromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id,
    weeklyDutyId: row.weekly_duty_id,
    scheduledDate: row.scheduled_date,
    status: row.status,
    createdAt: row.created_at
  };
}

function submissionFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    propertyId: row.property_id,
    roomId: row.room_id,
    tenantId: row.tenant_id,
    photoPaths: Array.isArray(row.photo_paths) ? row.photo_paths : [],
    note: row.note || '',
    createdAt: row.created_at
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    propertyId: row.property_id,
    roomId: row.room_id,
    authorProfileId: row.author_profile_id || null,
    comment: row.comment,
    createdAt: row.created_at
  };
}

export async function getAllTasks() {
  const { data, error } = await supabase.from('cleaning_tasks').select('*').order('scheduled_date', { ascending: true });
  if (error) throw error;
  return data.map(taskFromRow);
}

export async function getAllSubmissions() {
  const { data, error } = await supabase.from('cleaning_submissions').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(submissionFromRow);
}

export async function getAllComments() {
  const { data, error } = await supabase.from('cleaning_comments').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(commentFromRow);
}

/** Bulk-creates tasks from `rows` ([{propertyId, roomId, scheduledDate}, ...]) — used by the
 *  weekly rotation generator, which spreads one date per week across every room in turn so each
 *  room's turn comes back around every N weeks (N = room count). */
export async function createTasksBulk(rows) {
  const userId = await getCurrentUserId();
  const dbRows = rows.map(function(r){ return { user_id: userId, property_id: r.propertyId, room_id: r.roomId, weekly_duty_id: r.weeklyDutyId, scheduled_date: r.scheduledDate }; });
  const { data, error } = await supabase.from('cleaning_tasks').insert(dbRows).select();
  if (error) throw error;
  return data.map(taskFromRow);
}

/** Thrown when a guarded status write matched 0 rows — someone else (another device, another
 *  admin) already moved the task out of the expected prior status. Callers check
 *  err.code === STALE_STATUS_CODE and reload instead of showing a generic failure. */
export const STALE_STATUS_CODE = 'STALE_STATUS';
function staleStatusError() {
  const err = new Error('This task was already updated elsewhere.');
  err.code = STALE_STATUS_CODE;
  return err;
}

/** `expectedCurrentStatuses` (optional array): the write only applies while the row's stored
 *  status is still one of these — a concurrency guard so a stale view can't silently overwrite a
 *  newer change. 0 rows matched → throws a STALE_STATUS error. */
export async function setTaskStatus(id, status, expectedCurrentStatuses) {
  let query = supabase.from('cleaning_tasks').update({ status }).eq('id', id);
  if (Array.isArray(expectedCurrentStatuses) && expectedCurrentStatuses.length) query = query.in('status', expectedCurrentStatuses);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw error;
  if (!data) throw staleStatusError();
  return taskFromRow(data);
}

/** Only ever offered while the task is effectively 'overdue', which is computed from a stored
 *  'pending'/'in_progress' — guarded on exactly those so it can't clobber a completion. */
export async function markNotCompleted(id) {
  const { data, error } = await supabase.from('cleaning_tasks').update({ status: 'not_completed' })
    .eq('id', id).in('status', ['pending', 'in_progress']).select().maybeSingle();
  if (error) throw error;
  if (!data) throw staleStatusError();
  return taskFromRow(data);
}

export async function removeTask(id) {
  const { error } = await supabase.from('cleaning_tasks').delete().eq('id', id);
  if (error) throw error;
}

/** A tenant's photos for a task — inserts a new submission (a room can be cleaned more than
 *  once before its next scheduled date, so this doesn't upsert). */
export async function createSubmission(taskId, propertyId, roomId, tenantId, photoPaths, note) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('cleaning_submissions').insert({
    user_id: userId, task_id: taskId, property_id: propertyId, room_id: roomId, tenant_id: tenantId,
    photo_paths: photoPaths || [], note: note || null
  }).select().single();
  if (error) throw error;
  return submissionFromRow(data);
}

/** Appends more photos to an existing submission (e.g. the tenant re-opens it to add one they missed). */
export async function addSubmissionPhotos(id, photoPaths) {
  const { data: existing, error: getErr } = await supabase.from('cleaning_submissions').select('photo_paths').eq('id', id).single();
  if (getErr) throw getErr;
  const merged = (Array.isArray(existing.photo_paths) ? existing.photo_paths : []).concat(photoPaths || []);
  const { data, error } = await supabase.from('cleaning_submissions').update({ photo_paths: merged }).eq('id', id).select().single();
  if (error) throw error;
  return submissionFromRow(data);
}

/** Ad-hoc cleaning task creation (e.g. from an inspection finding), independent of the weekly
 *  rotation — same insert path as `createTasksBulk` but `weekly_duty_id` is always null, since
 *  this task isn't tied to a rotation slot (confirmed nullable live; `sync_task_index_cleaning`
 *  doesn't reference weekly_duty_id at all, so it needs no change for a null value here).
 *  `cleaning_tasks` genuinely has no title/description/priority/tenant_id columns, and per spec
 *  §27 ("no duplicar información" — use related entities, don't fork parallel databases per
 *  module) that's intentional: unlike a `maintenance_requests` ticket (its own multi-week
 *  lifecycle with status/priority/resolution notes), an ad-hoc cleaning task is just "clean this
 *  room by this date." The finding's own text stays on the source `inspection_comments` row;
 *  the caller should link the two via `entityLinkService.linkEntities('inspection_comments',
 *  commentId, 'cleaning_tasks', task.id, 'created_from')` (mirroring the existing
 *  inspection_comments -> maintenance_requests link) so a "why" can be shown by following that
 *  link back, rather than duplicating the comment text onto this row. Only `dueDate` (->
 *  scheduled_date) is persisted alongside property/room. */
export async function createAdHocTask(propertyId, roomId, dueDate) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('cleaning_tasks').insert({
    user_id: userId, property_id: propertyId, room_id: roomId, weekly_duty_id: null, scheduled_date: dueDate
  }).select().single();
  if (error) throw error;
  return taskFromRow(data);
}

/** Admin's comment/observation on a task's submitted photos. */
export async function addComment(taskId, propertyId, roomId, authorProfileId, comment) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('cleaning_comments').insert({
    user_id: userId, task_id: taskId, property_id: propertyId, room_id: roomId,
    author_profile_id: authorProfileId || null, comment: comment
  }).select().single();
  if (error) throw error;
  return commentFromRow(data);
}
