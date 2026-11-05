import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LanguageToggle } from '../components/LanguageToggle';
import { AuthProvider, useAuth } from '../lib/auth';
import { CartProvider } from '../lib/cart';
import { CatalogProvider } from '../lib/catalog';
import { I18nProvider, useI18n } from '../lib/i18n';
import { NotificationsProvider } from '../lib/notifications';
import { isConfigured, supabase } from '../lib/supabase';
import { colors } from '../lib/theme';

/** Keep the profile language in sync, so push/e-mail texts use the user's language. */
function LanguageSync() {
  const { lang } = useI18n();
  const { profile } = useAuth();
  useEffect(() => {
    if (profile && profile.language !== lang) {
      supabase.rpc('update_my_profile', { p: { language: lang } }).then(() => {}, () => {});
    }
  }, [lang, profile]);
  return null;
}

function NotConfigured() {
  const { t } = useI18n();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ color: colors.danger, fontWeight: '700', textAlign: 'center' }}>{t('e_notConfigured')}</Text>
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        {!isConfigured ? (
          <NotConfigured />
        ) : (
          <AuthProvider>
            <CatalogProvider>
              <CartProvider>
                <NotificationsProvider>
                  <LanguageSync />
                  <StatusBar style="light" />
                  <Stack
                    screenOptions={{
                      headerStyle: { backgroundColor: colors.brand },
                      headerTintColor: '#fff',
                      headerTitleStyle: { fontWeight: '700' },
                      headerRight: () => <LanguageToggle color="#fff" />,
                      contentStyle: { backgroundColor: colors.bg },
                    }}
                  >
                    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  </Stack>
                </NotificationsProvider>
              </CartProvider>
            </CatalogProvider>
          </AuthProvider>
        )}
      </I18nProvider>
    </SafeAreaProvider>
  );
}
