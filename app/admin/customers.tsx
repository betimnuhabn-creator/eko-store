import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { AdminOnly } from '../../components/AdminOnly';
import { Badge, Button, Card, Chip, Empty, Field, Loading, Muted, Row, Screen } from '../../components/ui';
import { confirmAction, showMessage } from '../../lib/dialog';
import { dateTime } from '../../lib/format';
import { errorText, TKey, useI18n } from '../../lib/i18n';
import { useNotifications } from '../../lib/notifications';
import { dispatchNotifications, supabase } from '../../lib/supabase';
import { colors } from '../../lib/theme';
import type { Profile } from '../../lib/types';

type Filter = 'pending' | 'wholesale' | 'retail' | 'all';

function Customers() {
  const params = useLocalSearchParams<{ filter?: string }>();
  const { t, lang } = useI18n();
  const { version } = useNotifications();
  const [filter, setFilter] = useState<Filter>((params.filter as Filter) ?? 'all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Profile[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .neq('role', 'admin')
      .order('created_at', { ascending: false })
      .limit(1000);
    setRows((data ?? []) as Profile[]);
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));
  useEffect(() => void load(), [version, load]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows ?? []).filter(
      (p) =>
        (filter === 'all' ||
          (filter === 'pending' && p.wholesale_status === 'pending') ||
          (filter === 'wholesale' && p.role === 'wholesale') ||
          (filter === 'retail' && p.role === 'retail')) &&
        (!s || `${p.full_name} ${p.business_name} ${p.email} ${p.phone}`.toLowerCase().includes(s)),
    );
  }, [rows, filter, q]);

  async function review(p: Profile, approve: boolean) {
    if (!approve && p.role === 'wholesale') {
      if (!(await confirmAction(t('revokeWholesale'), p.business_name || p.full_name, t('yes'), t('no')))) return;
    }
    setBusyId(p.id);
    const { error } = await supabase.rpc('admin_review_wholesale', { p_user: p.id, p_approve: approve });
    setBusyId(null);
    if (error) return showMessage(t('error'), errorText(t, error));
    dispatchNotifications();
    load();
  }

  if (!rows) return <Loading />;
  const pendingCount = rows.filter((r) => r.wholesale_status === 'pending').length;

  return (
    <Screen style={{ maxWidth: 900 }} onRefresh={load}>
      <Stack.Screen options={{ title: t('manageCustomers') }} />
      <Row>
        <Chip label={t('all')} active={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label={`${t('filterPending')} (${pendingCount})`} active={filter === 'pending'} onPress={() => setFilter('pending')} />
        <Chip label={t('tier_wholesale')} active={filter === 'wholesale'} onPress={() => setFilter('wholesale')} />
        <Chip label={t('tier_retail')} active={filter === 'retail'} onPress={() => setFilter('retail')} />
      </Row>
      <Field placeholder={t('search')} value={q} onChangeText={setQ} />
      {list.length === 0 && <Empty icon="people-outline" text="—" />}
      {list.map((p) => (
        <Card key={p.id} style={{ gap: 6 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontWeight: '700', color: colors.text, fontSize: 16 }}>{p.business_name || p.full_name || p.email}</Text>
            <Row style={{ gap: 6 }}>
              <Badge label={t(`role_${p.role}` as TKey)} tone={p.role === 'wholesale' ? 'success' : 'muted'} />
              {p.wholesale_status === 'pending' && <Badge label={t('filterPending')} tone="warning" />}
              {p.wholesale_status === 'rejected' && <Badge label={t('reject')} tone="danger" />}
            </Row>
          </Row>
          {!!p.business_name && <Muted>{p.full_name}</Muted>}
          <Muted>
            {p.email} · {p.phone}
            {p.business_number ? ` · ${p.business_number}` : ''}
          </Muted>
          {!!(p.address || p.city) && (
            <Muted>
              {p.address} {p.city}
            </Muted>
          )}
          <Muted>
            {t('registeredOn')} {dateTime(p.created_at, lang)}
          </Muted>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {p.wholesale_status === 'pending' && (
              <>
                <Button small icon="checkmark" title={t('approve')} onPress={() => review(p, true)} loading={busyId === p.id} testID={`approve-${p.email}`} />
                <Button small variant="danger" icon="close" title={t('reject')} onPress={() => review(p, false)} disabled={busyId === p.id} />
              </>
            )}
            {p.role === 'retail' && p.wholesale_status !== 'pending' && (
              <Button small variant="secondary" icon="briefcase-outline" title={`${t('approve')}: ${t('tier_wholesale')}`} onPress={() => review(p, true)} disabled={busyId === p.id} />
            )}
            {p.role === 'wholesale' && (
              <Button small variant="secondary" icon="remove-circle-outline" title={t('revokeWholesale')} onPress={() => review(p, false)} disabled={busyId === p.id} />
            )}
            {!!p.phone && <Button small variant="ghost" icon="call-outline" title={t('call')} onPress={() => Linking.openURL(`tel:${p.phone}`)} />}
          </View>
        </Card>
      ))}
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <Customers />
    </AdminOnly>
  );
}
