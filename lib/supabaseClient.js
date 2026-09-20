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
    detectSessionInUrl: false
  }
});
