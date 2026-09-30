// services/realEstateInspectionService.js
// Inspections booked by the real estate agency for a property. Staff schedule them; the
// property's tenants can read them (RLS) so they know when the agent is coming.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    date: row.inspection_date,
    startTime: row.start_time ? String(row.start_time).slice(0, 5) : '',
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : '',
    agency: row.agency || '',
    notes: row.notes || '',
    status: row.status,
    outcome: row.outcome || '',
    notifiedAt: row.notified_at || null,
    createdAt: row.created_at
  };
}
function toRow(i) {
  return {
    property_id: i.propertyId,
    inspection_date: i.date,
    start_time: i.startTime || null,
    end_time: i.endTime || null,
    agency: i.agency || null,
    notes: i.notes || null,
    outcome: i.outcome || null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('real_estate_inspections').select('*').order('inspection_date', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}
export async function create(i, createdByProfileId) {
  const { data, error } = await supabase.from('real_estate_inspections')
    .insert(Object.assign(toRow(i), { created_by_profile_id: createdByProfileId || null })).select().single();
  if (error) throw error;
  return fromRow(data);
}
export async function update(id, i) {
  const { data, error } = await supabase.from('real_estate_inspections').update(toRow(i)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}
export async function setStatus(id, status) {
  const { data, error } = await supabase.from('real_estate_inspections').update({ status: status }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}
export async function markNotified(id) {
  const { data, error } = await supabase.from('real_estate_inspections').update({ notified_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}
/** Keeps the property's own "Next inspection" field (shown on the property page) in step. */
export async function syncPropertyNextDate(propertyId, dateOrNull) {
  const { error } = await supabase.from('properties').update({ next_inspection_date: dateOrNull }).eq('id', propertyId);
  if (error) throw error;
}
/** Cancels the not-yet-sent "tomorrow" reminders for an inspection (identified by dedup key). */
export async function cancelReminders(inspectionId) {
  const { error } = await supabase.from('notifications').update({ canceled_at: new Date().toISOString() })
    .like('dedup_key', 'rei-remind-' + inspectionId + '%').is('canceled_at', null).gt('scheduled_for', new Date().toISOString());
  if (error) throw error;
}
