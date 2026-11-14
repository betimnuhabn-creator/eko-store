// Security tests: database privileges, RLS, SECURITY DEFINER functions,
// storage, direct API attacks on wholesale prices, wholesale approval.
//   npx supabase start && npx supabase db reset && node --test tests/security.test.mjs
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import {
  KEY, URL, client, delivery, denied, makeAdmin, ok, productBySku, service, signUp, sql,
} from './helpers.mjs';

const EKO_TABLES = ['profiles', 'categories', 'products', 'orders', 'order_items', 'notifications', 'push_tokens',
  'offers', 'offer_items', 'promo_events', 'promo_settings', 'password_reset_audit', 'account_deletion_audit'];
const EKO_DEFINER_FUNCTIONS = [
  'admin_archive_order', 'admin_cancel_offer', 'admin_cancel_order', 'admin_delete_category', 'admin_delete_product',
  'admin_get_promo_settings', 'admin_list_offers', 'admin_restore_order',
  'admin_review_wholesale', 'admin_save_category', 'admin_save_offer', 'admin_set_offer_active',
  'admin_set_promo_settings', 'admin_set_promo_tester',
  'admin_save_product', 'admin_set_order_status', 'admin_stats', 'assert_admin', 'cancel_my_order',
  'claim_notifications', 'delete_my_account', 'finish_notifications', 'forget_push_tokens', 'is_admin',
  'list_offers', 'list_products', 'mark_notifications_read', 'new_profile', 'notify_admins', 'notify_user', 'place_order',
  'price_tier', 'process_offer_activations', 'products_promo_trigger', 'promo_fanout', 'promo_queue_new_product',
  'promo_queue_price', 'register_push_token', 'request_wholesale', 'set_my_promo_preferences', 'unregister_push_token',
  'update_my_profile',
].concat(['best_offer', 'promo_dispatch', 'promo_dispatch_status', 'record_admin_password_change', 'clear_must_change_password', 'admin_import_products', 'delete_customer_account']).sort();
const AUTHENTICATED_EXEC = [
  'admin_archive_order', 'admin_cancel_offer', 'admin_cancel_order', 'admin_delete_category', 'admin_delete_product',
  'admin_get_promo_settings', 'admin_list_offers', 'admin_restore_order',
  'admin_review_wholesale', 'admin_save_category', 'admin_save_offer', 'admin_set_offer_active',
  'admin_set_promo_settings', 'admin_set_promo_tester',
  'admin_save_product', 'admin_set_order_status', 'admin_stats', 'cancel_my_order', 'delete_my_account',
  'is_admin', 'list_products', 'mark_notifications_read', 'place_order', 'register_push_token',
  'request_wholesale', 'unregister_push_token', 'update_my_profile',
  'list_offers', 'set_my_promo_preferences', 'admin_import_products',
].sort();

