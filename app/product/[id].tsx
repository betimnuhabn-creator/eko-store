import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { PriceTag } from '../../components/PriceTag';
import { ProductImage } from '../../components/ProductImage';
import { Button, Card, Empty, H1, Loading, Muted, QuantityStepper, Row, Screen } from '../../components/ui';
import { formatBelgrade } from '../../lib/belgrade';
import { useCart } from '../../lib/cart';
import { useCatalog } from '../../lib/catalog';
import { showMessage } from '../../lib/dialog';
import { goBack } from '../../lib/nav';
import { useI18n } from '../../lib/i18n';
import { colors } from '../../lib/theme';

export default function ProductScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, pick } = useI18n();
  const { byId, categories, loading } = useCatalog();
  const { add } = useCart();
  const { width } = useWindowDimensions();
  const [qty, setQty] = useState(1);
  const [index, setIndex] = useState(0);
  const p = byId(String(id));

  if (!p) return loading ? <Loading /> : <Empty text={t('noProducts')} />;
  const cat = categories.find((c) => c.id === p.category_id);
  const wide = width >= 800;

  return (
    <Screen>
      <Stack.Screen options={{ title: pick(p.name, p.name_en) }} />
      <View style={{ flexDirection: wide ? 'row' : 'column', gap: 16 }}>
        <View style={{ flex: wide ? 1 : undefined, gap: 8 }}>
          <ProductImage uri={p.images[index]} style={{ width: '100%', aspectRatio: 1, borderRadius: 12 }} />
          {p.images.length > 1 && (
            <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
              {p.images.map((uri, i) => (
                <Pressable key={uri} onPress={() => setIndex(i)} style={{ borderWidth: 2, borderColor: i === index ? colors.brand : 'transparent', borderRadius: 8 }}>
                  <ProductImage uri={uri} style={{ width: 64, height: 64, borderRadius: 6 }} />
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
        <Card style={{ flex: wide ? 1 : undefined, gap: 10 }}>
          <H1>{pick(p.name, p.name_en)}</H1>
          <Muted>
            {t('code')}: {p.sku}
            {cat ? ` · ${pick(cat.name_sq, cat.name_en)}` : ''}
          </Muted>
          <Text style={{ color: p.in_stock ? colors.success : colors.warning, fontWeight: '700' }}>
            {p.in_stock ? t('inStock') : t('onOrder')}
          </Text>
          <PriceTag product={p} size={24} />
          {p.offer_price != null && p.offer_ends_at && (
            <Muted>{t('offerEnds', { date: formatBelgrade(p.offer_ends_at) })}</Muted>
          )}
          {!!pick(p.description, p.description_en) && (
            <Text style={{ color: colors.text, lineHeight: 21 }}>{pick(p.description, p.description_en)}</Text>
          )}
          <Row>
            <QuantityStepper value={qty} onChange={(n) => setQty(Math.max(1, n))} />
            <Button
              icon="cart-outline"
              title={t('addToCart')}
              style={{ flex: 1 }}
              testID="add-to-cart"
              onPress={() => {
                add(p.id, qty);
                showMessage(t('addedToCart'));
                goBack();
              }}
            />
          </Row>
        </Card>
      </View>
    </Screen>
  );
}
