import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AdminOnly } from '../../../components/AdminOnly';
import { ProductImage } from '../../../components/ProductImage';
import { Badge, Button, Card, Checkbox, Empty, Field, H2, Loading, Muted, Row, Screen } from '../../../components/ui';
import { cancelOffer, listOffers, saveOffer, setOfferActive, stateTone, type AdminOffer } from '../../../lib/adminOffers';
import { formatBelgrade, parseBelgrade } from '../../../lib/belgrade';
import { useCatalog } from '../../../lib/catalog';
import { confirmAction, showMessage } from '../../../lib/dialog';
import { money, parseNumber } from '../../../lib/format';
import { errorText, TKey, useI18n } from '../../../lib/i18n';
import { goBack } from '../../../lib/nav';
import { colors } from '../../../lib/theme';

type Line = { product_id: string; offer_price: string; offer_wholesale_price: string };
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function OfferEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { t, pick } = useI18n();
  const { products, byId, reload } = useCatalog();
  const [offer, setOffer] = useState<AdminOffer | null | undefined>(isNew ? null : undefined);
  const [titleSq, setTitleSq] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [descSq, setDescSq] = useState('');
  const [descEn, setDescEn] = useState('');
  const [start, setStart] = useState(formatBelgrade(Date.now()));
  const [end, setEnd] = useState(formatBelgrade(Date.now() + 7 * 86400_000));
  const [active, setActive] = useState(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (isNew) return;
    const all = await listOffers().catch(() => []);
    const o = all.find((x) => x.id === String(id)) ?? null;
    setOffer(o);
    if (o) {
      setTitleSq(o.title_sq);
      setTitleEn(o.title_en);
      setDescSq(o.description_sq);
      setDescEn(o.description_en);
      setStart(formatBelgrade(o.starts_at));
      setEnd(formatBelgrade(o.ends_at));
      setActive(o.active);
      setLines(o.items.map((i) => ({ product_id: i.product_id, offer_price: String(i.offer_price), offer_wholesale_price: i.offer_wholesale_price == null ? '' : String(i.offer_wholesale_price) })));
    }
  };
  useEffect(() => void load(), [id]);

  const matches = useMemo(() => {
    const s = norm(search.trim());
    if (!s) return [];
    return products.filter((p) => !lines.some((l) => l.product_id === p.id) && norm(`${p.sku} ${p.name} ${p.name_en}`).includes(s)).slice(0, 8);
  }, [search, products, lines]);

  if (offer === undefined) return <Loading />;
  if (!isNew && !offer) return <Empty text={t('noOffersAdmin')} />;
  const cancelled = !!offer?.cancelled_at;

  async function save() {
    const s = parseBelgrade(start);
    const e = parseBelgrade(end);
    if (!s || !e) return showMessage(t('error'), t('invalidDate'));
    setBusy(true);
    try {
      const newId = await saveOffer({
        id: isNew ? null : String(id),
        title_sq: titleSq, title_en: titleEn, description_sq: descSq, description_en: descEn,
        starts_at: s, ends_at: e, active,
        items: lines.map((l) => ({
          product_id: l.product_id,
          offer_price: parseNumber(l.offer_price),
          offer_wholesale_price: l.offer_wholesale_price.trim() ? parseNumber(l.offer_wholesale_price) : null,
        })),
      });
      showMessage(t('offerSaved'));
      reload();
      if (isNew) goBack('/admin/offers');
      else load();
      return newId;
    } catch (err) {
      showMessage(t('error'), errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  async function act(kind: 'toggle' | 'cancel') {
    if (!offer) return;
    if (kind === 'cancel' && !(await confirmAction(t('cancelOffer'), t('cancelOfferConfirm', { name: offer.title_sq }), t('cancelOffer'), t('no')))) return;
    setBusy(true);
    try {
      if (kind === 'toggle') await setOfferActive(offer.id, !offer.active);
      else await cancelOffer(offer.id);
      reload();
      await load();
    } catch (err) {
      showMessage(t('error'), errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  const setLine = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  return (
    <Screen style={{ maxWidth: 820 }}>
      <Stack.Screen options={{ title: isNew ? t('newOffer') : t('editOffer') }} />
      {offer && (
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <H2>{offer.title_sq}</H2>
            <Badge label={t(`state_${offer.state}` as TKey)} tone={stateTone[offer.state]} />
          </Row>
          {!cancelled && (
            <Row>
              <Button small variant="secondary" icon={offer.active ? 'pause-outline' : 'play-outline'} title={offer.active ? t('deactivateOffer') : t('activateOffer')} onPress={() => act('toggle')} disabled={busy} testID="offer-toggle" />
              <Button small variant="secondary" icon="time-outline" title={t('extend7')} onPress={() => { const e = parseBelgrade(end); if (e) setEnd(formatBelgrade(new Date(e).getTime() + 7 * 86400_000)); }} disabled={busy} testID="offer-extend" />
              <Button small variant="danger" icon="close-circle-outline" title={t('cancelOffer')} onPress={() => act('cancel')} disabled={busy} testID="offer-cancel" />
            </Row>
          )}
        </Card>
      )}
      <Card>
        <Field label={t('offerTitleSq')} value={titleSq} onChangeText={setTitleSq} autoCapitalize="sentences" editable={!cancelled} testID="o-title" />
        <Field label={t('offerTitleEn')} value={titleEn} onChangeText={setTitleEn} autoCapitalize="sentences" editable={!cancelled} />
        <Field label={t('offerDescSq')} value={descSq} onChangeText={setDescSq} multiline autoCapitalize="sentences" editable={!cancelled} />
        <Field label={t('offerDescEn')} value={descEn} onChangeText={setDescEn} multiline autoCapitalize="sentences" editable={!cancelled} />
        <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Field label={t('offerStart')} value={start} onChangeText={setStart} placeholder="15.11.2026 08:00" error={parseBelgrade(start) ? null : t('invalidDate')} editable={!cancelled} testID="o-start" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t('offerEnd')} value={end} onChangeText={setEnd} placeholder="30.11.2026 23:59" error={parseBelgrade(end) ? null : t('invalidDate')} editable={!cancelled} testID="o-end" />
          </View>
        </Row>
        <Muted>{t('dateFormatHint')}</Muted>
        {isNew && <Checkbox checked={active} onChange={setActive} label={t('offerActive')} />}
      </Card>

      <Card>
        <H2>{t('offerProducts')}</H2>
        {lines.map((l, i) => {
          const p = byId(l.product_id);
          const retail = Number(p?.retail_price ?? 0);
          const pct = retail > 0 && parseNumber(l.offer_price) >= 0 ? Math.round((100 * (retail - parseNumber(l.offer_price))) / retail) : null;
          return (
            <View key={l.product_id} style={{ gap: 6, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: '#EEF2F6' }}>
              <Row style={{ flexWrap: 'nowrap' }}>
                <ProductImage uri={p?.images[0]} style={{ width: 44, height: 44, borderRadius: 6 }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', color: colors.text }}>{p ? pick(p.name, p.name_en) : l.product_id}</Text>
                  <Muted>
                    {p?.sku} · {t('regularRetail')} {money(p?.retail_price)} · {t('regularWholesale')} {money(p?.wholesale_price)}
                  </Muted>
                </View>
                {!cancelled && <Button small variant="ghost" icon="trash-outline" title="" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} />}
              </Row>
              <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Field label={`${t('offerPrice')}${pct != null && Number.isFinite(pct) ? `  (-${pct}%)` : ''}`} value={l.offer_price} onChangeText={(v) => setLine(i, 'offer_price', v)} keyboardType="decimal-pad" editable={!cancelled} testID={`o-price-${p?.sku}`} />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label={t('offerWholesalePrice')} value={l.offer_wholesale_price} onChangeText={(v) => setLine(i, 'offer_wholesale_price', v)} keyboardType="decimal-pad" editable={!cancelled} />
                </View>
              </Row>
            </View>
          );
        })}
        {!cancelled && (
          <>
            <Field placeholder={t('addProductToOffer')} value={search} onChangeText={setSearch} testID="o-search" />
            {matches.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => {
                  setLines((ls) => [...ls, { product_id: p.id, offer_price: '', offer_wholesale_price: '' }]);
                  setSearch('');
                }}
                style={{ paddingVertical: 8, flexDirection: 'row', gap: 8, alignItems: 'center' }}
                testID={`o-pick-${p.sku}`}
              >
                <ProductImage uri={p.images[0]} style={{ width: 32, height: 32, borderRadius: 4 }} />
                <Text style={{ color: colors.text, flex: 1 }}>
                  {p.sku} · {pick(p.name, p.name_en)} · {money(p.retail_price)}
                </Text>
              </Pressable>
            ))}
          </>
        )}
      </Card>
      {!cancelled && <Button title={t('save')} icon="save-outline" onPress={save} loading={busy} testID="o-save" />}
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <OfferEditor />
    </AdminOnly>
  );
}
