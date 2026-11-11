// Password recovery and password change — shared by the screens.
//
// Flow (Supabase Auth, implicit recovery link):
//   1. resetPasswordForEmail(email, { redirectTo: RESET_PAGE_URL })
//   2. The e-mail link opens Supabase, which verifies it and redirects to the
//      secure web page RESET_PAGE_URL#access_token=…&refresh_token=…&type=recovery
//   3. That page opens the app at ekostore://reset-password#<same tokens>
//      (or lets the customer set the password on the web).
//   4. The app's reset screen turns the tokens into a recovery session
//      (setSession verifies them with Supabase) and calls updateUser({ password }).
// The e-mail can also contain a 6-digit code ({{ .Token }}) as an alternative.
import type { AuthError } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Public web page the e-mail link leads to (must be in Supabase → Auth → URL Configuration → Redirect URLs). */
export const RESET_PAGE_URL = (
  process.env.EXPO_PUBLIC_PASSWORD_RESET_URL || 'https://betimnuhabn-creator.github.io/eko-store/reset-password.html'
).trim();

/** Same minimum as registration and Supabase "Minimum password length". */
export const MIN_PASSWORD_LENGTH = 6;

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

export type ResetRequestResult = 'sent' | 'rate_limited' | 'network';

/**
 * Asks Supabase to send the recovery e-mail. Never reveals whether the
 * address is registered: every outcome except "too many requests" and
 * "no connection" is reported as "sent".
 */
export async function requestPasswordReset(email: string): Promise<ResetRequestResult> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: RESET_PAGE_URL });
    if (!error) return 'sent';
    if (error.status === 429 || /rate limit|too many/i.test(error.message)) return 'rate_limited';
    if (isNetworkError(error)) return 'network';
    return 'sent';
  } catch (e) {
    return isNetworkError(e) ? 'network' : 'sent';
  }
}

export function isNetworkError(e: unknown): boolean {
  const m = String((e as any)?.message ?? e ?? '');
  return /Failed to fetch|Network request failed|NetworkError|AuthRetryableFetchError|network/i.test(m) || (e as any)?.name === 'AuthRetryableFetchError';
}

export type RecoveryParams = {
  accessToken?: string;
  refreshToken?: string;
  type?: string;
  errorCode?: string;
};

/** Reads the recovery tokens (or the error) from ekostore://reset-password#… / ?… */
export function parseRecoveryUrl(url: string | null | undefined): RecoveryParams {
  if (!url) return {};
  const hash = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#')[0] : '';
  const h = new URLSearchParams(hash);
  const q = new URLSearchParams(query);
  const get = (k: string) => h.get(k) ?? q.get(k) ?? undefined;
  return {
    accessToken: get('access_token'),
    refreshToken: get('refresh_token'),
    type: get('type'),
    errorCode: get('error_code') ?? get('error'),
  };
}

export type PasswordProblem = 'too_short' | 'mismatch' | null;

export function passwordProblem(password: string, confirm: string): PasswordProblem {
  if (password.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (password !== confirm) return 'mismatch';
  return null;
}

/** Translation key for an error returned by updateUser / verifyOtp / setSession. */
export function passwordErrorKey(e: AuthError | Error | unknown):
  | 'pwSame'
  | 'pwWeak'
  | 'pwLinkExpired'
  | 'pwRateLimited'
  | 'e_network'
  | 'pwSaveFailed' {
  const code = (e as any)?.code as string | undefined;
  const status = (e as any)?.status as number | undefined;
  const msg = String((e as any)?.message ?? '');
  if (code === 'same_password' || /different from the old/i.test(msg)) return 'pwSame';
  if (code === 'weak_password' || /weak|at least/i.test(msg)) return 'pwWeak';
  if (status === 429 || /rate limit/i.test(msg)) return 'pwRateLimited';
  if (isNetworkError(e)) return 'e_network';
  if (
    code === 'otp_expired' ||
    code === 'session_not_found' ||
    code === 'refresh_token_not_found' ||
    code === 'bad_jwt' ||
    status === 401 ||
    status === 403 ||
    /expired|invalid|not found|missing/i.test(msg)
  )
    return 'pwLinkExpired';
  return 'pwSaveFailed';
}
