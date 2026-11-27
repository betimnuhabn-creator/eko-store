import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { AdminOnly } from '../../../components/AdminOnly';
import { StatusBadge } from '../../../components/StatusBadge';
import { Button, Card, Chip, Empty, ListItem, Loading, Screen } from '../../../components/ui';
import { dateTime, money } from '../../../lib/format';
import { TKey, useI18n } from '../../../lib/i18n';
import { useNotifications } from '../../../lib/notifications';
import { archiveSupported } from '../../../lib/orderActions';
import { supabase } from '../../../lib/supabase';
import { ORDER_STATUSES, Order, OrderStatus } from '../../../lib/types';

function OrdersAdmin() {
  const params = useLocalSearchParams<{ status?: string }>();
  const { t, lang } = useI18n();
  const { version } = useNotifications();
  const [status, setStatus] = useState<OrderStatus | null>((params.status as OrderStatus) ?? null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [archiveDb, setArchiveDb] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const supported = await archiveSupported();
    setArchiveDb(supported);
    let q = supabase
      .from('orders')
      .select('*, profiles(email,full_name,business_name,phone)')
      .order('created_at', { ascending: false })
      .limit(300);
    if (supported) q = q.is('archived_at', null); // archived orders have their own screen
    if (status) q = q.eq('status', status);
    const { data } = await q;
    setOrders((data ?? []) as Order[]);
    setLoading(false);
  }, [status]);

  useFocusEffect(useCallback(() => void load(), [load]));
  useEffect(() => void load(), [version, load]);

  return (
    <Screen refreshing={loading} onRefresh={load}>
      <Stack.Screen options={{ title: t('manageOrders') }} />
      {archiveDb && (
        <Button variant="secondary" small icon="archive-outline" title={t('archivedOrders')} onPress={() => router.push('/admin/orders/archived')} testID="open-archive" />
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Chip label={t('all')} active={!status} onPress={() => setStatus(null)} />
        {ORDER_STATUSES.map((s) => (
          <Chip key={s} label={t(`st_${s}` as TKey)} active={status === s} onPress={() => setStatus(s)} />
        ))}
      </ScrollView>
      {!orders ? (
        <Loading />
      ) : orders.length === 0 ? (
        <Empty icon="receipt-outline" text={t('noOrders')} />
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
          {orders.map((o) => (
            <ListItem
              key={o.id}
              title={`#${o.order_number} · ${o.profiles?.business_name || o.delivery_name} · ${money(o.total)}`}
              subtitle={`${dateTime(o.created_at, lang)} · ${o.delivery_city} · ${t(`tier_${o.price_tier}` as TKey)}`}
              right={<StatusBadge status={o.status} />}
              onPress={() => router.push(`/admin/orders/${o.id}`)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <OrdersAdmin />
    </AdminOnly>
  );
}
