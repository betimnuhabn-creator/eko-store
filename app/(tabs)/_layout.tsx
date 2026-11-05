import { Ionicons } from '@expo/vector-icons';
import { router, Tabs } from 'expo-router';
import React from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { LanguageToggle } from '../../components/LanguageToggle';
import { useAuth } from '../../lib/auth';
import { useCart } from '../../lib/cart';
import { useI18n } from '../../lib/i18n';
import { useNotifications } from '../../lib/notifications';
import { colors, logo } from '../../lib/theme';

function HeaderTitle() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <View style={{ backgroundColor: '#fff', borderRadius: 999, padding: 3 }}>
        <Image source={logo} style={{ width: 30, height: 30 }} resizeMode="contain" />
      </View>
      <Text style={{ color: '#fff', fontWeight: '900', fontSize: 19, letterSpacing: 1 }}>EKO STORE</Text>
    </View>
  );
}

function HeaderRight() {
  const { session } = useAuth();
  const { unread } = useNotifications();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {session && (
        <Pressable accessibilityLabel="notifications" onPress={() => router.push('/notifications')} style={{ padding: 8 }}>
          <Ionicons name="notifications-outline" size={22} color="#fff" />
          {unread > 0 && (
            <View style={{ position: 'absolute', right: 2, top: 2, backgroundColor: '#F59E0B', borderRadius: 999, minWidth: 16, paddingHorizontal: 3 }}>
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800', textAlign: 'center' }}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          )}
        </Pressable>
      )}
      <LanguageToggle color="#fff" />
    </View>
  );
}

export default function TabsLayout() {
  const { t } = useI18n();
  const { count } = useCart();
  const { isAdmin } = useAuth();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.brand },
        headerTintColor: '#fff',
        headerTitle: () => <HeaderTitle />,
        headerRight: () => <HeaderRight />,
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: '#7A8797',
        tabBarLabelStyle: { fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t('tabProducts'), tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: t('tabCart'),
          tabBarBadge: count > 0 ? count : undefined,
          tabBarIcon: ({ color, size }) => <Ionicons name="cart-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="orders"
        options={{ title: t('tabOrders'), tabBarIcon: ({ color, size }) => <Ionicons name="receipt-outline" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="account"
        options={{ title: t('tabAccount'), tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} /> }}
      />
      <Tabs.Screen
        name="admin"
        options={{
          title: t('tabAdmin'),
          href: isAdmin ? undefined : null,
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-outline" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
