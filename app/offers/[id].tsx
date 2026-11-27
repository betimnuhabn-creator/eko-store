import { Stack, router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { OfferCard } from '../../components/OfferCard';
import { Button, Empty, Loading, Screen } from '../../components/ui';
import { useI18n } from '../../lib/i18n';
import { fetchOffers, type Offer } from '../../lib/offers';

// Opened from an "offer" push notification.
export default function OfferScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, pick } = useI18n();
  const [offer, setOffer] = useState<Offer | null | undefined>(undefined);

  useEffect(() => {
    fetchOffers().then((all) => setOffer(all.find((o) => o.id === String(id)) ?? null));
  }, [id]);

  if (offer === undefined) return <Loading />;
  return (
    <Screen>
      <Stack.Screen options={{ title: offer ? pick(offer.title_sq, offer.title_en) : t('offersTitle') }} />
      {offer ? <OfferCard offer={offer} /> : <Empty icon="pricetags-outline" text={t('noOffers')} />}
      <Button variant="secondary" icon="pricetags-outline" title={t('offersTitle')} onPress={() => router.replace('/offers')} />
    </Screen>
  );
}
