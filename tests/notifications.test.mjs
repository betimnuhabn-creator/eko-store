// Notification delivery tests: the Edge Function talks to a FAKE push/e-mail
// server started by this test, so success, failure, retry and give-up can be
// checked without real Expo/Resend accounts.
//
//   npx supabase start && npx supabase db reset
//   npx supabase functions serve --env-file tests/functions.test.env   (other terminal)
//   node --test tests/notifications.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { KEY, URL, delivery, env, makeAdmin, ok, productBySku, service, signUp } from './helpers.mjs';

// ---- fake Expo push + Resend --------------------------------------------
const mock = { push: 'ok', email: 'ok', pushes: [], emails: [] };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    if (req.url === '/push') {
      mock.pushes.push(...json);
      if (mock.push === 'down') return res.writeHead(503).end('down');
      const data = json.map((m) =>
        m.to.includes('dead') ? { status: 'error', details: { error: 'DeviceNotRegistered' } }
        : m.to.includes('flaky') ? { status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } }
        : { status: 'ok', id: 'ticket' });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    }
    if (req.url === '/email') {
      mock.emails.push(json);
      if (mock.email === 'down') return res.writeHead(500).end('{"message":"smtp down"}');
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"e1"}');
    }
    res.writeHead(404).end();
  });
});

