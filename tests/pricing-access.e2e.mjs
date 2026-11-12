// Retail / wholesale prices and who may see or change them — end to end on the
// LOCAL stack: app screens (Expo web build of the Android code), PC panel and
// direct API calls that bypass the app (what an attacker would try).
//
//   npx supabase db reset && <expo web export for the local stack>
//   node --test --test-concurrency=1 tests/pricing-access.e2e.mjs
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import { client, delivery, denied, env, makeAdmin, ok, service, signUp } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const APP = 'http://localhost:8083';
const WEB = 'http://localhost:8082/';
let servers = [], browser, admin, retail, pending, wholesale, product;

before(async () => {
  execSync('npx vite build --outDir dist-test --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY },
  });
  servers = [
    spawn('node', ['tests/serve.mjs', 'dist', '8083'], { stdio: 'ignore' }),
    spawn('node', ['tests/serve.mjs', 'admin-web/dist-test', '8082'], { stdio: 'ignore' }),
  ];
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();
  admin = await makeAdmin('pa-admin');
  retail = await signUp('pa-retail');
  pending = await signUp('pa-pending', { requested_wholesale: true, business_name: 'Në Pritje SHPK' });
  wholesale = await signUp('pa-ws', { requested_wholesale: true, business_name: 'Shumica SHPK' });
  ok(await admin.c.rpc('admin_review_wholesale', { p_user: wholesale.id, p_approve: true }));
  product = ok(await service.from('products').select('id,sku,name,retail_price,wholesale_price').eq('sku', 'HS-001').single());
});
after(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill());
});

const eur = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;
async function appPage(user) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sq-AL' });
  const pg = await ctx.newPage();
  if (user) {
    await pg.goto(`${APP}/login`);
    await pg.getByTestId('email').fill(user.email);
    await pg.getByTestId('password').fill('secret123');
    await pg.getByTestId('login-submit').click();
    await pg.waitForURL((u) => !u.pathname.startsWith('/login'));
  }
  return pg;
}
/** The prices visible on the product screen of the app. */
async function pricesOnProductScreen(user) {
  const pg = await appPage(user);
  await pg.goto(`${APP}/product/${product.id}`);
  await pg.getByText(product.name).first().waitFor();
  await pg.waitForTimeout(1200);
  const text = await pg.locator('body').innerText();
  await pg.context().close();
  return text;
}
const listed = async (u) => ok(await (u ? u.c : client()).rpc('list_products')).find((p) => p.id === product.id);

describe('who sees which price', () => {
  test('guest: no price at all (app and API)', async () => {
    const text = await pricesOnProductScreen(null);
    assert.ok(!text.includes(eur(product.retail_price)) && !text.includes(eur(product.wholesale_price)), 'no price shown');
    const p = await listed(null);
    assert.deepEqual([p.price, p.retail_price, p.wholesale_price], [null, null, null]);
  });

  test('1. retail customer sees ONLY the retail price', async () => {
    const text = await pricesOnProductScreen(retail);
    assert.ok(text.includes(eur(product.retail_price)), `retail price shown (${eur(product.retail_price)})`);
    assert.ok(!text.includes(eur(product.wholesale_price)), 'wholesale price not shown');
    const p = await listed(retail);
    assert.equal(Number(p.price), Number(product.retail_price));
    assert.equal(p.wholesale_price, null, 'API never returns the wholesale price to retail');
  });

  test('2. approved wholesale customer sees ONLY the wholesale price', async () => {
    const text = await pricesOnProductScreen(wholesale);
    assert.ok(text.includes(eur(product.wholesale_price)), `wholesale price shown (${eur(product.wholesale_price)})`);
    assert.ok(!text.includes(eur(product.retail_price)), 'retail price not shown');
    const p = await listed(wholesale);
    assert.equal(Number(p.price), Number(product.wholesale_price));
    assert.deepEqual([p.retail_price, p.wholesale_price], [null, null], 'raw price columns stay admin-only');
  });

  test('3. wholesale customer still PENDING approval gets no wholesale price', async () => {
    const text = await pricesOnProductScreen(pending);
    assert.ok(!text.includes(eur(product.wholesale_price)), 'no wholesale price while pending');
    assert.ok(text.includes(eur(product.retail_price)), 'retail price instead');
    const p = await listed(pending);
    assert.equal(Number(p.price), Number(product.retail_price));
    assert.equal(p.wholesale_price, null);
    const o = ok(await pending.c.rpc('place_order', { p_lines: [{ product_id: product.id, quantity: 1 }], p_delivery: delivery }));
    assert.equal(Number(o.total), Number(product.retail_price), 'pending is charged retail');
    assert.equal(ok(await service.from('orders').select('price_tier').eq('id', o.id).single()).price_tier, 'retail');
  });
});

