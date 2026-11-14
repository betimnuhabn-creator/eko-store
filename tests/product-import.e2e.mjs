// PC panel → Produktet → Excel template / export / import with photos (ZIP).
// LOCAL stack only; real files are built here, uploaded through the panel in a
// browser, and the database + Storage are checked afterwards.
//   npx supabase db reset && node --test --test-concurrency=1 tests/product-import.e2e.mjs
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { env, makeAdmin, ok, service, signUp, sql } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const adminRequire = createRequire(new URL('../admin-web/package.json', import.meta.url));
const load = async (m) => import(pathToFileURL(adminRequire.resolve(m)).href);
const WEB = 'http://localhost:8081/';
const DIR = mkdtempSync(join(tmpdir(), 'eko-import-'));
let server, browser, admin, writeXlsx, readXlsx, zipSync;

const HEADERS = ['SKU *', 'Emri (shqip) *', 'Emri (anglisht)', 'Përshkrimi (shqip)', 'Përshkrimi (anglisht)', 'Kategoria', 'Njësia',
  'Çmimi pakicë (€) *', 'Çmimi shumicë (€) *', 'Stoku', 'Aktiv (Po/Jo)', 'Fotot (emrat në ZIP, të ndara me ;)'];
const PNG = readFileSync('assets/icon.png');

before(async () => {
  writeXlsx = (await load('write-excel-file/node')).default;
  readXlsx = (await load('read-excel-file/node')).default;
  ({ zipSync } = await load('fflate'));
  execSync('npx vite build --outDir dist-test --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY },
  });
  server = spawn('node', ['tests/serve.mjs', 'admin-web/dist-test', '8081'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();
  admin = await makeAdmin('imp-admin');
});
after(async () => {
  await browser?.close();
  server?.kill();
});

async function xlsx(name, rows, header = HEADERS) {
  const path = join(DIR, name);
  writeFileSync(path, await writeXlsx([header, ...rows].map((r) => r.map((v) => (v === undefined ? null : v)))).toBuffer());
  return path;
}
function zip(name, files) {
  const path = join(DIR, name);
  writeFileSync(path, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v)]))));
  return path;
}
async function panel() {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'sq-AL', acceptDownloads: true });
  const pg = await ctx.newPage();
  await pg.goto(WEB);
  await pg.getByTestId('email').fill(admin.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login').click();
  await pg.getByTestId('logout').waitFor();
  await pg.goto(`${WEB}#/products`);
  await pg.getByTestId('excel-import').waitFor();
  return pg;
}
async function importFiles(pg, xlsxPath, zipPath, { limit, notify } = {}) {
  await pg.getByTestId('excel-import').click();
  await pg.getByTestId('import-xlsx').setInputFiles(xlsxPath);
  if (zipPath) await pg.getByTestId('import-zip').setInputFiles(zipPath);
  await pg.getByTestId('import-read').click();
  await pg.getByTestId('import-preview').waitFor();
  if (limit) await pg.getByTestId('import-limit').selectOption(String(limit));
  if (notify) await pg.getByTestId('import-notify').check();
}
const sum = async (pg, id) => Number(await pg.getByTestId(id).innerText());
async function startAndWait(pg) {
  await pg.getByTestId('import-start').click();
  await pg.getByTestId('import-done').waitFor({ timeout: 300000 });
  return { created: await sum(pg, 'rep-created'), updated: await sum(pg, 'rep-updated'), rejected: await sum(pg, 'rep-rejected') };
}
const product = async (sku) => ok(await service.from('products').select('*').ilike('sku', sku).maybeSingle());
const storageCount = () => Number(sql("select count(*) from storage.objects where bucket_id='product-images'"));

test('template: the empty Excel has the template columns and the instructions with the categories', async () => {
  const pg = await panel();
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.getByTestId('excel-template').click()]);
  assert.equal(dl.suggestedFilename(), 'eko-produktet-template.xlsx');
  const sheets = await readXlsx(await dl.path());
  const products = sheets.find((s) => s.sheet === 'Produktet');
  assert.deepEqual(products.data, [HEADERS], 'only the header row');
  const help = sheets.find((s) => s.sheet === 'Udhëzime').data.flat().join(' ');
  assert.match(help, /Ngrohje/, 'existing categories listed');
  await pg.context().close();
});

