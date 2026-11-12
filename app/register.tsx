import { RegisterConsent } from '../components/LegalLinks';
import { router, Stack } from 'expo-router';
import React, { useState } from 'react';
import { Banner, Button, Card, Checkbox, Field, Screen } from '../components/ui';
import { showMessage } from '../lib/dialog';
import { errorText, useI18n } from '../lib/i18n';
import { dispatchNotifications, supabase } from '../lib/supabase';
import { AuthHeader } from '../components/AuthHeader';

export default function RegisterScreen() {
  const { t, lang } = useI18n();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [business, setBusiness] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [businessNumber, setBusinessNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const req = (v: string) => (touched && !v.trim() ? t('required') : null);

  async function submit() {
    setTouched(true);
    const required = [fullName, phone, email, password, ...(business ? [businessName] : [])];
    if (!required.every((v) => v.trim())) return;
    if (password.length < 6) return showMessage(t('error'), t('passwordHint'));
    setBusy(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          full_name: fullName.trim(),
          phone: phone.trim(),
          requested_wholesale: business,
          business_name: business ? businessName.trim() : '',
          business_number: business ? businessNumber.trim() : '',
          language: lang,
        },
      },
    });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    dispatchNotifications();
    if (data.session) {
      showMessage(t('registeredOk'), business ? t('wholesaleNote') : undefined);
      router.replace('/');
    } else {
      showMessage(t('registerTitle'), t('registeredConfirm'));
      router.replace('/login');
    }
  }

  return (
    <Screen style={{ maxWidth: 460 }}>
      <Stack.Screen options={{ title: t('registerTitle') }} />
      <AuthHeader />
      <Card style={{ gap: 12 }}>
        <Field label={t('fullName')} value={fullName} onChangeText={setFullName} autoCapitalize="words" error={req(fullName)} testID="r-name" />
        <Field label={t('phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" error={req(phone)} testID="r-phone" />
        <Field label={t('email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" error={req(email)} testID="r-email" />
        <Field
          label={t('password')}
          placeholder={t('passwordHint')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          error={req(password)}
          testID="r-password"
        />
        <Checkbox checked={business} onChange={setBusiness} label={t('wantWholesale')} />
        {business && (
          <>
            <Field label={t('businessName')} value={businessName} onChangeText={setBusinessName} autoCapitalize="words" error={req(businessName)} testID="r-business" />
            <Field label={t('businessNumber')} value={businessNumber} onChangeText={setBusinessNumber} />
            <Banner tone="warning" text={t('wholesaleNote')} />
          </>
        )}
        <Button title={t('register')} onPress={submit} loading={busy} testID="register-submit" />
        <RegisterConsent />
      </Card>
      <Button variant="secondary" title={t('haveAccount')} onPress={() => router.replace('/login')} />
    </Screen>
  );
}
