import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Supabase connection — the ONLY place the app reads it.
//
//   EXPO_PUBLIC_SUPABASE_URL              https://<project-ref>.supabase.co
//   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY  sb_publishable_...
//   (EXPO_PUBLIC_SUPABASE_ANON_KEY is still accepted as the older name.)
//
// Values come from .env (local development) or from eas.json / EAS
// environment variables (Android builds). Both are public by design: they
// are compiled into the app and protected by the database's security rules.
// A secret / service_role key must NEVER be used here — the app refuses it.
// ---------------------------------------------------------------------------
const url = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
const key = (process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();

function jwtRole(k: string): string | null {
  try {
    const part = k.split('.')[1];
    if (!part) return null;
    const json = typeof atob === 'function' ? atob(part.replace(/-/g, '+').replace(/_/g, '/')) : '';
    return JSON.parse(json).role ?? null;
  } catch {
    return null;
  }
}

/** Why the configuration is unusable, or null when it is fine. */
export const configProblem: 'missing' | 'secret_key' | 'bad_url' | null = (() => {
  if (!url || !key || /YOUR[_-]?PROJECT|YOUR[_-]/i.test(url + key)) return 'missing';
  if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') return 'secret_key';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2)(:\d+)?\/?$/.test(url)) {
    return 'bad_url';
  }
  return null;
})();

export const isConfigured = configProblem === null;

/** Web only: the address the page was opened with, captured BEFORE supabase-js
 *  reads (and removes) a recovery/confirmation fragment from it. */
export const initialWebUrl: string | null =
  Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.href : null;

export const supabase = createClient(
  isConfigured ? url : 'https://placeholder.supabase.co',
  isConfigured ? key : 'placeholder',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: Platform.OS === 'web',
    },
  },
);

/** Sends queued notifications (push / e-mail). Fire-and-forget. */
export function dispatchNotifications() {
  if (!isConfigured) return;
  supabase.functions.invoke('dispatch-notifications', { body: {} }).catch(() => {});
}
