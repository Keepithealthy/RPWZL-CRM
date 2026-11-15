import { createClient } from '@supabase/supabase-js';
import { API_SCHEMA } from './contract';

// The only key allowed in the browser is the publishable key. All data access goes through RPCs in the `api` schema.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabaseConfigured = Boolean(url && key);

export const supabase = createClient(url ?? 'http://127.0.0.1:54321', key ?? 'missing-key', {
  db: { schema: API_SCHEMA },
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});
