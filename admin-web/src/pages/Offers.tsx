import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Badge, Empty, Spinner } from '../components/ui';
import { listOffers, offersSupported, type AdminOffer, type OfferState } from '../lib/adminOffers';
import { formatBelgrade } from '../lib/belgrade';
import { errorText, useI18n, type TKey } from '../lib/i18n';

export const webTone: Record<OfferState, 'ok' | 'info' | 'muted' | 'warn' | 'bad'> = {
  live: 'ok',
  scheduled: 'info',
  expired: 'muted',
  inactive: 'warn',
  cancelled: 'bad',
};

export function Offers() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [offers, setOffers] = useState<AdminOffer[] | null>(null);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const ok = await offersSupported();
    setSupported(ok);
    if (!ok) return setOffers([]);
    try {
      setOffers(await listOffers());
    } catch (e) {
      setError(errorText(t, e));
      setOffers([]);
    }
  }, [t]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1>{t('manageOffers')}</h1>
        {supported && (
          <div className="row">
            <button className="btn" onClick={() => nav('/promo')}>
              🔔 {t('promoSettings')}
            </button>
            <button className="btn btn-primary" onClick={() => nav('/offers/new')} data-testid="new-offer">
              + {t('newOffer')}
            </button>
          </div>
        )}
      </div>
      <div className="card">
        {!supported && <div className="alert alert-warn">Ofertat kërkojnë migrimin 20261112000000_offers_promo_notifications.sql në Supabase.</div>}
        {error && <div className="alert alert-error">{error}</div>}
        {!offers ? (
          <Spinner />
        ) : offers.length === 0 ? (
          supported && <Empty text={t('noOffersAdmin')} />
        ) : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>{t('offerTitleSq')}</th>
                  <th>{t('offerStart')}</th>
                  <th>{t('offerEnd')}</th>
                  <th className="num">{t('products')}</th>
                  <th>{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {offers.map((o) => (
                  <tr key={o.id} data-testid={`offer-row-${o.title_sq}`}>
                    <td data-label={t('offerTitleSq')}>
                      <Link to={`/offers/${o.id}`}>{o.title_sq}</Link>
                    </td>
                    <td data-label={t('offerStart')}>{formatBelgrade(o.starts_at)}</td>
                    <td data-label={t('offerEnd')}>{formatBelgrade(o.ends_at)}</td>
                    <td data-label={t('products')} className="num">
                      {o.items.length}
                    </td>
                    <td data-label={t('status')}>
                      <Badge tone={webTone[o.state]}>{t(`state_${o.state}` as TKey)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
