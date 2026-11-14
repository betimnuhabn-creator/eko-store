import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, StatusBadge } from '../components/ui';
import { useCatalog, useNotifications } from '../lib/data';
import { dateTime, money } from '../lib/format';
import { useI18n, type TKey } from '../lib/i18n';
import { archiveSupported } from '../lib/orders';
import { supabase } from '../lib/supabase';
import type { Order } from '../lib/types';

type Stats = { new_orders: number; open_orders: number; pending_wholesale: number; products: number; customers: number; sales_30d: number };

export function Dashboard() {
  const { t } = useI18n();
  const { version } = useNotifications();
  const { products } = useCatalog();
  const [stats, setStats] = useState<Stats | null>(null);
  const [latest, setLatest] = useState<Order[]>([]);
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));

  const load = useCallback(async () => {
    const supported = await archiveSupported();
    let latestQ = supabase.from('orders').select('*, profiles(business_name,full_name)').order('created_at', { ascending: false }).limit(10);
    if (supported) latestQ = latestQ.is('archived_at', null);
    const [s, o] = await Promise.all([supabase.rpc('admin_stats'), latestQ]);
    if (s.data) setStats(s.data as Stats);
    setLatest((o.data ?? []) as Order[]);
  }, []);
  useEffect(() => {
    load();
  }, [load, version]);

  const outOfStock = products.filter((p) => p.active && p.stock <= 0).length;
  const tiles: { key: keyof Stats | 'out'; label: TKey; to: string; value: string; hot?: boolean }[] = stats
    ? [
        { key: 'new_orders', label: 'newOrders', to: '/orders?status=new', value: String(stats.new_orders), hot: stats.new_orders > 0 },
        { key: 'pending_wholesale', label: 'pendingWholesale', to: '/customers?filter=pending', value: String(stats.pending_wholesale), hot: stats.pending_wholesale > 0 },
        { key: 'open_orders', label: 'openOrders', to: '/orders', value: String(stats.open_orders) },
        { key: 'sales_30d', label: 'sales30d', to: '/orders', value: money(stats.sales_30d) },
        { key: 'products', label: 'activeProducts', to: '/products', value: String(stats.products) },
        { key: 'out', label: 'outOfStock', to: '/products?stock=out', value: String(outOfStock) },
        { key: 'customers', label: 'customersCount', to: '/customers', value: String(stats.customers) },
      ]
    : [];

  return (
    <>
      <div className="page-head">
        <h1>{t('dashboard')}</h1>
        {perm === 'default' && (
          <button className="btn" onClick={async () => setPerm(await Notification.requestPermission())}>
            🔔 {t('enableBrowserNotifications')}
          </button>
        )}
      </div>
      <div className="tiles">
        {tiles.map((x) => (
          <Link key={x.key} to={x.to} className={`tile ${x.hot ? 'tile-hot' : ''}`} data-testid={`tile-${x.key}`}>
            <span className="tile-value">{x.value}</span>
            <span className="tile-label">{t(x.label)}</span>
          </Link>
        ))}
      </div>
      <div className="card">
        <h2>{t('latestOrders')}</h2>
        {latest.length === 0 ? (
          <Empty text={t('noOrders')} />
        ) : (
          <table className="table responsive">
            <thead>
              <tr>
                <th>{t('order')}</th>
                <th>{t('date')}</th>
                <th>{t('customer')}</th>
                <th>{t('city')}</th>
                <th className="num">{t('total')}</th>
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {latest.map((o) => (
                <tr key={o.id}>
                  <td data-label={t('order')}>
                    <Link to={`/orders/${o.id}`}>#{o.order_number}</Link>
                  </td>
                  <td data-label={t('date')}>{dateTime(o.created_at)}</td>
                  <td data-label={t('customer')}>{o.profiles?.business_name || o.delivery_name}</td>
                  <td data-label={t('city')}>{o.delivery_city}</td>
                  <td data-label={t('total')} className="num">{money(o.total)}</td>
                  <td data-label={t('status')}>
                    <StatusBadge status={o.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
