import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ORDER_SELECT, OrderView } from '../../components/OrderView';
import { Button, Empty, Loading, Screen } from '../../components/ui';
import { confirmAction, showMessage } from '../../lib/dialog';
import { errorText, useI18n } from '../../lib/i18n';
import { useNotifications } from '../../lib/notifications';
import { dispatchNotifications, supabase } from '../../lib/supabase';
import type { Order } from '../../lib/types';

export default function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const { version } = useNotifications();
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from('orders').select(ORDER_SELECT).eq('id', String(id)).maybeSingle();
    setOrder((data as Order) ?? null);
  }, [id]);
  useEffect(() => void load(), [load, version]);

  if (order === undefined) return <Loading />;
  if (!order) return <Empty text={t('noOrders')} />;

  async function cancel() {
    if (!(await confirmAction(t('cancelOrder'), t('cancelOrderConfirm'), t('yes'), t('no')))) return;
    setBusy(true);
    const { error } = await supabase.rpc('cancel_my_order', { p_order: order!.id });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    dispatchNotifications();
    showMessage(t('orderCancelled'));
    load();
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: `${t('order')} #${order.order_number}` }} />
      <OrderView order={order}>
        {order.status === 'new' && (
          <Button variant="danger" icon="close-circle-outline" title={t('cancelOrder')} onPress={cancel} loading={busy} />
        )}
      </OrderView>
    </Screen>
  );
}
