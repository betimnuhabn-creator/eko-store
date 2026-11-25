// WooCommerce (website) → app products, app orders → WooCommerce.
// LOCAL stack only, with a fake WooCommerce (tests/woo-mock.mjs, port 8099):
//   npx supabase db reset
//   npx supabase functions serve --env-file tests/functions.test.env
//   node --test --test-concurrency=1 tests/woo-sync.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { KEY, URL, client, delivery, denied, makeAdmin, ok, service, signUp, sql } from './helpers.mjs';
import { startWooMock } from './woo-mock.mjs';

const FN = `${URL}/functions/v1/woo-sync`;
let woo, admin, retail, wholesale;

async function call(body, { token, headers = {}, raw } = {}) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
function webhook(topic, payload, secret = 'whsec_test') {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(raw).digest('base64');
  return call(null, { raw, headers: { 'X-WC-Webhook-Topic': topic, 'X-WC-Webhook-Signature': sig } });
}
const prod = (wooId) => sql(`select row_to_json(p) from public.products p where woo_id=${wooId}`);
const P = (wooId) => JSON.parse(prod(wooId) || 'null');
const listFor = async (u) => ok(await (u ? u.c : client()).rpc('list_products'));

before(async () => {
  woo = await startWooMock(8099);
  admin = await makeAdmin('woo-admin');
  retail = await signUp('woo-retail');
  wholesale = await signUp('woo-ws', { requested_wholesale: true, business_name: 'Shumica Woo' });
  ok(await admin.c.rpc('admin_review_wholesale', { p_user: wholesale.id, p_approve: true }));
  // an existing app product with the same SKU as a website product: linked, not duplicated
  ok(await service.from('products').insert({ sku: '576', name: 'WC 21A (nga aplikacioni)', retail_price: 1, wholesale_price: 1 }));
});
after(() => woo?.close());

describe('who may run what', () => {
  test('customers cannot start a full sync; bad webhook signatures are refused; GET → 405', async () => {
    assert.deepEqual(await call({ action: 'sync' }, { token: retail.token }), { status: 403, json: { error: 'not_allowed' } });
    assert.equal((await webhook('product.updated', { id: 2742 }, 'wrong-secret')).status, 401);
    assert.equal((await fetch(FN, { method: 'GET' })).status, 405);
    assert.equal(sql('select count(*) from public.products where source=\'woo\''), '0', 'nothing synced');
  });

  test('database functions and tables are not reachable through the API', async () => {
    for (const [fn, args] of [['woo_apply_products', { p_items: [], p_full: true, p_notify: false }], ['woo_claim_order_jobs', { p_limit: 1 }],
      ['woo_finish_order_job', { p_job: 1, p_woo_order_id: 1, p_error: null }], ['woo_hide_product', { p_woo_id: 1 }], ['woo_dispatch', {}]]) {
      await denied(admin.c.rpc(fn, args));
      await denied(client().rpc(fn, args));
    }
    await denied(retail.c.rpc('admin_woo_status'), /ADMIN_ONLY/);
    await denied(retail.c.rpc('admin_woo_set_orders', { p_enabled: true }), /ADMIN_ONLY/);
    await denied(admin.c.from('woo_settings').select('*'));
    await denied(admin.c.from('woo_order_jobs').select('*'));
  });
});

