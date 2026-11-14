// Admin sets a customer's password through the Edge Function `admin-set-password`.
// The panel never holds a service key: the function checks on the server that
// the caller is the main administrator (secret list + admin role) and
// re-authenticates them with their own password.
import { supabase } from './supabase';

export type SetPasswordError =
  | 'reauth_failed'
  | 'not_allowed'
  | 'target_not_allowed'
  | 'password_length'
  | 'weak_password'
  | 'not_found'
  | 'unavailable'
  | 'network'
  | 'failed';

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: any }> {
  const { data, error } = await supabase.functions.invoke('admin-set-password', { body });
  if (!error) return { ok: true, status: 200, data };
  const ctx = (error as any).context as Response | undefined;
  if (ctx && typeof ctx.status === 'number') {
    const payload = await ctx.json().catch(() => ({}));
    return { ok: false, status: ctx.status, data: payload };
  }
  return { ok: false, status: 0, data: { error: (error as any).name === 'FunctionsFetchError' ? 'network' : 'unavailable' } };
}

/** Is the logged-in user the main administrator for passwords? (false if the function is not deployed) */
export async function canManagePasswords(): Promise<boolean> {
  try {
    const r = await call({ action: 'check' });
    return r.ok && r.data?.allowed === true;
  } catch {
    return false;
  }
}

export async function setCustomerPassword(userId: string, password: string, adminPassword: string): Promise<SetPasswordError | null> {
  try {
    const r = await call({ action: 'set', user_id: userId, password, admin_password: adminPassword });
    if (r.ok && r.data?.ok) return null;
    const code = String(r.data?.error ?? '');
    if (r.status === 404 && code !== 'not_found') return 'unavailable';
    if (['reauth_failed', 'not_allowed', 'target_not_allowed', 'password_length', 'weak_password', 'not_found', 'network', 'unavailable'].includes(code))
      return code as SetPasswordError;
    return 'failed';
  } catch {
    return 'network';
  }
}

/** Strong temporary password: 14 characters, unambiguous, upper + lower + digit + symbol. */
export function generatePassword(length = 14): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;
  const rnd = (n: number) => {
    // Unbiased random index with crypto.getRandomValues.
    const max = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do crypto.getRandomValues(buf);
    while (buf[0] >= max);
    return buf[0] % n;
  };
  const chars = [upper, lower, digits, symbols].map((set) => set[rnd(set.length)]);
  while (chars.length < length) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
