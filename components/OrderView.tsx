import React from 'react';
import { Text, View } from 'react-native';
import { dateTime, money } from '../lib/format';
import { TKey, useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';
import type { Order } from '../lib/types';
import { StatusBadge } from './StatusBadge';
import { Card, H1, H2, Muted, Row } from './ui';

export function OrderView({ order, children }: { order: Order; children?: React.ReactNode }) {
  const { t, lang } = useI18n();
  return (
    <>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <H1>
            {t('order')} #{order.order_number}
          </H1>
          <StatusBadge status={order.status} />
        </Row>
        <Muted>
          {dateTime(order.created_at, lang)} · {t(`tier_${order.price_tier}` as TKey)} · {t(`pay_${order.payment_method}` as TKey)}
        </Muted>
      </Card>
      <Card>
        <H2>{t('items')}</H2>
        {(order.order_items ?? []).map((i) => (
          <View key={i.id} style={{ flexDirection: 'row', gap: 8, paddingVertical: 4 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>{i.product_name}</Text>
              <Muted>
                {t('code')}: {i.sku} · {i.quantity} {i.unit} × {money(i.unit_price)}
              </Muted>
            </View>
            <Text style={{ fontWeight: '700', color: colors.text }}>{money(i.quantity * i.unit_price)}</Text>
          </View>
        ))}
        <View style={{ height: 1, backgroundColor: colors.border }} />
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>{t('total')}</H2>
          <Text style={{ fontSize: 20, fontWeight: '800', color: colors.brandDark }}>{money(order.total)}</Text>
        </Row>
      </Card>
      <Card>
        <H2>{t('delivery')}</H2>
        <Text style={{ color: colors.text }}>{order.delivery_name}</Text>
        <Text style={{ color: colors.text }}>{order.delivery_phone}</Text>
        <Text style={{ color: colors.text }}>
          {order.delivery_address}, {order.delivery_city}
        </Text>
        {!!order.customer_note && <Muted>“{order.customer_note}”</Muted>}
      </Card>
      {children}
    </>
  );
}

export const ORDER_SELECT =
  '*, order_items(id,product_id,product_name,sku,unit,quantity,unit_price), profiles(email,full_name,business_name,phone)';
