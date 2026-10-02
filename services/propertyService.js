// services/propertyService.js
// Maps the app's camelCase `property` shape ({id, name, address, bedrooms,
// bathrooms, notes, leasePaymentDay, leasePaymentAmount, leaseEndDate,
// leasePaymentMethod, bpayBillerCode, bpayReference, bankAccountName,
// bankBsb, bankAccountNumber, hasParking, parkingCost, parkingTenantId,
// binDutyRequired})
// to/from the `properties` table. Every create() sets user_id explicitly
// from the current session (RLS requires it).
//
// hasParking/parkingCost/parkingTenantId just record that the property has a
// parking spot, what it costs (optional) and which tenant is charged for it —
// it's informational only and doesn't generate a rent charge on its own.
//
// The lease* / bpay* / bank* fields are about the LANDLORD's own lease with
// the real estate agent for this property (when the admin themselves rents
// the property and sub-lets rooms) — separate from what tenants pay the
// admin. All optional: a property with none of these set just won't show a
// lease-payment reminder.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    name: row.name,
    address: row.address || '',
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    notes: row.notes || '',
    leasePaymentDay: row.lease_payment_day || null,
    leasePaymentAmount: row.lease_payment_amount != null ? Number(row.lease_payment_amount) : null,
    leasePaymentFrequency: row.lease_payment_frequency || 'monthly',
    leaseEndDate: row.lease_end_date || null,
    leasePaymentMethod: row.lease_payment_method || null,
    nextInspectionDate: row.next_inspection_date || null,
    lastLeasePaymentDate: row.last_lease_payment_date || null,
    bpayBillerCode: row.bpay_biller_code || '',
    bpayReference: row.bpay_reference || '',
    bankAccountName: row.bank_account_name || '',
    bankBsb: row.bank_bsb || '',
    bankAccountNumber: row.bank_account_number || '',
    whatsappGroupLink: row.whatsapp_group_link || '',
    wifiSsid: row.wifi_ssid || '',
    wifiPassword: row.wifi_password || '',
    wifiNotes: row.wifi_notes || '',
    hasParking: !!row.has_parking,
    parkingCost: row.parking_cost != null ? Number(row.parking_cost) : null,
    parkingTenantId: row.parking_tenant_id || null,
    binDutyRequired: row.bin_duty_required !== false
  };
}

function toRow(p) {
  return {
    name: p.name,
    address: p.address,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    notes: p.notes || null,
    lease_payment_day: p.leasePaymentDay || null,
    lease_payment_amount: p.leasePaymentAmount != null && p.leasePaymentAmount !== '' ? p.leasePaymentAmount : null,
    lease_payment_frequency: p.leasePaymentFrequency === 'fortnightly' ? 'fortnightly' : 'monthly',
    lease_end_date: p.leaseEndDate || null,
    lease_payment_method: p.leasePaymentMethod || null,
    next_inspection_date: p.nextInspectionDate || null,
    last_lease_payment_date: p.lastLeasePaymentDate || null,
    bpay_biller_code: p.bpayBillerCode || null,
    bpay_reference: p.bpayReference || null,
    bank_account_name: p.bankAccountName || null,
    bank_bsb: p.bankBsb || null,
    bank_account_number: p.bankAccountNumber || null,
    whatsapp_group_link: p.whatsappGroupLink || null,
    wifi_ssid: p.wifiSsid ? String(p.wifiSsid).trim() : null,
    wifi_password: p.wifiPassword || null,
    wifi_notes: p.wifiNotes || null,
    has_parking: !!p.hasParking,
    parking_cost: p.hasParking && p.parkingCost != null && p.parkingCost !== '' ? p.parkingCost : null,
    parking_tenant_id: p.hasParking && p.parkingTenantId ? p.parkingTenantId : null,
    bin_duty_required: p.binDutyRequired !== false
  };
}

// Columns safe to hand to a tenant session: never the landlord's own lease/bank/bpay details with
// the real estate agent — a tenant should never see what's paid to the real estate, or how.
const TENANT_SAFE_COLUMNS = 'id, name, address, bedrooms, bathrooms, notes, whatsapp_group_link, wifi_ssid, wifi_password, wifi_notes, has_parking, parking_cost, parking_tenant_id, created_at';

/** `restricted: true` (pass for a tenant session) fetches only tenant-safe columns from the
 *  server itself — not just hiding them in the UI — so the real-estate lease/bpay/bank fields
 *  never reach a tenant's browser at all. */
export async function getAll(restricted) {
  const { data, error } = await supabase.from('properties').select(restricted ? TENANT_SAFE_COLUMNS : '*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(p) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('properties').insert(
    Object.assign({ user_id: userId }, toRow(p))
  ).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, p) {
  const { data, error } = await supabase.from('properties').update(toRow(p)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('properties').delete().eq('id', id);
  if (error) throw error;
}
