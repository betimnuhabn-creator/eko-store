import { Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { AdminOnly } from '../../components/AdminOnly';
import { Badge, Banner, Button, Card, Checkbox, Field, H2, Loading, Muted, Row, Screen } from '../../components/ui';
import { getPromoSettings, setPromoSettings, type PromoSettings } from '../../lib/adminOffers';
import { formatBelgrade } from '../../lib/belgrade';
import { confirmAction, showMessage } from '../../lib/dialog';
import { errorText, TKey, useI18n } from '../../lib/i18n';
import { colors } from '../../lib/theme';

function Promo() {
  const { t } = useI18n();
  const [s, setS] = useState<PromoSettings | null | undefined>(undefined);
  const [cap, setCap] = useState('3');
  const [debounce, setDebounce] = useState('5');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const v = await getPromoSettings();
    setS(v);
    if (v) {
      setCap(String(v.daily_cap));
      setDebounce(String(v.debounce_minutes));
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  if (s === undefined) return <Loading />;
  if (s === null) return <Banner tone="warning" text="Kërkohet migrimi 20261112000000_offers_promo_notifications.sql." />;

  async function update(p: Parameters<typeof setPromoSettings>[0]) {
    // Going live for real customers needs an explicit confirmation.
    const goesLive = (p.enabled ?? s!.enabled) && !(p.test_only ?? s!.test_only);
    const wasLive = s!.enabled && !s!.test_only;
    if (goesLive && !wasLive && !(await confirmAction(t('promoSettings'), t('promoEnableConfirm'), t('yes'), t('no')))) return;
    setBusy(true);
    try {
      await setPromoSettings(p);
      await load();
    } catch (e) {
      showMessage(t('error'), errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  const mode = !s.enabled ? 'promoOffHint' : s.test_only ? 'promoTestHint' : 'promoLiveHint';
  return (
    <Screen style={{ maxWidth: 720 }}>
      <Stack.Screen options={{ title: t('promoSettings') }} />
      <Banner tone={!s.enabled ? 'info' : s.test_only ? 'warning' : 'success'} text={t(mode as TKey)} />
      <Card>
        <Checkbox checked={s.enabled} onChange={(v) => update({ enabled: v })} label={t('promoEnabledLabel')} />
        <Checkbox checked={s.test_only} onChange={(v) => update({ test_only: v })} label={t('promoTestOnly')} />
        <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}>
          <View style={{ flex: 1 }}>
            <Field label={t('promoDailyCap')} value={cap} onChangeText={(v) => setCap(v.replace(/\D/g, ''))} keyboardType="number-pad" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t('promoDebounce')} value={debounce} onChangeText={(v) => setDebounce(v.replace(/\D/g, ''))} keyboardType="number-pad" />
          </View>
        </Row>
        <Button small title={t('save')} onPress={() => update({ daily_cap: Number(cap || 0), debounce_minutes: Number(debounce || 0) })} loading={busy} />
        <Muted>
          {t('promoTesters')}: {s.testers} · {t('promoOptedIn')}: {s.opted_in} · {t('promoPending')}: {s.pending_events}
        </Muted>
      </Card>
      <Card>
        <H2>{t('promoRecent')}</H2>
        {s.events.length === 0 && <Muted>—</Muted>}
        {s.events.map((e) => (
          <View key={e.id} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: '#EEF2F6', gap: 2 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text style={{ fontWeight: '700', color: colors.text }}>
                {t(`ev_${e.kind}` as TKey)}: {e.subject ?? '—'}
              </Text>
              <Badge label={`${t(`evs_${e.status}` as TKey)}${e.status === 'sent' ? ` (${e.recipients ?? 0})` : ''}`} tone={e.status === 'sent' ? 'success' : e.status === 'pending' ? 'warning' : 'muted'} />
            </Row>
            <Muted>{formatBelgrade(e.created_at)}</Muted>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <Promo />
    </AdminOnly>
  );
}
