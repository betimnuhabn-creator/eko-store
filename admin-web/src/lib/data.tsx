import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n, type TKey } from './i18n';
import { supabase } from './supabase';
import type { AppNotification, Category, Product } from './types';

// ---------------------------------------------------------------------------
// Catalog: products come from list_products() — for an admin it returns both
// prices and stock. The products table itself is not readable through the API.
// ---------------------------------------------------------------------------
const PAGE = 1000;

async function fetchAllProducts(): Promise<Product[]> {
  const all: Product[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc('list_products').range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...((data ?? []) as Product[]));
    if (!data || data.length < PAGE) return all;
  }
}

type CatalogCtx = {
  products: Product[];
  categories: Category[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  byId: (id: string) => Product | undefined;
};
const Catalog = createContext<CatalogCtx | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, c] = await Promise.all([
        fetchAllProducts(),
        supabase.from('categories').select('*').order('sort_order').order('name_sq'),
      ]);
      if (c.error) throw c.error;
      setProducts(p);
      setCategories((c.data ?? []) as Category[]);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const value = useMemo<CatalogCtx>(() => {
    const map = new Map(products.map((p) => [p.id, p]));
    return { products, categories, loading, error, reload, byId: (id) => map.get(id) };
  }, [products, categories, loading, error, reload]);
  return <Catalog.Provider value={value}>{children}</Catalog.Provider>;
}

export function useCatalog() {
  const c = useContext(Catalog);
  if (!c) throw new Error('useCatalog outside provider');
  return c;
}

// ---------------------------------------------------------------------------
// Notifications for this admin, live via Supabase Realtime (RLS: own rows only).
// ---------------------------------------------------------------------------
type NotifCtx = {
  items: AppNotification[];
  unread: number;
  /** Increases with every new notification, so pages can refresh themselves. */
  version: number;
  text: (n: AppNotification) => string;
  link: (n: AppNotification) => string | null;
  markAllRead: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
};
const Notif = createContext<NotifCtx | null>(null);

export function NotificationsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const { t } = useI18n();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [version, setVersion] = useState(0);

  const text = useCallback(
    (n: AppNotification) => {
      const d = { ...n.data } as Record<string, any>;
      if (d.status) d.status = t(`st_${d.status}` as TKey);
      return t(`n_${n.type}` as TKey, d);
    },
    [t],
  );

  useEffect(() => {
    let alive = true;
    supabase
      .from('notifications')
      .select('id,type,data,read_at,created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => alive && setItems((data ?? []) as AppNotification[]));
    const channel = supabase
      .channel(`admin-notifications:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        (payload) => {
          const n = payload.new as AppNotification;
          setItems((xs) => [n, ...xs.filter((x) => x.id !== n.id)]);
          setVersion((v) => v + 1);
          if ('Notification' in window && Notification.permission === 'granted') {
            try {
              new Notification('EKO Store', { body: text(n), icon: './favicon.png' });
            } catch {
              /* ignore */
            }
          }
        },
      )
      .subscribe();
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const value = useMemo<NotifCtx>(
    () => ({
      items,
      unread: items.filter((n) => !n.read_at).length,
      version,
      text,
      link: (n) =>
        n.data?.order_id ? `/orders/${n.data.order_id}` : n.type === 'wholesale_request' || n.type === 'new_customer' ? '/customers' : null,
      markAllRead: async () => {
        await supabase.rpc('mark_notifications_read', { p_ids: null });
        setItems((xs) => xs.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
      },
      markRead: async (id) => {
        await supabase.rpc('mark_notifications_read', { p_ids: [id] });
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, read_at: new Date().toISOString() } : x)));
      },
    }),
    [items, version, text],
  );
  return <Notif.Provider value={value}>{children}</Notif.Provider>;
}

export function useNotifications() {
  const c = useContext(Notif);
  if (!c) throw new Error('useNotifications outside provider');
  return c;
}
