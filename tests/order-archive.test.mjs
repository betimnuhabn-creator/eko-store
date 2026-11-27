// Order cancel / archive / restore — database rules and security.
//   npx supabase start && npx supabase db reset && node --test tests/order-archive.test.mjs
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { client, delivery, denied, makeAdmin, ok, productBySku, service, signUp, sql } from './helpers.mjs';

let admin, customer, other, p1;
const newOrder = async (u = customer) =>
  ok(await u.c.rpc('place_order', { p_lines: [{ product_id: p1.id, quantity: 1 }], p_delivery: delivery }));
const row = async (id) => ok(await service.from('orders').select('*').eq('id', id).single());

before(async () => {
  admin = await makeAdmin('arc-admin');
  customer = await signUp('arc-customer');
  other = await signUp('arc-other');
  p1 = await productBySku('HS-001');
});

describe('admin_cancel_order()', () => {
  test('admin cancels; customer is notified; note kept', async () => {
    const o = await newOrder();
    ok(await admin.c.rpc('admin_cancel_order', { p_order: o.id, p_note: 'Klienti telefonoi' }));
    const r = await row(o.id);
    assert.equal(r.status, 'cancelled');
    assert.equal(r.admin_note, 'Klienti telefonoi');
    const n = ok(await customer.c.from('notifications').select('data').eq('type', 'order_status'));
    assert.ok(n.some((x) => x.data.order_id === o.id && x.data.status === 'cancelled'));
  });

  test('cancelling twice is harmless (no second notification)', async () => {
    const o = await newOrder();
    ok(await admin.c.rpc('admin_cancel_order', { p_order: o.id }));
    ok(await admin.c.rpc('admin_cancel_order', { p_order: o.id }));
    const n = ok(await customer.c.from('notifications').select('data').eq('type', 'order_status'));
    assert.equal(n.filter((x) => x.data.order_id === o.id).length, 1);
  });

  test('a delivered order cannot be cancelled', async () => {
    const o = await newOrder();
    ok(await admin.c.rpc('admin_set_order_status', { p_order: o.id, p_status: 'delivered', p_note: null }));
    await denied(admin.c.rpc('admin_cancel_order', { p_order: o.id }), /CANNOT_CANCEL_DELIVERED/);
    assert.equal((await row(o.id)).status, 'delivered');
  });
});

describe('admin_archive_order() / admin_restore_order()', () => {
  test('only cancelled orders can be archived', async () => {
    const o = await newOrder();
    await denied(admin.c.rpc('admin_archive_order', { p_order: o.id }), /ONLY_CANCELLED_CAN_BE_ARCHIVED/);
    assert.equal((await row(o.id)).archived_at, null);
  });

  test('archive keeps the order and its lines; records who and when', async () => {
    const o = await newOrder();
    const before = await row(o.id);
    const linesBefore = ok(await service.from('order_items').select('*').eq('order_id', o.id).order('id'));
    ok(await admin.c.rpc('admin_cancel_order', { p_order: o.id }));
    ok(await admin.c.rpc('admin_archive_order', { p_order: o.id }));
    const r = await row(o.id);
    assert.ok(r.archived_at);
    assert.equal(r.archived_by, admin.id);
    for (const k of ['order_number', 'customer_id', 'total', 'item_count', 'delivery_name', 'delivery_address', 'created_at']) {
      assert.deepEqual(r[k], before[k], k);
    }
    assert.deepEqual(ok(await service.from('order_items').select('*').eq('order_id', o.id).order('id')), linesBefore);
  });

  test('the customer still sees the archived order in their history', async () => {
    const o = await newOrder();
    ok(await admin.c.rpc('admin_cancel_order', { p_order: o.id }));
    ok(await admin.c.rpc('admin_archive_order', { p_order: o.id }));
    const mine = ok(await customer.c.from('orders').select('id,status').eq('id', o.id));
    assert.deepEqual(mine, [{ id: o.id, status: 'cancelled' }]);
  });

  test('archived orders are excluded from the active list query and counters', async () => {
    const o = await newOrder();
    ok(await admin.c.rpc('admin_cancel_order', { p_order: o.id }));
    ok(await admin.c.rpc('admin_archive_order', { p_order: o.id }));
    const active = ok(await admin.c.from('orders').select('id').is('archived_at', null));
    assert.ok(!active.some((x) => x.id === o.id));
    const archived = ok(await admin.c.from('orders').select('id').not('archived_at', 'is', null));
    assert.ok(archived.some((x) => x.id === o.id));
    const s = ok(await admin.c.rpc('admin_stats'));
    assert.ok(s.archived_orders >= 1);
  });

  test('status cannot be changed while archived; restore brings it back (still cancelled)', async () => {
    const o = await newOrder();
    ok(await admin.c.rpc('admin_cancel_order', { p_order: o.id }));
    ok(await admin.c.rpc('admin_archive_order', { p_order: o.id }));
    await denied(admin.c.rpc('admin_set_order_status', { p_order: o.id, p_status: 'new', p_note: null }), /ORDER_ARCHIVED/);
    await denied(admin.c.rpc('admin_cancel_order', { p_order: o.id }), /ORDER_ARCHIVED/);
    ok(await admin.c.rpc('admin_restore_order', { p_order: o.id }));
    const r = await row(o.id);
    assert.equal(r.archived_at, null);
    assert.equal(r.archived_by, null);
    assert.equal(r.status, 'cancelled');
    ok(await admin.c.rpc('admin_set_order_status', { p_order: o.id, p_status: 'new', p_note: null }));
  });

  test('database refuses an archived order that is not cancelled (constraint)', async () => {
    const o = await newOrder();
    const { error } = await service.from('orders').update({ archived_at: new Date().toISOString() }).eq('id', o.id);
    assert.match(error?.message ?? '', /orders_archive_only_cancelled/);
  });
});

