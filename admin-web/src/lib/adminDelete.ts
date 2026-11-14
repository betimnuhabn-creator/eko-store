// Klientët → Fshi klientin, through the Edge Function `delete-account`.
// The panel never holds a service key: the function checks on the server that
// the caller is an administrator, re-authenticates them with their own password
// and refuses administrator accounts.
import { supabase } from './supabase';

export type DeleteError = 'reauth_failed' | 'not_allowed' | 'target_not_allowed' | 'not_found' | 'unavailable' | 'network' | 'failed';
export type DeletePreview = { name: string; business_name: string; email: string; orders: number; open_orders: number };

async function call(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: any }> {
  const { data, error } = await supabase.functions.invoke('delete-account', { body });
  if (!error) return { ok: true, status: 200, data };
  const ctx = (error as any).context as Response | undefined;
  if (ctx && typeof ctx.status === 'number') {
    const payload = await ctx.json().catch(() => ({}));
    return { ok: false, status: ctx.status, data: payload };
  }
  return { ok: false, status: 0, data: { error: (error as any).name === 'FunctionsFetchError' ? 'network' : 'unavailable' } };
}

function errorOf(r: { status: number; data: any }): DeleteError {
  const code = String(r.data?.error ?? '');
  if (r.status === 404 && code !== 'not_found') return 'unavailable';
  return (['reauth_failed', 'not_allowed', 'target_not_allowed', 'not_found', 'network', 'unavailable'].includes(code) ? code : 'failed') as DeleteError;
}

/** Name, e-mail and order counts, as the server sees them. */
export async function previewDeletion(userId: string): Promise<DeletePreview | DeleteError> {
  try {
    const r = await call({ action: 'preview', user_id: userId });
    return r.ok ? (r.data as DeletePreview) : errorOf(r);
  } catch {
    return 'network';
  }
}

export async function deleteCustomer(userId: string, adminPassword: string): Promise<{ orders_kept: number } | DeleteError> {
  try {
    const r = await call({ action: 'admin_delete', user_id: userId, admin_password: adminPassword });
    return r.ok && r.data?.ok ? { orders_kept: Number(r.data.orders_kept ?? 0) } : errorOf(r);
  } catch {
    return 'network';
  }
}
