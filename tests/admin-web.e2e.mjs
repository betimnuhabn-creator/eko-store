// End-to-end test of the PC admin panel (admin-web/) in a real browser against
// the LOCAL Supabase stack (never the production project).
//
//   npx supabase start && npx supabase db reset
//   node --test --test-concurrency=1 tests/admin-web.e2e.mjs
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { delivery, env, makeAdmin, ok, productBySku, service, signUp } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 8098;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOTS_DIR;

let server, browser, admin, retail, biz, order;

before(async () => {
  // Build the panel against the local stack (process env overrides .env.production).
  execSync('npx vite build --outDir dist-test --emptyOutDir', {
    cwd: 'admin-web',
    stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY },
  });
  server = spawn('node', ['tests/serve.mjs', 'admin-web/dist-test', String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  browser = await chromium.launch();
  admin = await makeAdmin('aw-admin');
  retail = await signUp('aw-retail');
  biz = await signUp('aw-biz', { requested_wholesale: true, business_name: 'AW Instalime SHPK' });
  const p = await productBySku('HS-001');
  order = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: p.id, quantity: 2 }], p_delivery: delivery }));
});
after(async () => {
  await browser?.close();
  server?.kill();
});

async function page(width = 1366) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 } });
  const pg = await ctx.newPage();
  pg.errors = [];
  pg.on('pageerror', (e) => pg.errors.push(e.message));
  pg.on('console', (m) => m.type() === 'error' && pg.errors.push(m.text()));
  return pg;
}
async function login(pg, email) {
  await pg.goto(BASE);
  await pg.getByTestId('email').fill(email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login').click();
}
const shot = (pg, n) => SHOTS && pg.screenshot({ path: `${SHOTS}/${n}.png` });
const cspErrors = (pg) => pg.errors.filter((e) => /Content Security Policy|CSP/i.test(e));

test('non-admin accounts are refused and signed out', async () => {
  const pg = await page();
  await login(pg, retail.email);
  await pg.getByText('Kjo llogari nuk është administrator').waitFor();
  assert.equal(await pg.getByTestId('logout').count(), 0, 'no admin UI rendered');
  await pg.goto(`${BASE}#/customers`);
  await pg.getByTestId('login').waitFor();
  await pg.context().close();
});

test('admin: dashboard shows stats and the new order', async () => {
  const pg = await page();
  await login(pg, admin.email);
  await pg.getByTestId('tile-new_orders').waitFor();
  await pg.waitForFunction(() => document.querySelector('[data-testid="tile-new_orders"] .tile-value')?.textContent === '1');
  await pg.getByText(`#${order.order_number}`).first().waitFor();
  await shot(pg, 'aw-01-dashboard');
  assert.deepEqual(cspErrors(pg), []);
  await pg.context().close();
});

test('admin: create product with uploaded photo, both prices, stock, category', async () => {
  const pg = await page();
  await login(pg, admin.email);
  await pg.getByRole('link', { name: 'Produktet' }).click();
  await pg.getByTestId('new-product').click();
  await pg.getByTestId('f-sku').fill('AW-BOJ-80');
  await pg.getByTestId('f-name').fill('Bojler elektrik 80L');
  await pg.getByTestId('f-retail').fill('149,90');
  await pg.getByTestId('f-wholesale').fill('119');
  await pg.getByTestId('f-stock').fill('4');
  await pg.getByTestId('f-category').selectOption({ label: 'Ngrohje' });
  await pg.getByTestId('f-files').setInputFiles('assets/icon.png');
  await pg.locator('.photo img').first().waitFor({ timeout: 20000 });
  await shot(pg, 'aw-02-product-edit');
  await pg.getByTestId('save-product').click();
  await pg.getByTestId('row-AW-BOJ-80').waitFor();
  const { data } = await service.from('products').select('retail_price,wholesale_price,stock,images,category_id,active').eq('sku', 'AW-BOJ-80').single();
  assert.equal(Number(data.retail_price), 149.9);
  assert.equal(Number(data.wholesale_price), 119);
  assert.equal(data.stock, 4);
  assert.equal(data.images.length, 1);
  assert.match(data.images[0], /\/storage\/v1\/object\/public\/product-images\/.+\.jpg$/);
  assert.equal((await fetch(data.images[0])).status, 200, 'photo is publicly readable');
  assert.ok(data.category_id);
  assert.deepEqual(cspErrors(pg), []);
  await pg.context().close();
});

test('admin: quick-edit prices, stock and visibility in the product table', async () => {
  const pg = await page();
  await login(pg, admin.email);
  await pg.goto(`${BASE}#/products`);
  const row = pg.getByTestId('row-HS-002');
  await row.waitFor();
  await row.getByLabel('HS-002 Pakicë').fill('3,50');
  await row.getByLabel('HS-002 Shumicë').fill('2,25');
  await row.getByLabel('HS-002 Stoku').fill('0');
  await pg.getByTestId('row-HS-003').getByLabel('HS-003 Aktiv').uncheck();
  await pg.getByTestId('save-all').click();
  await pg.getByTestId('save-all').waitFor({ state: 'detached' });
  const a = await productBySku('HS-002');
  assert.equal(Number(a.retail_price), 3.5);
  assert.equal(Number(a.wholesale_price), 2.25);
  const { data: s } = await service.from('products').select('stock').eq('sku', 'HS-002').single();
  assert.equal(s.stock, 0);
  const { data: h } = await service.from('products').select('active').eq('sku', 'HS-003').single();
  assert.equal(h.active, false);
  // retail customers now see the new price, wholesale price stays hidden
  const pr = ok(await retail.c.rpc('list_products')).find((x) => x.sku === 'HS-002');
  assert.equal(Number(pr.price), 3.5);
  assert.equal(pr.wholesale_price, null);
  await pg.goto(`${BASE}#/products?stock=out`);
  await pg.getByTestId('row-HS-002').waitFor();
  await shot(pg, 'aw-03-products');
  await pg.context().close();
});

test('admin: categories create / edit / delete', async () => {
  const pg = await page();
  await login(pg, admin.email);
  await pg.goto(`${BASE}#/categories`);
  await pg.getByTestId('new-category').click();
  await pg.getByTestId('c-name-sq').fill('Vegla pune');
  await pg.getByTestId('c-name-en').fill('Tools');
  await pg.getByTestId('c-save').click();
  await pg.getByRole('cell', { name: 'Vegla pune' }).waitFor();
  const row = pg.getByRole('row', { name: /Vegla pune/ });
  await row.getByRole('button', { name: 'Fshi' }).click();
  await pg.getByRole('dialog').getByRole('button', { name: 'Fshi' }).click();
  await pg.getByRole('cell', { name: 'Vegla pune' }).waitFor({ state: 'detached' });
  const { data } = await service.from('categories').select('id').eq('name_sq', 'Vegla pune');
  assert.equal(data.length, 0);
  await pg.context().close();
});

test('admin: order list, detail, status change notifies the customer', async () => {
  const pg = await page();
  await login(pg, admin.email);
  await pg.goto(`${BASE}#/orders`);
  await pg.getByTestId(`order-${order.order_number}`).waitFor();
  await pg.getByTestId(`order-${order.order_number}`).getByRole('link').click();
  await pg.getByTestId('set-confirmed').click();
  await pg.getByTestId('save-status').click();
  await pg.getByText('Statusi u ruajt').waitFor();
  await shot(pg, 'aw-04-order');
  const { data } = await service.from('orders').select('status').eq('id', order.id).single();
  assert.equal(data.status, 'confirmed');
  const n = ok(await retail.c.from('notifications').select('type,data').eq('type', 'order_status'));
  assert.ok(n.some((x) => x.data.order_id === order.id && x.data.status === 'confirmed'));
  await pg.goto(`${BASE}#/orders?status=confirmed`);
  await pg.getByTestId(`order-${order.order_number}`).waitFor();
  await pg.context().close();
});

test('admin: wholesale approval -> customer gets wholesale prices; revoke -> retail again', async () => {
  const pg = await page();
  await login(pg, admin.email);
  await pg.goto(`${BASE}#/customers?filter=pending`);
  await pg.getByTestId(`approve-${biz.email}`).click();
  await pg.getByRole('dialog').getByRole('button', { name: 'Aprovo' }).click();
  await pg.getByTestId(`approve-${biz.email}`).waitFor({ state: 'detached' });
  await shot(pg, 'aw-05-customers');
  const p1 = await productBySku('HS-001');
  const price = async () => Number(ok(await biz.c.rpc('list_products')).find((x) => x.sku === 'HS-001').price);
  assert.equal(await price(), Number(p1.wholesale_price));
  await pg.goto(`${BASE}#/customers`);
  await pg.getByTestId(`revoke-${biz.email}`).click();
  await pg.getByRole('dialog').getByRole('button', { name: 'Po' }).click();
  await pg.getByTestId(`revoke-${biz.email}`).waitFor({ state: 'detached' });
  assert.equal(await price(), Number(p1.retail_price));
  await pg.context().close();
});

test('admin: new order appears live in the notification bell', async () => {
  const pg = await page();
  await login(pg, admin.email);
  await pg.getByTestId('tile-new_orders').waitFor();
  await pg.waitForTimeout(1500); // realtime subscription
  const before = Number((await pg.locator('.bell-count').textContent().catch(() => '0')) || 0);
  const p = await productBySku('HS-001');
  const o = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: p.id, quantity: 1 }], p_delivery: delivery }));
  await pg.waitForFunction((n) => Number(document.querySelector('.bell-count')?.textContent || 0) > n, before, { timeout: 15000 });
  await pg.getByTestId('bell').click();
  await pg.getByText(`Porosi e re #${o.order_number}`).waitFor();
  await pg.context().close();
});

