import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { StatusBadge } from '../../components/StatusBadge';
import { Button, Card, Empty, Loading, ListItem, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { dateTime, money } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useNotifications } from '../../lib/notifications';
import { supabase } from '../../lib/supabase';
import type { Order } from '../../lib/types';

export default function MyOrdersScreen() {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const { version } = useNotifications();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(false);
  const uid = session?.user.id;

  const load = useCallback(async () => {
    if (!uid) return;
    setLoading(true);
    const { data } = await supabase
      .from('orders')
      .select('*')
      .eq('customer_id', uid)
      .order('created_at', { ascending: false })
      .limit(200);
    setOrders((data ?? []) as Order[]);
    setLoading(false);
  }, [uid]);

  useFocusEffect(useCallback(() => void load(), [load]));
  useEffect(() => void load(), [version, load]);

  if (!session) {
    return (
      <Screen>
        <Empty icon="receipt-outline" text={t('guestAccount')} />
        <Button title={t('login')} onPress={() => router.push('/login')} />
      </Screen>
    );
  }
  if (!orders) return <Loading />;
  if (orders.length === 0) return <Empty icon="receipt-outline" text={t('noOrders')} />;

  return (
    <Screen refreshing={loading} onRefresh={load}>
      <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
        {orders.map((o) => (
          <ListItem
            key={o.id}
            title={`#${o.order_number} · ${money(o.total)}`}
            subtitle={`${dateTime(o.created_at, lang)} · ${o.item_count} ${t('items').toLowerCase()}`}
            right={<StatusBadge status={o.status} />}
            onPress={() => router.push(`/orders/${o.id}`)}
          />
        ))}
      </Card>
    </Screen>
  );
}
