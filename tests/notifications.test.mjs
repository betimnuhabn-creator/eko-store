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
import { KEY, URL, delivery, makeAdmin, ok, productBySku, service, signUp } from './helpers.mjs';

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
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}',
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
