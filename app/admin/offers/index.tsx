import { router, Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { AdminOnly } from '../../../components/AdminOnly';
import { Badge, Banner, Button, Card, Empty, ListItem, Loading, Screen } from '../../../components/ui';
import { listOffers, offersSupported, stateTone, type AdminOffer } from '../../../lib/adminOffers';
import { formatBelgrade } from '../../../lib/belgrade';
import { TKey, useI18n } from '../../../lib/i18n';

function OffersAdmin() {
  const { t } = useI18n();
  const [offers, setOffers] = useState<AdminOffer[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const ok = await offersSupported();
    setSupported(ok);
    setOffers(ok ? await listOffers().catch(() => []) : []);
    setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  return (
    <Screen refreshing={loading} onRefresh={load}>
      <Stack.Screen options={{ title: t('manageOffers') }} />
      {!supported ? (
        <Banner tone="warning" text="Ofertat kërkojnë migrimin 20261112000000_offers_promo_notifications.sql në Supabase." />
      ) : (
        <>
          <Button icon="add-circle-outline" title={t('newOffer')} onPress={() => router.push('/admin/offers/new')} testID="new-offer" />
          <Button variant="secondary" icon="notifications-outline" title={t('promoSettings')} onPress={() => router.push('/admin/promo')} testID="open-promo" />
          {!offers ? (
            <Loading />
          ) : offers.length === 0 ? (
            <Empty icon="pricetags-outline" text={t('noOffersAdmin')} />
          ) : (
            <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
              {offers.map((o) => (
                <View key={o.id} testID={`admin-offer-${o.title_sq}`}>
                  <ListItem
                    title={`${o.title_sq} · ${o.items.length}`}
                    subtitle={`${formatBelgrade(o.starts_at)} → ${formatBelgrade(o.ends_at)}`}
                    right={<Badge label={t(`state_${o.state}` as TKey)} tone={stateTone[o.state]} />}
                    onPress={() => router.push(`/admin/offers/${o.id}`)}
                  />
                </View>
              ))}
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <OffersAdmin />
    </AdminOnly>
  );
}
