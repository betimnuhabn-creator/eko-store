// One account for the website and the app — against a REAL WordPress with the
// snippet docs/wordpress/eko-account-link.php (tests/wp-site.sh, port 8098)
// and the Edge Functions account-link + woo-sync. LOCAL only, test accounts only.
//   bash tests/wp-site.sh up
//   npx supabase db reset && npx supabase functions serve --env-file tests/functions.test.env
//   node --test --test-concurrency=1 tests/account-link.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, test } from 'node:test';
import { KEY, URL, client, makeAdmin, ok, service, signUp, sql } from './helpers.mjs';
import { startWooMock } from './woo-mock.mjs';

const FN = `${URL}/functions/v1/account-link`;
const SITE = 'http://localhost:8098';
const LINK = 'test_link_secret_0123456789';
let woo, admin;

/** PHP inside the test WordPress (wp-cli). */
function wp(...args) {
  return execFileSync('docker', ['run', '--rm', '--network', 'eko-wp', '--add-host', 'host.docker.internal:host-gateway', '--volumes-from', 'eko-wp', '--user', '33',
    '-e', 'WORDPRESS_DB_HOST=eko-wp-db', '-e', 'WORDPRESS_DB_USER=wp', '-e', 'WORDPRESS_DB_PASSWORD=wp', '-e', 'WORDPRESS_DB_NAME=wp',
    '-e', `WORDPRESS_CONFIG_EXTRA=define('EKO_LINK_SECRET','${LINK}'); define('EKO_LINK_URL','http://host.docker.internal:54321/functions/v1/account-link');`,
    'wordpress:cli-php8.3', 'wp', '--quiet', ...args], { encoding: 'utf8' }).trim();
}
const php = (code) => wp('eval', code);
/** Website login (the same check the login forms use). */
const siteLogin = (email, password) =>
  php(`$u = wp_authenticate(${JSON.stringify(email)}, ${JSON.stringify(password)}); echo is_wp_error($u) ? 'ERR' : 'OK:' . implode(',', $u->roles);`);
const siteUser = (email) => php(`$u = get_user_by('email', ${JSON.stringify(email)}); echo $u ? implode(',', $u->roles) . '|' . $u->first_name . ' ' . $u->last_name . '|' . get_user_meta($u->ID, 'billing_phone', true) : 'NONE';`);
function siteCreate(email, pw, role = 'customer', first = 'Arta', phone = '+38344000111') {
  wp('user', 'create', email.split('@')[0] + Math.floor(Math.random() * 1e6), email, `--user_pass=${pw}`, `--role=${role}`, `--first_name=${first}`, '--last_name=Web');
  php(`update_user_meta(get_user_by('email', ${JSON.stringify(email)})->ID, 'billing_phone', ${JSON.stringify(phone)});`);
}
const appLogin = async (email, password) => !(await client().auth.signInWithPassword({ email, password })).error;
async function link(email, password) {
  const res = await fetch(FN, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'app_login', email, password }) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