test('import with photos: preview with errors, create/update by SKU, several photos, no duplicates, report', async () => {
  const hs001 = await product('HS-001');
  const objectsBefore = storageCount();
  const file = await xlsx('products.xlsx', [
    ['NEW-A', 'Bojler 50L', 'Boiler 50L', 'Bojler elektrik', '', 'Ngrohje', 'copë', '12,50', 10, 5, 'Po', 'a1.png; A2.PNG'],
    ['NEW-B', 'Tub 1', '', '', '', '', 'm', 3, 2, 100, 'Po', 'shared.png'],
    ['NEW-C', 'Tub 2', '', '', '', '', 'm', '4.20', '3.10', 50, 'Jo', 'shared.png'],
    ['hs-001', '', '', '', '', '', '', 39.9, null, null, '', ''],
    ['NEW-A', 'Përsëritje', '', '', '', '', '', 1, 1, 1, 'Po', ''],
    ['NEW-D', 'Pa shumicë', '', '', '', '', '', 5, null, 1, 'Po', ''],
    ['NEW-E', 'Kategori e gabuar', '', '', '', 'Nuk ekziston', '', 5, 4, 1, 'Po', ''],
    ['NEW-F', 'Foto mungon', '', '', '', '', '', 5, 4, 1, 'Po', 'mungon.png'],
    ['NEW-G', 'Foto e rreme', '', '', '', '', '', 5, 4, 1, 'Po', 'fake.jpg'],
    ['NEW-H', 'Çmim i gabuar', '', '', '', '', '', 'abc', 4, 1, 'Po', ''],
    ['NEW-I', 'Shumica më e lartë', '', '', '', '', '', 5, 6, 1, 'Po', ''],
    [null, null, null, null, null, null, null, null, null, null, null, null],
  ]);
  const photos = zip('photos.zip', { 'a1.png': PNG, 'foto/a2.png': PNG, 'shared.png': PNG, 'fake.jpg': Buffer.from('not an image'), '__MACOSX/._a1.png': PNG });
  const pg = await panel();
  await importFiles(pg, file, photos);
  assert.deepEqual([await sum(pg, 'sum-create'), await sum(pg, 'sum-update'), await sum(pg, 'sum-reject')], [4, 1, 6]);
  const errorsOf = async (sku) => pg.getByTestId(`import-row-${sku}`).locator('.err-list').innerText();
  await pg.getByTestId('import-filter-reject').click();
  assert.match(await errorsOf('NEW-D'), /Mungon çmimi i pakicës ose i shumicës/);
  assert.match(await errorsOf('NEW-E'), /Kategoria nuk ekziston/);
  assert.match(await errorsOf('NEW-F'), /nuk gjendet në ZIP/);
  assert.match(await errorsOf('NEW-G'), /nuk gjendet në ZIP/);
  assert.match(await errorsOf('NEW-H'), /Çmim i pavlefshëm/);
  await pg.getByTestId('import-filter-all').click();
  assert.match(await pg.getByTestId('import-row-NEW-I').locator('.warn-list').innerText(), /shumicës është më i lartë/);
  assert.equal(await pg.getByTestId('import-row-NEW-A').first().locator('img.thumb').count(), 1, 'photo preview from the ZIP');

  const rep = await startAndWait(pg);
  assert.deepEqual(rep, { created: 4, updated: 1, rejected: 6 });
  await pg.getByTestId('rep-row-NEW-D').waitFor();
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.getByTestId('import-report').click()]);
  const reportRows = (await readXlsx(await dl.path()))[0].data;
  assert.equal(reportRows.length, 1 + 11, 'report has every row');
  await pg.getByTestId('import-close').click();
  await pg.getByTestId('row-NEW-A').waitFor();
  await pg.context().close();

  const a = await product('NEW-A');
  assert.deepEqual([a.name, a.name_en, Number(a.retail_price), Number(a.wholesale_price), a.stock, a.active, a.unit], ['Bojler 50L', 'Boiler 50L', 12.5, 10, 5, true, 'copë']);
  assert.equal(sql(`select name_sq from public.categories where id='${a.category_id}'`), 'Ngrohje');
  assert.equal(a.images.length, 2, 'two photos');
  for (const u of a.images) assert.equal((await fetch(u)).status, 200, 'photo in Supabase Storage');
  const b = await product('NEW-B');
  const c = await product('NEW-C');
  assert.equal(b.images[0], c.images[0], 'the same file is uploaded once and shared');
  assert.equal(c.active, false);
  assert.equal(storageCount() - objectsBefore, 3, 'exactly 3 photos stored (no orphans, fake skipped)');
  const h = await product('HS-001');
  assert.deepEqual([Number(h.retail_price), Number(h.wholesale_price), h.name, h.images, h.stock], [39.9, Number(hs001.wholesale_price), hs001.name, hs001.images, hs001.stock], 'only the retail price changed');
  assert.equal(sql("select count(*) from public.products where lower(sku) in ('new-a','new-b','new-c','new-i')"), '4', 'no duplicates');
  assert.equal(sql("select count(*) from public.products where sku in ('NEW-D','NEW-E','NEW-F','NEW-G','NEW-H')"), '0', 'rejected rows not saved');
  assert.equal(sql("select count(*) from public.promo_events e join public.products p on p.id=e.product_id where p.sku like 'NEW-%' or (p.sku='HS-001' and e.kind='price')"), '0', 'no promotional notifications by default');

  // The same file again: everything is an update, nothing duplicated.
  const pg2 = await panel();
  await importFiles(pg2, file, photos);
  assert.deepEqual([await sum(pg2, 'sum-create'), await sum(pg2, 'sum-update')], [0, 5]);
  assert.deepEqual(await startAndWait(pg2), { created: 0, updated: 5, rejected: 6 });
  await pg2.context().close();
  assert.equal(sql("select count(*) from public.products where lower(sku) like 'new-%'"), '4');
});

