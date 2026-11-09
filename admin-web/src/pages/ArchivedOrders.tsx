import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Pager, Spinner, StatusBadge, useConfirm, usePaging, useToast } from '../components/ui';
import { dateTime, money, normalize } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { restoreOrder } from '../lib/orders';
import { supabase } from '../lib/supabase';
import type { Order } from '../lib/types';

export function ArchivedOrders() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from('orders')
      .select('*, profiles(email,full_name,business_name,phone)')
      .not('archived_at', 'is', null)
      .order('archived_at', { ascending: false })
      .limit(2000);
    if (e) setError(errorText(t, e));
    setOrders((data ?? []) as Order[]);
  }, [t]);
  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const s = normalize(q.trim().replace(/^#/, ''));
    return (orders ?? []).filter(
      (o) => !s || String(o.order_number).includes(s) || normalize(`${o.delivery_name} ${o.delivery_phone} ${o.delivery_city} ${o.profiles?.business_name ?? ''}`).includes(s),
    );
  }, [orders, q]);
  const paging = usePaging(rows, 50);

  async function restore(o: Order) {
    if (!(await confirm(t('restoreConfirm', { n: o.order_number }), { ok: t('restoreOrder') }))) return;
    setBusy(o.id);
    try {
      await restoreOrder(o.id);
      toast(t('orderRestored', { n: o.order_number }));
      await load();
    } catch (e) {
      toast(errorText(t, e), 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>{t('archivedOrders')}</h1>
      </div>
      <div className="card">
        <p className="muted">{t('archivedHint')}</p>
        <div className="filters">
          <input className="search" placeholder={`${t('search')} (#, ${t('customer')}, ${t('phone')})`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {!orders ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty text={t('noArchived')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('order')}</th>
                  <th>{t('date')}</th>
                  <th>{t('customer')}</th>
                  <th>{t('city')}</th>
                  <th className="num">{t('total')}</th>
                  <th>{t('status')}</th>
                  <th>{t('archivedOn')}</th>
                  <th className="num">{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paging.slice.map((o) => (
                  <tr key={o.id} data-testid={`archived-${o.order_number}`}>
                    <td>
                      <Link to={`/orders/${o.id}`}>#{o.order_number}</Link>
                    </td>
                    <td>{dateTime(o.created_at)}</td>
                    <td>{o.profiles?.business_name || o.delivery_name}</td>
                    <td>{o.delivery_city}</td>
                    <td className="num">{money(o.total)}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                    <td>{o.archived_at ? dateTime(o.archived_at) : ''}</td>
                    <td className="num">
                      <button className="btn btn-sm" disabled={busy === o.id} onClick={() => restore(o)} data-testid={`restore-${o.order_number}`}>
                        ↩ {t('restoreOrder')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager {...paging} total={rows.length} />
      </div>
    </>
  );
}
