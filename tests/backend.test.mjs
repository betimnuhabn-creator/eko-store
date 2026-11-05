// Integration tests for the database rules, RPCs, storage and Edge Function.
// Run against a LOCAL Supabase stack:
//   npx supabase start && npx supabase db reset && npm run test:backend
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const env = Object.fromEntries(
  execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .map((l) => l.match(/^(\w+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const URL = env.API_URL;
const ANON = env.ANON_KEY;
const service = createClient(URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const run = Date.now();

function client() {
  return createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signUp(name, meta = {}) {
  const c = client();
  const email = `${name}.${run}@test.local`;
  const { data, error } = await c.auth.signUp({
    email,
    password: 'secret123',
    options: { data: { full_name: name, phone: '+38344000000', ...meta } },
  });
  assert.ifError(error);
  assert.ok(data.session, 'local auth should auto-confirm');
  return { c, id: data.user.id, email };
}

const ok = ({ data, error }) => {
  assert.ifError(error);
  return data;
};
const fails = async (p, re) => {
  const { error } = await p;
  assert.ok(error, 'expected an error');
  if (re) assert.match(error.message, re);
};

let guest, admin, retail, biz, products;
const delivery = { name: 'Bleri', phone: '+38344111222', address: 'Rr. Nëna Terezë 1', city: 'Prishtinë', payment_method: 'cash_on_delivery' };

before(async () => {
  guest = client();
  admin = await signUp('admin');
  ok(await service.from('profiles').update({ role: 'admin' }).eq('id', admin.id));
  retail = await signUp('retail');
  biz = await signUp('biz', { requested_wholesale: true, business_name: 'Firma SHPK', business_number: '811111111' });
  products = ok(await admin.c.rpc('list_products'));
  assert.ok(products.length >= 4, 'seed products present');
});

describe('catalog & price visibility', () => {
  test('guests see products but no prices', async () => {
    const list = ok(await guest.rpc('list_products'));
    assert.ok(list.length > 0);
    for (const p of list) {
      assert.equal(p.price, null);
      assert.equal(p.retail_price, null);
      assert.equal(p.wholesale_price, null);
      assert.equal(p.stock, null);
      assert.equal(typeof p.in_stock, 'boolean');
    }
  });

  test('retail customer sees retail price only', async () => {
    const list = ok(await retail.c.rpc('list_products'));
    const p = list.find((x) => x.sku === 'HS-001');
    assert.equal(Number(p.price), 34.9);
    assert.equal(p.wholesale_price, null);
    assert.equal(p.retail_price, null);
  });

  test('pending wholesale customer still sees retail price', async () => {
    const prof = ok(await biz.c.from('profiles').select('role,wholesale_status,business_name').single());
    assert.deepEqual(prof, { role: 'retail', wholesale_status: 'pending', business_name: 'Firma SHPK' });
    const p = ok(await biz.c.rpc('list_products')).find((x) => x.sku === 'HS-001');
    assert.equal(Number(p.price), 34.9);
  });

  test('products table cannot be read directly (wholesale prices protected)', async () => {
    await fails(guest.from('products').select('wholesale_price'));
    await fails(retail.c.from('products').select('*'));
    await fails(biz.c.from('products').select('wholesale_price'));
  });

  test('admin sees both prices and stock', async () => {
    const p = products.find((x) => x.sku === 'HS-001');
    assert.equal(Number(p.retail_price), 34.9);
    assert.equal(Number(p.wholesale_price), 26.5);
    assert.equal(p.stock, 12);
  });
});

describe('accounts & wholesale approval', () => {
  test('customers cannot promote themselves', async () => {
    await fails(retail.c.from('profiles').update({ role: 'admin' }).eq('id', retail.id));
    await fails(biz.c.rpc('admin_review_wholesale', { p_user: biz.id, p_approve: true }), /ADMIN_ONLY|permission/);
    // update_my_profile ignores role fields
    ok(await retail.c.rpc('update_my_profile', { p: { role: 'admin', city: 'Prizren' } }));
    const me = ok(await retail.c.from('profiles').select('role,city').single());
    assert.deepEqual(me, { role: 'retail', city: 'Prizren' });
  });

  test('customers only see their own profile', async () => {
    const rows = ok(await retail.c.from('profiles').select('id'));
    assert.deepEqual(rows.map((r) => r.id), [retail.id]);
  });

  test('admins are notified of the wholesale request', async () => {
    const n = ok(await admin.c.from('notifications').select('type,data').eq('type', 'wholesale_request'));
    assert.ok(n.some((x) => x.data.user_id === biz.id));
  });

  test('admin approves wholesale -> customer sees wholesale price and is notified', async () => {
    ok(await admin.c.rpc('admin_review_wholesale', { p_user: biz.id, p_approve: true }));
    const prof = ok(await biz.c.from('profiles').select('role,wholesale_status').single());
    assert.deepEqual(prof, { role: 'wholesale', wholesale_status: 'approved' });
    const p = ok(await biz.c.rpc('list_products')).find((x) => x.sku === 'HS-001');
    assert.equal(Number(p.price), 26.5);
    assert.equal(p.retail_price, null, 'wholesale customers do not get admin columns');
    const n = ok(await biz.c.from('notifications').select('type'));
    assert.ok(n.some((x) => x.type === 'wholesale_approved'));
  });

  test('retail customer can request wholesale later; admin can reject', async () => {
    await fails(retail.c.rpc('request_wholesale', { p_business_name: '', p_business_number: '' }), /BUSINESS_NAME_REQUIRED/);
    ok(await retail.c.rpc('request_wholesale', { p_business_name: 'Retail Biz', p_business_number: '' }));
    ok(await admin.c.rpc('admin_review_wholesale', { p_user: retail.id, p_approve: false }));
    const prof = ok(await retail.c.from('profiles').select('role,wholesale_status').single());
    assert.deepEqual(prof, { role: 'retail', wholesale_status: 'rejected' });
  });
});

describe('orders', () => {
  let order;
  test('guest cannot order', async () => {
    await fails(guest.rpc('place_order', { p_lines: [], p_delivery: delivery }));
  });

  test('delivery details are required', async () => {
    const id = products[0].id;
    await fails(retail.c.rpc('place_order', { p_lines: [{ product_id: id, quantity: 1 }], p_delivery: { ...delivery, address: '' } }), /DELIVERY_REQUIRED/);
    await fails(retail.c.rpc('place_order', { p_lines: [{ product_id: id, quantity: 0 }], p_delivery: delivery }), /INVALID_QUANTITY/);
  });

  test('retail order is priced on the server (client prices ignored), duplicates merged, out-of-stock allowed', async () => {
    const a = products.find((x) => x.sku === 'HS-001'); // 34.90
    const b = products.find((x) => x.sku === 'NG-001'); // 11.50, stock 0
    order = ok(
      await retail.c.rpc('place_order', {
        p_lines: [
          { product_id: a.id, quantity: 1, unit_price: 0.01 },
          { product_id: a.id, quantity: 1 },
          { product_id: b.id, quantity: 3 },
        ],
        p_delivery: delivery,
      }),
    );
    assert.equal(Number(order.total), 34.9 * 2 + 11.5 * 3);
    assert.ok(order.order_number >= 1001);
    const items = ok(await retail.c.from('order_items').select('sku,quantity,unit_price').eq('order_id', order.id).order('sku'));
    assert.deepEqual(items.map((i) => [i.sku, i.quantity, Number(i.unit_price)]), [['HS-001', 2, 34.9], ['NG-001', 3, 11.5]]);
  });

  test('wholesale order uses wholesale prices', async () => {
    const a = products.find((x) => x.sku === 'HS-001');
    const o = ok(await biz.c.rpc('place_order', { p_lines: [{ product_id: a.id, quantity: 10 }], p_delivery: delivery }));
    assert.equal(Number(o.total), 265);
    const row = ok(await biz.c.from('orders').select('price_tier').eq('id', o.id).single());
    assert.equal(row.price_tier, 'wholesale');
  });

  test('admins get a new_order notification', async () => {
    const n = ok(await admin.c.from('notifications').select('type,data').eq('type', 'new_order'));
    assert.ok(n.some((x) => x.data.order_id === order.id));
  });

  test('customers cannot see or change other orders', async () => {
    const theirs = ok(await biz.c.from('orders').select('id').eq('id', order.id));
    assert.equal(theirs.length, 0);
    await fails(biz.c.rpc('cancel_my_order', { p_order: order.id }), /NOT_FOUND/);
    await fails(retail.c.from('orders').update({ total: 0 }).eq('id', order.id));
    await fails(retail.c.rpc('admin_set_order_status', { p_order: order.id, p_status: 'delivered' }), /ADMIN_ONLY|permission/);
  });

  test('admin changes status -> customer notified; customer can no longer cancel', async () => {
    ok(await admin.c.rpc('admin_set_order_status', { p_order: order.id, p_status: 'confirmed', p_note: 'OK' }));
    const n = ok(await retail.c.from('notifications').select('type,data').eq('type', 'order_status'));
    assert.ok(n.some((x) => x.data.order_id === order.id && x.data.status === 'confirmed'));
    await fails(retail.c.rpc('cancel_my_order', { p_order: order.id }), /CANNOT_CANCEL/);
  });

  test('customer can cancel a new order', async () => {
    const o = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: products.find((x) => x.sku === 'HS-001').id, quantity: 1 }], p_delivery: delivery }));
    ok(await retail.c.rpc('cancel_my_order', { p_order: o.id }));
    const row = ok(await retail.c.from('orders').select('status').eq('id', o.id).single());
    assert.equal(row.status, 'cancelled');
  });

  test('admin dashboard stats', async () => {
    const s = ok(await admin.c.rpc('admin_stats'));
    assert.ok(s.new_orders >= 1 && s.customers >= 2);
    await fails(retail.c.rpc('admin_stats'), /ADMIN_ONLY|permission/);
  });
});

describe('product management & photos', () => {
  let pid;
  test('only admin can create/edit/delete products', async () => {
    const p = { sku: `T-${run}`, name: 'Test', retail_price: 5, wholesale_price: 4, images: [] };
    await fails(retail.c.rpc('admin_save_product', { p }), /ADMIN_ONLY|permission/);
    pid = ok(await admin.c.rpc('admin_save_product', { p }));
    await fails(admin.c.rpc('admin_save_product', { p }), /SKU_EXISTS/);
    ok(await admin.c.rpc('admin_save_product', { p: { ...p, id: pid, name: 'Test 2', active: false } }));
    const asRetail = ok(await retail.c.rpc('list_products'));
    assert.ok(!asRetail.some((x) => x.id === pid), 'inactive product hidden from customers');
    const asAdmin = ok(await admin.c.rpc('list_products')).find((x) => x.id === pid);
    assert.equal(asAdmin.name, 'Test 2');
  });

  test('deleting a product keeps order history', async () => {
    const o = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: products.find((x) => x.sku === 'HS-003').id, quantity: 1 }], p_delivery: delivery }));
    ok(await admin.c.rpc('admin_delete_product', { p_id: products.find((x) => x.sku === 'HS-003').id }));
    const items = ok(await retail.c.from('order_items').select('product_id,product_name,sku').eq('order_id', o.id));
    assert.deepEqual(items, [{ product_id: null, product_name: 'Valvul topi 1/2"', sku: 'HS-003' }]);
  });

  test('photo upload: admin allowed, customers denied, public URL readable', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const path = `test/${run}.png`;
    const denied = await retail.c.storage.from('product-images').upload(path, png, { contentType: 'image/png' });
    assert.ok(denied.error, 'retail upload must fail');
    ok(await admin.c.storage.from('product-images').upload(path, png, { contentType: 'image/png' }));
    const url = admin.c.storage.from('product-images').getPublicUrl(path).data.publicUrl;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    ok(await admin.c.storage.from('product-images').remove([path]));
  });

  test('categories are public to read, admin-only to write', async () => {
    const cats = ok(await guest.from('categories').select('name_sq'));
    assert.ok(cats.length >= 3);
    await fails(guest.from('categories').insert({ name_sq: 'X' }));
    await fails(retail.c.rpc('admin_save_category', { p: { name_sq: 'X' } }), /ADMIN_ONLY|permission/);
    const id = ok(await admin.c.rpc('admin_save_category', { p: { name_sq: 'Vegla', name_en: 'Tools', sort_order: 40 } }));
    ok(await admin.c.rpc('admin_delete_category', { p_id: id }));
  });
});

