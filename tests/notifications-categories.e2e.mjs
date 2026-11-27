// "Njoftimet" screen: 4 categories with unread counts, filtering, opening the
// product / offer / order, "mark all as read". Customer app (Expo web build of
// the same screen code as the Android app) on the LOCAL stack only.
//
//   npx supabase db reset && <expo web export for the local stack> \
//     && node --test --test-concurrency=1 tests/notifications-categories.e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { delivery, makeAdmin, ok, service, signUp, sql } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const APP = 'http://localhost:8092';
const SHOTS = process.env.SHOTS_DIR;
let server, browser, customer, admin, product, order, offerId, ids;

before(async () => {
  server = spawn('node', ['tests/serve.mjs', 'dist', '8092'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 700));
  browser = await chromium.launch();
  sql("select cron.alter_job(jobid, active := false) from cron.job where jobname like 'eko-%'");
  admin = await makeAdmin('nc-admin');
  customer = await signUp('nc-customer');
  product = ok(await service.from('products').select('id,name,name_en').eq('sku', 'HS-001').single());
  order = ok(await customer.c.rpc('place_order', { p_lines: [{ product_id: product.id, quantity: 1 }], p_delivery: delivery }));
  offerId = ok(await admin.c.rpc('admin_save_offer', { p: {
    title_sq: 'Oferta e javës', title_en: 'Weekly offer', starts_at: new Date(Date.now() - 60e3).toISOString(),
    ends_at: new Date(Date.now() + 864e5).toISOString(), items: [{ product_id: product.id, offer_price: 30 }] } }));
  // Notifications as they exist in the database (one of each kind; one already read).
  const rows = [
    ['order_status', { order_id: order.id, order_number: order.order_number, status: 'confirmed' }, null, 'order'],
    ['wholesale_approved', {}, null, 'order'],
    ['promo_offer', { offer_id: offerId, title: 'Oferta e javës', title_en: 'Weekly offer' }, null, 'promo'],
    ['promo_new_product', { product_id: product.id, name: product.name, name_en: product.name_en }, null, 'promo'],
    ['promo_price_down', { product_id: product.id, name: product.name, name_en: product.name_en, old: 34.9, new: 29.9 }, null, 'promo'],
    ['promo_price_up', { product_id: product.id, name: product.name, name_en: product.name_en, old: 29.9, new: 31.9 }, new Date().toISOString(), 'promo'],
  ];
  ids = {};
  for (const [type, data, read_at, category] of rows) {
    const r = ok(await service.from('notifications').insert({ recipient_id: customer.id, type, data, read_at, category, dispatched_at: new Date().toISOString() }).select('id').single());
    ids[type] = r.id;
  }
});
after(async () => {
  sql("select cron.alter_job(jobid, active := true) from cron.job where jobname like 'eko-%'");
  await browser?.close();
  server?.kill();
});

async function appPage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sq-AL' });
  const pg = await ctx.newPage();
  await pg.goto(`${APP}/login`);
  await pg.getByTestId('email').fill(customer.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login-submit').click();
  await pg.waitForURL((u) => !u.pathname.startsWith('/login'));
  return pg;
}
const v = (pg, sel) => pg.locator(`${sel} >> visible=true`).first();
const chip = (pg, cat) => v(pg, `[data-testid="notif-cat-${cat}"]`);
const shot = (pg, n) => SHOTS && pg.screenshot({ path: `${SHOTS}/${n}.png` });
const notes = async () => ok(await service.from('notifications').select('id,type,read_at').eq('recipient_id', customer.id));