test('export → change prices in Excel → import again (no ZIP): prices updated, photos kept, nothing created', async () => {
  const pg = await panel();
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.getByTestId('excel-export').click()]);
  const data = (await readXlsx(await dl.path()))[0].data;
  assert.deepEqual(data[0], HEADERS);
  const total = Number(sql('select count(*) from public.products'));
  assert.equal(data.length - 1, total, 'every product exported');
  const iSku = 0, iRetail = 7, iWhole = 8;
  const row = data.find((r) => r[iSku] === 'NEW-A');
  assert.deepEqual([row[iRetail], row[iWhole]], [12.5, 10]);
  row[iRetail] = 13.9;
  row[iWhole] = '11,40';
  const edited = await xlsx('edited.xlsx', data.slice(1), data[0]);
  const before = await product('NEW-A');
  await pg.reload();
  await pg.getByTestId('excel-import').waitFor();
  await importFiles(pg, edited, null);
  assert.equal(await sum(pg, 'sum-create'), 0);
  assert.equal(await sum(pg, 'sum-reject'), 0);
  const rep = await startAndWait(pg);
  assert.deepEqual(rep, { created: 0, updated: total, rejected: 0 });
  await pg.context().close();
  const after = await product('NEW-A');
  assert.deepEqual([Number(after.retail_price), Number(after.wholesale_price)], [13.9, 11.4]);
  assert.deepEqual(after.images, before.images, 'photos kept');
  assert.equal(Number(sql('select count(*) from public.products')), total, 'no product added');
});

test('notification option: only when ticked, a new product records a promotional event', async () => {
  const file = await xlsx('notify.xlsx', [['NEW-N', 'Me njoftim', '', '', '', '', '', 9, 8, 1, 'Po', '']]);
  const pg = await panel();
  await importFiles(pg, file, null, { notify: true });
  assert.deepEqual(await startAndWait(pg), { created: 1, updated: 0, rejected: 0 });
  await pg.context().close();
  assert.equal(sql("select count(*) from public.promo_events e join public.products p on p.id=e.product_id where p.sku='NEW-N' and e.kind='new_product'"), '1');
});

test('1,000 products in one import (groups of 50); the 100 option imports only the first 100', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => [`BULK-${String(i + 1).padStart(4, '0')}`, `Produkt masiv ${i + 1}`, '', '', '', '', '', (i % 50) + 1, (i % 50) + 0.5, i, 'Po', '']);
  const file = await xlsx('bulk.xlsx', rows);
  const pg = await panel();
  await importFiles(pg, file, null, { limit: 100 });
  assert.equal(await sum(pg, 'sum-create'), 100);
  assert.deepEqual(await startAndWait(pg), { created: 100, updated: 0, rejected: 0 });
  await pg.getByTestId('import-close').click();
  assert.equal(sql("select count(*) from public.products where sku like 'BULK-%'"), '100');

  await importFiles(pg, file, null, { limit: 1000 });
  assert.deepEqual([await sum(pg, 'sum-create'), await sum(pg, 'sum-update')], [900, 100]);
  const t0 = Date.now();
  assert.deepEqual(await startAndWait(pg), { created: 900, updated: 100, rejected: 0 });
  const seconds = (Date.now() - t0) / 1000;
  console.log(`# 1000 rows imported in ${seconds.toFixed(1)} s`);
  await pg.context().close();
  assert.equal(sql("select count(*) from public.products where sku like 'BULK-%'"), '1000');
  assert.equal(sql("select count(distinct lower(sku)) from public.products"), sql('select count(*) from public.products'), 'no duplicate SKUs at all');
});

test('only administrators: customers cannot import, upload photos or see the import', async () => {
  const u = await signUp('imp-customer');
  const { error } = await u.c.rpc('admin_import_products', { p_rows: [{ row: 2, sku: 'HACK-1', name: 'x', retail_price: 0, wholesale_price: 0 }] });
  assert.match(error?.message ?? '', /ADMIN_ONLY/);
  const up = await u.c.storage.from('product-images').upload(`hack-${Date.now()}.png`, PNG, { contentType: 'image/png' });
  assert.ok(up.error, 'storage upload refused');
  assert.equal(sql("select count(*) from public.products where sku='HACK-1'"), '0');
  const { error: e2 } = await (await import('./helpers.mjs')).client().rpc('admin_import_products', { p_rows: [] });
  assert.ok(e2, 'guest refused');
});
