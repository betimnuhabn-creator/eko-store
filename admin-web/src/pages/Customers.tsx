import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Empty, Pager, Spinner, usePaging, useConfirm, useToast } from '../components/ui';
import { useNotifications } from '../lib/data';
import { dateOnly, downloadCsv, money, normalize } from '../lib/format';
import { errorText, useI18n, type TKey } from '../lib/i18n';
import { dispatchNotifications, supabase } from '../lib/supabase';
import { isWholesale, type Profile } from '../lib/types';

type Stats = Record<string, { count: number; total: number }>;

export function Customers() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { version } = useNotifications();
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') ?? '';
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Profile[] | null>(null);
  const [stats, setStats] = useState<Stats>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, o] = await Promise.all([
      supabase.from('profiles').select('*').neq('role', 'admin').order('created_at', { ascending: false }).limit(5000),
      supabase.from('orders').select('customer_id,total,status').neq('status', 'cancelled').limit(10000),
    ]);
    setRows((p.data ?? []) as Profile[]);
    const s: Stats = {};
    for (const r of (o.data ?? []) as { customer_id: string | null; total: number }[]) {
      if (!r.customer_id) continue;
      s[r.customer_id] ??= { count: 0, total: 0 };
      s[r.customer_id].count++;
      s[r.customer_id].total += Number(r.total);
    }
    setStats(s);
  }, []);
  useEffect(() => {
    load();
  }, [load, version]);

  const list = useMemo(() => {
    const s = normalize(q.trim());
    return (rows ?? []).filter(
      (p) =>
        (!filter ||
          (filter === 'pending' && p.wholesale_status === 'pending') ||
          (filter === 'wholesale' && isWholesale(p)) ||
          (filter === 'retail' && !isWholesale(p))) &&
        (!s || normalize(`${p.full_name} ${p.business_name} ${p.email} ${p.phone} ${p.city} ${p.business_number}`).includes(s)),
    );
  }, [rows, filter, q]);
  const paging = usePaging(list, 50);
  const pending = (rows ?? []).filter((p) => p.wholesale_status === 'pending').length;

  async function review(p: Profile, approve: boolean, text: TKey) {
    const name = p.business_name || p.full_name || p.email;
    if (!(await confirm(t(text, { name }), { danger: !approve, ok: approve ? t('approve') : t('yes') }))) return;
    setBusy(p.id);
    const { error } = await supabase.rpc('admin_review_wholesale', { p_user: p.id, p_approve: approve });
    setBusy(null);
    if (error) return toast(errorText(t, error), 'error');
    dispatchNotifications();
    toast(t('saved'));
    load();
  }

  const setFilter = (v: string) => setParams(v ? { filter: v } : {}, { replace: true });
  const exportCsv = () =>
    downloadCsv(`eko-klientet-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Emri', 'Biznesi', 'NUI/NIPT', 'Email', 'Telefoni', 'Adresa', 'Qyteti', 'Lloji', 'Shumica', 'Regjistruar', 'Porosi', 'Totali'],
      ...list.map((p) => [
        p.full_name, p.business_name, p.business_number, p.email, p.phone, p.address, p.city,
        t(isWholesale(p) ? 'role_wholesale' : 'role_retail'), t(`ws_${p.wholesale_status}` as TKey), dateOnly(p.created_at),
        stats[p.id]?.count ?? 0, (stats[p.id]?.total ?? 0).toFixed(2),
      ]),
    ]);

  return (
    <>
      <div className="page-head">
        <h1>{t('customers')}</h1>
        <button className="btn" onClick={exportCsv} disabled={!list.length}>
          {t('exportCsv')}
        </button>
      </div>
      <div className="card">
        <div className="filters">
          <div className="chips">
            <button className={`chip ${!filter ? 'chip-active' : ''}`} onClick={() => setFilter('')}>
              {t('all')}
            </button>
            <button className={`chip ${filter === 'pending' ? 'chip-active' : ''} ${pending ? 'chip-hot' : ''}`} onClick={() => setFilter('pending')} data-testid="filter-pending">
              {t('filterPending')} ({pending})
            </button>
            <button className={`chip ${filter === 'wholesale' ? 'chip-active' : ''}`} onClick={() => setFilter('wholesale')}>
              {t('role_wholesale')}
            </button>
            <button className={`chip ${filter === 'retail' ? 'chip-active' : ''}`} onClick={() => setFilter('retail')}>
              {t('role_retail')}
            </button>
          </div>
          <input className="search" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!rows ? (
          <Spinner />
        ) : list.length === 0 ? (
          <Empty text={t('none')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('customer')}</th>
                  <th>{t('email')}</th>
                  <th>{t('phone')}</th>
                  <th>{t('city')}</th>
                  <th>{t('type')}</th>
                  <th>{t('registered')}</th>
                  <th className="num">{t('orders')}</th>
                  <th className="num">{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {paging.slice.map((p) => (
                  <tr key={p.id} data-testid={`customer-${p.email}`}>
                    <td>
                      <strong>{p.business_name || p.full_name || '—'}</strong>
                      {p.business_name && <div className="muted small">{p.full_name}</div>}
                      {p.business_number && <div className="muted small">{t('businessNumber')}: {p.business_number}</div>}
                    </td>
                    <td>
                      <a href={`mailto:${p.email}`}>{p.email}</a>
                    </td>
                    <td>{p.phone}</td>
                    <td>{p.city}</td>
                    <td>
                      {isWholesale(p) ? <Badge tone="ok">{t('role_wholesale')}</Badge> : <Badge>{t('role_retail')}</Badge>}{' '}
                      {p.wholesale_status === 'pending' && <Badge tone="warn">{t('ws_pending')}</Badge>}
                      {p.wholesale_status === 'rejected' && <Badge tone="bad">{t('ws_rejected')}</Badge>}
                    </td>
                    <td>{dateOnly(p.created_at)}</td>
                    <td className="num">
                      {stats[p.id] ? <Link to={`/orders?customer=${p.id}`}>{stats[p.id].count} · {money(stats[p.id].total)}</Link> : '0'}
                    </td>
                    <td className="num nowrap">
                      {p.wholesale_status === 'pending' && (
                        <>
                          <button className="btn btn-sm btn-primary" disabled={busy === p.id} onClick={() => review(p, true, 'approveConfirm')} data-testid={`approve-${p.email}`}>
                            {t('approve')}
                          </button>{' '}
                          <button className="btn btn-sm btn-danger-outline" disabled={busy === p.id} onClick={() => review(p, false, 'rejectConfirm')} data-testid={`reject-${p.email}`}>
                            {t('reject')}
                          </button>
                        </>
                      )}
                      {p.wholesale_status !== 'pending' && !isWholesale(p) && (
                        <button className="btn btn-sm" disabled={busy === p.id} onClick={() => review(p, true, 'approveConfirm')}>
                          {t('makeWholesale')}
                        </button>
                      )}
                      {isWholesale(p) && (
                        <button className="btn btn-sm btn-danger-outline" disabled={busy === p.id} onClick={() => review(p, false, 'revokeConfirm')} data-testid={`revoke-${p.email}`}>
                          {t('revoke')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager {...paging} total={list.length} />
      </div>
    </>
  );
}
