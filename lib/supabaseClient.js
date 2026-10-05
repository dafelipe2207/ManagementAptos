// lib/supabaseClient.js
// Creates and exports a single shared Supabase client for the whole app.
// This is a static site (no bundler, no build step) so the Supabase JS
// client is imported directly from a CDN as an ES module, and the project
// URL / publishable (anon) key are hardcoded here. The anon key is safe to
// ship in client-side code: Row Level Security on every table is what
// actually protects the data, not secrecy of this key.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://iikdscwhwtkhlzzmqwur.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1go__JoGOVrJUkVI6RsB7A_y69A-KNT';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    // Run auth work in-process instead of through the browser's cross-tab lock (navigator.locks).
    // With the app open in more than one tab, that lock can get stuck and every later request
    // (e.g. deleting a bill) waits forever without ever reaching the server.
    lock: async (_name, _acquireTimeout, fn) => await fn()
  }
});

// ---------- View-only (Viewer role) guard ----------
// A Viewer can see everything for their assigned properties but change nothing. The database
// already refuses their writes (RLS); this stops them earlier, in the browser, with a clear message
// instead of a raw permission error. Switched on by the app right after loading the profile.
let viewOnly = false;
export function setViewOnly(on) { viewOnly = !!on; }
export function isViewOnly() { return viewOnly; }
export const VIEW_ONLY_MESSAGE = 'View-only access — you can see everything but can\'t make changes.';
function viewOnlyError() { const e = new Error(VIEW_ONLY_MESSAGE); e.code = 'VIEW_ONLY'; return e; }
// Read-only calls a viewer still needs (recording their own sign-in for the audit log).
const VIEWER_ALLOWED_RPC = ['log_app_login'];

const realFrom = supabase.from.bind(supabase);
supabase.from = function (table) {
  const qb = realFrom(table);
  if (!viewOnly) return qb;
  ['insert', 'update', 'upsert', 'delete'].forEach(function (m) {
    qb[m] = function () { return Promise.resolve({ data: null, error: viewOnlyError() }); };
  });
  return qb;
};
const realRpc = supabase.rpc.bind(supabase);
supabase.rpc = function (fn, args, opts) {
  if (viewOnly && VIEWER_ALLOWED_RPC.indexOf(fn) < 0) return Promise.resolve({ data: null, error: viewOnlyError() });
  return realRpc(fn, args, opts);
};
const realStorageFrom = supabase.storage.from.bind(supabase.storage);
supabase.storage.from = function (bucket) {
  const b = realStorageFrom(bucket);
  if (!viewOnly) return b;
  ['upload', 'update', 'remove', 'move', 'copy', 'uploadToSignedUrl'].forEach(function (m) {
    b[m] = function () { return Promise.resolve({ data: null, error: viewOnlyError() }); };
  });
  return b;
};
const realInvoke = supabase.functions.invoke.bind(supabase.functions);
supabase.functions.invoke = function (name, opts) {
  if (viewOnly) return Promise.resolve({ data: null, error: viewOnlyError() });
  return realInvoke(name, opts);
};
