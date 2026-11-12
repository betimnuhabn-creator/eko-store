// Privacy Policy, Terms, account deletion page (published with the PC panel) and
// the links in the app (register consent, Account). LOCAL only.
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { env, signUp } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const WEB = 'http://localhost:8085';
const APP = 'http://localhost:8084';
let servers = [], browser;
before(async () => {
  execSync('npx vite build --outDir dist-legal --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY, VITE_CONTACT_EMAIL: 'kontakt@eko.test' },
  });
  servers = [spawn('node', ['tests/serve.mjs', 'admin-web/dist-legal', '8085'], { stdio: 'ignore' }), spawn('node', ['tests/serve.mjs', 'dist', '8084'], { stdio: 'ignore' })];
  await new Promise((r) => setTimeout(r, 800));
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill());
  execSync('rm -rf admin-web/dist-legal');
});

test('privacy, terms and account deletion pages: content, contact, links, no placeholders', async () => {
  const pg = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'sq-AL' });
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  for (const [path, title] of [['privacy.html', 'Politika e privatësisë'], ['terms.html', 'Kushtet e përdorimit'], ['delete-account.html', 'Fshirja e llogarisë EKO Store']]) {
    await pg.goto(`${WEB}/${path}`);
    await pg.getByRole('heading', { name: title, level: 1 }).waitFor();
    const body = await pg.locator('body').innerText();
    assert.ok(body.includes('kontakt@eko.test'), `${path}: contact`);
    assert.doesNotMatch(body, /%[A-Z_]+%|KONTAKTI-MUNGON/, `${path}: no placeholders`);
    assert.match(body, /Përditësuar më: \d{2}\.\d{2}\.\d{4}/);
  }
  await pg.goto(`${WEB}/privacy.html`);
  await pg.getByRole('link', { name: 'Fshirja e llogarisë' }).click();
  await pg.waitForURL(/delete-account\.html$/);
  await pg.getByText('Fshi llogarinë').first().waitFor();
  assert.deepEqual(errors, []);
  await pg.close();
});

test('app: consent on registration and links in Account', async () => {
  const pg = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'sq-AL' });
  await pg.goto(`${APP}/register`);
  await pg.getByTestId('link-terms').waitFor();
  await pg.getByTestId('link-privacy').waitFor();
  await pg.getByText('Duke u regjistruar pranoni', { exact: false }).waitFor();
  const u = await signUp('legal-user');
  await pg.goto(`${APP}/login`);
  await pg.getByTestId('email').fill(u.email);
  await pg.getByTestId('password').fill('secret123');
  await pg.getByTestId('login-submit').click();
  await pg.waitForURL((x) => !x.pathname.startsWith('/login'));
  await pg.goto(`${APP}/account`);
  await pg.getByText('Politika e privatësisë').first().waitFor();
  await pg.getByText('Kushtet e përdorimit').first().waitFor();
  await pg.getByText('Fshi llogarinë').first().waitFor();
  await pg.close();
});
