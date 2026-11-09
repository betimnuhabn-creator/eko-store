import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import logo from '../eko-mark.png';
import { Empty, Spinner, StatusBadge, useToast } from '../components/ui';
import { useNotifications } from '../lib/data';
import { dateTime, money } from '../lib/format';
import { errorText, useI18n, type TKey } from '../lib/i18n';
import { dispatchNotifications, supabase } from '../lib/supabase';
import { ORDER_STATUSES, type Order, type OrderStatus } from '../lib/types';

const SELECT = '*, order_items(id,product_id,product_name,sku,unit,quantity,unit_price), profiles(email,full_name,business_name,phone)';

export function OrderDetail() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const toast = useToast();
  const { version } = useNotifications();
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  const [status, setStatus] = useState<OrderStatus>('new');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
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

  return (
    <>
      <div className="page-head no-print">
        <h1>
          <Link to="/orders" className="muted">
            {t('orders')}
          </Link>{' '}
          / #{order.order_number}
        </h1>
        <button className="btn" onClick={() => window.print()}>
          🖨 {t('print')}
        </button>
      </div>

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
          <table className="table">
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
                  <td className="mono">{i.product_id ? <Link to={`/products/${i.product_id}`}>{i.sku}</Link> : i.sku}</td>
                  <td>{i.product_name}</td>
                  <td className="num">
                    {i.quantity} {i.unit}
                  </td>
                  <td className="num">{money(i.unit_price)}</td>
                  <td className="num">{money(i.quantity * i.unit_price)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="num">
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
          <div className="card no-print">
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
