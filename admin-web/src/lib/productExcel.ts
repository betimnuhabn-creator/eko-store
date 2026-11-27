// Products ⇄ Excel (.xlsx) with photos in a ZIP — PC panel → Produktet.
//
// * Template / Export: the same columns, so an exported file can be edited
//   (e.g. prices) and imported again.
// * Import: rows are matched by SKU (case-insensitive) → update, otherwise
//   create. Photos are given by file name (column "Fotot", several separated
//   by ";") and taken from the ZIP; https URLs are kept as they are.
// * Everything is checked in the browser for the preview, and again on the
//   server (admin_import_products, administrators only).
// The Excel/ZIP libraries are loaded only when needed (dynamic import).
import { uploadProductImage, deleteProductImage } from './images';
import { supabase } from './supabase';
import type { Category, Product } from './types';

export type Field = 'sku' | 'name' | 'name_en' | 'description' | 'description_en' | 'category' | 'unit' | 'retail' | 'wholesale' | 'stock' | 'active' | 'photos';

/** Template columns (headers as in the file) and the other names accepted when importing. */
export const COLUMNS: { key: Field; header: string; width: number; aliases: string[]; help: string }[] = [
  { key: 'sku', header: 'SKU *', width: 16, aliases: ['sku', 'kodi', 'kodiproduktit', 'kod', 'code', 'productcode', 'artikull', 'shifra'], help: 'Kodi unik i produktit. Nëse ekziston, produkti përditësohet; përndryshe krijohet.' },
  { key: 'name', header: 'Emri (shqip) *', width: 32, aliases: ['emri', 'emrishqip', 'emerimi', 'emertimi', 'produkti', 'name', 'namesq', 'emrisq'], help: 'I detyrueshëm për produktet e reja.' },
  { key: 'name_en', header: 'Emri (anglisht)', width: 28, aliases: ['emrianglisht', 'emrien', 'nameen', 'englishname', 'nameenglish'], help: 'Opsional.' },
  { key: 'description', header: 'Përshkrimi (shqip)', width: 40, aliases: ['pershkrimi', 'pershkrimishqip', 'pershkrimisq', 'description', 'descriptionsq'], help: 'Opsional.' },
  { key: 'description_en', header: 'Përshkrimi (anglisht)', width: 40, aliases: ['pershkrimianglisht', 'pershkrimien', 'descriptionen', 'englishdescription'], help: 'Opsional.' },
  { key: 'category', header: 'Kategoria', width: 20, aliases: ['kategoria', 'kategori', 'category'], help: 'Emri i kategorisë saktësisht si në panel (shih listën më poshtë).' },
  { key: 'unit', header: 'Njësia', width: 10, aliases: ['njesia', 'njesi', 'unit', 'njesiamatese'], help: 'P.sh. copë, m, kg, pako. Bosh = copë.' },
  { key: 'retail', header: 'Çmimi pakicë (€) *', width: 18, aliases: ['cmimipakice', 'cmimiipakices', 'pakice', 'cmimiretail', 'retail', 'retailprice', 'pricepakice'], help: 'P.sh. 34,90 ose 34.90. I detyrueshëm për produktet e reja.' },
  { key: 'wholesale', header: 'Çmimi shumicë (€) *', width: 18, aliases: ['cmimishumice', 'cmimiishumices', 'shumice', 'cmimiwholesale', 'wholesale', 'wholesaleprice', 'priceshumice'], help: 'I detyrueshëm për produktet e reja.' },
  { key: 'stock', header: 'Stoku', width: 10, aliases: ['stoku', 'stok', 'stock', 'sasia', 'gjendja', 'quantity', 'qty'], help: 'Numër i plotë ≥ 0.' },
  { key: 'active', header: 'Aktiv (Po/Jo)', width: 14, aliases: ['aktiv', 'active', 'statusi', 'status', 'idukshem', 'visible'], help: 'Po = shfaqet te klientët, Jo = i fshehur. Bosh = Po (te të rejat).' },
  { key: 'photos', header: 'Fotot (emrat në ZIP, të ndara me ;)', width: 42, aliases: ['fotot', 'foto', 'fotografite', 'fotografia', 'fotografi', 'imazhet', 'images', 'image', 'photos', 'photo', 'pictures'], help: 'Emrat e skedarëve në ZIP, p.sh. HS-001-1.jpg; HS-001-2.jpg (deri në 10). Bosh = fotot ekzistuese mbeten.' },
];

