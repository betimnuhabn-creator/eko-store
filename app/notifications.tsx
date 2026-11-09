import { router, Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Button, Card, Chip, Empty, ListItem, Row, Screen } from '../components/ui';
import { dateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { useNotifications } from '../lib/notifications';

export default function NotificationsScreen() {
  const { t, lang } = useI18n();
  const { items, unread, reload, markAllRead, markRead, text, link } = useNotifications();
  useFocusEffect(useCallback(() => void reload(), [reload]));
  // Order notifications and promotional ones are shown separately.
  const [tab, setTab] = useState<'orders' | 'offers'>('orders');
  const promos = items.filter((n) => n.type.startsWith('promo_'));
  const shown = tab === 'offers' ? promos : items.filter((n) => !n.type.startsWith('promo_'));

  return (
    <Screen onRefresh={reload}>
      <Stack.Screen options={{ title: t('notifications') }} />
      {unread > 0 && <Button variant="secondary" icon="checkmark-done-outline" title={t('markAllRead')} onPress={markAllRead} />}
      {promos.length > 0 && (
        <Row>
          <Chip label={t('notifOrders')} active={tab === 'orders'} onPress={() => setTab('orders')} />
          <Chip label={`${t('notifOffers')} (${promos.length})`} active={tab === 'offers'} onPress={() => setTab('offers')} />
        </Row>
      )}
      {shown.length === 0 ? (
        <Empty icon="notifications-off-outline" text={t('noNotifications')} />
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
          {shown.map((n) => {
            const href = link(n);
            return (
              <ListItem
                key={n.id}
                icon={n.read_at ? 'mail-open-outline' : 'mail-unread-outline'}
                title={text(n)}
                subtitle={dateTime(n.created_at, lang)}
                onPress={() => {
                  if (!n.read_at) markRead(n.id);
                  if (href) router.push(href as any);
                }}
              />
            );
          })}
        </Card>
      )}
    </Screen>
  );
}
