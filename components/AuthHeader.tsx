import React from 'react';
import { Image, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { colors, logo } from '../lib/theme';

export function AuthHeader() {
  const { t } = useI18n();
  return (
    <View style={{ alignItems: 'center', gap: 6, marginVertical: 12 }}>
      <Image source={logo} style={{ width: 96, height: 96 }} resizeMode="contain" />
      <Text style={{ fontSize: 26, fontWeight: '900', color: colors.brandDark, letterSpacing: 1 }}>EKO STORE</Text>
      <Text style={{ color: colors.muted }}>{t('tagline')}</Text>
    </View>
  );
}