/** What the app does: normal login, and on "invalid credentials" the website link, then login again. */
async function appLoginWithLink(email, password) {
  if (await appLogin(email, password)) return true;
  return (await link(email, password)).json.ok === true && (await appLogin(email, password));
}
const tick = () => fetch(`${URL}/functions/v1/woo-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const uniq = (n) => `${n}.${Date.now()}${Math.floor(Math.random() * 1000)}@test.local`;

before(async () => {
  woo = await startWooMock(8099);
  admin = await makeAdmin('link-admin');
  assert.equal((await fetch(`${SITE}/wp-json/eko/v1/verify`, { method: 'POST' })).status, 401, 'test WordPress with the snippet is running');
});
after(() => woo?.close());

describe('website account → app', () => {
  test('wrong password: refused, nothing created; right password: app account created with name and phone', async () => {
    const email = uniq('web');
    siteCreate(email, 'WebPass123');
    assert.equal(await appLoginWithLink(email, 'wrong-pass'), false);
    assert.equal(sql(`select count(*) from auth.users where email='${email}'`), '0');
    assert.equal(await appLoginWithLink(email, 'WebPass123'), true, 'same e-mail + password works in the app');
    const p = ok(await service.from('profiles').select('full_name,phone,wholesale_status,role').eq('email', email).single());
    assert.deepEqual(p, { full_name: 'Arta Web', phone: '+38344000111', wholesale_status: 'none', role: 'retail' });
  });

  test('website "Wholesale Customer" → approved wholesale in the app', async () => {
    const email = uniq('webws');
    siteCreate(email, 'WebPass123', 'wholesale_customer');
    assert.equal(await appLoginWithLink(email, 'WebPass123'), true);
    const p = ok(await service.from('profiles').select('wholesale_status,role').eq('email', email).single());
    assert.deepEqual(p, { wholesale_status: 'approved', role: 'wholesale' });
  });

  test('password changed on the website → the app follows at the next login', async () => {
    const email = uniq('webpw');
    siteCreate(email, 'OldPass123');
    assert.equal(await appLoginWithLink(email, 'OldPass123'), true);
    php(`wp_set_password('NewPass456', get_user_by('email', ${JSON.stringify(email)})->ID);`);
    assert.equal(await appLoginWithLink(email, 'NewPass456'), true);
    assert.equal(await appLogin(email, 'OldPass123'), false, 'old password no longer works in the app');
  });
});

describe('app account → website', () => {
  test('first website login with the app password creates the WordPress user (customer)', async () => {
    const u = await signUp('appweb', { full_name: 'Blerim App', phone: '+38349111222' });
    assert.equal(siteUser(u.email), 'NONE');
    assert.equal(siteLogin(u.email, 'wrong-pass'), 'ERR');
    assert.equal(siteUser(u.email), 'NONE', 'wrong password: nothing created');
    assert.equal(siteLogin(u.email, 'secret123'), 'OK:customer');
    assert.equal(siteUser(u.email), 'customer|Blerim App|+38349111222');
    assert.equal(siteLogin(u.email, 'secret123'), 'OK:customer', 'next logins: WordPress itself');
  });

  test('approved wholesale in the app → "Wholesale Customer" on the website (new and existing users)', async () => {
    const u = await signUp('appws', { requested_wholesale: true, business_name: 'Biznes App' });
    ok(await admin.c.rpc('admin_review_wholesale', { p_user: u.id, p_approve: true }));
    assert.equal(siteLogin(u.email, 'secret123'), 'OK:wholesale_customer', 'created directly as wholesale');
    // revoked in the app → back to customer on the website (scheduler job)
    ok(await admin.c.rpc('admin_review_wholesale', { p_user: u.id, p_approve: false }));
    await tick();
    assert.equal(siteUser(u.email).split('|')[0], 'customer');
    ok(await admin.c.rpc('admin_review_wholesale', { p_user: u.id, p_approve: true }));
    await tick();
    assert.equal(siteUser(u.email).split('|')[0], 'wholesale_customer');
    assert.equal(sql(`select string_agg(status, ',') from public.link_jobs where email='${u.email}'`), 'sent,sent,sent', 'approve (no website account yet), revoke, approve');
  });

  test('password changed in the app → the website follows at the next login', async () => {
    const u = await signUp('apppw');
    assert.equal(siteLogin(u.email, 'secret123'), 'OK:customer');
    ok(await service.auth.admin.updateUserById(u.id, { password: 'Changed789' }));
    assert.equal(siteLogin(u.email, 'Changed789'), 'OK:customer');
    assert.equal(siteLogin(u.email, 'secret123'), 'ERR', 'old password no longer works on the website');
  });

  test('role "Wholesale Customer" given on the website → approved in the app (with notification); removed → revoked', async () => {
    const u = await signUp('roleweb');
    assert.equal(siteLogin(u.email, 'secret123'), 'OK:customer');
    php(`(new WP_User(get_user_by('email', ${JSON.stringify(u.email)})->ID))->set_role('wholesale_customer');`);
    assert.equal(ok(await service.from('profiles').select('wholesale_status').eq('id', u.id).single()).wholesale_status, 'approved');
    assert.equal(sql(`select count(*) from public.notifications where recipient_id='${u.id}' and type='wholesale_approved'`), '1');
    assert.equal(sql(`select count(*) from public.link_jobs where email='${u.email}'`), '0', 'a change from the website is not sent back');
    php(`(new WP_User(get_user_by('email', ${JSON.stringify(u.email)})->ID))->set_role('customer');`);
    assert.equal(ok(await service.from('profiles').select('wholesale_status').eq('id', u.id).single()).wholesale_status, 'none');
  });
});

describe('safety', () => {
  test('administrators are never linked, in either direction', async () => {
    assert.equal(siteLogin(admin.email, 'secret123'), 'ERR', 'app administrator: no website account created');
    assert.equal(siteUser(admin.email), 'NONE');
    assert.equal((await link('wpadmin@site.test', 'wpadminpass')).json.ok, false, 'website administrator: no app account');
    assert.equal(sql("select count(*) from auth.users where email='wpadmin@site.test'"), '0');
    // an app customer whose e-mail is a website administrator's: not touched
    const c = await signUp('clash');
    php(`$id = wp_create_user('clash' . rand(), 'AdminPass1', ${JSON.stringify(c.email)}); (new WP_User($id))->set_role('administrator');`);
    assert.equal((await link(c.email, 'AdminPass1')).json.ok, false);
    assert.equal(await appLogin(c.email, 'secret123'), true, 'app password unchanged');
  });

  test('website-only endpoints need the secret; the website endpoint too', async () => {
    const call = (body, secret) => fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-EKO-Link': secret } : {}) }, body: JSON.stringify(body) });
    assert.equal((await call({ action: 'wp_login', email: admin.email, password: 'secret123' })).status, 401);
    assert.equal((await call({ action: 'wholesale', email: admin.email, wholesale: true }, 'wrong-secret-wrong-secret')).status, 401);
    const v = await fetch(`${SITE}/wp-json/eko/v1/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EKO-Link': 'nope' }, body: '{"email":"a@b.c","password":"x"}' });
    assert.equal(v.status, 401);
    const r = await fetch(`${SITE}/wp-json/eko/v1/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"a@b.c","wholesale":true}' });
    assert.equal(r.status, 401);
  });

  test('at most 10 link logins per e-mail per 15 minutes', async () => {
    const email = uniq('rate');
    siteCreate(email, 'RatePass123');
    for (let i = 0; i < 10; i++) assert.equal((await link(email, `bad-${i}-pass`)).status, 200);
    assert.equal((await link(email, 'RatePass123')).status, 429, 'blocked even with the right password');
    assert.equal(sql(`select count(*) from auth.users where email='${email}'`), '0');
  });
});

describe('app login screen (Expo web build of the Android screens)', () => {
  test('a website-only customer logs into the app with the website e-mail and password', async () => {
    const { spawn } = await import('node:child_process');
    const { createRequire } = await import('node:module');
    const { chromium } = createRequire(import.meta.url)('playwright');
    const server = spawn('node', ['tests/serve.mjs', 'dist', '8094'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));
    const browser = await chromium.launch();
    try {
      const email = uniq('webui');
      siteCreate(email, 'WebUiPass123');
      const pg = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'sq-AL' });
      pg.on('dialog', (d) => d.accept());
      await pg.goto('http://localhost:8094/login');
      await pg.getByTestId('email').fill(email);
      await pg.getByTestId('password').fill('WebUiPass123');
      await pg.getByTestId('login-submit').click();
      await pg.waitForURL((x) => !x.pathname.startsWith('/login'), { timeout: 20000 });
      await pg.goto('http://localhost:8094/account');
      await pg.getByText(email).first().waitFor();
    } finally {
      await browser.close();
      server.kill();
    }
  });
});
