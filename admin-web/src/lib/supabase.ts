import { createClient } from '@supabase/supabase-js';

// The admin panel uses the SAME public settings as the Android app: the
// project URL and the publishable key. All permissions are enforced by the
// database (RLS + admin-only functions), not by this code.
const url = (import.meta.env.VITE_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim();

function jwtRole(k: string): string | null {
  try {
    return JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role ?? null;
  } catch {
    return null;
  }
}

export const configProblem: 'missing' | 'secret_key' | null =
  !url || !key ? 'missing' : key.startsWith('sb_secret_') || jwtRole(key) === 'service_role' ? 'secret_key' : null;

export const supabase = createClient(configProblem ? 'https://placeholder.supabase.co' : url, configProblem ? 'placeholder' : key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    // Separate storage key from the customer web app on the same domain.
    storageKey: 'eko-admin-auth',
  },
});

/** Ask the Edge Function to deliver queued push / e-mail notifications. */
export function dispatchNotifications() {
  supabase.functions.invoke('dispatch-notifications', { body: {} }).catch(() => {});
}

export const PRODUCT_BUCKET = 'product-images';