export const MAX_ROWS_OPTIONS = [100, 500, 1000] as const;
const MAX_XLSX_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_BYTES = 500 * 1024 * 1024;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_ZIP_TOTAL = 1024 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5000;
const BATCH = 50;
const UPLOAD_CONCURRENCY = 4;

export const norm = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which column holds which field (by header text). */
export function mapHeaders(row: unknown[]): Partial<Record<Field, number>> {
  const map: Partial<Record<Field, number>> = {};
  const candidates = COLUMNS.flatMap((c) => c.aliases.map((a) => ({ key: c.key, a }))).sort((x, y) => y.a.length - x.a.length);
  row.forEach((cell, idx) => {
    const h = norm(cell);
    if (!h) return;
    const hit = candidates.find((c) => h === c.a) ?? candidates.find((c) => h.startsWith(c.a));
    if (hit && map[hit.key] === undefined) map[hit.key] = idx;
  });
  return map;
}

// ------------------------------------------------------------------ files
export async function downloadTemplate(categories: Category[]) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const header = COLUMNS.map((c) => ({ value: c.header, fontWeight: 'bold' as const, backgroundColor: '#E6F0F9' }));
  const help = [
    [{ value: 'Kolona', fontWeight: 'bold' as const }, { value: 'Udhëzim', fontWeight: 'bold' as const }],
    ...COLUMNS.map((c) => [c.header, c.help]),
    [null, null],
    [{ value: 'Fotot', fontWeight: 'bold' as const }, 'Vendosni të gjitha fotot në një skedar ZIP. Në kolonën "Fotot" shkruani emrat e skedarëve (pa dosje), p.sh. HS-001-1.jpg; HS-001-2.jpg. Formatet: JPG, PNG, WEBP (deri në 15 MB secila).'],
    [{ value: 'Çmimet', fontWeight: 'bold' as const }, 'Çmimi i pakicës dhe i shumicës importohen veçmas. Klientët e pakicës shohin vetëm të pakicës; të shumicës (të aprovuar) vetëm të shumicës.'],
    [{ value: 'Përditësimi', fontWeight: 'bold' as const }, 'Nëse SKU ekziston, produkti përditësohet: qelizat bosh nuk e ndryshojnë vlerën ekzistuese.'],
    [null, null],
    [{ value: 'Kategoritë ekzistuese', fontWeight: 'bold' as const }, null],
    ...categories.map((c) => [c.name_sq, c.name_en || '']),
  ];
  await writeXlsxFile(
    [
      { sheet: 'Produktet', data: [header], columns: COLUMNS.map((c) => ({ width: c.width })), stickyRowsCount: 1 },
      { sheet: 'Udhëzime', data: help, columns: [{ width: 36 }, { width: 110 }] },
    ],
  ).toFile('eko-produktet-template.xlsx');
}

