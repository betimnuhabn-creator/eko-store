import { router } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';
import { isWholesale, type Product } from '../lib/types';

export function discountPercent(regular?: number | null, offer?: number | null) {
  if (regular == null || offer == null || Number(regular) <= 0) return null;
  return Math.round((100 * (Number(regular) - Number(offer))) / Number(regular));
}

/** Price as the logged-in customer pays it (offer price + struck regular price + discount). */
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
  const onOffer = product.offer_price != null && product.regular_price != null && Number(product.offer_price) < Number(product.regular_price);
  const pct = onOffer ? discountPercent(product.regular_price, product.offer_price) : null;
  return (
    <View style={{ gap: 2 }}>
      {onOffer && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: colors.muted, textDecorationLine: 'line-through', fontSize: Math.max(12, size - 5) }}>
            {money(product.regular_price)}
          </Text>
          {pct != null && pct > 0 && (
            <Text style={{ backgroundColor: colors.danger, color: '#fff', fontWeight: '800', fontSize: 11, paddingHorizontal: 6, borderRadius: 999 }}>
              -{pct}%
            </Text>
          )}
        </View>
      )}
      <Text style={{ color: onOffer ? colors.danger : colors.brandDark, fontWeight: '800', fontSize: size }}>
        {money(product.price)}
        <Text style={{ color: colors.muted, fontWeight: '500', fontSize: 12 }}>
          {' '}/ {product.unit}
          {isWholesale(profile) ? ` · ${t('tier_wholesale')}` : ''}
        </Text>
      </Text>
    </View>
  );
}
