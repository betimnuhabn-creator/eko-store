// Cancel / archive / restore across BOTH admin interfaces, on one database:
//   * PC admin panel (admin-web, built for the local stack)
//   * Android admin screens (the Expo app's web build runs the same screen code)
// Phone-sized viewports are used for both.
//
//   PREMIGRATION=1 -> database WITHOUT the archive migration (production today):
//                     both interfaces must keep working, archive hidden, cancel works.
//
//   npx supabase db reset && npx expo export -p web && node --test --test-concurrency=1 tests/admin-sync.e2e.mjs
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { delivery, env, makeAdmin, ok, productBySku, service, signUp } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const PRE = process.env.PREMIGRATION === '1';
const WEB = 'http://localhost:8096/'; // admin-web
const APP = 'http://localhost:8095'; // Expo app (Android screens)
const SHOTS = process.env.SHOTS_DIR;
let servers = [], browser, admin, customer, p1;

before(async () => {
  execSync('npx vite build --outDir dist-test --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY },
  });
  servers = [
    spawn('node', ['tests/serve.mjs', 'admin-web/dist-test', '8096'], { stdio: 'ignore' }),
    spawn('node', ['tests/serve.mjs', 'dist', '8095'], { stdio: 'ignore' }),
  ];
  await new Promise((r) => setTimeout(r, 700));
  browser = await chromium.launch();
  admin = await makeAdmin('sync-admin');
  customer = await signUp('sync-customer');
  p1 = await productBySku('HS-001');
});
after(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill());
});

const newOrder = async () =>
  ok(await customer.c.rpc('place_order', { p_lines: [{ product_id: p1.id, quantity: 1 }], p_delivery: delivery }));
const dbOrder = async (id) => ok(await service.from('orders').select('*').eq('id', id).single());

