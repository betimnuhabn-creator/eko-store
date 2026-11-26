import { useCallback, useEffect, useState } from 'react';
import { useCatalog } from '../lib/data';
import { dateTime } from '../lib/format';
import { errorText, useI18n, type TKey } from '../lib/i18n';
import { fetchWooStatus, retryOrders, setOrdersEnabled, syncNow, type WooStatus } from '../lib/woo';
import { useConfirm, useToast } from './ui';

// Produktet → "Faqja eko-store.com": the website is the source of the products.
// Hidden until the website sync is installed in the database.
export function WooSyncCard({ onSynced }: { onSynced: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { reload } = useCatalog();
  const [st, setSt] = useState<WooStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => fetchWooStatus().then(setSt), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!st) return null;

  async function sync() {
    setBusy(true);
    const r = await syncNow();
    setBusy(false);
    if (!r.ok) return toast(t(`woo_err_${r.error}` as TKey) || t('woo_err_failed'), 'error');
    const x = r.result ?? {};
    toast(t('woo_synced', { created: x.created ?? 0, updated: x.updated ?? 0, deactivated: x.deactivated ?? 0 }));
    await Promise.all([load(), reload()]);
    onSynced();
  }

  async function toggleOrders() {
    const on = !st!.orders_enabled;
    if (!(await confirm(t(on ? 'woo_orders_on_confirm' : 'woo_orders_off_confirm'), { danger: !on }))) return;
    try {
      await setOrdersEnabled(on);
      await load();
    } catch (e) {
      toast(errorText(t, e), 'error');
    }
  }

  const ls = st.last_sync;
  return (
    <div className="card" data-testid="woo-card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <strong>{t('woo_title')}</strong>
          <div className="muted small" data-testid="woo-summary">
            {st.last_sync_at
              ? t('woo_summary', { n: st.products, active: st.products_active, at: dateTime(st.last_sync_at) })
              : t('woo_never')}
            {ls && (ls.errors?.length ?? 0) > 0 && ` · ${t('woo_errors', { n: ls.errors!.length })}`}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-primary" onClick={sync} disabled={busy} data-testid="woo-sync">
            {busy ? '…' : t('woo_sync_now')}
          </button>
          <button className={`btn ${st.orders_enabled ? 'btn-primary' : ''}`} onClick={toggleOrders} data-testid="woo-orders">
            {st.orders_enabled ? '✔ ' : ''}
            {t('woo_orders_toggle')}
          </button>
        </div>
      </div>
      <p className="muted small">{t('woo_note')}</p>
      {st.products_no_retail > 0 && (
        <div className="alert alert-warn" data-testid="woo-no-retail">
          {t('woo_no_retail', { n: st.products_no_retail })}
        </div>
      )}
      {st.orders_enabled && (
        <p className="muted small" data-testid="woo-orders-status">
          {t('woo_orders_status', { sent: st.orders_sent, pending: st.orders_pending })}
          {!st.functions_url_set && ` ${t('woo_no_scheduler')}`}
        </p>
      )}
      {(st.prices_failed ?? 0) > 0 && (
        <div className="alert alert-warn" data-testid="woo-prices-failed">
          {t('woo_prices_failed', { n: st.prices_failed })} {st.last_price_error ? `(${st.last_price_error})` : ''}
        </div>
      )}
      {st.orders_failed > 0 && (
        <div className="alert alert-warn" data-testid="woo-orders-failed">
          {t('woo_orders_failed', { n: st.orders_failed })} {st.last_order_error ? `(${st.last_order_error})` : ''}{' '}
          <button
            className="btn btn-sm"
            onClick={async () => {
              await retryOrders();
              await load();
            }}
          >
            {t('woo_retry')}
          </button>
        </div>
      )}
    </div>
  );
}
