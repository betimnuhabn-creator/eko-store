// Account deletion in the browser: PC panel (Klientët → Fshi klientin), the app
// screen (Expo web build of the Android screens: Llogaria → Fshi llogarinë time)
// and the public page delete-account.html. LOCAL stack only, test accounts only.
//   functions served with tests/functions.test.env; app exported to dist/
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { client, delivery, env, makeAdmin, ok, service, signUp, sql } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const WEB = 'http://localhost:8092/';
const APP = 'http://localhost:8093';
let servers = [], browser, admin, product;

before(async () => {
  execSync('npx vite build --outDir dist-del --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY, VITE_CONTACT_EMAIL: 'kontakt@eko.test' },
  });
  servers = [spawn('node', ['tests/serve.mjs', 'admin-web/dist-del', '8092'], { stdio: 'ignore' }), spawn('node', ['tests/serve.mjs', 'dist', '8093'], { stdio: 'ignore' })];
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();
  admin = await makeAdmin('dele-admin');
  product = ok(await service.from('products').select('id').eq('sku', 'HS-001').single());
});
after(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill());
  execSync('rm -rf admin-web/dist-del');
});

async function page(mobile = false) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 }, isMobile: mobile, hasTouch: mobile, locale: 'sq-AL' });
  const pg = await ctx.newPage();
  pg.on('dialog', (d) => d.accept());
  return pg;
}
const canLogin = async (email) => !(await client().auth.signInWithPassword({ email, password: 'secret123' })).error;
const inAuth = (id) => Number(sql(`select count(*) from auth.users where id='${id}'`));
async function withOrders(u, n) {
  for (let i = 0; i < n; i++) ok(await u.c.rpc('place_order', { p_lines: [{ product_id: product.id, quantity: 1 }], p_delivery: delivery }));
}
async function panelCustomers() {
  const pg = await page();
  await pg.goto(WEB);
  await pg.getByTestId('email').fill(admin.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login').click();
  await pg.getByTestId('logout').waitFor();
  await pg.goto(`${WEB}#/customers`);
  return pg;
}

test('panel: delete a customer WITH orders (warning, name, e-mail, count) and one WITHOUT orders', async () => {
  const withO = await signUp('dele-with', { full_name: 'Klient Me Porosi' });
  await withOrders(withO, 2);
  const without = await signUp('dele-without', { full_name: 'Klient Pa Porosi' });
  const pg = await panelCustomers();
  await pg.getByTestId(`customer-${withO.email}`).waitFor();
  assert.equal(await pg.getByTestId(`delete-${admin.email}`).count(), 0, 'no delete button for administrators (not listed)');

  await pg.getByTestId(`delete-${withO.email}`).click();
  await pg.getByTestId('del-info').waitFor();
  await pg.getByText('A jeni i sigurt që dëshironi ta fshini këtë klient?').waitFor();
  assert.equal(await pg.getByTestId('del-name').innerText(), 'Klient Me Porosi');
  assert.equal(await pg.getByTestId('del-email').innerText(), withO.email);
  assert.equal(await pg.getByTestId('del-orders').innerText(), '2');
  assert.match(await pg.getByTestId('del-orders-warning').innerText(), /2 porosi \(2 të hapura\).*NUK fshihen/s);
  // Wrong password: nothing happens.
  await pg.getByTestId('del-admin-password').fill('gabim-gabim');
  await pg.getByTestId('del-confirm').click();
  await pg.getByTestId('del-error').getByText('nuk është i saktë').waitFor();
  assert.equal(inAuth(withO.id), 1);
  // Cancel keeps the customer.
  await pg.getByTestId('del-cancel').click();
  assert.equal(inAuth(withO.id), 1);

  await pg.getByTestId(`delete-${withO.email}`).click();
  await pg.getByTestId('del-info').waitFor();
  await pg.getByTestId('del-admin-password').fill('secret123');
  await pg.getByTestId('del-confirm').click();
  await pg.getByText('Klienti u fshi. Porositë e tij u ruajtën.').waitFor();
  await pg.getByTestId(`customer-${withO.email}`).waitFor({ state: 'detached' });
  assert.equal(inAuth(withO.id), 0, 'gone from Supabase Authentication');
  assert.equal(Number(sql(`select count(*) from public.orders where delivery_name='${delivery.name}' and customer_id is null`)) >= 2, true, 'orders kept');

  await pg.getByTestId(`delete-${without.email}`).click();
  await pg.getByTestId('del-info').waitFor();
  assert.equal(await pg.getByTestId('del-orders').innerText(), '0');
  assert.equal(await pg.getByTestId('del-orders-warning').count(), 0);
  await pg.getByText('Ky klient nuk ka porosi.').waitFor();
  await pg.getByTestId('del-admin-password').fill('secret123');
  await pg.getByTestId('del-confirm').click();
  await pg.getByTestId(`customer-${without.email}`).waitFor({ state: 'detached' });
  assert.equal(inAuth(without.id), 0);
  assert.equal(await canLogin(without.email), false);
  assert.equal(await canLogin(withO.email), false);
  await pg.context().close();
});

test('app: Llogaria → Fshi llogarinë time (password, confirmation) → logged out, cannot log in again', async () => {
  const u = await signUp('dele-app');
  await withOrders(u, 1);
  const pg = await page(true);
  const dialogs = [];
  pg.on('dialog', (d) => dialogs.push(d.message()));
  await pg.goto(`${APP}/login`);
  await pg.getByTestId('email').fill(u.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login-submit').click();
  await pg.waitForURL((x) => !x.pathname.startsWith('/login'));
  await pg.goto(`${APP}/account`);
  await pg.getByTestId('delete-my-account').click();
  await pg.getByTestId('del-password').waitFor();
  await pg.getByText('Keni 1 porosi të hapura', { exact: false }).waitFor();
  await pg.getByText('Ruhen: porositë e kryera', { exact: false }).waitFor();
  // Wrong password.
  await pg.getByTestId('del-password').fill('gabim-gabim');
  await pg.getByTestId('del-submit').click();
  await pg.getByText('Fjalëkalimi nuk është i saktë.').waitFor();
  assert.equal(inAuth(u.id), 1);
  // Right password + confirmation dialog (accepted).
  await pg.getByTestId('del-password').fill('secret123');
  await pg.getByTestId('del-submit').click();
  for (let i = 0; i < 50 && !dialogs.includes('Llogaria u fshi.'); i++) await pg.waitForTimeout(200);
  assert.ok(dialogs.some((m) => m.includes('A jeni i sigurt? Llogaria do të fshihet përgjithmonë.')), 'final confirmation asked');
  assert.ok(dialogs.includes('Llogaria u fshi.'), `success message (${dialogs.join(' | ')})`);
  assert.equal(inAuth(u.id), 0, 'gone from Supabase Authentication');
  await pg.goto(`${APP}/account`);
  await pg.getByTestId('go-login').waitFor(); // logged out
  const stored = await pg.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('auth-token')).length);
  assert.equal(stored, 0, 'no session left in the app');
  await pg.goto(`${APP}/login`);
  await pg.getByTestId('email').fill(u.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login-submit').click();
  await pg.waitForTimeout(1500);
  assert.ok(pg.url().includes('/login'), 'login refused');
  await pg.context().close();
});

test('public page delete-account.html: deletion outside the app; administrators refused', async () => {
  const u = await signUp('dele-web');
  const pg = await page(true);
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.goto(`${WEB}delete-account.html`);
  await pg.getByRole('heading', { name: 'Fshirja e llogarisë EKO Store', level: 1 }).waitFor();
  // Without the confirmation box ticked: nothing happens.
  await pg.locator('#email').fill(u.email);
  await pg.locator('#password').fill('secret123');
  await pg.locator('#submit').click();
  await pg.locator('#error').getByText('Konfirmoni').waitFor();
  // Wrong password.
  await pg.locator('#agree').check();
  await pg.locator('#password').fill('gabim-gabim');
  await pg.locator('#submit').click();
  await pg.locator('#error').getByText('nuk është i saktë').waitFor();
  assert.equal(inAuth(u.id), 1);
  await pg.locator('#password').fill('secret123');
  await pg.locator('#submit').click();
  await pg.locator('#done').waitFor();
  assert.equal(inAuth(u.id), 0);
  assert.equal(await canLogin(u.email), false);
  // An administrator cannot delete themself here.
  await pg.reload();
  await pg.locator('#email').fill(admin.email);
  await pg.locator('#password').fill('secret123');
  await pg.locator('#agree').check();
  await pg.locator('#submit').click();
  await pg.locator('#error').getByText('administratorëve').waitFor();
  assert.ok(await canLogin(admin.email));
  assert.deepEqual(errors, []);
  await pg.context().close();
});
