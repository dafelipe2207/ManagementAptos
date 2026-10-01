// lib/auth.js
// Minimal email+password auth. Single admin user for now (architecture
// leaves room for Admin/Property Manager/Tenant roles later, but there is
// no role table yet). Session persistence is handled entirely by
// supabase-js itself (it keeps its own localStorage keys for the auth
// token) — we never touch that storage directly.

import { supabase } from './supabaseClient.js';

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session || null;
}

export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    callback(event, session);
  });
  return data.subscription;
}

/** Changes the CURRENTLY SIGNED-IN user's own password — works for any role (email or
 *  phone-login) since it just updates the active session's account, no email/SMS involved. */
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function getCurrentUserId() {
  const session = await getSession();
  return session ? session.user.id : null;
}

/** Tenants can also sign in with their payment reference (e.g. NOE105). The login-by-reference
 *  Edge Function checks the password server-side and returns a session, which is installed here. */
export function looksLikePaymentReference(raw) {
  return /^[A-Za-z]{2,6}\d{2,6}$/.test((raw || '').trim());
}
export async function signInWithReference(reference, password) {
  const { data, error } = await supabase.functions.invoke('login-by-reference', { body: { reference: reference.trim(), password } });
  if (error) {
    let msg = 'Invalid login credentials';
    try { const b = await error.context.json(); if (b && b.error) msg = b.error; } catch (_e) {}
    throw new Error(msg);
  }
  if (!data || !data.access_token) throw new Error('Invalid login credentials');
  const { error: setErr } = await supabase.auth.setSession({ access_token: data.access_token, refresh_token: data.refresh_token });
  if (setErr) throw setErr;
  return data;
}
