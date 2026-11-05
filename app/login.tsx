import { Link, router, Stack } from 'expo-router';
import React, { useState } from 'react';
import { Button, Card, Field, Screen } from '../components/ui';
import { showMessage } from '../lib/dialog';
import { goBack } from '../lib/nav';
import { errorText, useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';
import { AuthHeader } from '../components/AuthHeader';

export default function LoginScreen() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function login() {
    if (!email.trim() || !password) return showMessage(t('error'), t('required'));
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    goBack();
  }

  return (
    <Screen style={{ maxWidth: 460 }}>
      <Stack.Screen options={{ title: t('loginTitle') }} />
      <AuthHeader />
      <Card style={{ gap: 12 }}>
        <Field label={t('email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" testID="email" />
        <Field label={t('password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" onSubmitEditing={login} testID="password" />
        <Button title={t('login')} onPress={login} loading={busy} testID="login-submit" />
        <Link href="/forgot-password" style={{ color: colors.brand, fontWeight: '600', textAlign: 'center' }}>
          {t('forgotPassword')}
        </Link>
      </Card>
      <Button variant="secondary" title={t('noAccount')} onPress={() => router.replace('/register')} />
    </Screen>
  );
}