const dispatch = async () => {
  const r = await fetch(`${URL}/functions/v1/dispatch-notifications`, {
    // Server key: the response then includes the counts the tests need.
    method: 'POST', headers: { apikey: env.SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  return j;
};
const note = async (id) => ok(await service.from('notifications').select('*').eq('id', id).single());
const latest = async (recipient, type) =>
  ok(await service.from('notifications').select('*').eq('recipient_id', recipient).eq('type', type)
    .order('created_at', { ascending: false }).limit(1).single());

let admin, customer, p1;

before(async () => {
  await new Promise((r) => server.listen(9099, '0.0.0.0', r));
  admin = await makeAdmin('nt-admin');
  customer = await signUp('nt-customer');
  p1 = await productBySku('HS-001');
  ok(await admin.c.rpc('register_push_token', { p_token: 'ExponentPushToken[admin-ok]', p_platform: 'android' }));
  // flush everything queued before this test
  for (let i = 0; i < 10 && (await dispatch()).claimed > 0; i++);
});
after(() => server.close());
beforeEach(() => {
  mock.push = 'ok';
  mock.email = 'ok';
  mock.pushes = [];
  mock.emails = [];
});

const newOrder = async () => {
  const o = ok(await customer.c.rpc('place_order', { p_lines: [{ product_id: p1.id, quantity: 1 }], p_delivery: delivery }));
  return { order: o, n: await latest(admin.id, 'new_order') };
};

describe('notification delivery', () => {
  test('anonymous callers (Verify JWT OFF): delivery works, but they learn nothing and cannot use other methods', async () => {
    const { n } = await newOrder();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${URL}/functions/v1/dispatch-notifications`, { method, headers: { apikey: KEY } });
      assert.equal(r.status, 405, method);
      await r.text();
    }
    assert.equal((await note(n.id)).dispatched_at, null, 'other methods did not dispatch anything');
    // No key at all, publishable key, a customer's session, and a forged key: same minimal answer.
    const customerToken = (await customer.c.auth.getSession()).data.session.access_token;
    for (const headers of [{}, { apikey: KEY }, { apikey: KEY, Authorization: `Bearer ${customerToken}` },
      { apikey: 'x'.repeat(env.SERVICE_ROLE_KEY.length) }, { Authorization: `Bearer ${env.SERVICE_ROLE_KEY.slice(0, -1)}x` }]) {
      const r = await fetch(`${URL}/functions/v1/dispatch-notifications`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        // A body is ignored: it can neither add recipients nor change what is sent.
        body: JSON.stringify({ recipient_id: customer.id, type: 'promo_offer', title: 'phish', p_limit: 100000 }),
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true }, 'no counts, no details for anonymous callers');
    }
    assert.ok((await note(n.id)).dispatched_at, 'the queued notification was delivered normally');
    assert.ok(mock.pushes.every((m) => m.title !== 'phish'), 'nothing from the request was sent');
  });

  test('success: push + admin e-mail sent, then marked dispatched', async () => {
    const { order, n } = await newOrder();
    assert.equal(n.dispatched_at, null);
    const r = await dispatch();
    assert.ok(r.delivered >= 1 && r.failed === 0, JSON.stringify(r));
    const after = await note(n.id);
    assert.ok(after.dispatched_at, 'dispatched');
    assert.equal(after.claimed_at, null);
    assert.equal(after.attempts, 1);
    assert.ok(mock.pushes.some((m) => m.to === 'ExponentPushToken[admin-ok]' && m.title === `Porosi e re #${order.order_number}`));
    assert.ok(mock.emails.some((e) => e.subject === `EKO Store: Porosi e re #${order.order_number}` && e.to.includes(admin.email)));
  });

  test('push service down: NOT marked dispatched, error kept, retried later', async () => {
    const { n } = await newOrder();
    mock.push = 'down';
    const r = await dispatch();
    assert.ok(r.failed >= 1, JSON.stringify(r));
    let s = await note(n.id);
    assert.equal(s.dispatched_at, null, 'must not be marked dispatched');
    assert.equal(s.claimed_at, null, 'released for retry');
    assert.equal(s.attempts, 1);
    assert.match(s.last_error, /push HTTP 503/);
    mock.push = 'ok';
    await dispatch();
    s = await note(n.id);
    assert.ok(s.dispatched_at, 'delivered on retry');
    assert.equal(s.attempts, 2);
    assert.equal(s.last_error, null);
  });

  test('e-mail service down: NOT marked dispatched', async () => {
    const { n } = await newOrder();
    mock.email = 'down';
    await dispatch();
    const s = await note(n.id);
    assert.equal(s.dispatched_at, null);
    assert.match(s.last_error, /email HTTP 500/);
    mock.email = 'ok';
    await dispatch();
    assert.ok((await note(n.id)).dispatched_at);
  });

  test('error ticket from Expo (e.g. rate limit): retried', async () => {
    ok(await customer.c.rpc('register_push_token', { p_token: 'ExponentPushToken[flaky-1]', p_platform: 'android' }));
    ok(await admin.c.rpc('admin_set_order_status', { p_order: (await newOrder()).order.id, p_status: 'confirmed', p_note: null }));
    const n = await latest(customer.id, 'order_status');
    await dispatch();
    const s = await note(n.id);
    assert.equal(s.dispatched_at, null);
    assert.match(s.last_error, /MessageRateExceeded/);
    ok(await customer.c.rpc('unregister_push_token', { p_token: 'ExponentPushToken[flaky-1]' }));
    await dispatch();
    assert.ok((await note(n.id)).dispatched_at, 'delivered once the bad token is gone');
  });

  test('uninstalled app (DeviceNotRegistered): token removed, notification completed', async () => {
    ok(await customer.c.rpc('register_push_token', { p_token: 'ExponentPushToken[dead-1]', p_platform: 'android' }));
    ok(await admin.c.rpc('admin_set_order_status', { p_order: (await newOrder()).order.id, p_status: 'preparing', p_note: null }));
    const n = await latest(customer.id, 'order_status');
    await dispatch();
    assert.ok((await note(n.id)).dispatched_at);
    const tokens = ok(await service.from('push_tokens').select('token').eq('token', 'ExponentPushToken[dead-1]'));
    assert.equal(tokens.length, 0);
  });

  test('gives up after 5 failed attempts (and keeps the error)', async () => {
    const { n } = await newOrder();
    mock.push = 'down';
    for (let i = 1; i <= 5; i++) {
      await dispatch();
      const s = await note(n.id);
      assert.equal(s.attempts, i);
      assert.equal(Boolean(s.dispatched_at), i === 5, `attempt ${i}`);
    }
    const s = await note(n.id);
    assert.match(s.last_error, /push HTTP 503/);
    mock.push = 'ok';
    mock.pushes = [];
    await dispatch();
    assert.equal((await note(n.id)).attempts, 5, 'not retried any more');
  });

  test('crash safety: a claimed but unfinished notification is retried after its lease expires', async () => {
    const { n } = await newOrder();
    const claimed = ok(await service.rpc('claim_notifications', { p_limit: 500 }));   // simulate a crashed run
    assert.ok(claimed.some((c) => c.id === n.id));
    await dispatch();
    let s = await note(n.id);
    assert.equal(s.dispatched_at, null, 'leased notification not taken by another run');
    ok(await service.from('notifications').update({ claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() }).eq('id', n.id));
    await dispatch();
    s = await note(n.id);
    assert.ok(s.dispatched_at, 'delivered after the lease expired');
  });

  test('in-app notification is visible immediately, independent of delivery', async () => {
    const { n } = await newOrder();
    mock.push = 'down';
    await dispatch();
    const mine = ok(await admin.c.from('notifications').select('id').eq('id', n.id));
    assert.equal(mine.length, 1);
  });
});

describe('promotional push notifications (offers migration)', () => {
  test('new product, price drop and price increase: texts, channel, deep link, no admin e-mail', async () => {
    const promoUser = await signUp('nt-promo');
    ok(await promoUser.c.rpc('set_my_promo_preferences', { p_new_products: true, p_offers: true, p_price_changes: true }));
    ok(await promoUser.c.rpc('register_push_token', { p_token: 'ExponentPushToken[promo-ok]', p_platform: 'android' }));
    ok(await admin.c.rpc('admin_set_promo_settings', { p: { enabled: true, test_only: false, debounce_minutes: 0, daily_cap: 50 } }));
    const save = (p) => admin.c.rpc('admin_save_product', { p: { sku: `NT-PROMO-${Date.now()}`, name: 'Bojler 80L', name_en: 'Boiler 80L', retail_price: 100, wholesale_price: 70, stock: 1, ...p } });
    const pid = ok(await save({}));
    await dispatch();
    let m = mock.pushes.find((x) => x.to === 'ExponentPushToken[promo-ok]' && x.data.url === `/product/${pid}`);
    assert.equal(m.title, 'EKO Store – Produkt i ri!');
    assert.equal(m.body, 'Shikoni produktin tonë më të ri: Bojler 80L.');
    assert.equal(m.channelId, 'promotions');
    assert.equal(m.data.url, `/product/${pid}`);
    assert.equal(m.data.category, 'promo');
    const sku = ok(await service.from('products').select('sku').eq('id', pid).single()).sku;
    mock.pushes = [];
    ok(await admin.c.rpc('admin_save_product', { p: { id: pid, sku, name: 'Bojler 80L', name_en: 'Boiler 80L', retail_price: 85, wholesale_price: 70, stock: 1 } }));
    await dispatch();
    m = mock.pushes.find((x) => x.to === 'ExponentPushToken[promo-ok]' && x.data.url === `/product/${pid}`);
    assert.equal(m.title, 'EKO Store – Ulje çmimi!');
    assert.equal(m.body, 'Produkti Bojler 80L nga 100€ tani 85€.');
    mock.pushes = [];
    ok(await admin.c.rpc('admin_save_product', { p: { id: pid, sku, name: 'Bojler 80L', name_en: 'Boiler 80L', retail_price: 95, wholesale_price: 70, stock: 1 } }));
    await dispatch();
    m = mock.pushes.find((x) => x.to === 'ExponentPushToken[promo-ok]' && x.data.url === `/product/${pid}`);
    assert.equal(m.title, 'EKO Store – Ndryshim çmimi!');
    assert.equal(m.body, 'Produkti Bojler 80L nga 85€ tani 95€.');
    assert.equal(mock.emails.filter((e) => /Produkt|çmim/i.test(e.subject)).length, 0, 'no admin e-mail for promotions');
    // order notifications keep the default channel
    const p = await productBySku('HS-001');
    mock.pushes = [];
    ok(await customer.c.rpc('place_order', { p_lines: [{ product_id: p.id, quantity: 1 }], p_delivery: delivery }));
    await dispatch();
    const order = mock.pushes.find((x) => x.to === 'ExponentPushToken[admin-ok]');
    assert.equal(order.channelId, 'default');
    assert.equal(order.data.category, 'order');
    ok(await admin.c.rpc('admin_set_promo_settings', { p: { enabled: false } }));
  });

  test('offer becoming active: push opens the offer', async () => {
    const promoUser = await signUp('nt-promo2');
    ok(await promoUser.c.rpc('set_my_promo_preferences', { p_new_products: false, p_offers: true, p_price_changes: false }));
    ok(await promoUser.c.rpc('register_push_token', { p_token: 'ExponentPushToken[promo-offer]', p_platform: 'android' }));
    ok(await admin.c.rpc('admin_set_promo_settings', { p: { enabled: true, test_only: false, debounce_minutes: 0 } }));
    const p = await productBySku('HS-001');
    const oid = ok(await admin.c.rpc('admin_save_offer', { p: {
      title_sq: 'Javët e banjës', title_en: 'Bathroom weeks',
      starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(),
      items: [{ product_id: p.id, offer_price: 29.9 }] } }));
    await dispatch();
    const m = mock.pushes.find((x) => x.to === 'ExponentPushToken[promo-offer]');
    assert.equal(m.title, 'EKO Store – Ofertë speciale!');
    assert.equal(m.body, 'Përfitoni nga çmimet promocionale: Javët e banjës.');
    assert.equal(m.data.url, `/offers/${oid}`);
    ok(await admin.c.rpc('admin_set_promo_settings', { p: { enabled: false } }));
  });
});
