import { router, Stack } from 'expo-router';
import React, { useState } from 'react';
import { Banner, Button, Card, Field, Screen } from '../components/ui';
import { showMessage } from '../lib/dialog';
import { errorText, useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';

// Code-based reset: works the same in the Android app and on the web.
// The Supabase "Reset password" e-mail template must contain {{ .Token }} (see README).
export default function ForgotPasswordScreen() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!email.trim()) return showMessage(t('error'), t('required'));
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    setSent(true);
  }

  async function reset() {
    if (!code.trim() || password.length < 6) return showMessage(t('error'), t('passwordHint'));
    setBusy(true);
    const v = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'recovery' });
    const u = v.error ? v : await supabase.auth.updateUser({ password });
    setBusy(false);
    if (u.error) return showMessage(t('error'), errorText(t, u.error));
    showMessage(t('resetDone'));
    router.replace('/');
  }

  return (
    <Screen style={{ maxWidth: 460 }}>
      <Stack.Screen options={{ title: t('resetTitle') }} />
      <Card style={{ gap: 12 }}>
        <Field label={t('email')} value={email} onChangeText={setEmail} keyboardType="email-address" editable={!sent} />
        {!sent ? (
          <Button title={t('resetSendCode')} onPress={send} loading={busy} />
        ) : (
          <>
            <Banner text={t('resetCodeSent')} />
            <Field label={t('resetCode')} value={code} onChangeText={setCode} keyboardType="number-pad" />
            <Field label={t('newPassword')} placeholder={t('passwordHint')} value={password} onChangeText={setPassword} secureTextEntry />
            <Button title={t('save')} onPress={reset} loading={busy} />
          </>
        )}
      </Card>
    </Screen>
  );
}
