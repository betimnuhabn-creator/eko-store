// Offers + promotional notifications end to end, on ONE local database:
//   * PC admin panel (admin-web build)
//   * customer app + Android admin screens (Expo web build, same screen code as the APK)
//
//   npx supabase db reset && <expo web export for the local stack> && node --test --test-concurrency=1 tests/offers.e2e.mjs
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { formatBelgrade } from '../lib/belgrade.ts';
import { env, makeAdmin, ok, productBySku, service, signUp, sql } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const WEB = 'http://localhost:8094/';
const APP = 'http://localhost:8093';
const SHOTS = process.env.SHOTS_DIR;
let servers = [], browser, admin, retail, whole, tester, hs1;

before(async () => {
  execSync('npx vite build --outDir dist-test --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY },
  });
  servers = [
    spawn('node', ['tests/serve.mjs', 'admin-web/dist-test', '8094'], { stdio: 'ignore' }),
    spawn('node', ['tests/serve.mjs', 'dist', '8093'], { stdio: 'ignore' }),
  ];
  await new Promise((r) => setTimeout(r, 700));
  browser = await chromium.launch();
  sql("select cron.alter_job(jobid, active := false) from cron.job where jobname like 'eko-%'");
  admin = await makeAdmin('e2e-offers-admin');
  retail = await signUp('e2e-offers-retail');
  whole = await signUp('e2e-offers-ws', { requested_wholesale: true, business_name: 'E2E Shumica' });
  ok(await admin.c.rpc('admin_review_wholesale', { p_user: whole.id, p_approve: true }));
  tester = await signUp('e2e-offers-tester');
  hs1 = await productBySku('HS-001'); // retail 34.90, wholesale 26.50
  // flush the seed's own "new product" events while notifications are off
  ok(await service.from('promo_events').update({ status: 'suppressed' }).eq('status', 'pending'));
});
after(async () => {
  sql("select cron.alter_job(jobid, active := true) from cron.job where jobname like 'eko-%'");
  await browser?.close();
  servers.forEach((s) => s.kill());
});

