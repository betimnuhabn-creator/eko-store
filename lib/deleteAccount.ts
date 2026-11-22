// Calls the Edge Function `delete-account` (the deletion runs on the server;
// the app never holds a service key) and turns its answer into an error code.
import { supabase } from './supabase';

export type DeleteErrorCode =
  | 'reauth_failed'
  | 'admin_cannot_delete'
  | 'not_allowed'
  | 'target_not_allowed'
  | 'not_found'
  | 'unavailable'
  | 'network'
  | 'failed';
const KNOWN: DeleteErrorCode[] = ['reauth_failed', 'admin_cannot_delete', 'not_allowed', 'target_not_allowed', 'not_found'];

export async function callDeleteAccount(body: Record<string, unknown>): Promise<{ data: any; error: DeleteErrorCode | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('delete-account', { body });
    if (!error) return { data, error: null };
    const ctx = (error as any).context as Response | undefined;
    if (ctx && typeof ctx.status === 'number') {
      const payload = await ctx.json().catch(() => ({}));
      const c = String(payload?.error ?? '') as DeleteErrorCode;
      if (KNOWN.includes(c)) return { data: payload, error: c };
      return { data: payload, error: ctx.status === 404 ? 'unavailable' : 'failed' };
    }
    return { data: null, error: (error as any).name === 'FunctionsFetchError' ? 'network' : 'unavailable' };
  } catch {
    return { data: null, error: 'network' };
  }
}
