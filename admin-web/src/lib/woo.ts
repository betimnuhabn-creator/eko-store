// Website (WooCommerce, eko-store.com) ⇄ app: status, "sync now", orders switch.
// The sync itself runs in the Edge Function `woo-sync`; the panel never holds
// a WooCommerce key.
import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export type WooStatus = {
  orders_enabled: boolean;
  last_sync_at: string | null;
  last_sync: { created?: number; updated?: number; deactivated?: number; errors?: unknown[]; products?: number } | null;
  functions_url_set: boolean;
  products: number;
  products_active: number;
  products_no_retail: number;
  orders_pending: number;
  orders_sent: number;
  orders_failed: number;
  last_order_error: string | null;
};

/** null when the website sync is not installed in the database yet. */
export async function fetchWooStatus(): Promise<WooStatus | null> {
  const { data, error } = await supabase.rpc('admin_woo_status');
  return error ? null : (data as WooStatus);
}

export async function syncNow(): Promise<{ ok: true; result: any } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('woo-sync', { body: { action: 'sync' } });
    if (!error) {
      if (data?.skipped === 'not_configured') return { ok: false, error: 'not_configured' };
      return { ok: true, result: data?.result };
    }
    const ctx = (error as any).context as Response | undefined;
    if (ctx && typeof ctx.status === 'number') {
      const body = await ctx.json().catch(() => ({}));
      return { ok: false, error: ctx.status === 404 && !body?.error ? 'not_deployed' : String(body?.error ?? 'failed') };
    }
    return { ok: false, error: (error as any).name === 'FunctionsFetchError' ? 'network' : 'not_deployed' };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export async function setOrdersEnabled(on: boolean) {
  const { error } = await supabase.rpc('admin_woo_set_orders', { p_enabled: on });
  if (error) throw error;
}

export async function retryOrders(): Promise<number> {
  const { data, error } = await supabase.rpc('admin_woo_retry_orders');
  if (error) throw error;
  return Number(data ?? 0);
}

/** Ids of the app products that come from the website. */
export function useWooProductIds(version = 0): Set<string> {
  const [ids, setIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    supabase.rpc('admin_woo_products').then(({ data, error }) => {
      if (!error && Array.isArray(data)) setIds(new Set(data.map((x: any) => (typeof x === 'string' ? x : x?.admin_woo_products ?? x?.id))));
    });
  }, [version]);
  return ids;
}
