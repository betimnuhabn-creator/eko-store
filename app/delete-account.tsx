import { router, Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Banner, Button, Card, Field, Screen } from '../components/ui';
import { useAuth } from '../lib/auth';
import { confirmAction, showMessage } from '../lib/dialog';
import { TKey, useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';
import { colors } from '../lib/theme';

// Llogaria → Fshi llogarinë time. The deletion runs on the server (Edge
// Function `delete-account`): it re-checks the password, removes the Supabase
// Auth account, profile, notifications and push tokens, and keeps the orders
// for accounting. Afterwards the app logs out.
const OPEN = ['new', 'confirmed', 'preparing', 'shipped', 'accepted'];
type ErrKey = 'reauth_failed' | 'admin_cannot_delete' | 'unavailable' | 'network' | 'failed';

export default function DeleteAccountScreen() {
  const { t } = useI18n();
  const { session, profile, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(0);
  const [error, setError] = useState<ErrKey | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    supabase
      .from('orders')
      .select('status')
      .eq('customer_id', session.user.id)
      .then(({ data }) => setOpen((data ?? []).filter((o: { status: string }) => OPEN.includes(o.status)).length));
  }, [session]);

  if (!session) {
    return (
      <Screen style={{ maxWidth: 460 }}>
        <Stack.Screen options={{ title: t('deleteMyAccount') }} />
        <Button title={t('login')} onPress={() => router.replace('/login')} />
      </Screen>
    );
  }

  async function remove() {
    setError(null);
    if (!password) return setError('reauth_failed');
    if (!(await confirmAction(t('deleteMyAccount'), t('delAccFinal'), t('delete'), t('cancel')))) return;
    setBusy(true);
    let code: ErrKey | null = null;
    try {
      const { data, error: e } = await supabase.functions.invoke('delete-account', { body: { action: 'self', password } });
      if (e) {
        const ctx = (e as any).context as Response | undefined;
        if (ctx && typeof ctx.status === 'number') {
          const body = await ctx.json().catch(() => ({}));
          const c = String(body?.error ?? '');
          code = c === 'reauth_failed' || c === 'admin_cannot_delete' ? c : ctx.status === 404 && c !== 'not_found' ? 'unavailable' : 'failed';
        } else code = (e as any).name === 'FunctionsFetchError' ? 'network' : 'unavailable';
      } else if (!data?.ok) code = 'failed';
    } catch {
      code = 'network';
    }
    setBusy(false);
    setPassword('');
    if (code) return setError(code);
    // The account no longer exists: end the local session and leave.
    await signOut().catch(() => {});
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    router.replace('/');
    showMessage(t('accountDeleted'));
  }

  return (
    <Screen style={{ maxWidth: 520 }}>
      <Stack.Screen options={{ title: t('deleteMyAccount') }} />
      <Card style={{ gap: 12 }}>
        <Text style={{ color: colors.text, fontWeight: '700' }}>{t('delAccIntro')}</Text>
        <Text style={{ color: colors.muted }}>{session.user.email}</Text>
        <Text style={{ color: colors.text }}>{t('delAccDeleted')}</Text>
        <Text style={{ color: colors.text }}>{t('delAccKept')}</Text>
        {open > 0 && <Banner tone="warning" text={t('delAccOpenOrders', { n: open })} />}
        {profile?.role === 'admin' ? (
          <Banner tone="warning" text={t('delAccErr_admin_cannot_delete')} />
        ) : (
          <>
            <Field
              label={t('delAccPassword')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              testID="del-password"
            />
            {error && <Banner tone="warning" text={t(`delAccErr_${error}` as TKey)} />}
            <Button variant="danger" icon="trash-outline" title={t('deleteMyAccount')} onPress={remove} loading={busy} testID="del-submit" />
          </>
        )}
        <Button variant="secondary" title={t('cancel')} onPress={() => router.back()} />
      </Card>
    </Screen>
  );
}