describe('products: website → app', () => {
  test('full sync from the panel button: simple products, one product per size, categories, photos, prices, stock', async () => {
    const r = await call({ action: 'sync' }, { token: admin.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.result.created, r.json.result.updated, r.json.result.errors], [6, 1, []], JSON.stringify(r.json.result));

    const fontan = P(2742);
    assert.deepEqual([fontan.sku, fontan.name, fontan.description, Number(fontan.retail_price), Number(fontan.wholesale_price), fontan.stock, fontan.active, fontan.source],
      ['35', 'Fontan muri Visam Slim80', 'Fontan muri Slim & i hollë.', 0, 65, 999, true, 'woo']);
    assert.equal(fontan.images.length, 2);
    assert.equal(sql(`select name_sq||'/'||woo_id from public.categories where id='${fontan.category_id}'`), 'Fontan Muri/22', 'deepest category, created');

    const wc = P(2795);
    assert.equal(sql("select count(*) from public.products where lower(sku)='576'"), '1', 'existing app product linked, not duplicated');
    assert.deepEqual([wc.name, wc.description, Number(wc.retail_price), Number(wc.wholesale_price), wc.stock], ['Wc guacë me fontanë 21A', '• Dalja P\n• Qeramikë', 130, 100, 4]);

    const b50 = P(2853), b80 = P(2854), b150 = P(2893);
    assert.equal(b50.name, 'Akumulues (Buffer) për sistemet e ngrohjes 50–150 L – 50L');
    assert.equal(b50.description, '50 litra, montim në mur.', 'size description');
    assert.equal(b80.description, 'Akumulues termik.', 'size without description → product description');
    assert.deepEqual([b50.images[0], b80.images.length], ['https://eko-store.example/wp-content/uploads/buffer-50.jpg', 1], 'size photo first, else product photo');
    assert.deepEqual([b50.woo_parent_id, b80.stock, Number(b80.wholesale_price)], [2738, 0, 139]);
    assert.equal(b150.sku, 'WOO-2893', 'size without SKU gets a stable code');
    assert.equal(P(2899).active, false, 'disabled (private) size is not sold');
    assert.equal(sql('select count(*) from public.products where sku in (\'G1\')'), '0', 'grouped products are not sold in the app');
    const draft = P(2601);
    assert.equal(draft?.active ?? false, false, 'draft product not visible');
    assert.equal(sql("select count(*) from public.promo_events e join public.products p on p.id=e.product_id where p.source='woo' and p.woo_id <> 2795"), '0', 'no promotional notifications for the first catalogue (2795 was created by this test as an app product)');
  });

  test('prices: wholesale customers see wholesale prices; retail sees none (and cannot order) until the website has a retail price', async () => {
    const ws = await listFor(wholesale), rt = await listFor(retail), guest = await listFor(null);
    const id50 = P(2853).id, id150 = P(2893).id, idWc = P(2795).id;
    assert.equal(Number(ws.find((p) => p.id === id50).price), 117);
    assert.equal(rt.find((p) => p.id === id50).price, null, 'retail price 0 on the website → no price for retail');
    assert.equal(Number(rt.find((p) => p.id === id150).price), 160, 'retail price filled in → shown');
    assert.equal(Number(rt.find((p) => p.id === idWc).price), 130);
    assert.equal(guest.find((p) => p.id === id150).price, null, 'guests never see prices');
    await denied(retail.c.rpc('place_order', { p_lines: [{ product_id: id50, quantity: 1 }], p_delivery: delivery }), /RETAIL_PRICE_MISSING/);
    const o = ok(await wholesale.c.rpc('place_order', { p_lines: [{ product_id: id50, quantity: 2 }], p_delivery: delivery }));
    assert.equal(Number(o.total), 234);
    const r = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: id150, quantity: 1 }], p_delivery: delivery }));
    assert.equal(Number(r.total), 160);
    // app products (not from the website) keep the old behaviour
    const appP = ok(await service.from('products').select('id').eq('sku', 'HS-001').single());
    assert.ok(ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: appP.id, quantity: 1 }], p_delivery: delivery })).id);
  });

  test('webhook "product updated": the change appears at once (with the usual price notification)', async () => {
    const v = woo.state.variations[2738].find((x) => x.id === 2854);
    v.regular_price = '175';
    v.meta_data = [{ key: 'wholesale_customer_wholesale_price', value: '129' }];
    v.stock_status = 'instock';
    const r = await webhook('product.updated', { id: 2738, name: 'x' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const b80 = P(2854);
    assert.deepEqual([Number(b80.retail_price), Number(b80.wholesale_price), b80.stock], [175, 129, 999]);
    assert.equal(sql(`select count(*) from public.promo_events where product_id='${b80.id}' and kind='price'`), '1', 'price-change notification queued (sent only if promos are on)');
    // a size saved on its own → the whole product is re-read
    v.regular_price = '180';
    assert.equal((await webhook('product.updated', { id: 2854 })).status, 200);
    assert.equal(Number(P(2854).retail_price), 180);
  });

  test('webhook ping, unknown topics and "deleted": safe', async () => {
    assert.equal((await webhook('', 'webhook_id=12')).status, 200, 'WooCommerce ping when the webhook is saved');
    assert.equal((await webhook('order.created', { id: 1 })).status, 200);
    const r = await webhook('product.deleted', { id: 2738 });
    assert.equal(r.status, 200);
    assert.equal(sql("select count(*) from public.products where woo_parent_id=2738 and active"), '0', 'all sizes hidden');
    assert.ok(P(2853), 'kept (orders refer to it), only hidden');
  });

  test('full sync: product removed from the website → hidden; back again → visible; nothing duplicated', async () => {
    woo.state.products = woo.state.products.filter((p) => p.id !== 2742);
    let r = await call({ action: 'sync' }, { token: admin.token });
    assert.equal(r.json.result.deactivated >= 1, true, JSON.stringify(r.json.result));
    assert.equal(P(2742).active, false);
    assert.equal(P(2853).active, true, 'the deleted-by-webhook product is still on the site → visible again');
    woo.state.products = (await import('./woo-mock.mjs')).catalogue().products;
    r = await call({ action: 'sync' }, { token: admin.token });
    assert.equal(P(2742).active, true);
    assert.equal(sql("select count(*) from public.products where source='woo'"), '7');
    assert.equal(r.json.result.created, 0);
  });

  test('hosting firewall refusing a burst (HTTP 403): the sync waits, tries again and succeeds', async () => {
    woo.state.refuse403 = 2;
    const t0 = Date.now();
    const r = await call({ action: 'sync' }, { token: admin.token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(woo.state.refuse403, 0);
    assert.ok(Date.now() - t0 >= 2000, 'waited before trying again');
  });

  test('keys travel in the Authorization header, never in the URL', async () => {
    // locally the site is http, so only the header is used: the switch is checked on the request log
    const before = woo.state.requests.length;
    await call({ action: 'sync' }, { token: admin.token });
    const reqs = woo.state.requests.slice(before);
    assert.ok(reqs.length > 0 && reqs.every((x) => x.headerAuth && !x.query.consumer_secret), 'Basic auth header, keys never in the URL');
  });
});

describe('orders: app → website', () => {
  const tick = () => call({});

  test('switched OFF (default): orders stay in the app only', async () => {
    const id = P(2795).id;
    ok(await wholesale.c.rpc('place_order', { p_lines: [{ product_id: id, quantity: 1 }], p_delivery: delivery }));
    assert.equal(sql('select count(*) from public.woo_order_jobs'), '0');
    await tick();
    assert.equal(woo.state.orders.length, 0);
    assert.equal(ok(await admin.c.rpc('admin_woo_status')).orders_enabled, false);
  });

  test('switched ON: the order is created in WooCommerce with the app prices, sizes and customer', async () => {
    ok(await admin.c.rpc('admin_woo_set_orders', { p_enabled: true }));
    sql("update public.profiles set email='known@test.local' where id='" + wholesale.id + "'");
    const lines = [{ product_id: P(2853).id, quantity: 2 }, { product_id: P(2795).id, quantity: 1 },
      { product_id: ok(await service.from('products').select('id').eq('sku', 'HS-001').single()).id, quantity: 3 }];
    const o = ok(await wholesale.c.rpc('place_order', { p_lines: lines, p_delivery: { ...delivery, note: 'Thirrni para' } }));
    assert.equal(sql(`select kind||'/'||status from public.woo_order_jobs where order_id='${o.id}'`), 'create/pending');
    const r = await tick();
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.orders, { sent: 1, failed: 0 });
    const w = woo.state.orders.at(-1);
    assert.equal(w.status, 'processing');
    assert.equal(w.customer_id, 77, 'known customer e-mail → linked to the WooCommerce customer');
    assert.equal(w.payment_method, 'cod');
    assert.deepEqual([w.billing.first_name, w.billing.phone, w.billing.city, w.billing.company], ['Bleri', delivery.phone, delivery.city, 'Shumica Woo']);
    assert.match(w.customer_note, new RegExp(`#${o.order_number}[\\s\\S]*Thirrni para`));
    const l1 = w.line_items.find((l) => l.variation_id === 2853);
    const l2 = w.line_items.find((l) => l.product_id === 2795);
    const l3 = w.line_items.find((l) => l.sku === 'HS-001');
    assert.equal(w.line_items.length, 3);
    assert.deepEqual([l1.product_id, l1.variation_id, l1.quantity, l1.total], [2738, 2853, 2, '234.00'], 'size → parent + variation, wholesale price');
    assert.deepEqual([l2.product_id, l2.variation_id, l2.total], [2795, undefined, '100.00']);
    assert.equal(l3.product_id, undefined, 'app-only product: by name and SKU');
    assert.equal(l3.sku, 'HS-001');
    assert.equal(sql(`select woo_order_id from public.orders where id='${o.id}'`), String(w.id));
    assert.equal(sql(`select status from public.woo_order_jobs where order_id='${o.id}'`), 'sent');
  });

  test('status changes in the app panel follow the WooCommerce order', async () => {
    const o = woo.state.orders.at(-1);
    const appOrder = sql(`select id from public.orders where woo_order_id=${o.id}`);
    ok(await admin.c.rpc('admin_set_order_status', { p_order: appOrder, p_status: 'delivered', p_note: null }));
    await tick();
    assert.equal(o.status, 'completed');
  });

  test('website errors: retried, then "failed" (visible in the panel), retry button sends it', async () => {
    woo.state.failOrders = 5;
    const o = ok(await wholesale.c.rpc('place_order', { p_lines: [{ product_id: P(2795).id, quantity: 1 }], p_delivery: delivery }));
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(sql(`select status||'/'||attempts from public.woo_order_jobs where order_id='${o.id}'`), 'failed/5');
    const st = ok(await admin.c.rpc('admin_woo_status'));
    assert.equal(st.orders_failed, 1);
    assert.match(st.last_order_error, /HTTP 500/);
    assert.equal(ok(await admin.c.rpc('admin_woo_retry_orders')), 1);
    await tick();
    assert.equal(sql(`select status from public.woo_order_jobs where order_id='${o.id}'`), 'sent');
    assert.equal(woo.state.orders.filter((x) => x.customer_note.includes(`#${sql(`select order_number from public.orders where id='${o.id}'`)}`)).length, 1, 'created once');
  });

  test('panel status summary', async () => {
    const st = ok(await admin.c.rpc('admin_woo_status'));
    assert.equal(st.products, 7);
    assert.equal(st.products_no_retail >= 2, true, 'sizes / products without a retail price are counted');
    assert.ok(st.last_sync_at);
  });
});