async function phone(dialogs = 'accept') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'sq-AL' });
  const pg = await ctx.newPage();
  pg.dialogMode = dialogs;
  pg.dialogTexts = [];
  pg.on('dialog', (d) => {
    pg.dialogTexts.push(d.message());
    pg.dialogMode === 'dismiss' ? d.dismiss() : d.accept();
  });
  return pg;
}
async function webLogin(pg) {
  await pg.goto(WEB);
  await pg.getByTestId('email').fill(admin.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login').click();
  await pg.getByTestId('logout').waitFor();
}
async function appLogin(pg) {
  await pg.goto(`${APP}/login`);
  await pg.getByTestId('email').fill(admin.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login-submit').click();
  await pg.waitForURL((u) => !u.pathname.startsWith('/login'));
}
const shot = (pg, n) => SHOTS && pg.screenshot({ path: `${SHOTS}/${n}.png` });
const visible = (pg, sel) => pg.locator(`${sel} >> visible=true`).first();

if (!PRE) {
  test('Android admin: cancel (dismiss first), archive, archived screen, restore — confirmations shown', async () => {
    const o = await newOrder();
    const pg = await phone();
    await appLogin(pg);
    await pg.goto(`${APP}/admin/orders/${o.id}`);
    // dismissing the confirmation changes nothing
    pg.dialogMode = 'dismiss';
    await visible(pg, '[data-testid="admin-cancel"]').click();
    await pg.waitForTimeout(500);
    assert.equal((await dbOrder(o.id)).status, 'new');
    assert.match(pg.dialogTexts.at(-1), new RegExp(`#${o.order_number}`));
    pg.dialogMode = 'accept';
    await visible(pg, '[data-testid="admin-cancel"]').click();
    await visible(pg, '[data-testid="admin-archive"]').waitFor();
    assert.equal((await dbOrder(o.id)).status, 'cancelled');
    const n = ok(await customer.c.from('notifications').select('data').eq('type', 'order_status'));
    assert.ok(n.some((x) => x.data.order_id === o.id && x.data.status === 'cancelled'), 'customer notified');
    await shot(pg, 'sync-01-android-order-cancelled');
    await visible(pg, '[data-testid="admin-archive"]').click();
    await visible(pg, '[data-testid="admin-restore"]').waitFor();
    assert.ok((await dbOrder(o.id)).archived_at);
    // archived screen lists it; active list does not
    await pg.goto(`${APP}/admin/orders/archived`);
    await visible(pg, `[data-testid="archived-${o.order_number}"]`).waitFor();
    await shot(pg, 'sync-02-android-archive');
    await pg.goto(`${APP}/admin/orders`);
    await visible(pg, '[data-testid="open-archive"]').waitFor();
    assert.equal(await pg.locator(`text=#${o.order_number} ·`).count(), 0);
    // restore
    await pg.goto(`${APP}/admin/orders/archived`);
    await visible(pg, `[data-testid="restore-${o.order_number}"]`).click();
    await visible(pg, `[data-testid="archived-${o.order_number}"]`).waitFor({ state: 'detached' });
    assert.equal((await dbOrder(o.id)).archived_at, null);
    assert.equal((await dbOrder(o.id)).status, 'cancelled');
    await pg.context().close();
  });

  test('sync: archived on the PC panel -> visible and restorable on Android -> back on the PC list', async () => {
    const o = await newOrder();
    const n = o.order_number;
    const web = await phone();
    await webLogin(web);
    await web.goto(`${WEB}#/orders`);
    await web.getByTestId(`cancel-${n}`).click();
    await web.getByRole('dialog').getByRole('button', { name: 'Anulo porosinë' }).click();
    await web.getByTestId(`archive-${n}`).click();
    await web.getByRole('dialog').getByRole('button', { name: 'Arkivo' }).click();
    await web.getByTestId(`order-${n}`).waitFor({ state: 'detached' });
    await shot(web, 'sync-03-web-orders-phone');

    const app = await phone();
    await appLogin(app);
    await app.goto(`${APP}/admin/orders/archived`);
    await visible(app, `[data-testid="archived-${n}"]`).waitFor();
    await visible(app, `[data-testid="restore-${n}"]`).click();
    await visible(app, `[data-testid="archived-${n}"]`).waitFor({ state: 'detached' });

    await web.goto(`${WEB}#/archived-orders`);
    await web.getByText('Nuk ka porosi të arkivuara').or(web.locator('table')).first().waitFor();
    assert.equal(await web.getByTestId(`archived-${n}`).count(), 0);
    await web.goto(`${WEB}#/orders`);
    await web.getByTestId(`archive-${n}`).waitFor(); // back in the active list, still cancelled
    await shot(web, 'sync-04-web-restored');
    await web.context().close();
    await app.context().close();
  });

  test('customer still sees an archived order in their history (Android app)', async () => {
    const o = await newOrder();
    ok(await admin.c.rpc('admin_cancel_order', { p_order: o.id, p_note: null }));
    ok(await admin.c.rpc('admin_archive_order', { p_order: o.id }));
    const pg = await phone();
    await pg.goto(`${APP}/login`);
    await pg.getByTestId('email').fill(customer.email);
    await pg.getByTestId('password').fill('secret123');
    await pg.getByTestId('login-submit').click();
    await pg.waitForURL((u) => !u.pathname.startsWith('/login'));
    await pg.goto(`${APP}/orders`);
    await visible(pg, `text=#${o.order_number} ·`).waitFor();
    // and cannot reach the admin screens
    await pg.goto(`${APP}/admin/orders/archived`);
    await visible(pg, 'text=Nuk keni qasje në këtë faqe.').waitFor();
    await pg.context().close();
  });
} else {
  test('PRE-MIGRATION: both interfaces load orders; cancel works; archive is hidden', async () => {
    const supported = await admin.c.from('orders').select('archived_at').limit(1);
    assert.ok(supported.error, 'this run must use a database without the archive migration');
    const o1 = await newOrder();
    const o2 = await newOrder();
    // PC panel
    const web = await phone();
    await webLogin(web);
    await web.goto(`${WEB}#/orders`);
    await web.getByTestId(`order-${o1.order_number}`).waitFor();
    await web.getByTestId(`cancel-${o1.order_number}`).click();
    await web.getByRole('dialog').getByRole('button', { name: 'Anulo porosinë' }).click();
    await web.getByTestId(`cancel-${o1.order_number}`).waitFor({ state: 'detached' });
    assert.equal((await dbOrder(o1.id)).status, 'cancelled');
    assert.equal(await web.getByTestId(`archive-${o1.order_number}`).count(), 0, 'no archive without migration');
    await web.goto(`${WEB}#/archived-orders`);
    await web.getByText('Nuk ka porosi të arkivuara').waitFor();
    await web.goto(`${WEB}#/`);
    await web.getByTestId('tile-new_orders').waitFor();
    // Android admin
    const app = await phone();
    await appLogin(app);
    await app.goto(`${APP}/admin/orders`);
    await visible(app, `text=#${o2.order_number} ·`).waitFor();
    assert.equal(await app.locator('[data-testid="open-archive"]').count(), 0);
    await app.goto(`${APP}/admin/orders/${o2.id}`);
    await visible(app, '[data-testid="admin-cancel"]').click();
    await visible(app, '[data-testid="order-save"]').waitFor();
    await app.waitForTimeout(500);
    assert.equal((await dbOrder(o2.id)).status, 'cancelled');
    assert.equal(await app.locator('[data-testid="admin-archive"]').count(), 0);
    await web.context().close();
    await app.context().close();
  });
}
