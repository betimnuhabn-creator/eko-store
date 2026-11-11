import { router, Stack } from 'expo-router';
import React, { useState } from 'react';
import { Text } from 'react-native';
import { PasswordFields } from '../components/PasswordFields';
import { Banner, Button, Card, Field, Screen } from '../components/ui';
import { useAuth } from '../lib/auth';
import { TKey, useI18n } from '../lib/i18n';
import { passwordErrorKey, passwordProblem } from '../lib/passwordReset';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';

// Llogaria → Siguria → Ndrysho fjalëkalimin.
// Re-authentication: the current password is verified with Supabase first;
// only then is the new password sent. Nothing else in the profile changes.
export default function ChangePasswordScreen() {
  const { t } = useI18n();
  const { session } = useAuth();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<TKey | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!session?.user.email) {
    return (
      <Screen style={{ maxWidth: 460 }}>
        <Stack.Screen options={{ title: t('changePassword') }} />
        <Button title={t('login')} onPress={() => router.replace('/login')} />
      </Screen>
    );
  }
  const email = session.user.email;

  async function save() {
    setError(null);
    setDone(false);
    if (!current) return setError('pwCurrentWrong');
    const problem = passwordProblem(password, confirm);
    if (problem) return setError(problem === 'too_short' ? 'pwTooShort' : 'pwMismatch');
    if (password === current) return setError('pwSame');
    setBusy(true);
    const check = await supabase.auth.signInWithPassword({ email, password: current });
    if (check.error) {
      setBusy(false);
      return setError(/Invalid login credentials/i.test(check.error.message) ? 'pwCurrentWrong' : passwordErrorKey(check.error));
    }
    const { error: e } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (e) return setError(passwordErrorKey(e));
    setCurrent('');
    setPassword('');
    setConfirm('');
    setDone(true); // only after Supabase accepted the change
  }

  return (
    <Screen style={{ maxWidth: 460 }}>
      <Stack.Screen options={{ title: t('changePassword') }} />
      <Card style={{ gap: 12 }}>
        <Text style={{ color: colors.muted }}>{email}</Text>
        <Field
          label={t('currentPassword')}
          value={current}
          onChangeText={setCurrent}
          secureTextEntry
          autoComplete="password"
          textContentType="password"
          testID="pw-current"
        />
        <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} onSubmit={save} />
        {error && <Banner tone="warning" text={t(error)} />}
        {done && <Banner tone="success" text={t('pwChangedProfile')} />}
        <Button title={t('savePassword')} onPress={save} loading={busy} testID="pw-change-save" />
      </Card>
    </Screen>
  );
}
