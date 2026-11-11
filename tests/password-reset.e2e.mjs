// Password recovery + password change, end to end on the LOCAL stack:
//   * real Supabase Auth e-mails, caught by the local mail server (Mailpit)
//   * the e-mail link → Supabase verify → reset web page (admin-web/reset-password.html)
//   * the app's screens (Expo web build of the same code as the Android app):
//     forgot-password, reset-password (deep link ekostore://reset-password#…), change-password
//
//   npx supabase start (with Mailpit) && npx supabase db reset
//   EXPO_PUBLIC_PASSWORD_RESET_URL=http://localhost:8091/reset-password.html <expo web export for the local stack>
//   node --test --test-concurrency=1 tests/password-reset.e2e.mjs
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { client, delivery, env, ok, signUp } from './helpers.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const APP = 'http://localhost:8090';
const WEB = 'http://localhost:8091';
const MAIL = (env.MAILPIT_URL || env.INBUCKET_URL || 'http://127.0.0.1:54324').replace(/\/$/, '');
const SHOTS = process.env.SHOTS_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let servers = [], browser;

before(async () => {
  execSync('npx vite build --outDir dist-test --emptyOutDir', {
    cwd: 'admin-web', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: env.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY },
  });
  servers = [
    spawn('node', ['tests/serve.mjs', 'dist', '8090'], { stdio: 'ignore' }),
    spawn('node', ['tests/serve.mjs', 'admin-web/dist-test', '8091'], { stdio: 'ignore' }),
  ];
  await sleep(800);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  servers.forEach((s) => s.kill());
});

async function page({ mobile = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: mobile, hasTouch: mobile, locale: 'sq-AL' });
  const pg = await ctx.newPage();
  pg.alerts = [];
  pg.on('dialog', (d) => { pg.alerts.push(d.message()); d.accept(); });
  return pg;
}
const v = (pg, sel) => pg.locator(`${sel} >> visible=true`).first();
const tid = (pg, id) => v(pg, `[data-testid="${id}"]`);
const shot = (pg, n) => SHOTS && pg.screenshot({ path: `${SHOTS}/${n}.png` });

/** Waits for the newest Supabase e-mail to `to` (after `since`) and returns its recovery link. */
async function recoveryMail(to, since) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = (await res.json()).messages ?? [];
    const m = list.find((x) => new Date(x.Created).getTime() >= since - 1000);
    if (m) {
      const full = await (await fetch(`${MAIL}/api/v1/message/${m.ID}`)).json();
      const html = full.HTML || full.Text || '';
      const link = html.match(/https?:\/\/[^"'\s<>]+\/auth\/v1\/verify\?[^"'\s<>]+/)?.[0]?.replace(/&amp;/g, '&');
      return { subject: full.Subject, link, count: list.filter((x) => new Date(x.Created).getTime() >= since - 1000).length };
    }
    await sleep(500);
  }
  return null;
}
async function mailCount(to, since) {
  const list = (await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()).messages ?? [];
  return list.filter((x) => new Date(x.Created).getTime() >= since - 1000).length;
}
async function canLogin(email, password) {
  const { error } = await client().auth.signInWithPassword({ email, password });
  return !error;
}
async function appLogin(pg, email, password) {
  await pg.goto(`${APP}/login`);
  await pg.getByTestId('email').fill(email);
  await pg.getByTestId('password').fill(password);
  await pg.getByTestId('login-submit').click();
}
/** Opens the e-mail link like a phone browser would; returns the reset page and its URL fragment. */
async function openEmailLink(link) {
  const pg = await page();
  let fragment = null;
  pg.on('framenavigated', (f) => {
    if (f === pg.mainFrame() && f.url().includes('/reset-password.html#')) fragment = f.url().split('#')[1];
  });
  await pg.goto(link);
  await pg.waitForURL(/reset-password\.html/);
  return { pg, fragment };
}