describe('4. customers cannot manipulate prices or their account type', () => {
  test('prices sent by the app are ignored: the server charges its own price', async () => {
    const o = ok(await retail.c.rpc('place_order', {
      p_lines: [{ product_id: product.id, quantity: 3, unit_price: 0.01, price: 0.01, total: 0.03 }],
      p_delivery: { ...delivery, total: 0.03, price_tier: 'wholesale' },
    }));
    assert.equal(Number(o.total), Number((3 * product.retail_price).toFixed(2)));
    const line = ok(await service.from('order_items').select('unit_price,quantity').eq('order_id', o.id).single());
    assert.deepEqual([Number(line.unit_price), line.quantity], [Number(product.retail_price), 3]);
    const w = ok(await wholesale.c.rpc('place_order', { p_lines: [{ product_id: product.id, quantity: 2, unit_price: 0.01 }], p_delivery: delivery }));
    assert.equal(Number(w.total), Number((2 * product.wholesale_price).toFixed(2)), 'wholesale charged wholesale');
  });

  test('orders, order lines and products cannot be written or read directly', async () => {
    const o = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: product.id, quantity: 1 }], p_delivery: delivery }));
    await denied(retail.c.from('orders').update({ total: 0.01 }).eq('id', o.id));
    await denied(retail.c.from('order_items').update({ unit_price: 0.01 }).eq('order_id', o.id));
    await denied(retail.c.from('order_items').insert({ order_id: o.id, product_id: product.id, quantity: 9, unit_price: 0.01 }));
    await denied(retail.c.from('orders').insert({ customer_id: retail.id, total: 0 }));
    await denied(retail.c.from('products').select('wholesale_price'));
    await denied(retail.c.from('products').update({ retail_price: 0.01 }).eq('id', product.id));
    assert.equal(Number(ok(await service.from('orders').select('total').eq('id', o.id).single()).total), Number(product.retail_price));
  });

  test('customers cannot change their account type or approve themselves', async () => {
    await denied(retail.c.from('profiles').update({ wholesale_status: 'approved', role: 'wholesale' }).eq('id', retail.id));
    ok(await retail.c.rpc('update_my_profile', { p: { role: 'admin', wholesale_status: 'approved', city: 'Prizren' } }));
    await denied(retail.c.rpc('admin_review_wholesale', { p_user: retail.id, p_approve: true }), /ADMIN_ONLY/);
    await denied(pending.c.rpc('admin_review_wholesale', { p_user: pending.id, p_approve: true }), /ADMIN_ONLY/);
    await denied(retail.c.rpc('admin_save_product', { p: { id: product.id, sku: product.sku, name: product.name, retail_price: 0.01, wholesale_price: 0.01 } }), /ADMIN_ONLY/);
    const r = ok(await service.from('profiles').select('role,wholesale_status,city').eq('id', retail.id).single());
    assert.deepEqual(r, { role: 'retail', wholesale_status: 'none', city: 'Prizren' }, 'only the city changed');
    assert.equal(ok(await service.from('profiles').select('wholesale_status').eq('id', pending.id).single()).wholesale_status, 'pending');
    assert.equal(Number((await listed(retail)).price), Number(product.retail_price));
  });
});

describe('5. the administrator changes prices from the PC panel', () => {
  test('new retail and wholesale prices apply immediately to the right customers', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'sq-AL' });
    const pg = await ctx.newPage();
    await pg.goto(WEB);
    await pg.getByTestId('email').fill(admin.email);
    await pg.getByTestId('password').fill('secret123');
    await pg.getByTestId('login').click();
    await pg.getByTestId('logout').waitFor();
    await pg.goto(`${WEB}#/products`);
    const row = pg.getByTestId(`row-${product.sku}`);
    await row.waitFor();
    await row.getByLabel(`${product.sku} Pakicë`).fill('39,90');
    await row.getByLabel(`${product.sku} Shumicë`).fill('29,50');
    await pg.getByTestId('save-all').click();
    await pg.getByTestId('save-all').waitFor({ state: 'detached' });
    await ctx.close();
    const saved = ok(await service.from('products').select('retail_price,wholesale_price').eq('id', product.id).single());
    assert.deepEqual([Number(saved.retail_price), Number(saved.wholesale_price)], [39.9, 29.5]);
    assert.equal(Number((await listed(retail)).price), 39.9);
    assert.equal(Number((await listed(wholesale)).price), 29.5);
    assert.equal(Number((await listed(pending)).price), 39.9);
    const tr = await pricesOnProductScreen(retail);
    assert.ok(tr.includes('39,90 €') && !tr.includes('29,50 €'), 'retail app shows the new retail price');
    const tw = await pricesOnProductScreen(wholesale);
    assert.ok(tw.includes('29,50 €') && !tw.includes('39,90 €'), 'wholesale app shows the new wholesale price');
    const o = ok(await wholesale.c.rpc('place_order', { p_lines: [{ product_id: product.id, quantity: 1 }], p_delivery: delivery }));
    assert.equal(Number(o.total), 29.5, 'checkout uses the new price');
  });
});
