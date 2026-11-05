import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { AdminOnly } from '../../components/AdminOnly';
import { Button, Card, ListItem, Screen, s as ui } from '../../components/ui';
import { money } from '../../lib/format';
import { TKey, useI18n } from '../../lib/i18n';
import { useNotifications } from '../../lib/notifications';
import { browserNotificationsState, requestBrowserNotifications } from '../../lib/push';
import { supabase } from '../../lib/supabase';
import { colors } from '../../lib/theme';

type Stats = {
  new_orders: number;
  open_orders: number;
  pending_wholesale: number;
  products: number;
  customers: number;
  sales_30d: number;
};

function Dashboard() {
  const { t } = useI18n();
  const { version } = useNotifications();
  const { width } = useWindowDimensions();
  const [stats, setStats] = useState<Stats | null>(null);
  const [browserPerm, setBrowserPerm] = useState(browserNotificationsState());

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('admin_stats');
    if (data) setStats(data as Stats);
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));
  useEffect(() => void load(), [version, load]);

  const tiles: { key: keyof Stats; label: TKey; href: string; money?: boolean; alert?: boolean }[] = [
    { key: 'new_orders', label: 'newOrders', href: '/admin/orders?status=new', alert: true },
    { key: 'pending_wholesale', label: 'pendingWholesale', href: '/admin/customers?filter=pending', alert: true },
    { key: 'open_orders', label: 'openOrders', href: '/admin/orders' },
    { key: 'sales_30d', label: 'sales30d', href: '/admin/orders', money: true },
    { key: 'products', label: 'productsCount', href: '/admin/products' },
    { key: 'customers', label: 'customersCount', href: '/admin/customers' },
  ];
  const cols = width < 600 ? 2 : 3;

  return (
    <Screen onRefresh={load}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {tiles.map((tile) => {
          const v = stats?.[tile.key] ?? 0;
          const hot = tile.alert && Number(v) > 0;
          return (
            <Pressable
              key={tile.key}
              onPress={() => router.push(tile.href as any)}
              style={[ui.card, { flexBasis: `${100 / cols - 4}%`, flexGrow: 1, backgroundColor: hot ? colors.warningSoft : '#fff' }]}
              testID={`stat-${tile.key}`}
            >
              <Text style={{ fontSize: 26, fontWeight: '800', color: hot ? colors.warning : colors.brandDark }}>
                {tile.money ? money(Number(v)) : String(v)}
              </Text>
              <Text style={{ color: colors.muted, fontWeight: '600' }}>{t(tile.label)}</Text>
            </Pressable>
          );
        })}
      </View>
      <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
        <ListItem icon="receipt-outline" title={t('manageOrders')} onPress={() => router.push('/admin/orders')} />
        <ListItem icon="cube-outline" title={t('manageProducts')} onPress={() => router.push('/admin/products')} />
        <ListItem icon="pricetags-outline" title={t('manageCategories')} onPress={() => router.push('/admin/categories')} />
        <ListItem icon="people-outline" title={t('manageCustomers')} onPress={() => router.push('/admin/customers')} />
        <ListItem icon="notifications-outline" title={t('notifications')} onPress={() => router.push('/notifications')} />
      </Card>
      {Platform.OS === 'web' && browserPerm === 'default' && (
        <Button
          variant="secondary"
          icon="notifications-outline"
          title={t('enableDesktopNotifications')}
          onPress={async () => setBrowserPerm((await requestBrowserNotifications()) as any)}
        />
      )}
    </Screen>
  );
}

export default function AdminTab() {
  return (
    <AdminOnly>
      <Dashboard />
    </AdminOnly>
  );
}
