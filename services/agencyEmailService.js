// services/agencyEmailService.js
// Follow-up data for the "Correos" page (agency emails). Each agency email is a notification per
// admin (related_table 'agency_email', dedup_key 'agency-email:<gmail id>'); this service reads the
// shared per-email case row (who is responsible, invoice details / linked bill), the last time the
// scheduled Gmail check ran, and the staff list for the "Responsable" picker.
// See supabase/migrations/20261021_agency_email_cases.sql.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(r) {
  return {
    dedupKey: r.dedup_key,
    kind: r.kind || null,
    propertyId: r.property_id || null,
    invoiceNumber: r.invoice_number || '',
    amount: r.amount == null ? null : Number(r.amount),
    dueDate: r.due_date || null,
    billId: r.bill_id || null,
    assignedProfileId: r.assigned_profile_id || null,
    assignedAt: r.assigned_at || null,
    assignedByProfileId: r.assigned_by_profile_id || null,
    linkedTable: r.linked_table || null,
    linkedId: r.linked_id || null,
    linkedAuto: !!r.linked_auto,
    invoiceDoc: r.invoice_doc || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

export async function getCases() {
  const { data, error } = await supabase.from('agency_email_cases').select('*');
  if (error) throw error;
  return data.map(fromRow);
}

export async function getLastCheck() {
  const { data, error } = await supabase.from('agency_email_checks')
    .select('checked_at, emails_found, notified').order('checked_at', { ascending: false }).limit(1);
  if (error) throw error;
  const r = data && data[0];
  return r ? { checkedAt: r.checked_at, emailsFound: r.emails_found, notified: r.notified } : null;
}

export async function getStaff() {
  const { data, error } = await supabase.rpc('agency_email_staff');
  if (error) throw error;
  return (data || []).map((r) => ({ id: r.id, name: r.name || '', role: r.role, authUserId: r.auth_user_id || null }));
}

/** Sets (or clears, with null) who follows up this email. Upserts so an email the scheduled
 *  check saved before case rows existed still gets one. */
export async function assign(dedupKey, profileId, byProfileId, propertyId) {
  const row = {
    dedup_key: dedupKey,
    assigned_profile_id: profileId || null,
    assigned_at: profileId ? new Date().toISOString() : null,
    assigned_by_profile_id: byProfileId || null
  };
  if (propertyId) row.property_id = propertyId;
  const { data, error } = await supabase.from('agency_email_cases')
    .upsert(row, { onConflict: 'dedup_key' }).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Ties the email to what it is about in the app. `target` is { table, id } with table one of
 *  'maintenance_requests' | 'real_estate_inspections' | 'bills', or null to clear. Bills go in
 *  bill_id (so the invoice status keeps working); the others in linked_table/linked_id. */
export async function link(dedupKey, target, byProfileId, propertyId) {
  const row = { dedup_key: dedupKey, linked_auto: false, linked_by_profile_id: byProfileId || null };
  if (propertyId) row.property_id = propertyId;
  if (target && target.table === 'bills') {
    row.bill_id = target.id; row.linked_table = null; row.linked_id = null;
  } else if (target) {
    row.linked_table = target.table; row.linked_id = target.id;
  } else {
    row.linked_table = null; row.linked_id = null; row.bill_id = null;
  }
  const { data, error } = await supabase.from('agency_email_cases')
    .upsert(row, { onConflict: 'dedup_key' }).select().single();
  if (error) throw error;
  return fromRow(data);
}