export async function exportProducts(products: Product[], categories: Category[]) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const cat = new Map(categories.map((c) => [c.id, c.name_sq]));
  const header = COLUMNS.map((c) => ({ value: c.header, fontWeight: 'bold' as const, backgroundColor: '#E6F0F9' }));
  const rows = products.map((p) => [
    p.sku, p.name, p.name_en || '', p.description || '', p.description_en || '',
    (p.category_id && cat.get(p.category_id)) || '', p.unit || '',
    { value: Number(p.retail_price), type: Number, format: '0.00' },
    { value: Number(p.wholesale_price), type: Number, format: '0.00' },
    { value: Number(p.stock ?? 0), type: Number },
    p.active ? 'Po' : 'Jo',
    (p.images ?? []).join('; '),
  ]);
  await writeXlsxFile(
    [{ sheet: 'Produktet', data: [header, ...rows], columns: COLUMNS.map((c) => ({ width: c.width })), stickyRowsCount: 1 }],
  ).toFile(`eko-produktet-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// ------------------------------------------------------------------ reading
export type ZipPhoto = { name: string; bytes: Uint8Array; mime: string };
export type ZipResult = { photos: Map<string, ZipPhoto>; skipped: string[] };

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const baseName = (p: string) => p.split(/[\\/]/).pop()!.trim();
/** A photo given as a link: https, or http only for a local development stack. */
export const isPhotoUrl = (p: string) => /^https:\/\/\S+$/i.test(p) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/\S*$/i.test(p);
const isLink = (p: string) => /^https?:\/\//i.test(p);
const photoKey = (p: string) => baseName(p).toLowerCase();

/** The file really is a JPEG / PNG / WEBP (not only by its name). */
function looksLikeImage(b: Uint8Array, mime: string) {
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (mime === 'image/webp') return String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP';
  return false;
}

export class ImportFileError extends Error {}

export async function readZip(file: File): Promise<ZipResult> {
  if (file.size > MAX_ZIP_BYTES) throw new ImportFileError('imp_zip_too_big');
  const { unzip } = await import('fflate');
  const data = new Uint8Array(await file.arrayBuffer());
  const skipped: string[] = [];
  let total = 0;
  let count = 0;
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(
      data,
      {
        // Only real photo files, within limits (protects against "zip bombs").
        filter: (f) => {
          const name = baseName(f.name);
          if (f.name.endsWith('/') || f.name.startsWith('__MACOSX/') || name.startsWith('.')) return false;
          const ext = name.split('.').pop()?.toLowerCase() ?? '';
          if (!MIME[ext]) { skipped.push(name); return false; }
          if (f.originalSize > MAX_PHOTO_BYTES) { skipped.push(name); return false; }
          total += f.originalSize;
          count += 1;
          return total <= MAX_ZIP_TOTAL && count <= MAX_ZIP_ENTRIES;
        },
      },
      (err, out) => (err ? reject(new ImportFileError('imp_zip_invalid')) : resolve(out)),
    ),
  );
  if (total > MAX_ZIP_TOTAL || count > MAX_ZIP_ENTRIES) throw new ImportFileError('imp_zip_too_big');
  const photos = new Map<string, ZipPhoto>();
  for (const [path, bytes] of Object.entries(files)) {
    const name = baseName(path);
    const mime = MIME[name.split('.').pop()!.toLowerCase()];
    if (!looksLikeImage(bytes, mime)) { skipped.push(name); continue; }
    photos.set(photoKey(name), { name, bytes, mime });
  }
  return { photos, skipped };
}

export async function readSheetRows(file: File): Promise<{ header: unknown[]; rows: { row: number; cells: unknown[] }[] }> {
  if (file.size > MAX_XLSX_BYTES) throw new ImportFileError('imp_xlsx_too_big');
  if (!/\.xlsx$/i.test(file.name)) throw new ImportFileError('imp_xlsx_type');
  const { default: readXlsxFile } = await import('read-excel-file/browser');
  let sheets;
  try {
    sheets = await readXlsxFile(file);
  } catch {
    throw new ImportFileError('imp_xlsx_invalid');
  }
  // The products sheet: the first one whose header row has an SKU column.
  for (const s of sheets) {
    for (let i = 0; i < Math.min(10, s.data.length); i++) {
      if (mapHeaders(s.data[i] as unknown[]).sku !== undefined) {
        const rows = s.data.slice(i + 1).map((cells, k) => ({ row: i + 2 + k, cells: cells as unknown[] }));
        return { header: s.data[i] as unknown[], rows: rows.filter((r) => r.cells.some((c) => c !== null && String(c).trim() !== '')) };
      }
    }
  }
  throw new ImportFileError('imp_no_sku_column');
}

// ------------------------------------------------------------------ checking
export type RowAction = 'create' | 'update' | 'reject' | 'skip';
export type ImportRow = {
  row: number;
  sku: string;
  name: string;
  name_en: string;
  description: string;
  description_en: string;
  category: string;
  unit: string;
  retail: number | null;
  wholesale: number | null;
  stock: number | null;
  active: boolean | null;
  photos: string[];           // file names or https URLs, as written
  errors: string[];           // translation keys (imp_e_…)
  warnings: string[];
  existing?: Product;
  action: RowAction;
};

const text = (v: unknown) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)).trim();

/** "34,90" "34.90" "1.234,50" "1,234.50" "34,90 €" → 34.9; '' → null; invalid → NaN */
export function parseNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v).replace(/[€\s ]/g, '').replace(/eur$/i, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma > -1) s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

function parseActive(v: unknown): boolean | null | undefined {
  if (typeof v === 'boolean') return v;
  const s = norm(v);
  if (!s) return null;
  if (['po', 'yes', 'true', '1', 'aktiv', 'active', 'x', 'shfaq', 'ok'].includes(s)) return true;
  if (['jo', 'no', 'false', '0', 'joaktiv', 'inactive', 'fshehur', 'hidden'].includes(s)) return false;
  return undefined;
}

export function buildRows(
  sheet: { header: unknown[]; rows: { row: number; cells: unknown[] }[] },
  existing: Product[],
  categories: Category[],
  zip: ZipResult | null,
): ImportRow[] {
  const map = mapHeaders(sheet.header);
  const get = (cells: unknown[], f: Field) => (map[f] === undefined ? null : cells[map[f]!] ?? null);
  const bySku = new Map(existing.map((p) => [p.sku.trim().toLowerCase(), p]));
  const catNames = new Set(categories.flatMap((c) => [c.name_sq.toLowerCase(), (c.name_en || '').toLowerCase()]).filter(Boolean));
  const seen = new Map<string, number>();

  return sheet.rows.map(({ row, cells }) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const sku = text(get(cells, 'sku')).slice(0, 100);
    const r: ImportRow = {
      row, sku,
      name: text(get(cells, 'name')).slice(0, 200),
      name_en: text(get(cells, 'name_en')).slice(0, 200),
      description: text(get(cells, 'description')).slice(0, 5000),
      description_en: text(get(cells, 'description_en')).slice(0, 5000),
      category: text(get(cells, 'category')),
      unit: text(get(cells, 'unit')).slice(0, 30),
      retail: null, wholesale: null, stock: null, active: null, photos: [], errors, warnings, action: 'create',
    };
    if (!sku) errors.push('imp_e_sku');
    else {
      const key = sku.toLowerCase();
      if (seen.has(key)) errors.push('imp_e_duplicate');
      else seen.set(key, row);
      r.existing = bySku.get(key);
    }
    const retail = parseNumber(get(cells, 'retail'));
    const wholesale = parseNumber(get(cells, 'wholesale'));
    if (Number.isNaN(retail) || Number.isNaN(wholesale) || (retail ?? 0) < 0 || (wholesale ?? 0) < 0) errors.push('imp_e_price');
    else {
      r.retail = retail === null ? null : Math.round(retail * 100) / 100;
      r.wholesale = wholesale === null ? null : Math.round(wholesale * 100) / 100;
    }
    const stock = parseNumber(get(cells, 'stock'));
    if (Number.isNaN(stock) || (stock !== null && (stock < 0 || !Number.isInteger(stock)))) errors.push('imp_e_stock');
    else r.stock = stock;
    const active = parseActive(get(cells, 'active'));
    if (active === undefined) errors.push('imp_e_active');
    else r.active = active;
    if (r.category && !catNames.has(r.category.toLowerCase())) errors.push('imp_e_category');

    const photoCell = text(get(cells, 'photos'));
    r.photos = [...new Set(photoCell.split(/[;\n|]+/).map((s) => s.trim()).filter(Boolean))];
    if (r.photos.length > 10) errors.push('imp_e_too_many_photos');
    for (const p of r.photos) {
      if (isLink(p)) {
        if (!isPhotoUrl(p)) errors.push('imp_e_photo_url');
      } else if (!zip) errors.push('imp_e_no_zip');
      else if (!zip.photos.has(photoKey(p))) errors.push('imp_e_photo_missing');
    }

    if (!r.existing) {
      if (!r.name) errors.push('imp_e_name');
      if ((r.retail === null || r.wholesale === null) && !errors.includes('imp_e_price')) errors.push('imp_e_price_required');
    }
    if (r.retail !== null && r.wholesale !== null && r.wholesale > r.retail) warnings.push('imp_w_wholesale_higher');
    r.action = errors.length ? 'reject' : r.existing ? 'update' : 'create';
    r.errors = [...new Set(errors)];
    return r;
  });
}

// ------------------------------------------------------------------ importing
export type ReportRow = { row: number; sku: string; status: 'created' | 'updated' | 'rejected'; error?: string };
export type Progress = { done: number; total: number };

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/** Imports the accepted rows in groups; photos are uploaded once each. */
export async function runImport(
  rows: ImportRow[],
  zip: ZipResult | null,
  opts: { notify: boolean },
  onProgress: (p: Progress) => void,
): Promise<ReportRow[]> {
  const report: ReportRow[] = [];
  const todo = rows.filter((r) => r.action === 'create' || r.action === 'update');
  const uploaded = new Map<string, string>(); // photo key → public URL
  let done = 0;
  onProgress({ done, total: todo.length });

  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    // 1. photos of this group (each file only once, even if used by several products)
    const needed = [...new Set(batch.flatMap((r) => r.photos.filter((p) => !isLink(p)).map(photoKey)))].filter((k) => !uploaded.has(k));
    const failed = new Set<string>();
    await pool(needed, UPLOAD_CONCURRENCY, async (k) => {
      const ph = zip!.photos.get(k)!;
      try {
        uploaded.set(k, await uploadProductImage(new File([ph.bytes], ph.name, { type: ph.mime })));
      } catch {
        failed.add(k);
      }
    });
    // 2. the rows (server checks everything again, administrators only)
    const payload: Record<string, unknown>[] = [];
    for (const r of batch) {
      const missing = r.photos.filter((p) => !isLink(p)).find((p) => failed.has(photoKey(p)));
      if (missing) {
        report.push({ row: r.row, sku: r.sku, status: 'rejected', error: 'imp_e_photo_upload' });
        continue;
      }
      payload.push({
        row: r.row, sku: r.sku,
        name: r.name || null, name_en: r.name_en || null, description: r.description || null, description_en: r.description_en || null,
        category: r.category || null, unit: r.unit || null,
        retail_price: r.retail, wholesale_price: r.wholesale, stock: r.stock, active: r.active,
        images: r.photos.length ? r.photos.map((p) => (isLink(p) ? p : uploaded.get(photoKey(p))!)) : null,
      });
    }
    if (payload.length) {
      const { data, error } = await supabase.rpc('admin_import_products', { p_rows: payload, p_notify: opts.notify });
      if (error) {
        const code = /ADMIN_ONLY/.test(error.message) ? 'imp_e_not_admin' : 'imp_e_server';
        for (const p of payload) report.push({ row: p.row as number, sku: p.sku as string, status: 'rejected', error: code });
        if (code === 'imp_e_not_admin') throw new ImportFileError('imp_e_not_admin');
      } else {
        for (const x of data as { row: number; sku: string; status: ReportRow['status']; error?: string }[]) {
          report.push({ row: x.row, sku: x.sku, status: x.status, error: x.error ? `imp_s_${x.error}` : undefined });
        }
      }
    }
    done += batch.length;
    onProgress({ done, total: todo.length });
  }

  // Photos uploaded only for rows that were then rejected: remove them again.
  const used = new Set<string>();
  const accepted = new Set(report.filter((r) => r.status !== 'rejected').map((r) => r.row));
  for (const r of todo) if (accepted.has(r.row)) r.photos.forEach((p) => used.add(photoKey(p)));
  await pool([...uploaded].filter(([k]) => !used.has(k)), UPLOAD_CONCURRENCY, async ([, url]) => {
    await deleteProductImage(url).catch(() => undefined);
  });
  return report.sort((a, b) => a.row - b.row);
}

export async function downloadReport(report: ReportRow[], rejectedBefore: ImportRow[], t: (k: string) => string) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const head = ['Rreshti', 'SKU', 'Rezultati', 'Arsyeja'].map((value) => ({ value, fontWeight: 'bold' as const }));
  const rows = [
    ...report.map((r) => [r.row, r.sku, t(`imp_st_${r.status}`), r.error ? t(r.error) : '']),
    ...rejectedBefore.map((r) => [r.row, r.sku, t('imp_st_rejected'), r.errors.map(t).join('; ')]),
  ].sort((a, b) => Number(a[0]) - Number(b[0]));
  await writeXlsxFile([{ sheet: 'Raporti', data: [head, ...rows], columns: [{ width: 10 }, { width: 18 }, { width: 16 }, { width: 70 }] }])
    .toFile(`eko-importi-raporti-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.xlsx`);
}