test('1-2 forgot password in the app: format check, same answer for unknown e-mails, real e-mail with a working link', async () => {
  const u = await signUp('pr-forgot');
  const pg = await page();
  await pg.goto(`${APP}/login`);
  await tid(pg, 'forgot-link').click();
  await pg.waitForURL(/\/forgot-password$/);
  // format check (nothing sent)
  await tid(pg, 'fp-email').fill('jo-email');
  await tid(pg, 'fp-send').click();
  await v(pg, 'text=Shkruani një adresë email të vlefshme.').waitFor();
  // unknown address: same message, no e-mail
  const t0 = Date.now();
  await tid(pg, 'fp-email').fill(`nobody.${Date.now()}@test.local`);
  await tid(pg, 'fp-send').click();
  await v(pg, 'text=Nëse kjo adresë është e regjistruar, do të pranoni një email për rikuperimin e fjalëkalimit.').waitFor();
  await v(pg, 'text=/Dërgo përsëri pas \\d+ s/').waitFor();  // resend is throttled in the app
  await pg.reload();
  // registered address: same message + a real e-mail
  const t1 = Date.now();
  await tid(pg, 'fp-email').fill(u.email);
  await tid(pg, 'fp-send').click();
  await v(pg, 'text=Nëse kjo adresë është e regjistruar, do të pranoni një email për rikuperimin e fjalëkalimit.').waitFor();
  await shot(pg, 'pr-01-forgot-sent');
  const mail = await recoveryMail(u.email, t1);
  assert.ok(mail?.link, 'recovery e-mail received with a link');
  assert.match(mail.link, /type=recovery/);
  assert.match(decodeURIComponent(mail.link), /redirect_to=http:\/\/localhost:8091\/reset-password\.html/, 'link goes to the reset page');
  assert.equal(await mailCount(`nobody.${t0}@test.local`, t0), 0);
  await pg.context().close();
});

