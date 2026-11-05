import { router } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth';
import { TKey, useI18n } from './i18n';
import { browserNotify, onPushOpened, registerForPush } from './push';
import { supabase } from './supabase';
import type { AppNotification } from './types';

type Ctx = {
  items: AppNotification[];
  unread: number;
  /** Increments on every new notification: screens can use it to refresh. */
  version: number;
  reload: () => Promise<void>;
  markAllRead: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  text: (n: AppNotification) => string;
  link: (n: AppNotification) => string | null;
};

const NotificationsContext = createContext<Ctx | null>(null);

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { session, isAdmin } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [version, setVersion] = useState(0);
  const uid = session?.user.id;

  const text = useCallback(
    (n: AppNotification) => {
      const d = { ...n.data } as Record<string, any>;
      if (d.status) d.status = t(`st_${d.status}` as TKey);
      const key = `n_${n.type}` as TKey;
      return t(key, d);
    },
    [t],
  );

  const link = useCallback(
    (n: AppNotification) => {
      if (n.data.order_id) return isAdmin ? `/admin/orders/${n.data.order_id}` : `/orders/${n.data.order_id}`;
      if (isAdmin && (n.type === 'wholesale_request' || n.type === 'new_customer')) return '/admin/customers';
      if (n.type.startsWith('wholesale_')) return '/account';
      return null;
    },
    [isAdmin],
  );

  const reload = useCallback(async () => {
    if (!uid) {
      setItems([]);
      return;
    }
    const { data } = await supabase
      .from('notifications')
      .select('id,type,data,read_at,created_at')
      .order('created_at', { ascending: false })
      .limit(100);
    setItems((data ?? []) as AppNotification[]);
  }, [uid]);

  useEffect(() => {
    reload();
    if (!uid) return;
    registerForPush();
    const channel = supabase
      .channel(`notifications:${uid}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${uid}` },
        (payload) => {
          const n = payload.new as AppNotification;
          setItems((xs) => [n, ...xs.filter((x) => x.id !== n.id)]);
          setVersion((v) => v + 1);
          browserNotify('EKO Store', text(n));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  useEffect(() => onPushOpened((url) => router.push(url as any)), []);

  const value = useMemo<Ctx>(
    () => ({
      items,
      unread: items.filter((n) => !n.read_at).length,
      version,
      reload,
      text,
      link,
      markAllRead: async () => {
        await supabase.rpc('mark_notifications_read', { p_ids: null });
        setItems((xs) => xs.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
      },
      markRead: async (id) => {
        await supabase.rpc('mark_notifications_read', { p_ids: [id] });
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, read_at: new Date().toISOString() } : x)));
      },
    }),
    [items, version, reload, text, link],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const c = useContext(NotificationsContext);
  if (!c) throw new Error('useNotifications outside provider');
  return c;
}
