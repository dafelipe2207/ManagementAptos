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

/** Creates one task per date in `dates` (an array of 'YYYY-MM-DD' strings) for the same
 *  room — used by the "repeat weekly for N weeks" helper in the schedule form as much as for a
 *  single one-off date. */
export async function createTasks(propertyId, roomId, dates) {
  const userId = await getCurrentUserId();
  const rows = dates.map(function(d){ return { user_id: userId, property_id: propertyId, room_id: roomId, scheduled_date: d }; });
  const { data, error } = await supabase.from('cleaning_tasks').insert(rows).select();
  if (error) throw error;
  return data.map(taskFromRow);
}

export async function setTaskStatus(id, status) {
  const { data, error } = await supabase.from('cleaning_tasks').update({ status }).eq('id', id).select().single();
  if (error) throw error;
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
