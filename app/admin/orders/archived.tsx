import { router, Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { AdminOnly } from '../../../components/AdminOnly';
import { StatusBadge } from '../../../components/StatusBadge';
import { Banner, Button, Card, Empty, ListItem, Loading, Screen } from '../../../components/ui';
import { confirmAction, showMessage } from '../../../lib/dialog';
import { dateTime, money } from '../../../lib/format';
import { errorText, useI18n } from '../../../lib/i18n';
import { archiveSupported, restoreOrder } from '../../../lib/orderActions';
import { supabase } from '../../../lib/supabase';
import type { Order } from '../../../lib/types';

function Archived() {
  const { t, lang } = useI18n();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const ok = await archiveSupported();
    setSupported(ok);
    if (ok) {
      const { data } = await supabase
        .from('orders')
        .select('*, profiles(email,full_name,business_name,phone)')
        .not('archived_at', 'is', null)
        .order('archived_at', { ascending: false })
        .limit(500);
      setOrders((data ?? []) as Order[]);
    } else setOrders([]);
    setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  async function restore(o: Order) {
    if (!(await confirmAction(t('restoreOrder'), t('restoreConfirm', { n: o.order_number }), t('restoreOrder'), t('cancel')))) return;
    setBusy(o.id);
    try {
      await restoreOrder(o.id);
      showMessage(t('orderRestored', { n: o.order_number }));
      await load();
    } catch (e) {
      showMessage(t('error'), errorText(t, e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Screen refreshing={loading} onRefresh={load}>
      <Stack.Screen options={{ title: t('archivedOrders') }} />
      <Banner text={t('archivedHint')} />
      {!orders ? (
        <Loading />
      ) : !supported || orders.length === 0 ? (
        <Empty icon="archive-outline" text={t('noArchived')} />
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
          {orders.map((o) => (
            <View key={o.id} testID={`archived-${o.order_number}`}>
              <ListItem
                title={`#${o.order_number} · ${o.profiles?.business_name || o.delivery_name} · ${money(o.total)}`}
                subtitle={`${t('archivedOn')} ${o.archived_at ? dateTime(o.archived_at, lang) : ''}`}
                right={<StatusBadge status={o.status} />}
                onPress={() => router.push(`/admin/orders/${o.id}`)}
              />
              <View style={{ paddingHorizontal: 14, paddingBottom: 10, backgroundColor: '#fff', alignItems: 'flex-start' }}>
                <Button small variant="secondary" icon="arrow-undo-outline" title={t('restoreOrder')} onPress={() => restore(o)} loading={busy === o.id} testID={`restore-${o.order_number}`} />
              </View>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <Archived />
    </AdminOnly>
  );
}
