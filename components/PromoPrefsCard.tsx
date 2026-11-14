import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useAuth } from '../lib/auth';
import { showMessage } from '../lib/dialog';
import { errorText, useI18n } from '../lib/i18n';
import { fetchPromoPrefs, savePromoPrefs, type PromoPrefs } from '../lib/offers';
import { registerForPush } from '../lib/push';
import { Card, Checkbox, H2, Muted } from './ui';

/** Opt-in switches for promotional notifications (hidden until the database supports them). */
export function PromoPrefsCard() {
  const { t } = useI18n();
  const { session } = useAuth();
  const [prefs, setPrefs] = useState<PromoPrefs | null>(null);
  const uid = session?.user.id;

  useEffect(() => {
    if (uid) fetchPromoPrefs(uid).then(setPrefs);
  }, [uid]);
  if (!prefs) return null;

  async function toggle(k: keyof PromoPrefs, v: boolean) {
    const next = { ...prefs!, [k]: v };
    setPrefs(next);
    try {
      if (v && Platform.OS !== 'web') await registerForPush(); // asks for the Android/iOS permission if needed
      await savePromoPrefs(next);
    } catch (e) {
      setPrefs(prefs);
      showMessage(t('error'), errorText(t, e));
    }
  }

  return (
    <Card testID="promo-prefs">
      <H2>{t('promoTitle')}</H2>
      <Checkbox checked={prefs.promo_offers} onChange={(v) => toggle('promo_offers', v)} label={t('promoOffers')} />
      <Checkbox checked={prefs.promo_new_products} onChange={(v) => toggle('promo_new_products', v)} label={t('promoNewProducts')} />
      <Checkbox checked={prefs.promo_price_changes} onChange={(v) => toggle('promo_price_changes', v)} label={t('promoPriceChanges')} />
      <Muted>{t('promoHint')}</Muted>
    </Card>
  );
}
