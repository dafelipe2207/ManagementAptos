// services/profileService.js
// The logged-in user's role/profile, plus (super_admin only, enforced by RLS) the full user
// list, role/active changes, password resets, and creating brand-new logins. Creating a user
// goes through the `create-user` Edge Function — never supabase.auth.signUp() here, which would
// swap the CALLER's own session for the new user's session.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email,
    phone: row.phone || '',
    role: row.role,
    avatarUrl: row.avatar_url || '',
    isActive: row.is_active,
    createdAt: row.created_at
  };
}

/** The signed-in user's own profile (their role, name, active status), or null if none exists
 *  yet (shouldn't happen for an account created the normal way, but handled defensively). */
export async function getMyProfile() {
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr) throw userErr;
  if (!userData.user) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('auth_user_id', userData.user.id).maybeSingle();
  if (error) throw error;
  return data ? fromRow(data) : null;
}

/** Every user account — only returns rows for a super_admin caller (RLS hides everyone else's
 *  profile from anyone else). */
export async function getAll() {
  const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function setRole(profileId, role) {
  const { data, error } = await supabase.from('profiles').update({ role }).eq('id', profileId).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function setActive(profileId, isActive) {
  const { data, error } = await supabase.from('profiles').update({ is_active: isActive }).eq('id', profileId).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function updateContact(profileId, p) {
  const { data, error } = await supabase.from('profiles').update({
    first_name: p.firstName, last_name: p.lastName, phone: p.phone || null
  }).eq('id', profileId).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Creates a brand-new login (Administrator or Tenant) via the create-user Edge Function.
 *  `tenantId`, if given (role 'tenant'), links the new login to that existing tenant record so
 *  they immediately see their own data. A tenant logs in with their PHONE number (no email
 *  needed) — pass `phone`, not `email`, when role is 'tenant'; the Edge Function derives an
 *  internal email behind the scenes. Throws with a plain message on failure. */
export async function createUser({ email, password, firstName, lastName, phone, role, tenantId }) {
  const res = await supabase.functions.invoke('create-user', {
    body: { email, password, firstName, lastName, phone, role, tenantId: tenantId || null }
  });
  if (res.error) throw await describeFunctionError(res.error);
  if (res.data && res.data.error) throw new Error(res.data.error);
  if (res.data && res.data.warning) return { warning: res.data.warning };
  return res.data;
}

/* ============ Property assignment (which Administrator sees which properties) ============ */
function assignmentFromRow(row) {
  return { id: row.id, propertyId: row.property_id, profileId: row.profile_id };
}

export async function getPropertyAssignments() {
  const { data, error } = await supabase.from('property_administrators').select('*');
  if (error) throw error;
  return data.map(assignmentFromRow);
}

export async function assignProperty(profileId, propertyId) {
  const { data, error } = await supabase.from('property_administrators')
    .insert({ profile_id: profileId, property_id: propertyId }).select().single();
  if (error) throw error;
  return assignmentFromRow(data);
}

export async function unassignProperty(profileId, propertyId) {
  const { error } = await supabase.from('property_administrators')
    .delete().eq('profile_id', profileId).eq('property_id', propertyId);
  if (error) throw error;
}

/** Sends the standard Supabase "reset your password" email to this address. Only works for a
 *  real email inbox — Administrator/Super Admin accounts, not a phone-login Tenant. */
export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

/** For a phone-login Tenant (no email inbox to send a reset link to): Super Admin sets a new
 *  password directly via the reset-password Edge Function, then hands it to the tenant. */
export async function forceSetPassword(profileId, newPassword) {
  const res = await supabase.functions.invoke('reset-password', { body: { profileId, newPassword } });
  if (res.error) throw await describeFunctionError(res.error);
  if (res.data && res.data.error) throw new Error(res.data.error);
  return res.data;
}

async function describeFunctionError(err) {
  try {
    if (err && err.context && typeof err.context.json === 'function') {
      var body = await err.context.clone().json();
      if (body && body.error) return new Error(body.error);
    }
  } catch (_e) { /* fall through */ }
  return err instanceof Error ? err : new Error((err && err.message) || 'Could not reach the server.');
}