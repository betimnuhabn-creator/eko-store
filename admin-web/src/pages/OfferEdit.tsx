import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Badge, Empty, Spinner, Thumb, useConfirm, useToast } from '../components/ui';
import { cancelOffer, listOffers, saveOffer, setOfferActive, type AdminOffer } from '../lib/adminOffers';
import { parseBelgrade, toBelgradeInput } from '../lib/belgrade';
import { useCatalog } from '../lib/data';
import { money, normalize, parseNumber } from '../lib/format';
import { errorText, useI18n, type TKey } from '../lib/i18n';
import { webTone } from './Offers';

type Line = { product_id: string; offer_price: string; offer_wholesale_price: string };

export function OfferEdit() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { t, pick } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const { products, byId, reload } = useCatalog();
  const [offer, setOffer] = useState<AdminOffer | null | undefined>(isNew ? null : undefined);
  const [titleSq, setTitleSq] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [descSq, setDescSq] = useState('');
  const [descEn, setDescEn] = useState('');
  // <input type="datetime-local"> values, always interpreted as Kosovo time
  const [start, setStart] = useState(toBelgradeInput(Date.now()));
  const [end, setEnd] = useState(toBelgradeInput(Date.now() + 7 * 86400_000));
  const [active, setActive] = useState(true);
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    if (isNew) return;
    const o = (await listOffers().catch(() => [])).find((x) => x.id === id) ?? null;
    setOffer(o);
    if (!o) return;
    setTitleSq(o.title_sq);
    setTitleEn(o.title_en);
    setDescSq(o.description_sq);
    setDescEn(o.description_en);
    setStart(toBelgradeInput(o.starts_at));
    setEnd(toBelgradeInput(o.ends_at));
    setActive(o.active);
    setLines(o.items.map((i) => ({ product_id: i.product_id, offer_price: String(i.offer_price), offer_wholesale_price: i.offer_wholesale_price == null ? '' : String(i.offer_wholesale_price) })));
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const matches = useMemo(() => {
    const s = normalize(search.trim());
    if (!s) return [];
    return products.filter((p) => !lines.some((l) => l.product_id === p.id) && normalize(`${p.sku} ${p.name} ${p.name_en}`).includes(s)).slice(0, 10);
  }, [search, products, lines]);

  if (offer === undefined) return <Spinner />;
  if (!isNew && !offer) return <Empty text={t('noOffersAdmin')} />;
  const cancelled = !!offer?.cancelled_at;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const s = parseBelgrade(start);
    const en = parseBelgrade(end);
    if (!s || !en) return toast(t('invalidDate'), 'error');
    setBusy(true);
    try {
      const newId = await saveOffer({
        id: isNew ? null : id,
        title_sq: titleSq, title_en: titleEn, description_sq: descSq, description_en: descEn,
        starts_at: s, ends_at: en, active,
        items: lines.map((l) => ({
          product_id: l.product_id,
          offer_price: parseNumber(l.offer_price),
          offer_wholesale_price: l.offer_wholesale_price.trim() ? parseNumber(l.offer_wholesale_price) : null,
        })),
      });
      toast(t('offerSaved'));
      reload();
      if (isNew) nav(`/offers/${newId}`, { replace: true });
      else await load();
    } catch (err) {
      toast(errorText(t, err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function act(kind: 'toggle' | 'cancel') {
    if (!offer) return;
    if (kind === 'cancel' && !(await confirm(t('cancelOfferConfirm', { name: offer.title_sq }), { danger: true, ok: t('cancelOffer') }))) return;
    setBusy(true);
    try {
      if (kind === 'toggle') await setOfferActive(offer.id, !offer.active);
      else await cancelOffer(offer.id);
      reload();
      await load();
    } catch (err) {
      toast(errorText(t, err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const setLine = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <h1>
          <Link to="/offers" className="muted">
            {t('manageOffers')}
          </Link>{' '}
          / {isNew ? t('newOffer') : offer!.title_sq}{' '}
          {offer && <Badge tone={webTone[offer.state]}>{t(`state_${offer.state}` as TKey)}</Badge>}
        </h1>
        <div className="row">
          {offer && !cancelled && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => act('toggle')} data-testid="offer-toggle">
                {offer.active ? t('deactivateOffer') : t('activateOffer')}
              </button>
              <button type="button" className="btn btn-danger-outline" disabled={busy} onClick={() => act('cancel')} data-testid="offer-cancel">
                {t('cancelOffer')}
              </button>
            </>
          )}
          {!cancelled && (
            <button className="btn btn-primary" disabled={busy} data-testid="offer-save">
              {busy ? t('saving') : t('save')}
            </button>
          )}
        </div>
      </div>

      <div className="grid-2 wide-left">
        <div className="card form">
          <div className="grid-2 tight">
            <label>
              {t('offerTitleSq')}
              <input value={titleSq} onChange={(e) => setTitleSq(e.target.value)} disabled={cancelled} data-testid="o-title" />
            </label>
            <label>
              {t('offerTitleEn')}
              <input value={titleEn} onChange={(e) => setTitleEn(e.target.value)} disabled={cancelled} />
            </label>
          </div>
          <div className="grid-2 tight">
            <label>
              {t('offerDescSq')}
              <textarea rows={3} value={descSq} onChange={(e) => setDescSq(e.target.value)} disabled={cancelled} />
            </label>
            <label>
              {t('offerDescEn')}
              <textarea rows={3} value={descEn} onChange={(e) => setDescEn(e.target.value)} disabled={cancelled} />
            </label>
          </div>
          <div className="grid-2 tight">
            <label>
              {t('offerStart')}
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} disabled={cancelled} data-testid="o-start" />
            </label>
            <label>
              {t('offerEnd')}
              <span className="row" style={{ flexWrap: 'nowrap' }}>
                <input type="datetime-local" className="grow" value={end} onChange={(e) => setEnd(e.target.value)} disabled={cancelled} data-testid="o-end" />
                {!cancelled && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const iso = parseBelgrade(end);
                      if (iso) setEnd(toBelgradeInput(new Date(iso).getTime() + 7 * 86400_000));
                    }}
                    data-testid="offer-extend"
                  >
                    +7
                  </button>
                )}
              </span>
            </label>
          </div>
          {isNew && (
            <label className="check">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
              {t('offerActive')}
            </label>
          )}
        </div>

        <div className="card">
          <h2>{t('offerProducts')}</h2>
          {!cancelled && (
            <>
              <input className="search" style={{ width: '100%' }} placeholder={t('addProductToOffer')} value={search} onChange={(e) => setSearch(e.target.value)} data-testid="o-search" />
              {matches.length > 0 && (
                <ul className="pick-list">
                  {matches.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="bell-item"
                        data-testid={`o-pick-${p.sku}`}
                        onClick={() => {
                          setLines((ls) => [...ls, { product_id: p.id, offer_price: '', offer_wholesale_price: '' }]);
                          setSearch('');
                        }}
                      >
                        <span>
                          {p.sku} · {pick(p.name, p.name_en)} · {money(p.retail_price)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card">
        {lines.length === 0 ? (
          <Empty text={t('offerProducts')} />
        ) : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th />
                  <th>{t('name')}</th>
                  <th className="num">{t('regularRetail')}</th>
                  <th className="num">{t('offerPrice')}</th>
                  <th className="num">%</th>
                  <th className="num">{t('regularWholesale')}</th>
                  <th className="num">{t('offerWholesalePrice')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const p = byId(l.product_id);
                  const retail = Number(p?.retail_price ?? 0);
                  const op = parseNumber(l.offer_price);
                  const pct = retail > 0 && op >= 0 ? Math.round((100 * (retail - op)) / retail) : null;
                  const bad = Number.isFinite(op) && op >= retail;
                  return (
                    <tr key={l.product_id} data-testid={`o-line-${p?.sku}`}>
                      <td data-label="">
                        <Thumb src={p?.images[0]} size={36} />
                      </td>
                      <td data-label={t('name')}>
                        <span className="mono">{p?.sku}</span> {p ? pick(p.name, p.name_en) : ''}
                      </td>
                      <td data-label={t('regularRetail')} className="num">
                        {money(p?.retail_price)}
                      </td>
                      <td data-label={t('offerPrice')} className="num">
                        <input className={`cell-input ${bad ? 'warn-input' : ''}`} inputMode="decimal" value={l.offer_price} onChange={(e) => setLine(i, 'offer_price', e.target.value)} disabled={cancelled} data-testid={`o-price-${p?.sku}`} />
                      </td>
                      <td data-label="%" className="num">
                        {pct != null && Number.isFinite(pct) ? `-${pct}%` : ''}
                      </td>
                      <td data-label={t('regularWholesale')} className="num">
                        {money(p?.wholesale_price)}
                      </td>
                      <td data-label={t('offerWholesalePrice')} className="num">
                        <input className="cell-input" inputMode="decimal" value={l.offer_wholesale_price} onChange={(e) => setLine(i, 'offer_wholesale_price', e.target.value)} disabled={cancelled} />
                      </td>
                      <td data-label="" className="num">
                        {!cancelled && (
                          <button type="button" className="icon-btn danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={t('delete')}>
                            🗑
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </form>
  );
}
