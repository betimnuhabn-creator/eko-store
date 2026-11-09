import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Empty, Pager, Spinner, Thumb, usePaging, useToast } from '../components/ui';
import { useCatalog } from '../lib/data';
import { downloadCsv, normalize, parseNumber } from '../lib/format';
import { errorText, useI18n } from '../lib/i18n';
import { saveProduct, toInput } from '../lib/products';
import type { Product } from '../lib/types';

type Draft = { retail?: string; wholesale?: string; stock?: string; active?: boolean };
type SortKey = 'name' | 'sku' | 'retail_price' | 'wholesale_price' | 'stock' | 'updated_at';

export function Products() {
  const { t, pick } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const { products, categories, loading, error, reload } = useCatalog();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'updated_at', dir: -1 });
  const category = params.get('category') ?? '';
  const state = params.get('state') ?? '';
  const stock = params.get('stock') ?? '';
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const catName = (id: string | null) => {
    const c = categories.find((x) => x.id === id);
    return c ? pick(c.name_sq, c.name_en) : '—';
  };

  const rows = useMemo(() => {
    const s = normalize(q.trim());
    const list = products.filter(
      (p) =>
        (!s || normalize(`${p.sku} ${p.name} ${p.name_en}`).includes(s)) &&
        (!category || (category === 'none' ? !p.category_id : p.category_id === category)) &&
        (!state || (state === 'active' ? p.active : !p.active)) &&
        (!stock || (stock === 'out' ? p.stock <= 0 : p.stock > 0)),
    );
    const { key, dir } = sort;
    return list.sort((a, b) => {
      const x = a[key] as any;
      const y = b[key] as any;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'sq')) * dir;
    });
  }, [products, q, category, state, stock, sort]);
  const paging = usePaging(rows, 50);

  const setDraft = (id: string, d: Draft) => setDrafts((all) => ({ ...all, [id]: { ...all[id], ...d } }));
  const dirtyIds = Object.keys(drafts).filter((id) => {
    const p = products.find((x) => x.id === id);
    const d = drafts[id];
    if (!p) return false;
    return (
      (d.retail !== undefined && parseNumber(d.retail) !== Number(p.retail_price)) ||
      (d.wholesale !== undefined && parseNumber(d.wholesale) !== Number(p.wholesale_price)) ||
      (d.stock !== undefined && parseNumber(d.stock) !== Number(p.stock)) ||
      (d.active !== undefined && d.active !== p.active)
    );
  });

  async function saveAll() {
    setSaving(true);
    let ok = 0;
    for (const id of dirtyIds) {
      const p = products.find((x) => x.id === id)!;
      const d = drafts[id];
      const retail = d.retail !== undefined ? parseNumber(d.retail) : Number(p.retail_price);
      const wholesale = d.wholesale !== undefined ? parseNumber(d.wholesale) : Number(p.wholesale_price);
      const qty = d.stock !== undefined ? parseNumber(d.stock) : Number(p.stock);
      if (!(retail >= 0) || !(wholesale >= 0) || !(qty >= 0) || !Number.isInteger(qty)) {
        toast(`${p.sku}: ${t('invalidPrice')}`, 'error');
        continue;
      }
      try {
        await saveProduct({ ...toInput(p), retail_price: retail, wholesale_price: wholesale, stock: qty, active: d.active ?? p.active });
        ok++;
        setDrafts((all) => {
          const n = { ...all };
          delete n[id];
          return n;
        });
      } catch (e) {
        toast(`${p.sku}: ${errorText(t, e)}`, 'error');
      }
    }
    setSaving(false);
    if (ok) {
      toast(`${t('saved')} (${ok})`);
      reload();
    }
  }

  const head = (key: SortKey, label: string, num = false) => (
    <th className={`sortable ${num ? 'num' : ''}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}>
      {label} {sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : ''}
    </th>
  );

  const exportCsv = () =>
    downloadCsv(`eko-produktet-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['SKU', 'Emri', 'Name', 'Kategoria', 'Njësia', 'Pakicë', 'Shumicë', 'Stoku', 'Aktiv'],
      ...rows.map((p) => [p.sku, p.name, p.name_en, catName(p.category_id), p.unit, p.retail_price, p.wholesale_price, p.stock, p.active ? 'po' : 'jo']),
    ]);

  const val = (p: Product, d: Draft | undefined, k: 'retail' | 'wholesale' | 'stock') =>
    d?.[k] ?? String(k === 'retail' ? p.retail_price : k === 'wholesale' ? p.wholesale_price : p.stock);

  return (
    <>
      <div className="page-head">
        <h1>{t('products')}</h1>
        <div className="row">
          <button className="btn" onClick={exportCsv}>
            {t('exportCsv')}
          </button>
          <button className="btn btn-primary" onClick={() => nav('/products/new')} data-testid="new-product">
            + {t('newProduct')}
          </button>
        </div>
      </div>
      <div className="card">
        <div className="filters">
          <input className="search" placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="product-search" />
          <select value={category} onChange={(e) => setFilter('category', e.target.value)} aria-label={t('category')}>
            <option value="">
              {t('category')}: {t('all')}
            </option>
            <option value="none">{t('noCategory')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {pick(c.name_sq, c.name_en)}
              </option>
            ))}
          </select>
          <select value={state} onChange={(e) => setFilter('state', e.target.value)} aria-label={t('status')}>
            <option value="">
              {t('status')}: {t('all')}
            </option>
            <option value="active">{t('onlyActive')}</option>
            <option value="inactive">{t('onlyInactive')}</option>
          </select>
          <select value={stock} onChange={(e) => setFilter('stock', e.target.value)} aria-label={t('stock')}>
            <option value="">
              {t('stock')}: {t('all')}
            </option>
            <option value="out">{t('onlyOutOfStock')}</option>
            <option value="in">{t('inStock')}</option>
          </select>
          <div className="grow" />
          {dirtyIds.length > 0 && (
            <button className="btn btn-primary" onClick={saveAll} disabled={saving} data-testid="save-all">
              {saving ? t('saving') : `${t('save')} (${dirtyIds.length})`}
            </button>
          )}
        </div>
        <p className="muted small">{t('quickEditHint')}</p>
        {error && <div className="alert alert-error">{error}</div>}
        {loading && products.length === 0 ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <Empty text={t('noProducts')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  {head('sku', t('sku'))}
                  {head('name', t('name'))}
                  <th>{t('category')}</th>
                  {head('retail_price', t('retail'), true)}
                  {head('wholesale_price', t('wholesale'), true)}
                  {head('stock', t('stock'), true)}
                  <th>{t('active')}</th>
                </tr>
              </thead>
              <tbody>
                {paging.slice.map((p) => {
                  const d = drafts[p.id];
                  const dirty = dirtyIds.includes(p.id);
                  const w = parseNumber(val(p, d, 'wholesale'));
                  const r = parseNumber(val(p, d, 'retail'));
                  return (
                    <tr key={p.id} className={dirty ? 'dirty' : ''} data-testid={`row-${p.sku}`}>
                      <td>
                        <Thumb src={p.images[0]} />
                      </td>
                      <td className="mono">{p.sku}</td>
                      <td>
                        <Link to={`/products/${p.id}`}>{pick(p.name, p.name_en)}</Link>
                      </td>
                      <td>{catName(p.category_id)}</td>
                      <td className="num">
                        <input className="cell-input" inputMode="decimal" aria-label={`${p.sku} ${t('retail')}`} value={val(p, d, 'retail')} onChange={(e) => setDraft(p.id, { retail: e.target.value })} />
                      </td>
                      <td className="num">
                        <input
                          className={`cell-input ${w > r ? 'warn-input' : ''}`}
                          title={w > r ? t('wholesaleAboveRetail') : undefined}
                          inputMode="decimal"
                          aria-label={`${p.sku} ${t('wholesale')}`}
                          value={val(p, d, 'wholesale')}
                          onChange={(e) => setDraft(p.id, { wholesale: e.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input className={`cell-input ${parseNumber(val(p, d, 'stock')) <= 0 ? 'warn-input' : ''}`} inputMode="numeric" aria-label={`${p.sku} ${t('stock')}`} value={val(p, d, 'stock')} onChange={(e) => setDraft(p.id, { stock: e.target.value.replace(/[^\d]/g, '') })} />
                      </td>
                      <td>
                        <label className="switch">
                          <input type="checkbox" checked={d?.active ?? p.active} onChange={(e) => setDraft(p.id, { active: e.target.checked })} aria-label={`${p.sku} ${t('active')}`} />
                          {(d?.active ?? p.active) ? <Badge tone="ok">{t('active')}</Badge> : <Badge>{t('inactive')}</Badge>}
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager {...paging} total={rows.length} />
      </div>
    </>
  );
}