test('4 categories with unread counts; each shows only its own notifications', async () => {
  const pg = await appPage();
  await pg.goto(`${APP}/notifications`);
  // Unread counts: orders 2 (order status + account), offers 1, new products 1, prices 1 (the increase is read).
  await chip(pg, 'orders').getByText('Porositë (2)').waitFor();
  await chip(pg, 'offers').getByText('Ofertat (1)').waitFor();
  await chip(pg, 'new_products').getByText('Produktet e reja (1)').waitFor();
  await chip(pg, 'prices').getByText('Ndryshimet e çmimeve (1)').waitFor();
  await shot(pg, 'nc-01-orders');

  const visibleTexts = async () => (await pg.locator('text=/Porosia #|shumicë|Ofertë|Produkt i ri|Ulje çmimi|Ndryshim çmimi/ >> visible=true').allTextContents()).join(' | ');
  // Orders (default): order status + account message, no promotions
  let t = await visibleTexts();
  assert.match(t, new RegExp(`Porosia #${order.order_number}`)); assert.doesNotMatch(t, /Ofertë|Produkt i ri|Ulje çmimi|Ndryshim çmimi/);
  await chip(pg, 'offers').click();
  await v(pg, 'text=/Oferta e javës/').waitFor();
  t = await visibleTexts(); assert.doesNotMatch(t, /Porosia #|Produkt i ri|Ulje çmimi|Ndryshim çmimi/, t);
  await chip(pg, 'new_products').click();
  await v(pg, 'text=/^Produkt i ri:/').waitFor();
  t = await visibleTexts(); assert.doesNotMatch(t, /Porosia #|Oferta e javës|Ulje çmimi|Ndryshim çmimi/, t);
  await chip(pg, 'prices').click();
  await v(pg, 'text=/Ulje çmimi/').waitFor();
  await v(pg, 'text=/Ndryshim çmimi/').waitFor();
  t = await visibleTexts(); assert.doesNotMatch(t, /Porosia #|Oferta e javës/, t);
  await v(pg, `text=Ulje çmimi: ${product.name} nga 34,90 € tani 29,90 €`).waitFor();
  assert.doesNotMatch(await pg.locator('body').innerText(), /undefined|\{name\}/);
  await shot(pg, 'nc-02-prices');
  await pg.context().close();
});

test('tapping a notification opens the product, the offer or the order (and marks it read)', async () => {
  const pg = await appPage();
  await pg.goto(`${APP}/notifications`);
  await chip(pg, 'prices').click();
  await v(pg, 'text=/Ulje çmimi/').click();
  await pg.waitForURL(new RegExp(`/product/${product.id}$`));
  await pg.goto(`${APP}/notifications`);
  await chip(pg, 'offers').click();
  await v(pg, 'text=/Oferta e javës/').click();
  await pg.waitForURL(new RegExp(`/offers/${offerId}$`));
  await pg.goto(`${APP}/notifications`);
  await chip(pg, 'new_products').click();
  await v(pg, 'text=/^Produkt i ri:/').click();
  await pg.waitForURL(new RegExp(`/product/${product.id}$`));
  await pg.goto(`${APP}/notifications`);
  await v(pg, `text=/Porosia #${order.order_number}/`).click();
  await pg.waitForURL(new RegExp(`/orders/${order.id}$`));
  await pg.waitForTimeout(500);
  const n = await notes();
  for (const type of ['promo_price_down', 'promo_offer', 'promo_new_product', 'order_status']) {
    assert.ok(n.find((x) => x.type === type).read_at, `${type} marked read`);
  }
  await pg.goto(`${APP}/notifications`);
  await chip(pg, 'orders').getByText('Porositë (1)').waitFor();   // only the account message is unread now
  await pg.context().close();
});

test('"Shëno të gjitha si të lexuara" clears every category; nothing is deleted', async () => {
  const before = (await notes()).length;
  const pg = await appPage();
  await pg.goto(`${APP}/notifications`);
  await v(pg, 'text=Shëno të gjitha si të lexuara').click();
  for (const [cat, label] of [['orders', 'Porositë'], ['offers', 'Ofertat'], ['new_products', 'Produktet e reja'], ['prices', 'Ndryshimet e çmimeve']]) {
    await chip(pg, cat).getByText(label, { exact: true }).waitFor();
  }
  await pg.waitForTimeout(500);
  const n = await notes();
  assert.equal(n.length, before, 'no notification deleted');
  assert.ok(n.every((x) => x.read_at), 'all read');
  // Opening a category directly (e.g. from a link): /notifications?cat=prices
  await pg.goto(`${APP}/notifications?cat=prices`);
  await v(pg, 'text=/Ulje çmimi/').waitFor();
  await pg.goto(`${APP}/notifications?cat=offers`);
  await v(pg, 'text=/Oferta e javës/').waitFor();
  await shot(pg, 'nc-03-all-read');
  await pg.context().close();
});

test('a notification with missing data never shows "undefined"', async () => {
  ok(await service.from('notifications').insert({ recipient_id: customer.id, type: 'promo_new_product', data: { product_id: product.id }, category: 'promo', dispatched_at: new Date().toISOString() }));
  const pg = await appPage();
  await pg.goto(`${APP}/notifications?cat=new_products`);
  await chip(pg, 'new_products').getByText('Produktet e reja (1)').waitFor();
  const body = await pg.locator('body').innerText();
  assert.doesNotMatch(body, /undefined|\{name\}/);
  await pg.context().close();
});

test('categories never change data: orders and customer untouched', async () => {
  const o = ok(await service.from('orders').select('total,status').eq('id', order.id).single());
  assert.equal(o.status, 'new');
  assert.equal(Number(o.total), Number(order.total));
  const p = ok(await service.from('profiles').select('role,wholesale_status').eq('id', customer.id).single());
  assert.deepEqual(p, { role: 'retail', wholesale_status: 'none' });
});
