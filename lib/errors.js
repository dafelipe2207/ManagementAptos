// lib/errors.js
// Turns a thrown error (from supabase-js, or a plain network failure) into a
// short, user-safe message. Never swallows an error silently — every caller
// is expected to catch and display whatever this returns.

export function friendlyErrorMessage(err) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'No internet connection. Your changes could not be saved.';
  }
  if (!err) return 'Something went wrong. Please try again.';
  // A raw network failure from fetch() (Supabase down, CORS, DNS, offline, etc).
  if (err instanceof TypeError && /fetch|network/i.test(err.message || '')) {
    return 'No internet connection. Your changes could not be saved.';
  }
  const msg = err.message || String(err);
  if (/JWT|not authenticated|401/i.test(msg)) {
    return 'Your session has expired. Please sign in again.';
  }
  if (/row-level security|permission denied|RLS/i.test(msg)) {
    return "You don't have permission to do that (" + msg + ')';
  }
  return msg;
}
