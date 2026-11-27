import * as Linking from 'expo-linking';
import { router, Stack } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text } from 'react-native';
import { PasswordFields } from '../components/PasswordFields';
import { Banner, Button, Card, Loading, Screen } from '../components/ui';
import { TKey, useI18n } from '../lib/i18n';
import { parseRecoveryUrl, passwordErrorKey, passwordProblem } from '../lib/passwordReset';
import { initialWebUrl, supabase } from '../lib/supabase';
import { colors } from '../lib/theme';

// Opened by the recovery link: ekostore://reset-password#access_token=…&refresh_token=…&type=recovery
// (from the reset web page), whether the app was closed, in the background or open.
// The tokens are checked with Supabase (setSession) BEFORE the form is shown;
// updateUser() is only called with that verified recovery session.
export default function ResetPasswordScreen() {
  const { t } = useI18n();
  const nativeUrl = Linking.useURL();
  const [state, setState] = useState<'checking' | 'invalid' | 'form'>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<TKey | null>(null);
  const [busy, setBusy] = useState(false);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const url = Platform.OS === 'web' ? initialWebUrl : nativeUrl;
    if (url === null && Platform.OS !== 'web') return; // still waiting for the link
    if (handled.current === url) return;
    handled.current = url ?? '';
    (async () => {
      const p = parseRecoveryUrl(url);
      if (p.errorCode || !p.accessToken || !p.refreshToken || (p.type && p.type !== 'recovery')) {
        return setState('invalid');
      }
      setState('checking');
      const { error: e } = await supabase.auth.setSession({ access_token: p.accessToken, refresh_token: p.refreshToken });
      setState(e ? 'invalid' : 'form');
    })();
  }, [nativeUrl]);

  async function save() {
    setError(null);
    const problem = passwordProblem(password, confirm);
    if (problem) return setError(problem === 'too_short' ? 'pwTooShort' : 'pwMismatch');
    setBusy(true);
    const { error: e } = await supabase.auth.updateUser({ password });
    if (e) {
      setBusy(false);
      const key = passwordErrorKey(e);
      if (key === 'pwLinkExpired') setState('invalid');
      return setError(key);
    }
    // The recovery session is finished: sign this account out everywhere,
    // then log in with the new password.
    await supabase.auth.signOut({ scope: 'global' }).catch(() => {});
    setBusy(false);
    router.replace('/login?reset=1');
  }

  return (
    <Screen style={{ maxWidth: 460 }}>
      <Stack.Screen options={{ title: t('newPasswordTitle') }} />
      {state === 'checking' && (
        <Card>
          <Text style={{ color: colors.muted }}>{t('pwChecking')}</Text>
          <Loading />
        </Card>
      )}
      {state === 'invalid' && (
        <Card style={{ gap: 12 }} testID="reset-invalid">
          <Banner tone="warning" text={t('pwLinkExpired')} />
          <Button title={t('pwRequestNew')} onPress={() => router.replace('/forgot-password')} testID="reset-request-new" />
        </Card>
      )}
      {state === 'form' && (
        <Card style={{ gap: 12 }}>
          <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} onSubmit={save} />
          {error && <Banner tone="warning" text={t(error)} />}
          <Button title={t('savePassword')} onPress={save} loading={busy} testID="reset-save" />
        </Card>
      )}
    </Screen>
  );
}
