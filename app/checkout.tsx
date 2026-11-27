import { router, Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Banner, Button, Card, Checkbox, Empty, Field, H2, Row, Screen } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useCart } from '../lib/cart';
import { useCatalog } from '../lib/catalog';
import { showMessage } from '../lib/dialog';
import { money } from '../lib/format';
import { errorText, TKey, useI18n } from '../lib/i18n';
import { dispatchNotifications, supabase } from '../lib/supabase';
import { colors } from '../lib/theme';
import type { PaymentMethod } from '../lib/types';

export default function CheckoutScreen() {
  const { t, pick } = useI18n();
  const { profile, session, refreshProfile } = useAuth();
  const { lines, total, clear } = useCart();
  const { reload } = useCatalog();
  const [name, setName] = useState(profile?.business_name || profile?.full_name || '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [address, setAddress] = useState(profile?.address ?? '');
  const [city, setCity] = useState(profile?.city ?? '');
  const [note, setNote] = useState('');
  const [payment, setPayment] = useState<PaymentMethod>('cash_on_delivery');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  // Profile may arrive after the first render (e.g. page reload on web).
  useEffect(() => {
    if (!profile) return;
    setName((v) => v || profile.business_name || profile.full_name);
    setPhone((v) => v || profile.phone);
    setAddress((v) => v || profile.address);
    setCity((v) => v || profile.city);
  }, [profile]);

  if (!session) {
    return (
      <Screen>
        <Empty icon="log-in-outline" text={t('loginToOrder')} />
        <Button title={t('login')} onPress={() => router.replace('/login')} />
      </Screen>
    );
  }
  if (lines.length === 0) return <Empty icon="cart-outline" text={t('cartEmpty')} />;

  const req = (v: string) => (touched && !v.trim() ? t('required') : null);

  async function submit() {
    setTouched(true);
    if (![name, phone, address, city].every((v) => v.trim())) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('place_order', {
        p_lines: lines.map((l) => ({ product_id: l.product.id, quantity: l.quantity })),
        p_delivery: { name, phone, address, city, note, payment_method: payment },
      });
      if (error) throw error;
      dispatchNotifications();
      if (remember) {
        await supabase.rpc('update_my_profile', { p: { phone, address, city } });
        refreshProfile();
      }
      clear();
      showMessage(t('orderPlaced'), t('orderPlacedBody', { n: (data as any).order_number }));
      router.replace(`/orders/${(data as any).id}`);
    } catch (e) {
      showMessage(t('error'), errorText(t, e));
      if (/PRODUCT_UNAVAILABLE/.test(String((e as any)?.message))) reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: t('checkout') }} />
      <Card>
        <H2>{t('delivery')}</H2>
        <Field label={t('fullName')} value={name} onChangeText={setName} autoCapitalize="words" error={req(name)} testID="d-name" />
        <Field label={t('phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" error={req(phone)} testID="d-phone" />
        <Field label={t('address')} value={address} onChangeText={setAddress} autoCapitalize="sentences" error={req(address)} testID="d-address" />
        <Field label={t('city')} value={city} onChangeText={setCity} autoCapitalize="words" error={req(city)} testID="d-city" />
        <Field label={t('note')} value={note} onChangeText={setNote} multiline autoCapitalize="sentences" />
        <Checkbox checked={remember} onChange={setRemember} label={t('saveAddress')} />
      </Card>

      <Card>
        <H2>{t('paymentMethod')}</H2>
        {(['cash_on_delivery', 'bank_transfer'] as PaymentMethod[]).map((m) => (
          <Pressable key={m} onPress={() => setPayment(m)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 6 }}>
            <Ionicons name={payment === m ? 'radio-button-on' : 'radio-button-off'} size={22} color={colors.brand} />
            <Text style={{ color: colors.text }}>{t(`pay_${m}` as TKey)}</Text>
          </Pressable>
        ))}
        <Banner text={t('noOnlinePayment')} />
      </Card>

      <Card>
        {lines.map(({ product: p, quantity }) => (
          <Row key={p.id} style={{ justifyContent: 'space-between', flexWrap: 'nowrap' }}>
            <Text style={{ flex: 1, color: colors.text }}>
              {quantity} × {pick(p.name, p.name_en)}
            </Text>
            <Text style={{ fontWeight: '600' }}>{money((p.price ?? 0) * quantity)}</Text>
          </Row>
        ))}
        <View style={{ height: 1, backgroundColor: colors.border }} />
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>{t('total')}</H2>
          <Text style={{ fontSize: 22, fontWeight: '800', color: colors.brandDark }}>{money(total)}</Text>
        </Row>
        <Button title={t('placeOrder')} icon="checkmark-circle-outline" onPress={submit} loading={busy} testID="place-order" />
      </Card>
    </Screen>
  );
}
