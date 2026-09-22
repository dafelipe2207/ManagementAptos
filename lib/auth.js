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
