import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Text } from 'react-native';
import { AdminOnly } from '../../../components/AdminOnly';
import { ORDER_SELECT, OrderView } from '../../../components/OrderView';
import { Button, Card, Chip, Empty, Field, H2, Loading, Muted, Row, Screen } from '../../../components/ui';
import { showMessage } from '../../../lib/dialog';
import { errorText, TKey, useI18n } from '../../../lib/i18n';
import { useNotifications } from '../../../lib/notifications';
import { dispatchNotifications, supabase } from '../../../lib/supabase';
import { colors } from '../../../lib/theme';
import { ORDER_STATUSES, Order, OrderStatus } from '../../../lib/types';

function AdminOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const { version } = useNotifications();
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  const [status, setStatus] = useState<OrderStatus>('new');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from('orders').select(ORDER_SELECT).eq('id', String(id)).maybeSingle();
    const o = (data as Order) ?? null;
    setOrder(o);
    if (o) {
      setStatus(o.status);
      setNote(o.admin_note);
    }
  }, [id]);
  useEffect(() => void load(), [load, version]);

  if (order === undefined) return <Loading />;
  if (!order) return <Empty text={t('noOrders')} />;

  async function save() {
    setBusy(true);
    const { error } = await supabase.rpc('admin_set_order_status', { p_order: order!.id, p_status: status, p_note: note });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    dispatchNotifications();
    showMessage(t('saved'));
    load();
  }

  const c = order.profiles;
  return (
    <Screen style={{ maxWidth: 820 }}>
      <Stack.Screen options={{ title: `${t('order')} #${order.order_number}` }} />
      <OrderView order={order}>
        <Card>
          <H2>{t('customer')}</H2>
          {c ? (
            <>
              <Text style={{ color: colors.text, fontWeight: '600' }}>{c.business_name || c.full_name}</Text>
              <Muted>
                {c.email} · {c.phone}
              </Muted>
            </>
          ) : (
            <Muted>{t('deletedCustomer')}</Muted>
          )}
          <Row>
            <Button small variant="secondary" icon="call-outline" title={t('call')} onPress={() => Linking.openURL(`tel:${order.delivery_phone}`)} />
            {c?.email && (
              <Button small variant="secondary" icon="mail-outline" title={t('email')} onPress={() => Linking.openURL(`mailto:${c.email}`)} />
            )}
          </Row>
        </Card>
        <Card>
          <H2>{t('changeStatus')}</H2>
          <Row>
            {ORDER_STATUSES.map((s) => (
              <Chip key={s} label={t(`st_${s}` as TKey)} active={status === s} onPress={() => setStatus(s)} />
            ))}
          </Row>
          <Field label={t('adminNote')} value={note} onChangeText={setNote} multiline autoCapitalize="sentences" />
          <Button title={t('save')} icon="save-outline" onPress={save} loading={busy} testID="order-save" />
        </Card>
      </OrderView>
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <AdminOrder />
    </AdminOnly>
  );
}
