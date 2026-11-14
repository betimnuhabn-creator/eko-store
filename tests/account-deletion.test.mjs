// Customer account deletion: Edge Function `delete-account` + database.
// LOCAL stack only (test accounts created here; no real customer is touched):
//   npx supabase db reset
//   npx supabase functions serve --env-file tests/functions.test.env
//   node --test --test-concurrency=1 tests/account-deletion.test.mjs
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { KEY, URL, client, delivery, denied, makeAdmin, ok, service, signUp, sql } from './helpers.mjs';

const FN = `${URL}/functions/v1/delete-account`;
async function call(token, body, method = 'POST') {
  const res = await fetch(FN, {
    method,
    headers: { apikey: KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const canLogin = async (email) => !(await client().auth.signInWithPassword({ email, password: 'secret123' })).error;
const authUserExists = async (id) => !(await service.auth.admin.getUserById(id)).error;
const count = (q) => Number(sql(q));

let admin, admin2, product;
before(async () => {
  admin = await makeAdmin('del-admin');
  admin2 = await makeAdmin('del-admin2');
  product = ok(await service.from('products').select('id,retail_price').eq('sku', 'HS-001').single());
});

/** A test customer with `n` orders (the first `open` stay open, the rest delivered), a push token and a notification. */
async function customerWith(name, n = 0, open = 0) {
  const u = await signUp(name, { full_name: `Klient ${name}`, phone: '+38344999888' });
  ok(await u.c.rpc('register_push_token', { p_token: `ExponentPushToken[${name}-${Date.now()}]`, p_platform: 'android' }));
  const orders = [];
  for (let i = 0; i < n; i++) {
    const o = ok(await u.c.rpc('place_order', { p_lines: [{ product_id: product.id, quantity: 1 }], p_delivery: delivery }));
    if (i >= open) sql(`update public.orders set status='delivered' where id='${o.id}'`);
    orders.push(o.id);
  }
  ok(await service.from('notifications').insert({ recipient_id: u.id, type: 'order_status', data: {} }));
  return { ...u, orders };
}

function assertGone(u) {
  assert.equal(count(`select count(*) from auth.users where id='${u.id}'`), 0, 'Auth account deleted');
  assert.equal(count(`select count(*) from auth.sessions where user_id='${u.id}'`), 0, 'sessions deleted');
  assert.equal(count(`select count(*) from auth.refresh_tokens where user_id='${u.id}'`), 0, 'refresh tokens deleted');
  assert.equal(count(`select count(*) from public.profiles where id='${u.id}'`), 0, 'profile (personal data) deleted');
  assert.equal(count(`select count(*) from public.push_tokens where user_id='${u.id}'`), 0, 'push tokens deleted');
  assert.equal(count(`select count(*) from public.notifications where recipient_id='${u.id}'`), 0, 'notifications deleted');
}
function assertOrdersKept(u) {
  for (const id of u.orders) {
    const r = sql(`select coalesce(customer_id::text,'null')||'|'||delivery_name||'|'||total||'|'||(select count(*) from public.order_items where order_id=o.id) from public.orders o where id='${id}'`);
    assert.match(r, new RegExp(`^null\\|${delivery.name}\\|${Number(product.retail_price).toFixed(2)}\\|1$`), 'order kept for accounting, unlinked');
  }
}

describe('who may delete what', () => {
  test('not logged in → 401; GET → 405; unknown action → 400', async () => {
    assert.equal((await call(null, { action: 'self', password: 'secret123' })).status, 401);
    const c = await signUp('del-x');
    assert.equal((await call(c.token, null, 'GET')).status, 405);
    assert.equal((await call(c.token, { action: 'nope' })).status, 400);
  });

  test('a customer cannot preview or delete another customer, nor call the database function', async () => {
    const a = await signUp('del-a');
    const b = await signUp('del-b');
    assert.deepEqual(await call(a.token, { action: 'preview', user_id: b.id }), { status: 403, json: { error: 'not_allowed' } });
    assert.deepEqual(await call(a.token, { action: 'admin_delete', user_id: b.id, admin_password: 'secret123' }), { status: 403, json: { error: 'not_allowed' } });
    await denied(a.c.rpc('delete_customer_account', { p_user: b.id, p_actor: a.id }));
    await denied(client().rpc('delete_customer_account', { p_user: b.id, p_actor: b.id }));
    assert.ok(await authUserExists(b.id) && await canLogin(b.email), 'b untouched');
  });

  test('administrators cannot be deleted: not by another admin, not themselves, not from the app', async () => {
    assert.deepEqual(await call(admin.token, { action: 'preview', user_id: admin2.id }), { status: 403, json: { error: 'target_not_allowed' } });
    assert.deepEqual(await call(admin.token, { action: 'admin_delete', user_id: admin2.id, admin_password: 'secret123' }), { status: 403, json: { error: 'target_not_allowed' } });
    assert.deepEqual(await call(admin.token, { action: 'admin_delete', user_id: admin.id, admin_password: 'secret123' }), { status: 403, json: { error: 'target_not_allowed' } });
    assert.deepEqual(await call(admin.token, { action: 'self', password: 'secret123' }), { status: 403, json: { error: 'admin_cannot_delete' } });
    await denied(admin.c.rpc('delete_my_account'), /ADMIN_CANNOT_DELETE/);
    assert.ok(await canLogin(admin.email) && await canLogin(admin2.email));
  });
});

describe('the customer deletes their own account', () => {
  test('wrong password → refused, nothing deleted', async () => {
    const u = await customerWith('del-self-wrong', 1, 1);
    assert.deepEqual(await call(u.token, { action: 'self', password: 'wrong-pass' }), { status: 401, json: { error: 'reauth_failed' } });
    assert.deepEqual(await call(u.token, { action: 'self' }), { status: 401, json: { error: 'reauth_failed' } });
    assert.ok(await authUserExists(u.id) && await canLogin(u.email));
  });

  test('WITHOUT orders: everything deleted, cannot log in again, not among the customers', async () => {
    const u = await customerWith('del-self-0');
    const r = await call(u.token, { action: 'self', password: 'secret123' });
    assert.deepEqual(r, { status: 200, json: { ok: true, orders_kept: 0, open_orders: 0 } });
    assert.equal(await authUserExists(u.id), false, 'not in Supabase Authentication');
    assertGone(u);
    assert.equal(await canLogin(u.email), false, 'cannot log in');
    const list = ok(await admin.c.from('profiles').select('id').neq('role', 'admin'));
    assert.ok(!list.some((p) => p.id === u.id), 'not in the panel customer list');
    assert.equal(sql(`select via||'|'||coalesce(admin_id::text,'-')||'|'||orders_kept from public.account_deletion_audit where deleted_user_id='${u.id}'`), 'self|-|0');
    // The old access token is useless now.
    assert.equal((await call(u.token, { action: 'self', password: 'secret123' })).status, 401);
    await denied(u.c.rpc('place_order', { p_lines: [{ product_id: product.id, quantity: 1 }], p_delivery: delivery }));
    // Signing up again with the same e-mail is a brand-new, empty account.
    const again = await client().auth.signUp({ email: u.email, password: 'secret123' });
    assert.ifError(again.error);
    assert.notEqual(again.data.user.id, u.id);
  });

  test('WITH orders: orders and lines kept (unlinked) for accounting, the rest deleted', async () => {
    const u = await customerWith('del-self-2', 3, 1);
    const r = await call(u.token, { action: 'self', password: 'secret123' });
    assert.deepEqual(r, { status: 200, json: { ok: true, orders_kept: 3, open_orders: 1 } });
    assertGone(u);
    assertOrdersKept(u);
    assert.equal(await canLogin(u.email), false);
    const audit = sql(`select row_to_json(a)::text from public.account_deletion_audit a where deleted_user_id='${u.id}'`);
    assert.match(audit, /"via":"self".*"orders_kept":3,"open_orders":1/);
    assert.ok(!audit.includes(u.email) && !audit.includes('999888'), 'no personal data in the audit');
  });

  test('older apps (≤ 1.3.0) using delete_my_account still work and are recorded', async () => {
    const u = await customerWith('del-old-app', 1, 0);
    ok(await u.c.rpc('delete_my_account'));
    assertGone(u);
    assertOrdersKept(u);
    assert.equal(sql(`select via from public.account_deletion_audit where deleted_user_id='${u.id}'`), 'self');
  });
});

describe('the administrator deletes a customer', () => {
  test('preview shows name, e-mail and orders as the server sees them', async () => {
    const u = await customerWith('del-prev', 2, 1);
    const r = await call(admin.token, { action: 'preview', user_id: u.id });
    assert.deepEqual(r, { status: 200, json: { name: 'Klient del-prev', business_name: '', email: u.email, orders: 2, open_orders: 1 } });
    assert.deepEqual(await call(admin.token, { action: 'preview', user_id: '00000000-0000-0000-0000-000000000000' }), { status: 404, json: { error: 'not_found' } });
    assert.equal((await call(admin.token, { action: 'preview', user_id: 'not-a-uuid' })).status, 400);
  });

  test('wrong administrator password → refused, nothing deleted', async () => {
    const u = await customerWith('del-adm-wrong', 1, 0);
    assert.deepEqual(await call(admin.token, { action: 'admin_delete', user_id: u.id, admin_password: 'nope-nope' }), { status: 401, json: { error: 'reauth_failed' } });
    assert.ok(await authUserExists(u.id) && await canLogin(u.email));
  });

  test('customer WITHOUT orders', async () => {
    const u = await customerWith('del-adm-0');
    const r = await call(admin.token, { action: 'admin_delete', user_id: u.id, admin_password: 'secret123' });
    assert.deepEqual(r, { status: 200, json: { ok: true, orders_kept: 0, open_orders: 0 } });
    assertGone(u);
    assert.equal(await canLogin(u.email), false);
    assert.equal(sql(`select via||'|'||admin_id from public.account_deletion_audit where deleted_user_id='${u.id}'`), `admin|${admin.id}`);
    assert.deepEqual(await call(admin.token, { action: 'admin_delete', user_id: u.id, admin_password: 'secret123' }), { status: 404, json: { error: 'not_found' } });
  });

  test('customer WITH orders (and a password-change audit row): orders kept, e-mail removed from the audit', async () => {
    const u = await customerWith('del-adm-2', 2, 2);
    sql(`insert into public.password_reset_audit (admin_id, admin_email, customer_id, customer_email) values ('${admin.id}','${admin.email}','${u.id}','${u.email}')`);
    const r = await call(admin.token, { action: 'admin_delete', user_id: u.id, admin_password: 'secret123' });
    assert.deepEqual(r, { status: 200, json: { ok: true, orders_kept: 2, open_orders: 2 } });
    assertGone(u);
    assertOrdersKept(u);
    assert.equal(sql(`select customer_email from public.password_reset_audit where customer_id='${u.id}'`), '');
    // The panel still opens the kept orders without errors.
    const kept = ok(await admin.c.from('orders').select('id,customer_id,delivery_name').in('id', u.orders));
    assert.equal(kept.length, 2);
    assert.ok(kept.every((o) => o.customer_id === null && o.delivery_name === delivery.name));
  });
});

describe('database', () => {
  test('audit table and function are not reachable through the API', async () => {
    const c = await signUp('del-api');
    await denied(c.c.from('account_deletion_audit').select('*'));
    await denied(admin.c.from('account_deletion_audit').select('*'));
    await denied(admin.c.rpc('delete_customer_account', { p_user: c.id, p_actor: admin.id }));
    assert.ok(await authUserExists(c.id));
  });
});
