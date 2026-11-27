import { useEffect, useMemo, useState } from 'react';
import { useCatalog } from '../lib/data';
import { money } from '../lib/format';
import { useI18n, type TKey } from '../lib/i18n';
import {
  buildRows, downloadReport, ImportFileError, MAX_ROWS_OPTIONS, readSheetRows, readZip, runImport,
  type ImportRow, type Progress, type ReportRow, type ZipResult,
} from '../lib/productExcel';
import { Badge, Modal, Pager, usePaging } from './ui';

type Step = 'pick' | 'preview' | 'running' | 'done';
type Filter = '' | 'create' | 'update' | 'reject';

// Produktet → Importo: Excel (.xlsx) + photos (.zip) → preview → import in groups → report.
export function ProductImport({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const tr = (k: string) => t(k as TKey);
  // The preview compares with the catalog, so it waits until the catalog is loaded.
  const { products, categories, reload, loading: catalogLoading, error: catalogError } = useCatalog();
  const [step, setStep] = useState<Step>('pick');
  const [xlsx, setXlsx] = useState<File | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zip, setZip] = useState<ZipResult | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState<number>(100);
  const [notify, setNotify] = useState(false);
  const [filter, setFilter] = useState<Filter>('');
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0 });
  const [report, setReport] = useState<ReportRow[]>([]);

  async function read() {
    setFileError(null);
    if (!xlsx) return setFileError('imp_pick_xlsx');
    setBusy(true);
    try {
      const [sheet, z] = await Promise.all([readSheetRows(xlsx), zipFile ? readZip(zipFile) : Promise.resolve(null)]);
      if (!sheet.rows.length) throw new ImportFileError('imp_empty');
      const built = buildRows(sheet, products, categories, z);
      setZip(z);
      setRows(built);
      setLimit(MAX_ROWS_OPTIONS.find((n) => n >= built.length) ?? MAX_ROWS_OPTIONS[MAX_ROWS_OPTIONS.length - 1]);
      setStep('preview');
    } catch (e) {
      setFileError(e instanceof ImportFileError ? e.message : 'imp_xlsx_invalid');
    } finally {
      setBusy(false);
    }
  }

  // Rows beyond the chosen amount are not part of this import.
  const effective = useMemo(
    () => rows.map((r, i) => (i >= limit && r.action !== 'reject' ? { ...r, action: 'skip' as const } : r)),
    [rows, limit],
  );
  const count = (a: ImportRow['action']) => effective.filter((r) => r.action === a).length;
  const shown = filter ? effective.filter((r) => r.action === filter) : effective;
  const paging = usePaging(shown, 50);

  // Thumbnails of the visible page only (object URLs, released when no longer shown).
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const pageKey = paging.slice.map((r) => `${r.row}:${r.photos[0] ?? ''}`).join('|');
  useEffect(() => {
    if (step !== 'preview' || !zip) return;
    const urls: Record<string, string> = {};
    for (const r of paging.slice) {
      const first = r.photos[0];
      if (!first) continue;
      if (/^https?:\/\//i.test(first)) urls[r.row] = first;
      else {
        const ph = zip.photos.get(first.split(/[\\/]/).pop()!.toLowerCase());
        if (ph) urls[r.row] = URL.createObjectURL(new Blob([ph.bytes as BlobPart], { type: ph.mime }));
      }
    }
    setThumbs(urls);
    return () => Object.values(urls).forEach((u) => u.startsWith('blob:') && URL.revokeObjectURL(u));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey, zip, step]);

  async function start() {
    setStep('running');
    try {
      const rep = await runImport(effective, zip, { notify }, setProgress);
      setReport(rep);
    } catch (e) {
      setFileError(e instanceof ImportFileError ? e.message : 'imp_e_server');
    }
    setStep('done');
    await reload();
  }

  const rejectedBefore = effective.filter((r) => r.action === 'reject');
  const created = report.filter((r) => r.status === 'created').length;
  const updated = report.filter((r) => r.status === 'updated').length;
  const rejectedServer = report.filter((r) => r.status === 'rejected');
  const priceCell = (now: number | null, before?: number) =>
    now === null ? (before !== undefined ? <span className="muted">{money(before)}</span> : '—')
      : before !== undefined && Number(before) !== now ? <span><span className="muted"><s>{money(before)}</s></span> {money(now)}</span>
        : money(now);

  return (
    <Modal title={t('impTitle')} onClose={step === 'running' ? () => undefined : onClose} wide>
      {step === 'pick' && (
        <div className="form" data-testid="import-pick">
          <p className="muted small">{t('impIntro')}</p>
          <label>
            {t('impXlsx')}
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setXlsx(e.target.files?.[0] ?? null)} data-testid="import-xlsx" />
          </label>
          <label>
            {t('impZip')}
            <input type="file" accept=".zip,application/zip" onChange={(e) => setZipFile(e.target.files?.[0] ?? null)} data-testid="import-zip" />
          </label>
          {fileError && <div className="alert alert-error" role="alert">{tr(fileError)}</div>}
          <button className="btn btn-primary" disabled={busy || !xlsx || catalogLoading || !!catalogError} onClick={read} data-testid="import-read">
            {busy ? t('impReading') : t('impPreview')}
          </button>
        </div>
      )}

      {step === 'preview' && (
        <div data-testid="import-preview">
          <div className="import-summary">
            <Badge>{t('impRows')}: {rows.length}</Badge>
            <Badge tone="ok">{t('imp_st_created')}: <span data-testid="sum-create">{count('create')}</span></Badge>
            <Badge tone="info">{t('imp_st_updated')}: <span data-testid="sum-update">{count('update')}</span></Badge>
            <Badge tone="bad">{t('impWithErrors')}: <span data-testid="sum-reject">{count('reject')}</span></Badge>
            {count('skip') > 0 && <Badge tone="warn">{t('impNotIncluded')}: {count('skip')}</Badge>}
            {zip && <Badge>{t('impPhotosInZip')}: {zip.photos.size}</Badge>}
            {zip && zip.skipped.length > 0 && <Badge tone="warn" >{t('impPhotosSkipped')}: {zip.skipped.length}</Badge>}
          </div>
          <div className="filters">
            <div className="chips">
              {(['', 'create', 'update', 'reject'] as Filter[]).map((f) => (
                <button key={f} className={`chip ${filter === f ? 'chip-active' : ''}`} onClick={() => setFilter(f)} data-testid={`import-filter-${f || 'all'}`}>
                  {f === '' ? t('all') : f === 'create' ? t('imp_st_created') : f === 'update' ? t('imp_st_updated') : t('impWithErrors')}
                </button>
              ))}
            </div>
            <label className="row small" style={{ gap: 6 }}>
              {t('impHowMany')}
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} data-testid="import-limit">
                {MAX_ROWS_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n.toLocaleString('de-DE')}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th>#</th><th></th><th>SKU</th><th>{t('name')}</th><th className="num">{t('retailPrice')}</th><th className="num">{t('wholesalePrice')}</th>
                  <th className="num">{t('stock')}</th><th>{t('impPhotos')}</th><th>{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {paging.slice.map((r) => (
                  <tr key={r.row} data-testid={`import-row-${r.sku || r.row}`}>
                    <td data-label="#">{r.row}</td>
                    <td data-label="">{thumbs[r.row] ? <img className="thumb" src={thumbs[r.row]} width={40} height={40} alt="" /> : <span className="thumb thumb-empty" style={{ width: 40, height: 40 }} />}</td>
                    <td data-label="SKU"><strong>{r.sku || '—'}</strong></td>
                    <td data-label={t('name')}>{r.name || r.existing?.name || '—'}{r.category && <div className="muted small">{r.category}</div>}</td>
                    <td data-label={t('retailPrice')} className="num">{priceCell(r.retail, r.existing?.retail_price)}</td>
                    <td data-label={t('wholesalePrice')} className="num">{priceCell(r.wholesale, r.existing?.wholesale_price)}</td>
                    <td data-label={t('stock')} className="num">{r.stock ?? (r.existing ? <span className="muted">{r.existing.stock}</span> : 0)}</td>
                    <td data-label={t('impPhotos')} className="small">{r.photos.length ? r.photos.length : r.existing?.images.length ? <span className="muted">{t('impKeepPhotos')}</span> : '—'}</td>
                    <td data-label={t('status')}>
                      {r.action === 'create' && <Badge tone="ok">{t('imp_st_created')}</Badge>}
                      {r.action === 'update' && <Badge tone="info">{t('imp_st_updated')}</Badge>}
                      {r.action === 'reject' && <Badge tone="bad">{t('imp_st_rejected')}</Badge>}
                      {r.action === 'skip' && <Badge tone="warn">{t('impNotIncluded')}</Badge>}
                      {r.errors.length > 0 && <ul className="err-list">{r.errors.map((e) => <li key={e}>{tr(e)}</li>)}</ul>}
                      {r.warnings.length > 0 && <ul className="warn-list">{r.warnings.map((w) => <li key={w}>{tr(w)}</li>)}</ul>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager {...paging} total={shown.length} />
          <label className="check" style={{ margin: '10px 0' }}>
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} data-testid="import-notify" />
            {t('impNotify')}
          </label>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => setStep('pick')}>{t('back')}</button>
            <button className="btn btn-primary" disabled={!count('create') && !count('update')} onClick={start} data-testid="import-start">
              {t('impStart', { n: count('create') + count('update') })}
            </button>
          </div>
        </div>
      )}

      {step === 'running' && (
        <div className="form" data-testid="import-running">
          <p>{t('impRunning', { done: progress.done, total: progress.total })}</p>
          <div className="progress"><div style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }} /></div>
          <p className="muted small">{t('impDontClose')}</p>
        </div>
      )}

      {step === 'done' && (
        <div className="form" data-testid="import-done">
          {fileError && <div className="alert alert-error">{tr(fileError)}</div>}
          <div className="import-summary">
            <Badge tone="ok">{t('imp_st_created')}: <span data-testid="rep-created">{created}</span></Badge>
            <Badge tone="info">{t('imp_st_updated')}: <span data-testid="rep-updated">{updated}</span></Badge>
            <Badge tone="bad">{t('imp_st_rejected')}: <span data-testid="rep-rejected">{rejectedServer.length + rejectedBefore.length}</span></Badge>
            {count('skip') > 0 && <Badge tone="warn">{t('impNotIncluded')}: {count('skip')}</Badge>}
          </div>
          {rejectedServer.length + rejectedBefore.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>SKU</th><th>{t('impReason')}</th></tr></thead>
                <tbody>
                  {[...rejectedBefore.map((r) => ({ row: r.row, sku: r.sku, why: r.errors.map(tr).join('; ') })),
                    ...rejectedServer.map((r) => ({ row: r.row, sku: r.sku, why: r.error ? tr(r.error) : '' }))]
                    .sort((a, b) => a.row - b.row).slice(0, 300)
                    .map((r) => <tr key={r.row} data-testid={`rep-row-${r.sku || r.row}`}><td>{r.row}</td><td>{r.sku || '—'}</td><td className="small">{r.why}</td></tr>)}
                </tbody>
              </table>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => downloadReport(report, rejectedBefore, tr)} data-testid="import-report">{t('impDownloadReport')}</button>
            <button className="btn btn-primary" onClick={onClose} data-testid="import-close">{t('close')}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