async function page({ width = 1280, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: mobile ? 390 : width, height: mobile ? 844 : 860 }, isMobile: mobile, hasTouch: mobile, locale: 'sq-AL' });
  const pg = await ctx.newPage();
  pg.on('dialog', (d) => d.accept());
  return pg;
}
const v = (pg, sel) => pg.locator(`${sel} >> visible=true`).first();
const shot = (pg, n) => SHOTS && pg.screenshot({ path: `${SHOTS}/${n}.png` });
async function webLogin(pg, email) {
  await pg.goto(WEB);
  await pg.getByTestId('email').fill(email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login').click();
  await pg.getByTestId('logout').waitFor();
}
async function appLogin(pg, email) {
  await pg.goto(`${APP}/login`);
  await pg.getByTestId('email').fill(email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login-submit').click();
  await pg.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test('PC admin creates an offer (Kosovo time), customers see it with the right prices', async () => {
  const pg = await page();
  await webLogin(pg, admin.email);
  await pg.goto(`${WEB}#/offers`);
  await pg.getByTestId('new-offer').click();
  await pg.getByTestId('o-title').fill('Javët e banjës');
  await pg.getByTestId('o-search').fill('HS-001');
  await pg.getByTestId('o-pick-HS-001').click();
  await pg.getByTestId('o-price-HS-001').fill('29,90');
  await shot(pg, 'of-01-pc-offer-editor');
  await pg.getByTestId('offer-save').click();
  await pg.getByText('Aktive tani').first().waitFor();
  const { data: offers } = await service.from('offers').select('id,starts_at,ends_at').eq('title_sq', 'Javët e banjës');
  assert.equal(offers.length, 1);
  const startMs = new Date(offers[0].starts_at).getTime();
  assert.ok(Math.abs(startMs - Date.now()) < 3 * 60_000, 'start = now in Kosovo time, stored as UTC');
  await pg.context().close();

  // retail customer: banner + Offers tab + cart/checkout at the offer price
  const app = await page({ mobile: true });
  await appLogin(app, retail.email);
  await app.goto(APP);
  await v(app, '[data-testid="offers-banner"]').waitFor();
  await shot(app, 'of-02-home-banner');
  await v(app, '[data-testid="offers-banner"]').click();
  await v(app, '[data-testid="offer-price-HS-001"]').waitFor();
  assert.equal(await v(app, '[data-testid="offer-price-HS-001"]').innerText(), '29,90 €');
  assert.ok(await v(app, 'text=-14%').isVisible());
  assert.ok(await v(app, 'text=34,90 €').isVisible(), 'regular price struck through');
  await shot(app, 'of-03-offers-tab');
  await v(app, '[data-testid="offer-add-HS-001"]').click();
  await app.goto(`${APP}/cart`);
  await v(app, '[data-testid="cart-total"]').waitFor();
  assert.equal(await v(app, '[data-testid="cart-total"]').innerText(), '29,90 €');
  await v(app, '[data-testid="go-checkout"]').click();
  await v(app, '[data-testid="d-address"]').fill('Rr. 1');
  await v(app, '[data-testid="d-city"]').fill('Prishtinë');
  await v(app, '[data-testid="place-order"]').click();
  await app.waitForURL(/\/orders\//);
  const orderId = app.url().split('/').pop();
  const line = ok(await service.from('order_items').select('unit_price,offer_id').eq('order_id', orderId).single());
  assert.equal(Number(line.unit_price), 29.9, 'server charged the offer price');
  assert.equal(line.offer_id, offers[0].id);
  await app.context().close();

  // wholesale customer: their 26,50 is already lower -> no offer shown for them
  const ws = await page({ mobile: true });
  await appLogin(ws, whole.email);
  await ws.goto(`${APP}/offers`);
  await v(ws, 'text=Nuk ka oferta aktive tani').waitFor();
  assert.equal(await ws.locator('text=29,90 €').count(), 0);
  await ws.context().close();

  // guest: sees the offer, no prices
  const g = await page({ mobile: true });
  await g.goto(`${APP}/offers`);
  await v(g, 'text=Javët e banjës').waitFor();
  assert.equal(await g.locator('text=29,90 €').count(), 0);
  await g.context().close();
});

test('Android admin: create a scheduled offer, it starts on time; deactivate and cancel', async () => {
  const pg = await page({ mobile: true });
  await appLogin(pg, admin.email);
  await pg.goto(`${APP}/admin/offers/new`);
  await v(pg, '[data-testid="o-title"]').fill('Ngrohje dimri');
  const fmt = (ms) => formatBelgrade(ms);
  // starts at the next full minute (Kosovo time), ends in 2 days
  const startMs = Math.ceil((Date.now() + 5000) / 60000) * 60000;
  await v(pg, '[data-testid="o-start"]').fill(fmt(startMs));
  await v(pg, '[data-testid="o-end"]').fill(fmt(Date.now() + 2 * 86400_000));
  const ng = await productBySku('NG-001');
  await v(pg, '[data-testid="o-search"]').fill('NG-001');
  await v(pg, '[data-testid="o-pick-NG-001"]').click();
  await v(pg, '[data-testid="o-price-NG-001"]').fill('9,90');
  await v(pg, '[data-testid="o-save"]').click();
  await pg.waitForURL((u) => u.pathname === '/admin/offers');
  await v(pg, '[data-testid="admin-offer-Ngrohje dimri"]').waitFor();
  await v(pg, 'text=E planifikuar').waitFor();
  await shot(pg, 'of-04-android-offers');
  const { data } = await service.from('offers').select('id,starts_at').eq('title_sq', 'Ngrohje dimri').single();
  assert.equal(new Date(data.starts_at).getTime(), startMs, 'Kosovo time converted exactly');

  const price = async () => Number(ok(await retail.c.rpc('list_products')).find((p) => p.id === ng.id).price);
  assert.equal(await price(), 11.5, 'not started yet');
  await new Promise((r) => setTimeout(r, Math.max(0, startMs - Date.now()) + 1500));
  assert.equal(await price(), 9.9, 'started automatically');

  await pg.goto(`${APP}/admin/offers/${data.id}`);
  await v(pg, '[data-testid="offer-toggle"]').click();
  await v(pg, 'text=Joaktive').waitFor();
  assert.equal(await price(), 11.5, 'deactivated -> regular price');
  await v(pg, '[data-testid="offer-cancel"]').click();
  await v(pg, 'text=E anuluar').waitFor();
  await pg.context().close();
});

test('Promotions: PC settings in test mode, tester flag, price drop reaches only the tester; tap opens the product', async () => {
  // tester and a real customer opt in (tokens added directly: the web build has no push)
  for (const u of [tester, retail]) {
    ok(await u.c.rpc('set_my_promo_preferences', { p_new_products: true, p_offers: true, p_price_changes: true }));
    ok(await u.c.rpc('register_push_token', { p_token: `ExponentPushToken[e2e-${u.id.slice(0, 6)}]`, p_platform: 'android' }));
  }
  const pg = await page();
  await webLogin(pg, admin.email);
  await pg.goto(`${WEB}#/customers`);
  await pg.getByTestId(`tester-${tester.email}`).click();
  await pg.waitForTimeout(500);
  assert.equal(ok(await service.from('profiles').select('promo_tester').eq('id', tester.id).single()).promo_tester, true);
  await pg.goto(`${WEB}#/promo`);
  await pg.getByTestId('promo-mode').getByText('Njoftimet promocionale janë të fikura').waitFor();
  await pg.getByTestId('promo-enabled').click();
  await pg.getByTestId('promo-mode').getByText('Modaliteti test').waitFor();
  ok(await admin.c.rpc('admin_set_promo_settings', { p: { debounce_minutes: 0 } }));
  await shot(pg, 'of-05-pc-promo-settings');

  // price drop from the PC product table (quick edit)
  const hs2 = await productBySku('HS-002');
  await pg.goto(`${WEB}#/products`);
  const row = pg.getByTestId('row-HS-002');
  await row.waitFor();
  await row.getByLabel('HS-002 Pakicë').fill('2,90');
  await pg.getByTestId('save-all').click();
  await pg.getByTestId('save-all').waitFor({ state: 'detached' });
  ok(await service.rpc('promo_fanout', { p_limit: 50 }));
  const forTester = ok(await service.from('notifications').select('type,data').eq('recipient_id', tester.id).eq('category', 'promo'));
  const drop = forTester.find((n) => n.type === 'promo_price_down' && n.data.product_id === hs2.id);
  assert.ok(drop, 'tester notified');
  assert.deepEqual([Number(drop.data.old), Number(drop.data.new)], [3.2, 2.9]);
  const forReal = ok(await service.from('notifications').select('id').eq('recipient_id', retail.id).eq('category', 'promo'));
  assert.equal(forReal.length, 0, 'real customer NOT notified in test mode');
  await pg.context().close();

  // tester sees it under "Ofertat" in notifications, tap opens the product
  const app = await page({ mobile: true });
  await appLogin(app, tester.email);
  await app.goto(`${APP}/notifications`);
  await v(app, 'text=Ofertat (').click();
  await v(app, 'text=Ulje çmimi: Tub PPR 20mm nga 3,20 € tani 2,90 €').click();
  await app.waitForURL(new RegExp(`/product/${hs2.id}$`));
  await shot(app, 'of-06-notification-opens-product');
  await app.context().close();
});

test('customer can opt in from the Offers tab and set preferences in Account', async () => {
  const u = await signUp('e2e-optin');
  const app = await page({ mobile: true });
  await appLogin(app, u.email);
  await app.goto(`${APP}/offers`);
  await v(app, '[data-testid="promo-ask-yes"]').click();
  await app.waitForTimeout(800);
  let p = ok(await service.from('profiles').select('promo_new_products,promo_offers,promo_price_changes').eq('id', u.id).single());
  assert.deepEqual(p, { promo_new_products: true, promo_offers: true, promo_price_changes: true });
  await app.goto(`${APP}/account`);
  await v(app, '[data-testid="promo-prefs"]').waitFor();
  await v(app, 'text=Ndryshime çmimesh').click();
  await app.waitForTimeout(800);
  p = ok(await service.from('profiles').select('promo_price_changes').eq('id', u.id).single());
  assert.equal(p.promo_price_changes, false);
  await shot(app, 'of-07-account-prefs');
  await app.context().close();
});
