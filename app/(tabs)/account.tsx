import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { AuthHeader } from '../../components/AuthHeader';
import { Badge, Banner, Button, Card, Chip, Field, H2, ListItem, Muted, Row, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { confirmAction, showMessage } from '../../lib/dialog';
import { errorText, TKey, useI18n } from '../../lib/i18n';
import { useNotifications } from '../../lib/notifications';
import { dispatchNotifications, supabase } from '../../lib/supabase';
import { colors } from '../../lib/theme';
import { accountKind } from '../../lib/types';

export default function AccountScreen() {
  const { t, lang, setLang } = useI18n();
  const { session, profile, refreshProfile, signOut } = useAuth();
  const { unread } = useNotifications();
  const [form, setForm] = useState({ full_name: '', phone: '', address: '', city: '', business_name: '', business_number: '' });
  const [busy, setBusy] = useState(false);
  const [showWholesale, setShowWholesale] = useState(false);

  useEffect(() => {
    if (profile)
      setForm({
        full_name: profile.full_name,
        phone: profile.phone,
        address: profile.address,
        city: profile.city,
        business_name: profile.business_name,
        business_number: profile.business_number,
      });
  }, [profile]);

  const languagePicker = (
    <Card>
      <H2>{t('language')}</H2>
      <Row>
        <Chip label="Shqip" active={lang === 'sq'} onPress={() => setLang('sq')} />
        <Chip label="English" active={lang === 'en'} onPress={() => setLang('en')} />
      </Row>
    </Card>
  );

  if (!session) {
    return (
      <Screen style={{ maxWidth: 460 }}>
        <AuthHeader />
        <Banner text={t('guestAccount')} />
        <Button title={t('login')} icon="log-in-outline" onPress={() => router.push('/login')} testID="go-login" />
        <Button variant="secondary" title={t('register')} icon="person-add-outline" onPress={() => router.push('/register')} testID="go-register" />
        {languagePicker}
      </Screen>
    );
  }

  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy(true);
    const { error } = await supabase.rpc('update_my_profile', { p: form });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    await refreshProfile();
    showMessage(t('saved'));
  }

  async function requestWholesale() {
    setBusy(true);
    const { error } = await supabase.rpc('request_wholesale', {
      p_business_name: form.business_name,
      p_business_number: form.business_number,
    });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    dispatchNotifications();
    await refreshProfile();
    setShowWholesale(false);
    showMessage(t('wholesaleRequested'));
  }

  async function deleteAccount() {
    if (!(await confirmAction(t('deleteAccount'), t('deleteAccountConfirm'), t('delete'), t('cancel')))) return;
    const { error } = await supabase.rpc('delete_my_account');
    if (error) return showMessage(t('error'), errorText(t, error));
    await signOut();
    showMessage(t('accountDeleted'));
    router.replace('/');
  }

  const canRequest = profile && accountKind(profile) === 'retail' && profile.wholesale_status !== 'pending';

  return (
    <Screen style={{ maxWidth: 640 }}>
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <H2>{profile?.business_name || profile?.full_name || session.user.email}</H2>
          {profile && <Badge label={t(`role_${accountKind(profile)}` as TKey)} tone={accountKind(profile) === 'retail' ? 'muted' : 'success'} />}
        </Row>
        <Muted>{session.user.email}</Muted>
        {profile?.wholesale_status === 'pending' && <Banner tone="warning" text={t('ws_pending')} />}
        {profile?.wholesale_status === 'rejected' && <Banner tone="warning" text={t('ws_rejected')} />}
      </Card>

      <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
        <ListItem
          icon="notifications-outline"
          title={t('notifications')}
          right={unread > 0 ? <Badge label={String(unread)} tone="warning" /> : undefined}
          onPress={() => router.push('/notifications')}
        />
        <ListItem icon="receipt-outline" title={t('myOrders')} onPress={() => router.push('/orders')} />
      </Card>

      <Card>
        <H2>{t('profileDetails')}</H2>
        <Field label={t('fullName')} value={form.full_name} onChangeText={set('full_name')} autoCapitalize="words" />
        <Field label={t('phone')} value={form.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
        <Field label={t('address')} value={form.address} onChangeText={set('address')} autoCapitalize="sentences" />
        <Field label={t('city')} value={form.city} onChangeText={set('city')} autoCapitalize="words" />
        {(profile?.role === 'admin' || showWholesale || profile?.wholesale_status !== 'none') && (
          <>
            <Field label={t('businessName')} value={form.business_name} onChangeText={set('business_name')} autoCapitalize="words" testID="a-business" />
            <Field label={t('businessNumber')} value={form.business_number} onChangeText={set('business_number')} />
          </>
        )}
        <Button title={t('save')} onPress={save} loading={busy} />
      </Card>

      {canRequest && (
        <Card>
          <Text style={{ color: colors.text }}>{t('wholesaleNote')}</Text>
          {showWholesale ? (
            <Button title={t('requestWholesale')} icon="briefcase-outline" onPress={requestWholesale} loading={busy} testID="request-wholesale" />
          ) : (
            <Button variant="secondary" title={t('requestWholesale')} icon="briefcase-outline" onPress={() => setShowWholesale(true)} testID="show-wholesale" />
          )}
        </Card>
      )}

      {languagePicker}

      <Button variant="secondary" icon="log-out-outline" title={t('logout')} onPress={signOut} testID="logout" />
      {profile?.role !== 'admin' && (
        <Button variant="ghost" icon="trash-outline" title={t('deleteAccount')} onPress={deleteAccount} style={{ alignSelf: 'center' }} />
      )}
    </Screen>
  );
}
