// End-to-end test of the web app in a real browser against local Supabase.
//   npx supabase start && npx supabase db reset
//   npm run build:web:local && npm run test:e2e
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';

// Playwright is resolved like `require` so a globally installed copy also works.
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = 'http://localhost:8099';
const SHOTS = process.env.SHOTS_DIR;
const env = Object.fromEntries(
  execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').map((l) => l.match(/^(\w+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const service = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const run = Date.now();
const users = {
  admin: `admin.${run}@test.local`,
  retail: `blerina.${run}@test.local`,
  biz: `firma.${run}@test.local`,
};

let server, browser;

before(async () => {
  server = spawn('node', ['tests/serve.mjs', 'dist', '8099'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  browser = await chromium.launch();
  // Admin account (promotion is done in SQL, exactly like in production).
  const { data, error } = await service.auth.admin.createUser({
    email: users.admin, password: 'secret123', email_confirm: true, user_metadata: { full_name: 'EKO Admin' },
  });
  assert.ifError(error);
  await service.from('profiles').update({ role: 'admin' }).eq('id', data.user.id);
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function newPage(width = 420) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: 'sq-AL' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  return page;
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const byId = (page, id) => page.getByTestId(id);

async function register(page, { name, email, business }) {
  await page.goto(`${BASE}/register`);
  await byId(page, 'r-name').fill(name);
  await byId(page, 'r-phone').fill('+38344123456');
  await byId(page, 'r-email').fill(email);
  await byId(page, 'r-password').fill('secret123');
  if (business) {
    await page.getByRole('checkbox').click();
    await byId(page, 'r-business').fill(business);
  }
  await byId(page, 'register-submit').click();
  await page.waitForURL(`${BASE}/`);
}

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await byId(page, 'email').fill(email);
  await byId(page, 'password').fill('secret123');
  await byId(page, 'login-submit').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

test('guest browses the catalog without prices', async () => {
  const page = await newPage();
  await page.goto(BASE);
  await byId(page, 'product-HS-001').waitFor();
  assert.ok(await page.getByText('Rubinet lavamani krom').isVisible());
  assert.ok((await page.getByText('Hyni për të parë çmimet').count()) > 0);
  assert.equal(await page.getByText('34,90 €').count(), 0);
  await shot(page, '01-guest-catalog');
  // Language switch
  await page.getByLabel('language').first().click();
  await page.getByText('Chrome basin tap').waitFor();
  assert.ok((await page.getByText('Log in to see prices').count()) > 0);
  await page.context().close();
});

test('retail customer registers, sees retail prices and places an order', async () => {
  const page = await newPage();
  await register(page, { name: 'Blerina Krasniqi', email: users.retail });
  await page.getByText('34,90 €').first().waitFor();
  await shot(page, '02-retail-catalog');
  await byId(page, 'add-HS-001').click();
  await byId(page, 'add-HS-001').click();
  await byId(page, 'add-NG-001').click();
  await page.goto(`${BASE}/cart`);
  await byId(page, 'cart-total').waitFor();
  assert.equal(await byId(page, 'cart-total').innerText(), '81,30 €');
  await byId(page, 'go-checkout').click();
  await byId(page, 'd-address').fill('Rr. Agim Ramadani 10');
  await byId(page, 'd-city').fill('Prishtinë');
  await shot(page, '03-checkout');
  await byId(page, 'place-order').click();
  await page.waitForURL(/\/orders\/[0-9a-f-]+$/);
  await page.getByText('#1001').first().waitFor();
  await page.getByText('E re').first().waitFor();
  await shot(page, '04-order-placed');
  await page.context().close();
});

test('business registers and sees retail prices until approved', async () => {
  const page = await newPage();
  await register(page, { name: 'Arben Gashi', email: users.biz, business: 'Instalimi SHPK' });
  await page.getByText(/Kërkesa për shumicë është në pritje/).waitFor();
  await page.getByText('34,90 €').first().waitFor();
  await page.context().close();
});

test('admin: dashboard, approves wholesale, manages order, adds product with photo', async () => {
  const page = await newPage(1280);
  await login(page, users.admin);
  await page.goto(`${BASE}/admin`);
  await byId(page, 'stat-new_orders').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="stat-new_orders"]')?.textContent?.startsWith('1'));
  await shot(page, '05-admin-dashboard');

  // Notifications arrived for the admin
  await page.goto(`${BASE}/notifications`);
  await page.getByText('Porosi e re #1001').waitFor();
  await page.getByText(/Kërkesë e re për shumicë: Instalimi SHPK/).waitFor();
  await shot(page, '06-admin-notifications');

  // Approve wholesale
  await page.goto(`${BASE}/admin/customers?filter=pending`);
  await byId(page, `approve-${users.biz}`).click();
  await byId(page, `approve-${users.biz}`).waitFor({ state: 'detached' });
  await page.getByText('Të gjitha').first().click();
  await page.getByText('Klient shumice').first().waitFor();
  await shot(page, '07-admin-customers');

  // Order status
  await page.goto(`${BASE}/admin/orders`);
  await page.locator('text=/#1001/ >> visible=true').first().click();
  await page.locator('text=E konfirmuar >> visible=true').first().click();
  await byId(page, 'order-save').click();
  await page.waitForTimeout(500);
  await shot(page, '08-admin-order');

  // New product with uploaded photo
  await page.goto(`${BASE}/admin/products/new`);
  await byId(page, 'p-sku').fill(`BOJ-${run}`);
  await byId(page, 'p-name').fill('Bojler elektrik 80L');
  await byId(page, 'p-retail').fill('149,90');
  await byId(page, 'p-wholesale').fill('119');
  await byId(page, 'p-stock').fill('4');
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Shto foto').click();
  await (await chooser).setFiles('assets/icon.png');
  await page.locator('img[src*="product-images"]').first().waitFor({ timeout: 20000 });
  await shot(page, '09-admin-product-edit');
  await byId(page, 'p-save').click();
  await page.waitForURL(`${BASE}/admin/products`);
  await page.getByText('Bojler elektrik 80L').waitFor();
  await page.context().close();
});

test('approved wholesale customer sees wholesale prices; retail customer sees status notification', async () => {
  const page = await newPage();
  await login(page, users.biz);
  await page.goto(BASE);
  await page.getByText('Po shihni çmimet e shumicës').waitFor();
  await page.getByText('26,50 €').first().waitFor();
  await page.getByText('119,00 €').first().waitFor();
  assert.equal(await page.getByText('34,90 €').count(), 0);
  await shot(page, '10-wholesale-catalog');
  await page.context().close();

  const p2 = await newPage();
  await login(p2, users.retail);
  await p2.goto(`${BASE}/notifications`);
  await p2.getByText('Porosia #1001: E konfirmuar').waitFor();
  await p2.goto(`${BASE}/orders`);
  await p2.getByText('E konfirmuar').first().waitFor();
  await p2.context().close();
});

test('non-admin cannot open admin pages', async () => {
  const page = await newPage();
  await login(page, users.retail);
  await page.goto(`${BASE}/admin/products`);
  await page.getByText('Nuk keni qasje në këtë faqe.').waitFor();
  await page.context().close();
});
