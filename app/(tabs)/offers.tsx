import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { OfferCard } from '../../components/OfferCard';
import { Banner, Button, Card, Empty, Loading, Muted, Row, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useCatalog } from '../../lib/catalog';
import { showMessage } from '../../lib/dialog';
import { useI18n } from '../../lib/i18n';
import { fetchOffers, fetchPromoPrefs, savePromoPrefs, type Offer } from '../../lib/offers';
import { registerForPush } from '../../lib/push';

const ASKED_KEY = 'eko.promoAsked';

export default function OffersScreen() {
  const { t } = useI18n();
  const { session } = useAuth();
  const { reload: reloadCatalog } = useCatalog();
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [ask, setAsk] = useState(false);
  const uid = session?.user.id;

  const load = useCallback(async () => {
    setLoading(true);
    setOffers(await fetchOffers());
    setLoading(false);
    // One-time invitation to opt in to promotional notifications.
    if (uid) {
      const prefs = await fetchPromoPrefs(uid);
      const asked = await AsyncStorage.getItem(`${ASKED_KEY}.${uid}`).catch(() => '1');
      setAsk(!!prefs && !asked && !prefs.promo_new_products && !prefs.promo_offers && !prefs.promo_price_changes);
    } else setAsk(false);
  }, [uid]);
  useFocusEffect(useCallback(() => void load(), [load]));

  async function answer(yes: boolean) {
    setAsk(false);
    await AsyncStorage.setItem(`${ASKED_KEY}.${uid}`, yes ? 'yes' : 'no').catch(() => {});
    if (!yes) return;
    try {
      if (Platform.OS !== 'web') await registerForPush();
      await savePromoPrefs({ promo_new_products: true, promo_offers: true, promo_price_changes: true });
      showMessage(t('promoEnabled'));
    } catch (e: any) {
      showMessage(t('error'), String(e?.message ?? e));
    }
  }

  if (!offers) return <Loading />;
  return (
    <Screen
      refreshing={loading}
      onRefresh={() => {
        load();
        reloadCatalog();
      }}
    >
      {ask && (
        <Card>
          <Muted>{t('promoAsk')}</Muted>
          <Row>
            <Button small icon="notifications-outline" title={t('enable')} onPress={() => answer(true)} testID="promo-ask-yes" />
            <Button small variant="secondary" title={t('notNow')} onPress={() => answer(false)} testID="promo-ask-no" />
          </Row>
        </Card>
      )}
      {!session && offers.length > 0 && <Banner text={t('guestAccount')} />}
      {offers.length === 0 ? (
        <Empty icon="pricetags-outline" text={t('noOffers')} />
      ) : (
        offers.map((o) => <OfferCard key={o.id} offer={o} onAdded={(name) => Platform.OS !== 'web' && showMessage(t('addedToCart'), name)} />)
      )}
    </Screen>
  );
}
