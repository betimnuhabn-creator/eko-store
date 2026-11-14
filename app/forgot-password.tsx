import { router, Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { PasswordFields } from '../components/PasswordFields';
import { Banner, Button, Card, Field, Screen } from '../components/ui';
import { TKey, useI18n } from '../lib/i18n';
import { isValidEmail, passwordErrorKey, passwordProblem, requestPasswordReset } from '../lib/passwordReset';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';

const RESEND_SECONDS = 60;

// "Keni harruar fjalëkalimin?" — sends the Supabase recovery e-mail. The e-mail
// link opens the reset page / app (app/reset-password.tsx). If the e-mail also
// shows a 6-digit code, it can be entered here instead.
export default function ForgotPasswordScreen() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'sent' | 'rate_limited' | 'network'>('idle');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [codeError, setCodeError] = useState<TKey | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  async function send() {
    setEmailError(null);
    if (!isValidEmail(email)) return setEmailError(t('fpInvalidEmail'));
    setBusy(true);
    const result = await requestPasswordReset(email);
    setBusy(false);
    setStatus(result);
    if (result === 'sent') setWait(RESEND_SECONDS);
  }

  async function resetWithCode() {
    setCodeError(null);
    if (!/^\d{6,10}$/.test(code.trim())) return setCodeError('pwLinkExpired');
    const problem = passwordProblem(password, confirm);
    if (problem) return setCodeError(problem === 'too_short' ? 'pwTooShort' : 'pwMismatch');
    setBusy(true);
    const v = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'recovery' });
    if (v.error) {
      setBusy(false);
      return setCodeError(passwordErrorKey(v.error));
    }
    const u = await supabase.auth.updateUser({ password });
    if (u.error) {
      setBusy(false);
      return setCodeError(passwordErrorKey(u.error));
    }
    await supabase.auth.signOut({ scope: 'global' }).catch(() => {});
    setBusy(false);
    router.replace('/login?reset=1');
  }

  return (
    <Screen style={{ maxWidth: 460 }}>
      <Stack.Screen options={{ title: t('resetTitle') }} />
      <Card style={{ gap: 12 }}>
        <Text style={{ color: colors.text }}>{t('fpIntro')}</Text>
        <Field
          label={t('email')}
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            setEmailError(null);
          }}
          keyboardType="email-address"
          autoComplete="email"
          error={emailError}
          onSubmitEditing={send}
          testID="fp-email"
        />
        {status === 'sent' && (
          <>
            <Banner tone="success" text={t('fpSent')} />
            <Text style={{ color: colors.muted }}>{t('fpSentHint')}</Text>
          </>
        )}
        {status === 'rate_limited' && <Banner tone="warning" text={t('fpRateLimited')} />}
        {status === 'network' && <Banner tone="warning" text={t('e_network')} />}
        <Button
          title={wait > 0 ? t('fpResendIn', { s: wait }) : status === 'sent' ? t('fpResend') : t('fpSend')}
          onPress={send}
          loading={busy && !showCode}
          disabled={wait > 0}
          testID="fp-send"
        />
      </Card>

      {status === 'sent' && !showCode && (
        <Button variant="ghost" title={t('fpHaveCode')} onPress={() => setShowCode(true)} testID="fp-have-code" />
      )}
      {showCode && (
        <Card style={{ gap: 12 }}>
          <Field label={t('resetCode')} value={code} onChangeText={setCode} keyboardType="number-pad" testID="fp-code" />
          <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} onSubmit={resetWithCode} />
          {codeError && <Banner tone="warning" text={t(codeError)} />}
          <Button title={t('savePassword')} onPress={resetWithCode} loading={busy} testID="fp-code-save" />
        </Card>
      )}
    </Screen>
  );
}
