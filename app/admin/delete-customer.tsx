import { router, Stack, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { AdminOnly } from '../../components/AdminOnly';
import { Banner, Button, Card, Field, Loading, Muted, Screen } from '../../components/ui';
import { callDeleteAccount, type DeleteErrorCode } from '../../lib/deleteAccount';
import { confirmAction, showMessage } from '../../lib/dialog';
import { TKey, useI18n } from '../../lib/i18n';
import { colors } from '../../lib/theme';

// Admin → Klientët → Fshi klientin (same server function and checks as the PC panel):
// name, e-mail and orders as the server sees them, warnings, admin password.
type Preview = { name: string; business_name: string; email: string; orders: number; open_orders: number };

function DeleteCustomer() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [info, setInfo] = useState<Preview | null>(null);
  const [error, setError] = useState<DeleteErrorCode | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    callDeleteAccount({ action: 'preview', user_id: id }).then((r) => (r.error ? setError(r.error) : setInfo(r.data as Preview)));
  }, [id]);

  async function remove() {
    setError(null);
    if (!password) return setError('reauth_failed');
    if (!(await confirmAction(t('delCustButton'), t('delCustQuestion'), t('delete'), t('cancel')))) return;
    setBusy(true);
    const r = await callDeleteAccount({ action: 'admin_delete', user_id: id, admin_password: password });
    setBusy(false);
    setPassword('');
    if (r.error || !r.data?.ok) return setError(r.error ?? 'failed');
    router.back(); // the list reloads when it is shown again
    showMessage(t('delCustDone'));
  }

  const errText = (e: DeleteErrorCode) => t(`delCustErr_${['admin_cannot_delete'].includes(e) ? 'target_not_allowed' : e}` as TKey);

  return (
    <Screen style={{ maxWidth: 520 }}>
      <Stack.Screen options={{ title: t('delCustButton') }} />
      <Card style={{ gap: 12 }}>
        <Text style={{ color: colors.text, fontWeight: '700' }}>{t('delCustQuestion')}</Text>
        {!info && !error && <Loading />}
        {info && (
          <>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }} testID="del-cust-name">
              {info.business_name || info.name || '—'}
            </Text>
            {!!info.business_name && !!info.name && <Muted>{info.name}</Muted>}
            <Muted>{info.email}</Muted>
            <Text style={{ color: colors.text }} testID="del-cust-orders">
              {t('delCustOrders', { n: info.orders, open: info.open_orders })}
            </Text>
            {info.orders > 0 ? <Banner tone="warning" text={t('delCustHasOrders')} /> : <Muted>{t('delCustNoOrders')}</Muted>}
            {info.open_orders > 0 && <Banner tone="warning" text={t('delCustHasOpen', { open: info.open_orders })} />}
            <Muted>{t('delCustWhat')}</Muted>
            <Field
              label={t('delCustAdminPassword')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="password"
              textContentType="password"
              testID="del-cust-password"
            />
          </>
        )}
        {error && <Banner tone="warning" text={errText(error)} />}
        {info && <Button variant="danger" icon="trash-outline" title={t('delCustConfirm')} onPress={remove} loading={busy} testID="del-cust-confirm" />}
        <Button variant="secondary" title={t('cancel')} onPress={() => router.back()} />
      </Card>
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <DeleteCustomer />
    </AdminOnly>
  );
}
