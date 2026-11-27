import { router } from 'expo-router';
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { PriceTag } from '../../components/PriceTag';
import { ProductImage } from '../../components/ProductImage';
import { Button, Card, Empty, H2, QuantityStepper, Row, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useCart } from '../../lib/cart';
import { money } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { colors } from '../../lib/theme';

export default function CartScreen() {
  const { t, pick } = useI18n();
  const { session } = useAuth();
  const { lines, total, setQuantity } = useCart();

  if (lines.length === 0) return <Empty icon="cart-outline" text={t('cartEmpty')} />;

  return (
    <Screen>
      {lines.map(({ product: p, quantity }) => (
        <Card key={p.id} style={{ flexDirection: 'row', gap: 12 }}>
          <Pressable onPress={() => router.push(`/product/${p.id}`)}>
            <ProductImage uri={p.images[0]} style={{ width: 72, height: 72, borderRadius: 8 }} />
          </Pressable>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ fontWeight: '700', color: colors.text }}>{pick(p.name, p.name_en)}</Text>
            <PriceTag product={p} size={15} />
            <Row style={{ justifyContent: 'space-between' }}>
              <QuantityStepper value={quantity} onChange={(n) => setQuantity(p.id, n)} />
              {p.price != null && <Text style={{ fontWeight: '800', color: colors.text }}>{money(p.price * quantity)}</Text>}
              <Button small variant="ghost" icon="trash-outline" title={t('remove')} onPress={() => setQuantity(p.id, 0)} />
            </Row>
          </View>
        </Card>
      ))}
      <Card>
        {total != null && (
          <Row style={{ justifyContent: 'space-between' }}>
            <H2>{t('total')}</H2>
            <Text style={{ fontSize: 22, fontWeight: '800', color: colors.brandDark }} testID="cart-total">
              {money(total)}
            </Text>
          </Row>
        )}
        {session ? (
          <Button title={t('continueToOrder')} icon="arrow-forward" onPress={() => router.push('/checkout')} testID="go-checkout" />
        ) : (
          <Button title={t('loginToOrder')} icon="log-in-outline" onPress={() => router.push('/login')} />
        )}
      </Card>
    </Screen>
  );
}
