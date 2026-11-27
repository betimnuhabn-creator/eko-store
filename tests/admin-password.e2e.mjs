// PC panel → Klientët → Fjalëkalimi, then the customer in the app (Expo web
// build of the same screens as the Android app) is made to change the
// temporary password. LOCAL stack only (functions served with tests/functions.test.env).
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { client, env, mainAdmin, makeAdmin, signUp, sql } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const WEB = 'http://localhost:8088/';
const APP = 'http://localhost:8087';
const SHOTS = process.env.SHOTS_DIR;
let servers = [], browser, main, other, customer, tempPassword;

before(async () => {
  execSync('npx vite build --outDir dist-test --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY },
  });
  servers = [
    spawn('node', ['tests/serve.mjs', 'admin-web/dist-test', '8088'], { stdio: 'ignore' }),
    spawn('node', ['tests/serve.mjs', 'dist', '8087'], { stdio: 'ignore' }),
  ];
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();
  main = await mainAdmin();
  other = await makeAdmin('ape-other-admin');
  customer = await signUp('ape-customer', { full_name: 'Klient Panel' });
});
after(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill());
});

async function page({ mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 }, isMobile: mobile, hasTouch: mobile, locale: 'sq-AL', permissions: ['clipboard-read', 'clipboard-write'] });
  const pg = await ctx.newPage();
  pg.on('dialog', (d) => d.accept());
  return pg;
}
const shot = (pg, n) => SHOTS && pg.screenshot({ path: `${SHOTS}/${n}.png` });
async function webLogin(pg, email) {
  await pg.goto(WEB);
  await pg.getByTestId('email').fill(email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login').click();
  await pg.getByTestId('logout').waitFor();
}
const canLogin = async (email, password) => !(await client().auth.signInWithPassword({ email, password })).error;

test('another administrator does not see the "Fjalëkalimi" button', async () => {
  const pg = await page();
  await webLogin(pg, other.email);
  await pg.goto(`${WEB}#/customers`);
  await pg.getByTestId(`customer-${customer.email}`).waitFor();
  await pg.waitForTimeout(1500); // the server check has answered
  assert.equal(await pg.getByTestId(`password-${customer.email}`).count(), 0);
  await pg.context().close();
});

test('main administrator: generate, show/hide, re-authenticate, save, copy; nothing shown after closing', async () => {
  const pg = await page();
  await webLogin(pg, main.email);
  await pg.goto(`${WEB}#/customers`);
  await pg.getByTestId(`password-${customer.email}`).click();
  const modal = pg.getByTestId('password-modal');
  await modal.getByText('Klient Panel').waitFor();
  await modal.getByText(customer.email).waitFor();
  assert.equal(await pg.getByTestId('pwd-new').getAttribute('type'), 'password');
  await pg.getByTestId('pwd-generate').click();
  const generated = await pg.getByTestId('pwd-new').inputValue();
  assert.equal(generated.length, 14);
  assert.match(generated, /[A-Z]/); assert.match(generated, /[a-z]/); assert.match(generated, /[2-9]/); assert.match(generated, /[!@#$%&*?]/);
  assert.equal(await pg.getByTestId('pwd-new').getAttribute('type'), 'text', 'visible after generating');
  await pg.getByTestId('pwd-toggle').click();
  assert.equal(await pg.getByTestId('pwd-new').getAttribute('type'), 'password');
  // wrong administrator password
  await pg.getByTestId('pwd-admin').fill('wrong-password');
  await pg.getByTestId('pwd-save').click();
  await pg.getByTestId('pwd-error').getByText('Fjalëkalimi juaj i administratorit nuk është i saktë.').waitFor();
  assert.equal(await canLogin(customer.email, 'secret123'), true, 'unchanged');
  // correct
  await pg.getByTestId('pwd-admin').fill('secret123');
  await shot(pg, 'ap-01-modal');
  await pg.getByTestId('pwd-save').click();
  await pg.getByTestId('pwd-done').waitFor();
  assert.equal(await pg.getByTestId('pwd-result').inputValue(), generated, 'shown for copying');
  await pg.getByTestId('pwd-copy').click();
  await pg.getByText('U kopjua').waitFor();
  assert.equal(await pg.evaluate(() => navigator.clipboard.readText()), generated);
  await shot(pg, 'ap-02-done');
  await pg.getByTestId('pwd-close').click();
  // Reopen: empty — the temporary password is not shown again
  await pg.getByTestId(`password-${customer.email}`).click();
  assert.equal(await pg.getByTestId('pwd-new').inputValue(), '');
  assert.equal(await pg.locator('[data-testid="pwd-result"]').count(), 0);
  await pg.keyboard.press('Escape');
  await pg.context().close();
  assert.equal(await canLogin(customer.email, generated), true, 'customer can log in with the new password');
  assert.equal(await canLogin(customer.email, 'secret123'), false, 'old password refused');
  assert.equal(sql(`select count(*) from public.password_reset_audit where customer_id='${customer.id}' and admin_id='${main.id}'`), '1');
  tempPassword = generated;
});

test('the customer must change the temporary password after logging in (app)', async () => {
  const app = await page({ mobile: true });
  await app.goto(`${APP}/login`);
  await app.getByTestId('email').fill(customer.email);
  await app.getByTestId('password').fill(tempPassword);
  await app.getByTestId('login-submit').click();
  await app.waitForURL(/\/change-password/);
  await app.getByText('Administratori ju ka vendosur një fjalëkalim të përkohshëm.', { exact: false }).first().waitFor();
  await shot(app, 'ap-03-forced');
  // cannot go elsewhere before changing it
  await app.goto(`${APP}/account`);
  await app.waitForURL(/\/change-password/);
  await app.getByTestId('pw-current').fill(tempPassword);
  await app.getByTestId('pw-new').fill('MyNewPass2026');
  await app.getByTestId('pw-confirm').fill('MyNewPass2026');
  await app.getByTestId('pw-change-save').click();
  await app.getByText('Fjalëkalimi u ndryshua me sukses.').first().waitFor();
  // free to use the app again
  await app.goto(`${APP}/account`);
  await app.waitForURL(/\/account$/);
  await app.waitForTimeout(800);
  assert.match(app.url(), /\/account$/);
  await app.context().close();
  assert.equal(sql(`select must_change_password::text from public.profiles where id='${customer.id}'`), 'false');
  assert.equal(await canLogin(customer.email, 'MyNewPass2026'), true);
  assert.equal(await canLogin(customer.email, tempPassword), false);
});