describe('only administrators', () => {
  test('customers cannot cancel, archive or restore (not even their own order)', async () => {
    const o = await newOrder();
    for (const [fn, args] of [
      ['admin_cancel_order', { p_order: o.id, p_note: null }],
      ['admin_archive_order', { p_order: o.id }],
      ['admin_restore_order', { p_order: o.id }],
    ]) {
      await denied(customer.c.rpc(fn, args), /ADMIN_ONLY/);
      await denied(other.c.rpc(fn, args), /ADMIN_ONLY/);
      await denied(client().rpc(fn, args));
    }
    assert.equal((await row(o.id)).status, 'new');
  });

  test('customers cannot set archived_at directly through the API', async () => {
    const o = await newOrder();
    await denied(customer.c.from('orders').update({ archived_at: new Date().toISOString() }).eq('id', o.id));
    await denied(customer.c.from('orders').update({ status: 'cancelled' }).eq('id', o.id));
    await denied(customer.c.from('orders').delete().eq('id', o.id));
    assert.equal((await row(o.id)).archived_at, null);
  });

  test('privileges: guests cannot execute, functions are SECURITY DEFINER with fixed search_path', () => {
    for (const f of ['admin_cancel_order(uuid,text)', 'admin_archive_order(uuid)', 'admin_restore_order(uuid)']) {
      assert.equal(sql(`select has_function_privilege('anon','public.${f}','execute')`), 'f', f);
      assert.equal(sql(`select has_function_privilege('authenticated','public.${f}','execute')`), 't', f);
      assert.equal(sql(`select prosecdef::text || array_to_string(proconfig, ',') from pg_proc where oid = 'public.${f}'::regprocedure`), 'truesearch_path=""', f);
      assert.match(sql(`select prosrc from pg_proc where oid = 'public.${f}'::regprocedure`), /perform public\.assert_admin\(\);/);
    }
  });

  test('no order or order line was deleted by any of the above', async () => {
    const count = sql(`select count(*) from public.orders o where not exists (select 1 from public.order_items i where i.order_id = o.id)`);
    assert.equal(count, '0');
  });
});

describe('compatibility with the installed Android app', () => {
  // These are the exact selects used by the app (components/OrderView.tsx, admin/orders).
  const APP_ORDER_SELECT = '*, order_items(id,product_id,product_name,sku,unit,quantity,unit_price), profiles(email,full_name,business_name,phone)';
  test('order queries with profiles(...) embed still work for admin and customer', async () => {
    const o = await newOrder();
    const a = await admin.c.from('orders').select(APP_ORDER_SELECT).eq('id', o.id).maybeSingle();
    assert.ifError(a.error);
    assert.equal(a.data.order_items.length, 1);
    const l = await admin.c.from('orders').select('*, profiles(email,full_name,business_name,phone)').limit(5);
    assert.ifError(l.error);
    const c = await customer.c.from('orders').select(APP_ORDER_SELECT).eq('id', o.id).maybeSingle();
    assert.ifError(c.error);
    assert.equal(c.data.id, o.id);
  });
});
