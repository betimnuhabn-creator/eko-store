import { router } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatBelgrade } from '../lib/belgrade';
import { useCart } from '../lib/cart';
import { money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { Offer } from '../lib/offers';
import { colors } from '../lib/theme';
import { ProductImage } from './ProductImage';
import { Button, Card, H2, Muted } from './ui';

export function OfferCard({ offer, onAdded }: { offer: Offer; onAdded?: (name: string) => void }) {
  const { t, pick } = useI18n();
  const { add, quantities } = useCart();
  const description = pick(offer.description_sq, offer.description_en);
  return (
    <Card testID={`offer-${offer.id}`}>
      <H2>{pick(offer.title_sq, offer.title_en)}</H2>
      <Muted>{t('offerValid', { from: formatBelgrade(offer.starts_at), to: formatBelgrade(offer.ends_at) })}</Muted>
      {!!description && <Text style={{ color: colors.text }}>{description}</Text>}
      {offer.items.map((it) => (
        <View key={it.product_id} style={{ flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#EEF2F6' }}>
          <Pressable onPress={() => router.push(`/product/${it.product_id}`)}>
            <ProductImage uri={it.images[0]} style={{ width: 72, height: 72, borderRadius: 8 }} />
          </Pressable>
          <View style={{ flex: 1, gap: 3 }}>
            <Text onPress={() => router.push(`/product/${it.product_id}`)} style={{ fontWeight: '700', color: colors.text }}>
              {pick(it.name, it.name_en)}
            </Text>
            {it.offer_price == null ? (
              <Text onPress={() => router.push('/login')} style={{ color: colors.brand, fontWeight: '700', fontSize: 13 }}>
                {t('loginToSeePrices')}
              </Text>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={{ color: colors.muted, textDecorationLine: 'line-through' }}>{money(it.regular_price)}</Text>
                <Text style={{ color: colors.danger, fontWeight: '800', fontSize: 17 }} testID={`offer-price-${it.sku}`}>
                  {money(it.offer_price)}
                </Text>
                {it.discount_percent != null && it.discount_percent > 0 && (
                  <Text style={{ backgroundColor: colors.danger, color: '#fff', fontWeight: '800', fontSize: 12, paddingHorizontal: 7, borderRadius: 999 }}>
                    -{it.discount_percent}%
                  </Text>
                )}
              </View>
            )}
            <Text style={{ color: it.in_stock ? colors.success : colors.warning, fontSize: 12, fontWeight: '700' }}>
              {it.in_stock ? t('inStock') : t('onOrder')}
            </Text>
          </View>
          <Button
            small
            icon="cart-outline"
            title={quantities[it.product_id] ? `${quantities[it.product_id]}` : t('add')}
            onPress={() => {
              add(it.product_id);
              onAdded?.(pick(it.name, it.name_en));
            }}
            testID={`offer-add-${it.sku}`}
          />
        </View>
      ))}
    </Card>
  );
}
