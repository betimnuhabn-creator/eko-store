// Admin sets a customer's password: Edge Function `admin-set-password` + database.
// LOCAL stack only:
//   npx supabase start && npx supabase db reset
//   npx supabase functions serve --env-file tests/functions.test.env   (PASSWORD_ADMIN_EMAILS=eko-main-admin@test.local)
//   node --test --test-concurrency=1 tests/admin-password.test.mjs
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { KEY, MAIN_ADMIN, URL, client, mainAdmin, makeAdmin, ok, service, signUp, sql } from './helpers.mjs';

const FN = `${URL}/functions/v1/admin-set-password`;

async function call(token, body, method = 'POST') {
  const res = await fetch(FN, {
    method,
    headers: { apikey: KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const canLogin = async (email, password) => !(await client().auth.signInWithPassword({ email, password })).error;
const sessions = (id) => Number(sql(`select count(*) from auth.sessions where user_id='${id}'`));

let main, otherAdmin, customer, wholesale;
before(async () => {
  main = await mainAdmin();
  otherAdmin = await makeAdmin('ap-other-admin');
  customer = await signUp('ap-customer', { full_name: 'Klient Test', phone: '+38344123123' });
  wholesale = await signUp('ap-ws', { requested_wholesale: true, business_name: 'Shumica AP' });
});

describe('who may use it', () => {
  test('not logged in → 401; other methods → 405', async () => {
    assert.equal((await call(null, { action: 'check' })).status, 401);
    assert.equal((await call(main.token, null, 'GET')).status, 405);
  });

  test('customers and OTHER administrators are refused (check = false, set = 403)', async () => {
    for (const u of [customer, wholesale, otherAdmin]) {
      const chk = await call(u.token, { action: 'check' });
      assert.deepEqual([chk.status, chk.json.allowed], [200, false]);
      const set = await call(u.token, { action: 'set', user_id: customer.id, password: 'Hacked12345!', admin_password: 'secret123' });
      assert.equal(set.status, 403, JSON.stringify(set.json));
    }
    assert.equal(await canLogin(customer.email, 'secret123'), true, 'nothing changed');
  });

  test('the main administrator is allowed', async () => {
    const chk = await call(main.token, { action: 'check' });
    assert.deepEqual([chk.status, chk.json.allowed], [200, true]);
  });

  test('main administrator who lost the admin role is refused', async () => {
    ok(await service.from('profiles').update({ role: 'retail' }).eq('id', main.id));
    try {
      assert.equal((await call(main.token, { action: 'check' })).json.allowed, false);
      assert.equal((await call(main.token, { action: 'set', user_id: customer.id, password: 'Hacked12345!', admin_password: 'secret123' })).status, 403);
    } finally {
      ok(await service.from('profiles').update({ role: 'admin' }).eq('id', main.id));
    }
  });
});

describe('checks before changing anything', () => {
  test('re-authentication: a wrong administrator password is refused, nothing changes', async () => {
    const r = await call(main.token, { action: 'set', user_id: customer.id, password: 'NewTemp12345!', admin_password: 'wrong' });
    assert.deepEqual([r.status, r.json.error], [401, 'reauth_failed']);
    const r2 = await call(main.token, { action: 'set', user_id: customer.id, password: 'NewTemp12345!' });
    assert.equal(r2.status, 401);
    assert.equal(await canLogin(customer.email, 'secret123'), true);
  });

  test('administrators (others and oneself) cannot be targeted; bad input refused', async () => {
    for (const target of [otherAdmin.id, main.id]) {
      const r = await call(main.token, { action: 'set', user_id: target, password: 'NewTemp12345!', admin_password: 'secret123' });
      assert.deepEqual([r.status, r.json.error], [403, 'target_not_allowed']);
    }
    assert.equal(await canLogin(otherAdmin.email, 'secret123'), true, 'other admin password unchanged');
    assert.equal((await call(main.token, { action: 'set', user_id: 'not-a-uuid', password: 'NewTemp12345!', admin_password: 'secret123' })).status, 400);
    assert.equal((await call(main.token, { action: 'set', user_id: customer.id, password: 'short', admin_password: 'secret123' })).json.error, 'password_length');
    assert.equal((await call(main.token, { action: 'set', user_id: '00000000-0000-0000-0000-000000000000', password: 'NewTemp12345!', admin_password: 'secret123' })).status, 404);
  });
});

describe('setting the password', () => {
  test('success: new password works, old one does not, old sessions ended, audit without password, must change', async () => {
    const before = await client().auth.signInWithPassword({ email: customer.email, password: 'secret123' });
    const oldRefresh = before.data.session.refresh_token;
    const adminSessions = sessions(main.id);
    const r = await call(main.token, { action: 'set', user_id: customer.id, password: 'TempPass#2026', admin_password: 'secret123' });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    assert.ok(!r.text.includes('TempPass#2026'), 'password not echoed');

    assert.equal(await canLogin(customer.email, 'TempPass#2026'), true, 'new password works');
    assert.equal(await canLogin(customer.email, 'secret123'), false, 'old password refused');
    const refreshed = await client().auth.refreshSession({ refresh_token: oldRefresh });
    assert.ok(refreshed.error, 'old session can no longer be refreshed');
    assert.equal(sessions(main.id), adminSessions, 're-authentication session was closed again');

    const audit = JSON.parse(sql(`select coalesce(json_agg(a), '[]') from (select admin_id, admin_email, customer_id, customer_email, created_at is not null as has_time from public.password_reset_audit where customer_id='${customer.id}') a`));
    assert.deepEqual(audit, [{ admin_id: main.id, admin_email: MAIN_ADMIN, customer_id: customer.id, customer_email: customer.email, has_time: true }]);
    const cols = sql("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='password_reset_audit'");
    assert.equal(cols, 'id,admin_id,admin_email,customer_id,customer_email,created_at', 'no password column');
    assert.equal(sql("select count(*) from public.password_reset_audit a where a::text ilike '%TempPass%'"), '0');
    assert.equal(sql(`select must_change_password::text from public.profiles where id='${customer.id}'`), 'true');
  });

  test('the customer changes the temporary password → "must change" is cleared by the database', async () => {
    const c = client();
    ok(await c.auth.signInWithPassword({ email: customer.email, password: 'TempPass#2026' }));
    const p = ok(await c.from('profiles').select('must_change_password').eq('id', customer.id).single());
    assert.equal(p.must_change_password, true, 'the app can see it must ask for a new password');
    ok(await c.auth.updateUser({ password: 'MyOwnPass!77' }));
    assert.equal(sql(`select must_change_password::text from public.profiles where id='${customer.id}'`), 'false');
    assert.equal(await canLogin(customer.email, 'MyOwnPass!77'), true);
  });

  test('customers cannot read the audit, call the internal function or clear the flag themselves', async () => {
    const r = await call(main.token, { action: 'set', user_id: wholesale.id, password: 'TempWs#123456', admin_password: 'secret123' });
    assert.equal(r.status, 200);
    const c = client();
    ok(await c.auth.signInWithPassword({ email: wholesale.email, password: 'TempWs#123456' }));
    assert.ok((await c.from('password_reset_audit').select('*')).error);
    assert.ok((await c.rpc('record_admin_password_change', { p_admin: main.id, p_customer: wholesale.id })).error);
    assert.ok((await c.rpc('clear_must_change_password')).error);
    await c.from('profiles').update({ must_change_password: false }).eq('id', wholesale.id);
    await c.rpc('update_my_profile', { p: { must_change_password: false } });
    assert.equal(sql(`select must_change_password::text from public.profiles where id='${wholesale.id}'`), 'true');
    // wholesale status untouched by the password change
    assert.equal(sql(`select wholesale_status from public.profiles where id='${wholesale.id}'`), 'pending');
  });
});