test('an admin who loses the admin role is signed out on the next check', async () => {
  const demoted = await makeAdmin('aw-demoted');
  const pg = await page();
  await login(pg, demoted.email);
  await pg.getByTestId('logout').waitFor();
  ok(await service.from('profiles').update({ role: 'retail' }).eq('id', demoted.id));
  await pg.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pg.getByText('Kjo llogari nuk është administrator').waitFor();
  await pg.context().close();
});

test('responsive: narrow screen hides the sidebar behind a menu button', async () => {
  const pg = await page(390);
  await login(pg, admin.email);
  await pg.getByLabel('menu').waitFor();
  assert.equal(await pg.locator('.sidebar').evaluate((e) => e.getBoundingClientRect().right <= 0), true);
  await pg.getByLabel('menu').click();
  await pg.waitForTimeout(300);
  assert.equal(await pg.locator('.sidebar').evaluate((e) => e.getBoundingClientRect().left >= 0), true);
  await shot(pg, 'aw-06-mobile');
  await pg.context().close();
});

test('built files contain no secret key', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = 'admin-web/dist-test/assets';
  const code = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
  // the actual secret values of this stack must not appear
  for (const secret of [env.SECRET_KEY, env.SERVICE_ROLE_KEY]) assert.ok(secret && !code.includes(secret));
  // no real sb_secret_ key and no embedded JWT with role service_role
  assert.equal(/sb_secret_[A-Za-z0-9_-]{10,}/.test(code), false);
  for (const jwt of code.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g) ?? []) {
    const role = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).role;
    assert.notEqual(role, 'service_role');
  }
  // the publishable key IS expected (public by design)
  assert.ok(code.includes(env.PUBLISHABLE_KEY));
});
