import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import logo from '../eko-mark.png';
import { Empty, Spinner, StatusBadge, useConfirm, useToast } from '../components/ui';
import { useNotifications } from '../lib/data';
import { dateTime, money } from '../lib/format';
import { errorText, useI18n, type TKey } from '../lib/i18n';
import { archiveOrder, archiveSupported, canArchive, canCancel, cancelOrder, restoreOrder } from '../lib/orders';
import { dispatchNotifications, supabase } from '../lib/supabase';
import { ORDER_STATUSES, type Order, type OrderStatus } from '../lib/types';

const SELECT = '*, order_items(id,product_id,product_name,sku,unit,quantity,unit_price), profiles(email,full_name,business_name,phone)';

export function OrderDetail() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { version } = useNotifications();
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  const [status, setStatus] = useState<OrderStatus>('new');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [archiveDb, setArchiveDb] = useState(false);

  const load = useCallback(async () => {
    setArchiveDb(await archiveSupported());
    const { data } = await supabase.from('orders').select(SELECT).eq('id', id).maybeSingle();
    const o = (data as Order) ?? null;
    setOrder(o);
    if (o) {
      setStatus(o.status);
      setNote(o.admin_note);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load, version]);

  if (order === undefined) return <Spinner />;
  if (!order) return <Empty text={t('noOrders')} />;
  const c = order.profiles;
  const changed = status !== order.status || note !== order.admin_note;

  async function save() {
    setBusy(true);
    const { error } = await supabase.rpc('admin_set_order_status', { p_order: order!.id, p_status: status, p_note: note });
    setBusy(false);
    if (error) return toast(errorText(t, error), 'error');
    dispatchNotifications();
    toast(status !== order!.status ? t('statusSaved') : t('saved'));
    load();
  }

  const archived = !!order.archived_at;
  async function act(kind: 'cancel' | 'archive' | 'restore') {
    const n = order!.order_number;
    const text = { cancel: 'cancelConfirm', archive: 'archiveConfirm', restore: 'restoreConfirm' } as const;
    const okLabel = { cancel: 'cancelOrder', archive: 'archiveOrder', restore: 'restoreOrder' } as const;
    if (!(await confirm(t(text[kind], { n }), { danger: kind === 'cancel', ok: t(okLabel[kind]) }))) return;
    setBusy(true);
    try {
      if (kind === 'cancel') await cancelOrder(order!.id, note !== order!.admin_note ? note : undefined, archiveDb);
      if (kind === 'archive') await archiveOrder(order!.id);
      if (kind === 'restore') await restoreOrder(order!.id);
      const done = { cancel: 'orderCancelled', archive: 'orderArchived', restore: 'orderRestored' } as const;
      toast(t(done[kind], { n }));
      await load();
    } catch (e) {
      toast(errorText(t, e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head no-print">
        <h1>
          <Link to={archived ? '/archived-orders' : '/orders'} className="muted">
            {t(archived ? 'archivedOrders' : 'orders')}
          </Link>{' '}
          / #{order.order_number}
        </h1>
        <div className="row">
          {canCancel(order.status, order.archived_at) && (
            <button className="btn btn-danger-outline" disabled={busy} onClick={() => act('cancel')} data-testid="detail-cancel">
              {t('cancelOrder')}
            </button>
          )}
          {archiveDb && canArchive(order.status, order.archived_at) && (
            <button className="btn" disabled={busy} onClick={() => act('archive')} data-testid="detail-archive">
              🗄 {t('archiveOrder')}
            </button>
          )}
          {archived && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act('restore')} data-testid="detail-restore">
              ↩ {t('restoreOrder')}
            </button>
          )}
          <button className="btn" onClick={() => window.print()}>
            🖨 {t('print')}
          </button>
        </div>
      </div>
      {archived && <div className="alert alert-warn no-print">{t('archivedBanner', { date: dateTime(order.archived_at!) })}</div>}

      <div className="print-only print-head">
        <img src={logo} alt="" width={48} height={48} />
        <div>
          <strong>EKO SHPK</strong>
          <div>
            {t('order')} #{order.order_number} · {dateTime(order.created_at)}
          </div>
        </div>
      </div>

      <div className="grid-2 wide-left">
        <div className="card">
          <div className="row between">
            <h2>
              {t('order')} #{order.order_number}
            </h2>
            <StatusBadge status={order.status} />
          </div>
          <p className="muted">
            {dateTime(order.created_at)} · {t(order.price_tier === 'wholesale' ? 'wholesale' : 'retail')} · {t(`pay_${order.payment_method}` as TKey)}
          </p>
          <table className="table responsive">
            <thead>
              <tr>
                <th>{t('sku')}</th>
                <th>{t('name')}</th>
                <th className="num">{t('quantity')}</th>
                <th className="num">{t('unitPrice')}</th>
                <th className="num">{t('lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {(order.order_items ?? []).map((i) => (
                <tr key={i.id}>
                  <td data-label={t('sku')} className="mono">{i.product_id ? <Link to={`/products/${i.product_id}`}>{i.sku}</Link> : i.sku}</td>
                  <td data-label={t('name')}>{i.product_name}</td>
                  <td data-label={t('quantity')} className="num">
                    {i.quantity} {i.unit}
                  </td>
                  <td data-label={t('unitPrice')} className="num">{money(i.unit_price)}</td>
                  <td data-label={t('lineTotal')} className="num">{money(i.quantity * i.unit_price)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="num" data-label="">
                  <strong>{t('total')}</strong>
                </td>
                <td className="num">
                  <strong>{money(order.total)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
          {!!order.customer_note && (
            <div className="note">
              <strong>{t('customerNote')}:</strong> {order.customer_note}
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card">
            <h2>{t('delivery')}</h2>
            <p>
              <strong>{order.delivery_name}</strong>
              <br />
              {order.delivery_address}
              <br />
              {order.delivery_city}
              <br />
              <a href={`tel:${order.delivery_phone}`}>{order.delivery_phone}</a>
            </p>
            <h2>{t('customer')}</h2>
            {c ? (
              <p>
                {c.business_name && (
                  <>
                    <strong>{c.business_name}</strong>
                    <br />
                  </>
                )}
                {c.full_name}
                <br />
                <a href={`mailto:${c.email}`}>{c.email}</a>
                <br />
                {c.phone}
                <br />
                <Link className="no-print" to={`/orders?customer=${order.customer_id}`}>
                  {t('customerOrders')} →
                </Link>
              </p>
            ) : (
              <p className="muted">{t('deletedCustomer')}</p>
            )}
          </div>
          <div className="card no-print" hidden={archived}>
            <h2>{t('changeStatus')}</h2>
            <div className="chips">
              {ORDER_STATUSES.map((s) => (
                <button key={s} className={`chip ${status === s ? 'chip-active' : ''}`} onClick={() => setStatus(s)} data-testid={`set-${s}`}>
                  {t(`st_${s}` as TKey)}
                </button>
              ))}
            </div>
            <label>
              {t('adminNote')}
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={!changed || busy} onClick={save} data-testid="save-status">
              {busy ? t('saving') : t('save')}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