describe('notifications', () => {
  test('notifications are private and can be marked read', async () => {
    const mine = ok(await retail.c.from('notifications').select('recipient_id'));
    assert.ok(mine.every((n) => n.recipient_id === retail.id));
    ok(await retail.c.rpc('mark_notifications_read', { p_ids: null }));
    const unread = ok(await retail.c.from('notifications').select('id').is('read_at', null));
    assert.equal(unread.length, 0);
  });

  test('internal functions are not callable by app users', async () => {
    await fails(retail.c.rpc('claim_notifications', { p_limit: 10 }));
    await fails(retail.c.rpc('notify_admins', { p_type: 'x', p_data: {} }));
    await fails(guest.rpc('forget_push_tokens', { p_tokens: [] }));
  });

  test('push token registration', async () => {
    ok(await admin.c.rpc('register_push_token', { p_token: `ExponentPushToken[test-${run}]`, p_platform: 'android' }));
    await fails(retail.c.from('push_tokens').select('*'));
  });

  test('dispatch-notifications Edge Function claims queued notifications exactly once', async () => {
    const r1 = await fetch(`${URL}/functions/v1/dispatch-notifications`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' });
    const j1 = await r1.json();
    assert.equal(r1.status, 200, JSON.stringify(j1));
    assert.ok(j1.claimed > 0);
    const r2 = await fetch(`${URL}/functions/v1/dispatch-notifications`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: '{}' });
    const j2 = await r2.json();
    assert.equal(j2.claimed, 0);
    const left = ok(await service.from('notifications').select('id').is('dispatched_at', null));
    assert.equal(left.length, 0);
  });
});

describe('account deletion', () => {
  test('customer can delete their account; their orders are kept', async () => {
    const u = await signUp('leaver');
    const o = ok(await u.c.rpc('place_order', { p_lines: [{ product_id: products.find((x) => x.sku === 'HS-001').id, quantity: 1 }], p_delivery: delivery }));
    ok(await u.c.rpc('delete_my_account'));
    const row = ok(await service.from('orders').select('customer_id,delivery_name').eq('id', o.id).single());
    assert.deepEqual(row, { customer_id: null, delivery_name: 'Bleri' });
    const prof = ok(await service.from('profiles').select('id').eq('id', u.id));
    assert.equal(prof.length, 0);
  });

  test('admin cannot delete own account from the app', async () => {
    await fails(admin.c.rpc('delete_my_account'), /ADMIN_CANNOT_DELETE/);
  });
});
