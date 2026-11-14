import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Empty, Pager, Spinner, StatusBadge, useConfirm, usePaging, useToast } from '../components/ui';
import { useNotifications } from '../lib/data';
import { dateTime, downloadCsv, money, normalize } from '../lib/format';
import { errorText, useI18n, type TKey } from '../lib/i18n';
import { archiveOrder, archiveSupported, canArchive, canCancel, cancelOrder } from '../lib/orders';
import { supabase } from '../lib/supabase';
import { ORDER_STATUSES, type Order } from '../lib/types';

export function Orders() {
  const { t } = useI18n();
  const { version } = useNotifications();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const customer = params.get('customer') ?? '';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [archiveDb, setArchiveDb] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();

  const load = useCallback(async () => {
    const supported = await archiveSupported();
    setArchiveDb(supported);
    let query = supabase
      .from('orders')
      .select('*, profiles(email,full_name,business_name,phone)')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (supported) query = query.is('archived_at', null); // archived orders live in the Archive section
    if (status === 'open') query = query.in('status', ['new', 'confirmed', 'preparing', 'shipped', 'accepted']);
    else if (status) query = query.eq('status', status);
    if (customer) query = query.eq('customer_id', customer);
    if (from) query = query.gte('created_at', new Date(`${from}T00:00:00`).toISOString());
    if (to) query = query.lte('created_at', new Date(`${to}T23:59:59`).toISOString());
    const { data, error: e } = await query;
    if (e) setError(errorText(t, e));
    setOrders((data ?? []) as Order[]);
  }, [status, customer, from, to, t]);

  useEffect(() => {
    load();
  }, [load, version]);

  const rows = useMemo(() => {
    const s = normalize(q.trim().replace(/^#/, ''));
    return (orders ?? []).filter(
      (o) =>
        !s ||
        String(o.order_number).includes(s) ||
        normalize(`${o.delivery_name} ${o.delivery_phone} ${o.delivery_city} ${o.profiles?.business_name ?? ''} ${o.profiles?.email ?? ''}`).includes(s),
    );
  }, [orders, q]);
  const paging = usePaging(rows, 50);
  const totalSum = rows.filter((o) => o.status !== 'cancelled').reduce((a, o) => a + Number(o.total), 0);

  async function act(o: Order, kind: 'cancel' | 'archive') {
    const n = o.order_number;
    const ok = await confirm(t(kind === 'cancel' ? 'cancelConfirm' : 'archiveConfirm', { n }), {
      danger: kind === 'cancel',
      ok: t(kind === 'cancel' ? 'cancelOrder' : 'archiveOrder'),
    });
    if (!ok) return;
    setBusy(o.id);
    try {
      if (kind === 'cancel') await cancelOrder(o.id, undefined, archiveDb);
      else await archiveOrder(o.id);
      toast(t(kind === 'cancel' ? 'orderCancelled' : 'orderArchived', { n }));
      await load();
    } catch (e) {
      toast(errorText(t, e), 'error');
    } finally {
      setBusy(null);
    }
  }

  const setStatus = (v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set('status', v);
    else n.delete('status');
    setParams(n, { replace: true });
  };

  const exportCsv = () =>
    downloadCsv(`eko-porosite-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Nr', 'Data', 'Klienti', 'Email', 'Telefoni', 'Adresa', 'Qyteti', 'Çmimi', 'Pagesa', 'Artikuj', 'Totali', 'Statusi'],
      ...rows.map((o) => [
        o.order_number, dateTime(o.created_at), o.profiles?.business_name || o.delivery_name, o.profiles?.email ?? '', o.delivery_phone,
        o.delivery_address, o.delivery_city, t(o.price_tier === 'wholesale' ? 'wholesale' : 'retail'), t(`pay_${o.payment_method}` as TKey),
        o.item_count, Number(o.total).toFixed(2), t(`st_${o.status}` as TKey),
      ]),
    ]);

  return (
    <>
      <div className="page-head">
        <h1>{t('orders')}</h1>
        <div className="row">
          <button className="btn" onClick={load}>
            {t('refresh')}
          </button>
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>
            {t('exportCsv')}
          </button>
        </div>
      </div>
      <div className="card">
        <div className="chips">
          {['', 'open', ...ORDER_STATUSES].map((s) => (
            <button key={s || 'all'} className={`chip ${status === s ? 'chip-active' : ''}`} onClick={() => setStatus(s)} data-testid={`status-filter-${s || 'all'}`}>
              {s === '' ? t('all') : s === 'open' ? t('openOrders') : t(`st_${s}` as TKey)}
            </button>
          ))}
        </div>
        <div className="filters">
          <input className="search" placeholder={`${t('search')} (#, ${t('customer')}, ${t('phone')})`} value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="inline">
            {t('from')} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="inline">
            {t('to')} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {customer && (
            <button className="chip chip-active" onClick={() => setParams(new URLSearchParams(status ? { status } : {}))}>
              {t('customer')} ✕
            </button>
          )}
          <div className="grow" />
          <strong>
            {t('total')}: {money(totalSum)}
          </strong>
        </div>
        {error && <div className="alert alert-error">{error}</div>}
        {!orders ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty text={t('noOrders')} />
        ) : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>{t('order')}</th>
                  <th>{t('date')}</th>
                  <th>{t('customer')}</th>
                  <th>{t('phone')}</th>
                  <th>{t('city')}</th>
                  <th>{t('tier')}</th>
                  <th className="num">{t('items')}</th>
                  <th className="num">{t('total')}</th>
                  <th>{t('status')}</th>
                  <th className="num">{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paging.slice.map((o) => (
                  <tr key={o.id} data-testid={`order-${o.order_number}`}>
                    <td data-label={t('order')}>
                      <Link to={`/orders/${o.id}`}>#{o.order_number}</Link>
                    </td>
                    <td data-label={t('date')}>{dateTime(o.created_at)}</td>
                    <td data-label={t('customer')}>{o.profiles?.business_name || o.delivery_name}</td>
                    <td data-label={t('phone')}>{o.delivery_phone}</td>
                    <td data-label={t('city')}>{o.delivery_city}</td>
                    <td data-label={t('tier')}>{t(o.price_tier === 'wholesale' ? 'wholesale' : 'retail')}</td>
                    <td data-label={t('items')} className="num">{o.item_count}</td>
                    <td data-label={t('total')} className="num">{money(o.total)}</td>
                    <td data-label={t('status')}>
                      <StatusBadge status={o.status} />
                    </td>
                    <td data-label="" className="num nowrap">
                      {canCancel(o.status, o.archived_at) && (
                        <button className="btn btn-sm btn-danger-outline" disabled={busy === o.id} onClick={() => act(o, 'cancel')} data-testid={`cancel-${o.order_number}`}>
                          {t('cancelOrder')}
                        </button>
                      )}
                      {archiveDb && canArchive(o.status, o.archived_at) && (
                        <button className="btn btn-sm" disabled={busy === o.id} onClick={() => act(o, 'archive')} data-testid={`archive-${o.order_number}`}>
                          🗄 {t('archiveOrder')}
                        </button>
                      )}
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
