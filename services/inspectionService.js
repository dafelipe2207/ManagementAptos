// services/inspectionService.js
// Move-in / move-out condition photos: a tenant photographs how they received the room, and
// again how they left it. RLS scopes a tenant's session to just their own submissions — see the
// add_inspection_submissions migration.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id,
    tenantId: row.tenant_id,
    type: row.type, // 'move_in' | 'move_out'
    photoPaths: Array.isArray(row.photo_paths) ? row.photo_paths : [],
    note: row.note || '',
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('inspection_submissions').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(propertyId, roomId, tenantId, type, photoPaths, note) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('inspection_submissions').insert({
    user_id: userId, property_id: propertyId, room_id: roomId, tenant_id: tenantId,
    type: type, photo_paths: photoPaths || [], note: note || null
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

/* ---------- Admin comments on a tenant's move-in/move-out photos (mirrors cleaningService's
   task comments, just keyed by tenant+type instead of a cleaning task id). ---------- */
function commentFromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id,
    tenantId: row.tenant_id,
    type: row.type,
    authorProfileId: row.author_profile_id || null,
    comment: row.comment,
    findingSeverity: row.finding_severity || null, // null | 'attention' | 'failed'
    createdAt: row.created_at
  };
}

export async function getAllComments() {
  const { data, error } = await supabase.from('inspection_comments').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(commentFromRow);
}

export async function addComment(propertyId, roomId, tenantId, type, authorProfileId, comment, findingSeverity) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('inspection_comments').insert({
    user_id: userId, property_id: propertyId, room_id: roomId, tenant_id: tenantId,
    type: type, author_profile_id: authorProfileId || null, comment: comment,
    finding_severity: findingSeverity || null // null | 'attention' | 'failed'
  }).select().single();
  if (error) throw error;
  return commentFromRow(data);
}
