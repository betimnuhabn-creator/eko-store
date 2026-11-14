import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Button, Card, Chip, Empty, ListItem, Row, Screen } from '../components/ui';
import { dateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { categoryOf, isCategory, NOTIFICATION_CATEGORIES, type NotificationCategory } from '../lib/notificationCategories';
import { useNotifications } from '../lib/notifications';

export default function NotificationsScreen() {
  const { t, lang } = useI18n();
  const { items, unread, reload, markAllRead, markRead, text, link } = useNotifications();
  useFocusEffect(useCallback(() => void reload(), [reload]));
  const params = useLocalSearchParams<{ cat?: string }>();
  const [cat, setCat] = useState<NotificationCategory>(isCategory(params.cat) ? params.cat : 'orders');

  // Unread count per category (shown on each chip).
  const unreadBy = useMemo(() => {
    const c: Record<NotificationCategory, number> = { orders: 0, offers: 0, new_products: 0, prices: 0 };
    for (const n of items) if (!n.read_at) c[categoryOf(n.type)]++;
    return c;
  }, [items]);
  const shown = items.filter((n) => categoryOf(n.type) === cat);

  return (
    <Screen onRefresh={reload}>
      <Stack.Screen options={{ title: t('notifications') }} />
      {unread > 0 && <Button variant="secondary" icon="checkmark-done-outline" title={t('markAllRead')} onPress={markAllRead} />}
      <Row>
        {NOTIFICATION_CATEGORIES.map(({ key, label }) => (
          <Chip
            key={key}
            testID={`notif-cat-${key}`}
            label={unreadBy[key] > 0 ? `${t(label)} (${unreadBy[key]})` : t(label)}
            active={cat === key}
            onPress={() => setCat(key)}
          />
        ))}
      </Row>
      {shown.length === 0 ? (
        <Empty icon="notifications-off-outline" text={t('noNotificationsInCategory')} />
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
