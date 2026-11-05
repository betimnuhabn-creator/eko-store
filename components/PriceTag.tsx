import { router } from 'expo-router';
import React from 'react';
import { Text } from 'react-native';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';
import { isWholesale, type Product } from '../lib/types';

export function PriceTag({ product, size = 18 }: { product: Product; size?: number }) {
  const { t } = useI18n();
  const { profile } = useAuth();
  if (product.price == null) {
    return (
      <Text onPress={() => router.push('/login')} style={{ color: colors.brand, fontWeight: '700', fontSize: 13 }}>
        {t('loginToSeePrices')}
      </Text>
    );
  }
  return (
    <Text style={{ color: colors.brandDark, fontWeight: '800', fontSize: size }}>
      {money(product.price)}
      <Text style={{ color: colors.muted, fontWeight: '500', fontSize: 12 }}>
        {' '}/ {product.unit}
        {isWholesale(profile) ? ` · ${t('tier_wholesale')}` : ''}
      </Text>
    </Text>
  );
}
