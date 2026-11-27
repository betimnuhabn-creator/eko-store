import { useCallback, useEffect, useState } from 'react';
import { Badge, Spinner, useConfirm, useToast } from '../components/ui';
import { getPromoSettings, setPromoSettings, type PromoSettings } from '../lib/adminOffers';
import { formatBelgrade } from '../lib/belgrade';
import { errorText, useI18n, type TKey } from '../lib/i18n';

export function Promo() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [s, setS] = useState<PromoSettings | null | undefined>(undefined);
  const [cap, setCap] = useState('3');
  const [debounce, setDebounce] = useState('5');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const v = await getPromoSettings();
    setS(v);
    if (v) {
      setCap(String(v.daily_cap));
      setDebounce(String(v.debounce_minutes));
      setUrl(v.functions_url);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (s === undefined) return <Spinner />;
  if (s === null) return <div className="alert alert-warn">Kërkohet migrimi 20261112000000_offers_promo_notifications.sql.</div>;

  async function update(p: Parameters<typeof setPromoSettings>[0]) {
    const goesLive = (p.enabled ?? s!.enabled) && !(p.test_only ?? s!.test_only);
    const wasLive = s!.enabled && !s!.test_only;
    if (goesLive && !wasLive && !(await confirm(t('promoEnableConfirm'), { danger: true, ok: t('yes') }))) return;
    setBusy(true);
    try {
      await setPromoSettings(p);
      toast(t('saved'));
      await load();
    } catch (e) {
      toast(errorText(t, e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const mode: TKey = !s.enabled ? 'promoOffHint' : s.test_only ? 'promoTestHint' : 'promoLiveHint';
  return (
    <>
      <div className="page-head">
        <h1>{t('promoSettings')}</h1>
      </div>
      <div className={`alert ${!s.enabled ? '' : s.test_only ? 'alert-warn' : 'alert-ok'}`} data-testid="promo-mode">
        {t(mode)}
      </div>
      <div className="grid-2">
        <div className="card form">
          <label className="check">
            <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => update({ enabled: e.target.checked })} data-testid="promo-enabled" />
            {t('promoEnabledLabel')}
          </label>
          <label className="check">
            <input type="checkbox" checked={s.test_only} disabled={busy} onChange={(e) => update({ test_only: e.target.checked })} data-testid="promo-test-only" />
            {t('promoTestOnly')}
          </label>
          <div className="grid-2 tight">
            <label>
              {t('promoDailyCap')}
              <input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} />
            </label>
            <label>
              {t('promoDebounce')}
              <input inputMode="numeric" value={debounce} onChange={(e) => setDebounce(e.target.value.replace(/\D/g, ''))} />
            </label>
          </div>
          <label>
            {t('promoFunctionsUrl')}
            <input placeholder="https://xxxx.supabase.co/functions/v1" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => update({ daily_cap: Number(cap || 0), debounce_minutes: Number(debounce || 0), functions_url: url.trim() })}
          >
            {t('save')}
          </button>
          {s.dispatch && s.dispatch.state !== 'no_pg_net' && (
            <p className={`small ${s.dispatch.state === 'error' ? 'alert alert-warn' : 'muted'}`} data-testid="dispatch-status">
              {s.dispatch.state === 'ok'
                ? `✓ ${t('dispatchOk')} (HTTP ${s.dispatch.status_code}, ${formatBelgrade(s.dispatch.at!)})`
                : s.dispatch.state === 'error'
                  ? `${t('dispatchError')}: ${s.dispatch.timed_out ? 'timeout' : s.dispatch.status_code ? `HTTP ${s.dispatch.status_code}` : s.dispatch.error}`
                    + (s.dispatch.status_code === 401 ? ` — ${t('dispatchJwtHint')}` : '')
                  : t(s.dispatch.state === 'pending' ? 'dispatchPending' : 'dispatchNotCalled')}
            </p>
          )}
          <p className="muted small">
            {t('promoTesters')}: {s.testers} · {t('promoOptedIn')}: {s.opted_in} · {t('promoPending')}: {s.pending_events}
          </p>
        </div>
        <div className="card">
          <h2>{t('promoRecent')}</h2>
          <table className="table responsive">
            <tbody>
              {s.events.length === 0 && (
                <tr>
                  <td className="muted">—</td>
                </tr>
              )}
              {s.events.map((e) => (
                <tr key={e.id}>
                  <td data-label={t('date')}>{formatBelgrade(e.created_at)}</td>
                  <td data-label={t('type')}>
                    {t(`ev_${e.kind}` as TKey)}: <strong>{e.subject ?? '—'}</strong>
                  </td>
                  <td data-label={t('status')}>
                    <Badge tone={e.status === 'sent' ? 'ok' : e.status === 'pending' ? 'warn' : 'muted'}>
                      {t(`evs_${e.status}` as TKey)}
                      {e.status === 'sent' ? ` (${e.recipients ?? 0})` : ''}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
