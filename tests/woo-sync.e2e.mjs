// Website sync in the browser: PC panel (Produktet → card, button, badges,
// orders switch) and the app (Expo web build of the Android screens).
// LOCAL only, fake WooCommerce on port 8099; functions served with tests/functions.test.env.
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { env, makeAdmin, ok, signUp, sql } from './helpers.mjs';
import { startWooMock } from './woo-mock.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const WEB = 'http://localhost:8096/';
const APP = 'http://localhost:8097';
let servers = [], browser, woo, admin, retail, wholesale;

before(async () => {
  execSync('npx vite build --outDir dist-woo --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY },
  });
  servers = [spawn('node', ['tests/serve.mjs', 'admin-web/dist-woo', '8096'], { stdio: 'ignore' }), spawn('node', ['tests/serve.mjs', 'dist', '8097'], { stdio: 'ignore' })];
  woo = await startWooMock(8099);
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();
  admin = await makeAdmin('woe-admin');
  retail = await signUp('woe-retail');
  wholesale = await signUp('woe-ws', { requested_wholesale: true, business_name: 'Shumica E2E' });
  ok(await admin.c.rpc('admin_review_wholesale', { p_user: wholesale.id, p_approve: true }));
});
after(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill());
  woo?.close();
  execSync('rm -rf admin-web/dist-woo');
});

async function page(mobile = false) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: mobile, hasTouch: mobile, locale: 'sq-AL' });
  const pg = await ctx.newPage();
  pg.on('dialog', (d) => d.accept());
  return pg;
}

test('panel: card, "Sinkronizo me faqen", badges, no-retail warning, edit note, orders switch', async () => {
  const pg = await page();
  await pg.goto(WEB);
  await pg.getByTestId('email').fill(admin.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login').click();
  await pg.getByTestId('logout').waitFor();
  await pg.goto(`${WEB}#/products`);
  await pg.getByTestId('woo-summary').getByText('Ende pa sinkronizim').waitFor();
  await pg.getByTestId('woo-sync').click();
  await pg.getByText('Sinkronizimi përfundoi: 7 të reja').waitFor();
  await pg.getByTestId('woo-summary').getByText('7 produkte nga faqja').waitFor();
  await pg.getByTestId('woo-no-retail').waitFor();
  await pg.getByTestId('row-35').getByText('Nga faqja').waitFor();
  assert.equal(await pg.getByTestId('row-HS-001').getByText('Nga faqja').count(), 0, 'app products are not marked');
  await pg.getByTestId('row-35').getByRole('link').click();
  await pg.getByTestId('woo-edit-note').waitFor();
  await pg.goto(`${WEB}#/products`);
  await pg.getByTestId('woo-orders').click();
  await pg.getByRole('dialog').getByText('WooCommerce → Orders', { exact: false }).waitFor();
  await pg.getByRole('dialog').locator('button.btn-primary').click();
  await pg.getByTestId('woo-orders-status').waitFor();
  assert.equal(sql('select orders_enabled::text from public.woo_settings'), 'true');
  await pg.context().close();
});

async function appLogin(pg, u) {
  await pg.goto(`${APP}/login`);
  await pg.getByTestId('email').fill(u.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login-submit').click();
  await pg.waitForURL((x) => !x.pathname.startsWith('/login'));
}
const pid = (wooId) => sql(`select id from public.products where woo_id=${wooId}`);

test('app: retail customer — "Çmimi sipas kërkesës" and no add-to-cart for a website product without retail price', async () => {
  const pg = await page(true);
  await appLogin(pg, retail);
  await pg.goto(`${APP}/product/${pid(2853)}`);
  await pg.getByText('Çmimi sipas kërkesës').first().waitFor();
  assert.equal(await pg.getByText('Hyni për të parë çmimet').count(), 0);
  assert.equal(await pg.getByTestId('add-to-cart').getAttribute('aria-disabled'), 'true', 'add to cart disabled');
  // a website product WITH a retail price can be bought normally
  await pg.goto(`${APP}/product/${pid(2795)}`);
  await pg.getByText('130,00 €').first().waitFor();
  await pg.context().close();
});

test('app: wholesale customer sees the wholesale price of the same product', async () => {
  const pg = await page(true);
  await appLogin(pg, wholesale);
  await pg.goto(`${APP}/product/${pid(2853)}`);
  await pg.getByText('117,00 €').first().waitFor();
  assert.equal(await pg.getByText('Çmimi sipas kërkesës').count(), 0);
  await pg.context().close();
});