test('3-6 e-mail link → reset page → app (deep link) → new password; old password refused; link works once', async () => {
  const u = await signUp('pr-link');
  const since = Date.now();
  ok(await client().auth.resetPasswordForEmail(u.email, { redirectTo: `${WEB}/reset-password.html` }));
  const mail = await recoveryMail(u.email, since);

  // The phone opens the e-mail link: Supabase verifies it and shows the reset page.
  const { pg: web, fragment } = await openEmailLink(mail.link);
  await v(web, 'text=Vendosni fjalëkalimin e ri').waitFor();
  assert.ok(!web.url().includes('access_token'), 'tokens removed from the address bar');
  const appHref = await web.locator('#open-app').getAttribute('href');
  assert.match(appHref, /^ekostore:\/\/reset-password#access_token=.+&refresh_token=.+type=recovery/);
  assert.ok(fragment?.includes('access_token='));
  await shot(web, 'pr-02-web-page');
  await web.context().close();

  // "Hap në aplikacionin EKO Store": the app opens reset-password with the same fragment.
  const app = await page();
  await app.goto(`${APP}/reset-password#${appHref.split('#')[1]}`);
  await tid(app, 'pw-new').waitFor();
  await tid(app, 'pw-new').fill('abc');
  await tid(app, 'pw-confirm').fill('abc');
  await tid(app, 'reset-save').click();
  await v(app, 'text=Fjalëkalimi duhet të ketë të paktën 6 karaktere.').waitFor();
  await tid(app, 'pw-new').fill('NewSecret456');
  await tid(app, 'pw-confirm').fill('NewSecret457');
  await tid(app, 'reset-save').click();
  await v(app, 'text=Fjalëkalimet nuk përputhen.').waitFor();
  assert.equal(await app.getByTestId('pw-new').getAttribute('type'), 'password', 'hidden by default');
  await v(app, 'text=Shfaq fjalëkalimin').click();
  assert.notEqual(await app.getByTestId('pw-new').getAttribute('type'), 'password', 'show password works');
  await tid(app, 'pw-confirm').fill('NewSecret456');
  await shot(app, 'pr-03-app-new-password');
  await tid(app, 'reset-save').click();
  await app.waitForURL(/\/login\?reset=1$/);
  await v(app, 'text=Fjalëkalimi u ndryshua. Hyni me fjalëkalimin e ri.').waitFor();
  // Log in with the new password in the app
  await app.getByTestId('email').fill(u.email);
  await app.getByTestId('password').fill('NewSecret456');
  await app.getByTestId('login-submit').click();
  await app.waitForURL((x) => !x.pathname.startsWith('/login'));
  await app.context().close();
  assert.equal(await canLogin(u.email, 'NewSecret456'), true, 'new password works');
  assert.equal(await canLogin(u.email, 'secret123'), false, 'old password refused');
  // old password in the app UI: refused with a message
  const app2 = await page();
  await appLogin(app2, u.email, 'secret123');
  await app2.waitForTimeout(1500);
  assert.ok(app2.alerts.some((m) => m.includes('Email ose fjalëkalim i pasaktë.')), `old password refused in the app: ${JSON.stringify(app2.alerts)}`);
  assert.match(app2.url(), /\/login/);
  await app2.context().close();

  // The same e-mail link a second time: refused (single use).
  const again = await page();
  await again.goto(mail.link);
  await v(again, 'text=Lidhja nuk është më e vlefshme').waitFor();
  await again.context().close();
  // The tokens again in the app (session signed out after the reset): refused.
  const app3 = await page();
  await app3.goto(`${APP}/reset-password#${appHref.split('#')[1]}`);
  await tid(app3, 'reset-invalid').waitFor();
  await app3.context().close();
});

test('7 expired / invalid / incomplete links are refused in the app and on the web page', async () => {
  const app = await page();
  await app.goto(`${APP}/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
  await tid(app, 'reset-invalid').waitFor();
  await v(app, 'text=Lidhja ose kodi ka skaduar, është përdorur tashmë ose nuk është i vlefshëm. Kërkoni një të ri.').waitFor();
  await shot(app, 'pr-04-app-expired');
  await tid(app, 'reset-request-new').click();
  await app.waitForURL(/\/forgot-password$/);
  await app.goto(`${APP}/reset-password#access_token=forged.jwt.token&refresh_token=nope&type=recovery`);
  await tid(app, 'reset-invalid').waitFor();
  await app.goto(`${APP}/reset-password`);
  await tid(app, 'reset-invalid').waitFor();
  await app.context().close();

  const web = await page();
  await web.goto(`${WEB}/reset-password.html#error=access_denied&error_code=otp_expired`);
  await v(web, 'text=Lidhja nuk është më e vlefshme').waitFor();
  await web.goto(`${WEB}/reset-password.html#access_token=forged&refresh_token=x&type=recovery`);
  await v(web, 'text=Lidhja nuk është më e vlefshme').waitFor();
  await web.context().close();

  // An expired link from Supabase itself (verify with a wrong / old token)
  const bad = await page();
  await bad.goto(`${env.API_URL}/auth/v1/verify?token=000000000000000000000000000000000000000000000000&type=recovery&redirect_to=${encodeURIComponent(`${WEB}/reset-password.html`)}`);
  await v(bad, 'text=Lidhja nuk është më e vlefshme').waitFor();
  await bad.context().close();
});

test('web alternative: the new password can be set on the reset page itself', async () => {
  const u = await signUp('pr-web');
  const since = Date.now();
  ok(await client().auth.resetPasswordForEmail(u.email, { redirectTo: `${WEB}/reset-password.html` }));
  const { pg } = await openEmailLink((await recoveryMail(u.email, since)).link);
  await v(pg, 'text=Vendosni fjalëkalimin e ri').waitFor();
  await pg.fill('#pw1', 'WebSecret789');
  await pg.fill('#pw2', 'WebSecret788');
  await pg.click('#save');
  await v(pg, 'text=/Fjalëkalimet nuk përputhen/').waitFor();
  await pg.fill('#pw2', 'WebSecret789');
  await pg.click('#save');
  await v(pg, 'text=Fjalëkalimi u ndryshua').waitFor();
  await shot(pg, 'pr-05-web-done');
  await pg.context().close();
  assert.equal(await canLogin(u.email, 'WebSecret789'), true);
  assert.equal(await canLogin(u.email, 'secret123'), false);
});

test('6-digit code from the e-mail (alternative): reset in the app', async () => {
  const u = await signUp('pr-code');
  const { service } = await import('./helpers.mjs');
  const pg = await page();
  await pg.goto(`${APP}/forgot-password`);
  await tid(pg, 'fp-email').fill(u.email);
  await tid(pg, 'fp-send').click();
  await tid(pg, 'fp-have-code').click();
  // The e-mail template shows {{ .Token }}; here we take the same code from Supabase.
  const link = ok(await service.auth.admin.generateLink({ type: 'recovery', email: u.email }));
  await tid(pg, 'fp-code').fill('123456');
  await tid(pg, 'pw-new').fill('CodeSecret321');
  await tid(pg, 'pw-confirm').fill('CodeSecret321');
  await tid(pg, 'fp-code-save').click();
  await v(pg, 'text=/Lidhja ose kodi ka skaduar/').waitFor();   // wrong code refused
  await tid(pg, 'fp-code').fill(link.properties.email_otp);
  await tid(pg, 'fp-code-save').click();
  await pg.waitForURL(/\/login\?reset=1$/);
  await pg.context().close();
  assert.equal(await canLogin(u.email, 'CodeSecret321'), true);
  assert.equal(await canLogin(u.email, 'secret123'), false);
});

test('8 change password from the profile (re-authentication with the current password)', async () => {
  const u = await signUp('pr-change', { full_name: 'Klient Ndryshim', phone: '+38344111222' });
  const { service } = await import('./helpers.mjs');
  const before = ok(await service.from('profiles').select('full_name,phone,role,wholesale_status,city,address').eq('id', u.id).single());
  const pg = await page();
  await appLogin(pg, u.email, 'secret123');
  await pg.waitForURL((x) => !x.pathname.startsWith('/login'));
  await pg.goto(`${APP}/account`);
  await v(pg, 'text=Ndrysho fjalëkalimin').click();
  await pg.waitForURL(/\/change-password$/);
  await tid(pg, 'pw-current').fill('wrong-pass');
  await tid(pg, 'pw-new').fill('Changed654');
  await tid(pg, 'pw-confirm').fill('Changed654');
  await tid(pg, 'pw-change-save').click();
  await v(pg, 'text=Fjalëkalimi aktual nuk është i saktë.').waitFor();
  assert.equal(await canLogin(u.email, 'secret123'), true, 'nothing changed after a wrong current password');
  await tid(pg, 'pw-current').fill('secret123');
  await tid(pg, 'pw-confirm').fill('Changed65');
  await tid(pg, 'pw-change-save').click();
  await v(pg, 'text=Fjalëkalimet nuk përputhen.').waitFor();
  await tid(pg, 'pw-confirm').fill('Changed654');
  await tid(pg, 'pw-change-save').click();
  await v(pg, 'text=Fjalëkalimi u ndryshua me sukses.').waitFor();
  await shot(pg, 'pr-06-change-done');
  // still logged in, other data unchanged
  await pg.goto(`${APP}/account`);
  await v(pg, `text=${u.email}`).waitFor();
  await pg.context().close();
  assert.equal(await canLogin(u.email, 'Changed654'), true);
  assert.equal(await canLogin(u.email, 'secret123'), false);
  const afterP = ok(await service.from('profiles').select('full_name,phone,role,wholesale_status,city,address').eq('id', u.id).single());
  assert.deepEqual(afterP, before, 'profile data unchanged');
});

test('9 existing customers log in normally; orders unaffected', async () => {
  const u = await signUp('pr-normal');
  const { service, productBySku } = await import('./helpers.mjs');
  const p = await productBySku('HS-001');
  const o = ok(await u.c.rpc('place_order', { p_lines: [{ product_id: p.id, quantity: 1 }], p_delivery: delivery }));
  const pg = await page();
  await appLogin(pg, u.email, 'secret123');
  await pg.waitForURL((x) => !x.pathname.startsWith('/login'));
  await pg.goto(`${APP}/orders`);
  await v(pg, `text=/#${o.order_number}/`).waitFor();
  await pg.context().close();
  const row = ok(await service.from('orders').select('status,total').eq('id', o.id).single());
  assert.equal(row.status, 'new');
});
