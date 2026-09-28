// services/maintenanceService.js
// Maintenance/repair requests. A tenant can create their own (report a problem) and see only
// their own; staff (super_admin/administrator) see and manage every request — RLS enforces both
// sides, this file just maps camelCase <-> snake_case.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id || null,
    tenantId: row.tenant_id || null,
    title: row.title,
    description: row.description || '',
    category: row.category,
    priority: row.priority,
    photoPath: row.photo_path || null,
    // Multiple photos, most-recent-last — falls back to the single legacy photo_path (pre
    // multi-photo support) so old requests still show their one photo.
    photoPaths: Array.isArray(row.photo_paths) && row.photo_paths.length ? row.photo_paths : (row.photo_path ? [row.photo_path] : []),
    // Before/during/after staged photos (Phase 1) — jsonb columns default to '[]', so a plain
    // Array.isArray guard is enough (no legacy single-array fallback needed, unlike photoPaths).
    photosBefore: Array.isArray(row.photos_before) ? row.photos_before : [],
    photosDuring: Array.isArray(row.photos_during) ? row.photos_during : [],
    photosAfter: Array.isArray(row.photos_after) ? row.photos_after : [],
    status: row.status,
    assignedTo: row.assigned_to || null,
    dueDate: row.due_date || null,
    resolutionNotes: row.resolution_notes || '',
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toRow(m) {
  return {
    property_id: m.propertyId,
    room_id: m.roomId || null,
    tenant_id: m.tenantId || null,
    title: m.title,
    description: m.description || null,
    category: m.category || 'other',
    priority: m.priority || 'medium',
    // photo_path/photo_paths (the old flat single-array shape) are intentionally not written
    // here anymore — they stay in the DB as read-only historical data (Phase 1 replaced them
    // with the 3 staged arrays below).
    photos_before: m.photosBefore || [],
    photos_during: m.photosDuring || [],
    photos_after: m.photosAfter || [],
    status: m.status || 'reported',
    assigned_to: m.assignedTo || null,
    due_date: m.dueDate || null,
    resolution_notes: m.resolutionNotes || null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('maintenance_requests').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(m) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('maintenance_requests').insert(
    Object.assign({ created_by: userId }, toRow(m))
  ).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, m) {
  const { data, error } = await supabase.from('maintenance_requests').update(toRow(m)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('maintenance_requests').delete().eq('id', id);
  if (error) throw error;
}