describe('database catalog audit', () => {
  test('RLS is enabled on every EKO table', () => {
    const rows = sql(`select tablename||':'||rowsecurity from pg_tables where schemaname='public' and tablename in (${EKO_TABLES.map((t) => `'${t}'`).join(',')}) order by 1`);
    assert.deepEqual(rows.split('\n'), EKO_TABLES.slice().sort().map((t) => `${t}:true`));
  });

  test('API roles have no write privileges on any EKO table', () => {
    const writes = sql(`select string_agg(grantee||' '||privilege_type||' '||table_name, ', ') from information_schema.role_table_grants
      where table_schema='public' and grantee in ('anon','authenticated','public')
        and table_name in (${EKO_TABLES.map((t) => `'${t}'`).join(',')}) and privilege_type <> 'SELECT'`);
    assert.equal(writes, '');
  });

  test('read privileges are exactly the intended ones', () => {
    const reads = sql(`select string_agg(grantee||':'||table_name, ',' order by grantee, table_name) from information_schema.role_table_grants
      where table_schema='public' and grantee in ('anon','authenticated') and privilege_type='SELECT'
        and table_name in (${EKO_TABLES.map((t) => `'${t}'`).join(',')})`);
    assert.equal(reads, 'anon:categories,authenticated:categories,authenticated:notifications,authenticated:order_items,authenticated:orders,authenticated:profiles');
  });

  test('no role can read products columns (incl. wholesale_price) directly', () => {
    for (const role of ['anon', 'authenticated']) {
      for (const col of ['wholesale_price', 'retail_price', 'stock', 'name']) {
        assert.equal(sql(`select has_column_privilege('${role}','public.products','${col}','select')`), 'f', `${role}.${col}`);
      }
    }
  });

  test('all policies on EKO tables are SELECT-only and scoped to the right roles', () => {
    const rows = sql(`select string_agg(tablename||'/'||policyname||'/'||cmd||'/'||array_to_string(roles,'+'), E'\\n' order by tablename, policyname)
      from pg_policies where schemaname='public' and tablename in (${EKO_TABLES.map((t) => `'${t}'`).join(',')})`);
    assert.equal(rows, [
      'categories/categories_select_auth/SELECT/authenticated',
      'categories/categories_select_public/SELECT/anon',
      'notifications/notifications_select/SELECT/authenticated',
      'order_items/order_items_select/SELECT/authenticated',
      'orders/orders_select/SELECT/authenticated',
      'profiles/profiles_select/SELECT/authenticated',
    ].join('\n'));
  });

  test('every SECURITY DEFINER function in public is an EKO function with a fixed search_path', () => {
    const rows = sql(`select string_agg(p.proname||':'||coalesce(array_to_string(p.proconfig,','),'-'), E'\\n' order by p.proname)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef`);
    assert.deepEqual(rows.split('\n'), EKO_DEFINER_FUNCTIONS.map((f) => `${f}:search_path=""`));
  });

  test('anon can execute only list_offers() and list_products()', () => {
    const rows = sql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname = any(array[${EKO_DEFINER_FUNCTIONS.map((f) => `'${f}'`).join(',')}])
        and has_function_privilege('anon', p.oid, 'execute')`);
    assert.equal(rows, 'list_offers,list_products');
  });

  test('authenticated can execute exactly the app functions', () => {
    const rows = sql(`select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname = any(array[${EKO_DEFINER_FUNCTIONS.map((f) => `'${f}'`).join(',')}])
        and has_function_privilege('authenticated', p.oid, 'execute')`);
    assert.equal(rows, AUTHENTICATED_EXEC.join(','));
  });

  test('notification delivery functions are service_role only', () => {
    for (const f of ['claim_notifications(integer)', 'finish_notifications(uuid,uuid[],uuid[],text)', 'forget_push_tokens(text[])', 'delete_customer_account(uuid,uuid)']) {
      assert.equal(sql(`select has_function_privilege('service_role','public.${f}','execute')`), 't');
      assert.equal(sql(`select has_function_privilege('authenticated','public.${f}','execute')`), 'f');
      assert.equal(sql(`select has_function_privilege('anon','public.${f}','execute')`), 'f');
    }
  });

  test('API roles cannot use the order-number counter', () => {
    const seq = sql(`select pg_get_serial_sequence('public.orders','order_number')`);
    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['usage', 'select', 'update']) {
        assert.equal(sql(`select has_sequence_privilege('${role}','${seq}','${priv}')`), 'f', `${role} ${priv}`);
      }
    }
  });

  test('SECURITY DEFINER functions are owned by postgres (not by an API role)', () => {
    const owners = sql(`select string_agg(distinct pg_get_userbyid(p.proowner), ',') from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef`);
    assert.equal(owners, 'postgres');
  });

  test('every admin function checks is_admin() first', () => {
    for (const f of ['admin_archive_order', 'admin_cancel_order', 'admin_delete_category', 'admin_delete_product',
      'admin_restore_order', 'admin_review_wholesale', 'admin_save_category', 'admin_save_product', 'admin_set_order_status', 'admin_stats',
      'admin_cancel_offer', 'admin_get_promo_settings', 'admin_list_offers', 'admin_save_offer', 'admin_set_offer_active',
      'admin_set_promo_settings', 'admin_set_promo_tester', 'admin_import_products']) {
      const src = sql(`select prosrc from pg_proc where proname='${f}'`);
      const first = src.split('\n').map((l) => l.trim()).find((l) => l && l !== 'begin' && !l.startsWith('declare'));
      assert.match(src, /perform public\.assert_admin\(\);/, f);
      assert.ok(src.indexOf('assert_admin') < src.search(/\b(insert|update|delete)\b/i) || !/\b(insert|update|delete)\b/i.test(src), `${f}: check before writes (${first})`);
    }
  });

  test('storage policies: product-images writes and listing are admin-only', () => {
    const rows = sql(`select string_agg(policyname||'/'||cmd||'/'||array_to_string(roles,'+')||'/'||(coalesce(qual,'')||coalesce(with_check,'') like '%is_admin()%'), E'\\n' order by policyname)
      from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'product images%'`);
    assert.equal(rows, [
      'product images admin delete/DELETE/authenticated/true',
      'product images admin insert/INSERT/authenticated/true',
      'product images admin select/SELECT/authenticated/true',
      'product images admin update/UPDATE/authenticated/true',
    ].join('\n'));
    assert.equal(sql(`select public||'/'||file_size_limit||'/'||array_to_string(allowed_mime_types,',') from storage.buckets where id='product-images'`),
      'true/5242880/image/jpeg,image/png,image/webp');
  });
});

describe('direct API attacks on wholesale prices', () => {
  let retail, pending, p1;
  before(async () => {
    retail = await signUp('sec-retail');
    pending = await signUp('sec-pending', { requested_wholesale: true, business_name: 'Pending SHPK' });
    p1 = await productBySku('HS-001');
  });

  const attempts = (c) => [
    ['select *', () => c.from('products').select('*')],
    ['select wholesale_price', () => c.from('products').select('wholesale_price')],
    ['count only', () => c.from('products').select('*', { count: 'exact', head: true })],
    ['filter on wholesale_price', () => c.from('products').select('id').gt('wholesale_price', 0)],
    ['embed via order_items', () => c.from('order_items').select('id, products(wholesale_price)')],
    ['embed via orders', () => c.from('orders').select('id, order_items(products(wholesale_price))')],
  ];

  for (const who of ['guest', 'retail', 'pending wholesale']) {
    test(`${who}: every PostgREST route to the products table is refused`, async () => {
      const c = who === 'guest' ? client() : who === 'retail' ? retail.c : pending.c;
      for (const [label, fn] of attempts(c)) {
        const { data, error } = await fn();
        const leaked = JSON.stringify(data ?? '').includes('wholesale_price') || (Array.isArray(data) && data.some((r) => r?.products));
        assert.ok(error || !leaked, `${who} / ${label} leaked: ${JSON.stringify(data)}`);
        if (label.startsWith('select') || label === 'count only' || label.startsWith('filter')) assert.ok(error, `${who} / ${label} must error`);
      }
    });
  }

  test('raw HTTP request with the publishable key + user token is refused', async () => {
    for (const path of ['/rest/v1/products?select=*', '/rest/v1/products?select=wholesale_price&limit=1']) {
      const res = await fetch(URL + path, { headers: { apikey: KEY, Authorization: `Bearer ${retail.token}` } });
      const body = await res.text();
      assert.ok(res.status >= 400, `${path} → ${res.status} ${body}`);
      assert.ok(!body.includes('26.5'), 'no wholesale price in body');
    }
  });

  test('GraphQL endpoint does not expose products', async () => {
    const res = await fetch(`${URL}/graphql/v1`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${retail.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ productsCollection { edges { node { wholesale_price } } } }' }),
    });
    const body = await res.text();
    assert.ok(!body.includes('26.5') && !/"wholesale_price"\s*:\s*"?\d/.test(body), body);
  });

  test('list_products(): retail and pending wholesale get only the retail price', async () => {
    for (const u of [retail, pending]) {
      const p = ok(await u.c.rpc('list_products')).find((x) => x.id === p1.id);
      assert.equal(Number(p.price), Number(p1.retail_price));
      assert.equal(p.wholesale_price, null);
      assert.equal(p.retail_price, null);
      assert.equal(p.stock, null);
    }
  });

  test('internal helpers cannot be called to learn the price tier or send notifications', async () => {
    await denied(retail.c.rpc('price_tier'));
    await denied(retail.c.rpc('notify_admins', { p_type: 'x', p_data: {} }));
    await denied(retail.c.rpc('notify_user', { p_user: retail.id, p_type: 'x', p_data: {} }));
    await denied(retail.c.rpc('claim_notifications', { p_limit: 10 }));
    await denied(retail.c.rpc('finish_notifications', { p_claim: null, p_delivered: [], p_failed: [], p_error: null }));
    await denied(client().rpc('finish_notifications', { p_claim: null, p_delivered: [], p_failed: [], p_error: null }));
    await denied(client().rpc('claim_notifications', { p_limit: 1 }));
    await denied(client().rpc('is_admin'));
  });

  test('a retail order is always charged retail, whatever the app sends', async () => {
    const o = ok(await retail.c.rpc('place_order', {
      p_lines: [{ product_id: p1.id, quantity: 1, unit_price: Number(p1.wholesale_price), price: 0 }],
      p_delivery: { ...delivery, price_tier: 'wholesale' },
    }));
    assert.equal(Number(o.total), Number(p1.retail_price));
    const row = ok(await retail.c.from('orders').select('price_tier').eq('id', o.id).single());
    assert.equal(row.price_tier, 'retail');
  });
});

describe('unauthorized access', () => {
  let a, b, admin;
  before(async () => {
    a = await signUp('sec-a');
    b = await signUp('sec-b');
    admin = await makeAdmin('sec-admin');
  });

  test('sign-up metadata cannot grant admin or wholesale', async () => {
    const u = await signUp('sec-sneaky', { role: 'admin', wholesale_status: 'approved', requested_wholesale: false });
    const p = ok(await u.c.from('profiles').select('role,wholesale_status').single());
    assert.deepEqual(p, { role: 'retail', wholesale_status: 'none' });
  });

  test('customers cannot write to any table directly', async () => {
    await denied(a.c.from('profiles').update({ role: 'admin' }).eq('id', a.id));
    await denied(a.c.from('profiles').update({ wholesale_status: 'approved' }).eq('id', a.id));
    await denied(a.c.from('profiles').insert({ id: a.id, role: 'admin' }));
    await denied(a.c.from('orders').insert({ customer_id: a.id, total: 0 }));
    await denied(a.c.from('order_items').insert({ order_id: '00000000-0000-0000-0000-000000000000', quantity: 1, unit_price: 0 }));
    await denied(a.c.from('notifications').insert({ recipient_id: a.id, type: 'x' }));
    await denied(a.c.from('categories').insert({ name_sq: 'x' }));
    await denied(a.c.from('products').insert({ sku: 'x', name: 'x', retail_price: 0, wholesale_price: 0 }));
    await denied(a.c.from('push_tokens').insert({ token: 'x', user_id: a.id }));
    await denied(client().from('categories').insert({ name_sq: 'x' }));
  });

  test('update_my_profile cannot change role or wholesale status', async () => {
    ok(await a.c.rpc('update_my_profile', { p: { role: 'admin', wholesale_status: 'approved', city: 'Pejë' } }));
    const p = ok(await a.c.from('profiles').select('role,wholesale_status,city').single());
    assert.deepEqual(p, { role: 'retail', wholesale_status: 'none', city: 'Pejë' });
  });

  test('customers see only their own profile, orders and notifications', async () => {
    const p1 = await productBySku('HS-001');
    const oa = ok(await a.c.rpc('place_order', { p_lines: [{ product_id: p1.id, quantity: 1 }], p_delivery: delivery }));
    assert.deepEqual(ok(await b.c.from('profiles').select('id')).map((r) => r.id), [b.id]);
    assert.equal(ok(await b.c.from('orders').select('id').eq('id', oa.id)).length, 0);
    assert.equal(ok(await b.c.from('order_items').select('id').eq('order_id', oa.id)).length, 0);
    assert.ok(ok(await b.c.from('notifications').select('recipient_id')).every((n) => n.recipient_id === b.id));
    await denied(b.c.rpc('cancel_my_order', { p_order: oa.id }), /NOT_FOUND/);
    // and guests see nothing private at all
    await denied(client().from('orders').select('id'));
    await denied(client().from('profiles').select('id'));
  });

  test('guests cannot call any customer or admin function', async () => {
    const g = client();
    await denied(g.rpc('place_order', { p_lines: [], p_delivery: delivery }));
    await denied(g.rpc('update_my_profile', { p: {} }));
    await denied(g.rpc('request_wholesale', { p_business_name: 'x', p_business_number: '' }));
    await denied(g.rpc('admin_stats'));
    await denied(g.rpc('admin_review_wholesale', { p_user: a.id, p_approve: true }));
    await denied(g.rpc('delete_my_account'));
  });

  test('every admin function refuses non-admins', async () => {
    const calls = [
      ['admin_stats', {}],
      ['admin_save_product', { p: { sku: 'x', name: 'x', retail_price: 1, wholesale_price: 1 } }],
      ['admin_delete_product', { p_id: '00000000-0000-0000-0000-000000000000' }],
      ['admin_save_category', { p: { name_sq: 'x' } }],
      ['admin_delete_category', { p_id: '00000000-0000-0000-0000-000000000000' }],
      ['admin_review_wholesale', { p_user: a.id, p_approve: true }],
      ['admin_set_order_status', { p_order: '00000000-0000-0000-0000-000000000000', p_status: 'delivered', p_note: null }],
      ['admin_cancel_order', { p_order: '00000000-0000-0000-0000-000000000000', p_note: null }],
      ['admin_archive_order', { p_order: '00000000-0000-0000-0000-000000000000' }],
      ['admin_restore_order', { p_order: '00000000-0000-0000-0000-000000000000' }],
      ['admin_import_products', { p_rows: [{ row: 2, sku: 'X-1', name: 'x', retail_price: 1, wholesale_price: 1 }] }],
    ];
    for (const [fn, args] of calls) await denied(a.c.rpc(fn, args), /ADMIN_ONLY/);
  });

  test('admins cannot demote another admin through the wholesale review', async () => {
    const other = await makeAdmin('sec-admin2');
    await denied(admin.c.rpc('admin_review_wholesale', { p_user: other.id, p_approve: false }), /CANNOT_CHANGE_ADMIN/);
  });

  test('storage: only admins may upload, replace, delete or list product photos', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const path = `sec/${Date.now()}.png`;
    assert.ok((await client().storage.from('product-images').upload(path, png, { contentType: 'image/png' })).error, 'guest upload');
    assert.ok((await a.c.storage.from('product-images').upload(path, png, { contentType: 'image/png' })).error, 'customer upload');
    ok(await admin.c.storage.from('product-images').upload(path, png, { contentType: 'image/png' }));
    assert.ok((await a.c.storage.from('product-images').upload(path, png, { contentType: 'image/png', upsert: true })).error, 'customer overwrite');
    const del = await a.c.storage.from('product-images').remove([path]);
    assert.ok(del.error || (del.data ?? []).length === 0, 'customer delete must not remove anything');
    assert.equal((await fetch(admin.c.storage.from('product-images').getPublicUrl(path).data.publicUrl)).status, 200, 'still there + public');
    const listed = await a.c.storage.from('product-images').list('sec');
    assert.ok(listed.error || listed.data.length === 0, 'customer cannot list');
    assert.ok((await admin.c.storage.from('product-images').upload(`sec/${Date.now()}.txt`, Buffer.from('x'), { contentType: 'text/plain' })).error, 'non-image refused');
    ok(await admin.c.storage.from('product-images').remove([path]));
  });
});

describe('wholesale approval flow', () => {
  let admin, biz, other, p1;
  before(async () => {
    admin = await makeAdmin('wf-admin');
    biz = await signUp('wf-biz', { requested_wholesale: true, business_name: 'WF SHPK' });
    other = await signUp('wf-other', { requested_wholesale: true, business_name: 'Other SHPK' });
    p1 = await productBySku('HS-001');
  });
  const priceOf = async (u) => Number(ok(await u.c.rpc('list_products')).find((x) => x.id === p1.id).price);

  test('pending: retail price, and the customer cannot approve themselves', async () => {
    assert.equal(await priceOf(biz), Number(p1.retail_price));
    await denied(biz.c.rpc('admin_review_wholesale', { p_user: biz.id, p_approve: true }), /ADMIN_ONLY/);
    ok(await biz.c.rpc('request_wholesale', { p_business_name: 'WF SHPK', p_business_number: '' }));
    assert.equal(await priceOf(biz), Number(p1.retail_price));
  });

  test('admin is notified of the request', async () => {
    const n = ok(await admin.c.from('notifications').select('type,data').eq('type', 'wholesale_request'));
    assert.ok(n.some((x) => x.data.user_id === biz.id));
  });

  test('approved: wholesale price, wholesale orders, customer notified', async () => {
    ok(await admin.c.rpc('admin_review_wholesale', { p_user: biz.id, p_approve: true }));
    assert.equal(await priceOf(biz), Number(p1.wholesale_price));
    const o = ok(await biz.c.rpc('place_order', { p_lines: [{ product_id: p1.id, quantity: 2 }], p_delivery: delivery }));
    assert.equal(Number(o.total), Number(p1.wholesale_price) * 2);
    assert.ok(ok(await biz.c.from('notifications').select('type')).some((n) => n.type === 'wholesale_approved'));
  });

  test('an approved wholesale customer cannot approve someone else', async () => {
    await denied(biz.c.rpc('admin_review_wholesale', { p_user: other.id, p_approve: true }), /ADMIN_ONLY/);
    assert.equal(await priceOf(other), Number(p1.retail_price));
  });

  test('revoked: back to retail price immediately', async () => {
    ok(await admin.c.rpc('admin_review_wholesale', { p_user: biz.id, p_approve: false }));
    const p = ok(await biz.c.from('profiles').select('role,wholesale_status').single());
    assert.deepEqual(p, { role: 'retail', wholesale_status: 'rejected' });
    assert.equal(await priceOf(biz), Number(p1.retail_price));
    const o = ok(await biz.c.rpc('place_order', { p_lines: [{ product_id: p1.id, quantity: 1 }], p_delivery: delivery }));
    assert.equal(Number(o.total), Number(p1.retail_price));
  });

  test('rejected request: stays retail, may request again', async () => {
    ok(await admin.c.rpc('admin_review_wholesale', { p_user: other.id, p_approve: false }));
    assert.equal(await priceOf(other), Number(p1.retail_price));
    ok(await other.c.rpc('request_wholesale', { p_business_name: 'Other SHPK', p_business_number: '1' }));
    const p = ok(await other.c.from('profiles').select('wholesale_status').single());
    assert.equal(p.wholesale_status, 'pending');
    assert.equal(await priceOf(other), Number(p1.retail_price));
  });

  test('state set directly in the database (e.g. v0.2 data) follows the same rule', async () => {
    // role 'wholesale' without approval must NOT give wholesale prices
    ok(await service.from('profiles').update({ role: 'wholesale', wholesale_status: 'pending' }).eq('id', other.id));
    assert.equal(await priceOf(other), Number(p1.retail_price));
  });
});

describe('offers + promotional notifications: abuse attempts', () => {
  let cust, p, settings0;
  const settingsNow = () => sql('select enabled::text||test_only::text||daily_cap||functions_url from public.promo_settings');
  const Z = '00000000-0000-0000-0000-000000000000';
  before(async () => {
    cust = await signUp('sec-promo');
    p = await productBySku('HS-001');
    settings0 = settingsNow();
  });

  test('internal SECURITY DEFINER helpers are not callable by guests or customers', async () => {
    for (const c of [client(), cust.c]) {
      await denied(c.rpc('best_offer', { p_product: p.id, p_tier: 'wholesale' }));       // would reveal wholesale offer prices
      await denied(c.rpc('promo_queue_new_product', { p_product: p.id }));               // would queue a push to everyone
      await denied(c.rpc('promo_queue_price', { p_product: p.id, r_old: 1, r_new: 2, w_old: 1, w_new: 2 }));
      await denied(c.rpc('process_offer_activations'));
      await denied(c.rpc('promo_fanout', { p_limit: 200 }));
      await denied(c.rpc('products_promo_trigger'));
      await denied(c.rpc('promo_dispatch'));                                             // would make the DB call out
      await denied(c.rpc('promo_dispatch_status'));
      await denied(c.rpc('promo_functions_url_valid', { u: 'x' }));
    }
  });

  test('offers, offer items, promo events and settings are not reachable through the API', async () => {
    for (const c of [client(), cust.c]) {
      for (const t of ['offers', 'offer_items', 'promo_events', 'promo_settings']) {
        await denied(c.from(t).select('*'));
        await denied(c.from(t).insert({}));
      }
      await denied(c.from('promo_settings').update({ enabled: true, test_only: false }).eq('id', true));
    }
    assert.equal(settingsNow(), settings0);
  });

  test('customers cannot make themselves promo testers or change other people\'s preferences', async () => {
    ok(await cust.c.rpc('update_my_profile', { p: { promo_tester: true, promo_offers: true } }));
    await denied(cust.c.from('profiles').update({ promo_tester: true }).eq('id', cust.id));
    ok(await cust.c.rpc('set_my_promo_preferences', { p_new_products: true, p_offers: null, p_price_changes: null }));
    assert.equal(sql(`select promo_tester::text||promo_new_products::text||promo_offers::text from public.profiles where id='${cust.id}'`), 'falsetruefalse');
    await denied(client().rpc('set_my_promo_preferences', { p_new_products: true, p_offers: true, p_price_changes: true }));
  });

  test('promo and offer admin functions refuse customers and guests', async () => {
    const calls = [
      ['admin_list_offers', {}],
      ['admin_save_offer', { p: { title_sq: 'x', starts_at: '2026-01-01', ends_at: '2027-01-01', items: [{ product_id: p.id, offer_price: 0 }] } }],
      ['admin_set_offer_active', { p_id: Z, p_active: true }],
      ['admin_cancel_offer', { p_id: Z }],
      ['admin_get_promo_settings', {}],
      ['admin_set_promo_settings', { p: { enabled: true, test_only: false, functions_url: 'https://evil.supabase.co/functions/v1' } }],
      ['admin_set_promo_tester', { p_user: cust.id, p_tester: true }],
    ];
    for (const [fn, args] of calls) {
      await denied(cust.c.rpc(fn, args), /ADMIN_ONLY/);
      await denied(client().rpc(fn, args));
    }
    assert.equal(settingsNow(), settings0);
  });

  test('admins can only point the scheduler at a Supabase functions URL', async () => {
    const admin = await makeAdmin('sec-promo-admin');
    for (const url of ['http://example.com', 'https://evil.com/functions/v1', 'https://x.supabase.co.evil.com/functions/v1',
      "https://x.supabase.co/functions/v1'; drop table x;--", 'http://abc.supabase.co/functions/v1',
      'https://abc.supabase.co/functions/v1/../../rest/v1', 'https://abc.supabase.co/functions/v1?x=1',
      'https://abc.supabase.co:8443/functions/v1', 'https://a-b.supabase.co/functions/v1', 'https://abc.supabase.co/functions/v1\nx']) {
      await denied(admin.c.rpc('admin_set_promo_settings', { p: { functions_url: url } }), /INVALID_FUNCTIONS_URL/);
    }
    assert.equal(settingsNow(), settings0);
    // A real project address is accepted (trailing slash and spaces removed), then cleared again.
    ok(await admin.c.rpc('admin_set_promo_settings', { p: { functions_url: ' https://abcdefghijklmnopqrst.supabase.co/functions/v1/ ' } }));
    assert.equal(sql('select functions_url from public.promo_settings'), 'https://abcdefghijklmnopqrst.supabase.co/functions/v1');
    ok(await admin.c.rpc('admin_set_promo_settings', { p: { functions_url: '' } }));
    assert.equal(settingsNow(), settings0);
  });

  test('pg_net (net schema) is not reachable through the API', async () => {
    for (const headers of [{ apikey: KEY }, { apikey: KEY, Authorization: `Bearer ${cust.token}` }]) {
      for (const [path, method, body] of [
        ['/rest/v1/rpc/http_post', 'POST', JSON.stringify({ url: 'https://example.com' })],
        ['/rest/v1/http_request_queue?select=*', 'GET', undefined],
        ['/rest/v1/_http_response?select=*', 'GET', undefined],
      ]) {
        for (const profile of ['net', 'extensions']) {
          const res = await fetch(URL + path, { method, body, headers: { ...headers, 'Content-Type': 'application/json',
            'Accept-Profile': profile, 'Content-Profile': profile } });
          assert.ok(res.status >= 400, `${profile}${path} -> ${res.status} ${await res.text()}`);
        }
      }
    }
  });

  test('the scheduler only calls a valid functions address', () => {
    const valid = (u) => sql(`select public.promo_functions_url_valid(${u === null ? 'null' : `'${u}'`})`);
    assert.equal(valid('https://mfpmcriffqlhlgaptdzx.supabase.co/functions/v1'), 't');
    for (const u of [null, '', 'http://example.com', 'https://evil.com/functions/v1', 'https://x.supabase.co.evil.com/functions/v1',
      'https://x.supabase.co/functions/v1/', 'http://x.supabase.co/functions/v1', 'https://x.supabase.co/rest/v1']) {
      assert.equal(valid(u), 'f', String(u));
    }
  });
});
