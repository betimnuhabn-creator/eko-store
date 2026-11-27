// Database-level tests of claim_notifications() / finish_notifications():
// leases, claim tokens, stale workers, retries, give-up. No Edge Function needed.
//   npx supabase start && npx supabase db reset && node --test tests/notify-db.test.mjs
import assert from 'node:assert/strict';
import { before, beforeEach, describe, test } from 'node:test';
import { ok, service, signUp } from './helpers.mjs';

let user;
const claim = async (limit = 500) => ok(await service.rpc('claim_notifications', { p_limit: limit }));
const finish = async (token, delivered = [], failed = [], error = null) =>
  ok(await service.rpc('finish_notifications', { p_claim: token, p_delivered: delivered, p_failed: failed, p_error: error }));
const get = async (id) => ok(await service.from('notifications').select('*').eq('id', id).single());
const add = async (n = 1, extra = {}) =>
  ok(await service.from('notifications')
    .insert(Array.from({ length: n }, (_, i) => ({ recipient_id: user.id, type: 'new_customer', data: { i }, ...extra })))
    .select('id')).map((r) => r.id);
const expireLease = (ids) =>
  service.from('notifications').update({ claimed_at: new Date(Date.now() - 6 * 60_000).toISOString() }).in('id', ids);

before(async () => {
  user = await signUp('ndb');
});
// Start each test with an empty delivery queue (local test database only).
beforeEach(async () => {
  ok(await service.from('notifications').update({ dispatched_at: new Date().toISOString(), claim_token: null, claimed_at: null })
    .is('dispatched_at', null));
});

describe('claim_notifications()', () => {
  test('one claim token per batch, attempts + 1, lease set, nothing marked delivered', async () => {
    const ids = await add(3);
    const rows = await claim();
    assert.deepEqual(rows.map((r) => r.id).sort(), ids.slice().sort());
    assert.equal(new Set(rows.map((r) => r.claim_token)).size, 1);
    for (const id of ids) {
      const n = await get(id);
      assert.equal(n.attempts, 1);
      assert.ok(n.claimed_at);
      assert.equal(n.claim_token, rows[0].claim_token);
      assert.equal(n.dispatched_at, null);
    }
  });

  test('leased notifications are not claimed again until the lease expires', async () => {
    const [id] = await add(1);
    await claim();
    assert.equal((await claim()).length, 0);
    ok(await expireLease([id]));
    const again = await claim();
    assert.deepEqual(again.map((r) => r.id), [id]);
    assert.equal((await get(id)).attempts, 2);
  });

  test('two workers claiming at the same moment never get the same notification', async () => {
    const ids = await add(60);
    const [a, b] = await Promise.all([claim(40), claim(40)]);
    const seen = [...a, ...b].map((r) => r.id);
    assert.equal(seen.length, new Set(seen).size, 'no duplicates');
    assert.deepEqual(seen.sort(), ids.slice().sort());
    if (a.length && b.length) assert.notEqual(a[0].claim_token, b[0].claim_token);
  });

  test('notifications older than 2 days are not sent any more', async () => {
    await add(1, { created_at: new Date(Date.now() - 3 * 86400_000).toISOString() });
    assert.equal((await claim()).length, 0);
  });
});

describe('finish_notifications()', () => {
  test('UPDATE 1 (delivered): dispatched_at set, lease and token cleared, error cleared', async () => {
    const [id] = await add(1);
    const [c] = await claim();
    assert.equal(await finish(c.claim_token, [id]), 1);
    const n = await get(id);
    assert.ok(n.dispatched_at);
    assert.equal(n.claimed_at, null);
    assert.equal(n.claim_token, null);
    assert.equal(n.last_error, null);
  });

  test('UPDATE 2 (failed): released for retry with the error kept, claimable again', async () => {
    const [id] = await add(1);
    const [c] = await claim();
    assert.equal(await finish(c.claim_token, [], [id], 'push HTTP 503'), 1);
    const n = await get(id);
    assert.equal(n.dispatched_at, null);
    assert.equal(n.claimed_at, null);
    assert.equal(n.claim_token, null);
    assert.equal(n.last_error, 'push HTTP 503');
    assert.deepEqual((await claim()).map((r) => r.id), [id], 'retried on the next run');
  });

  test('mixed batch: each row handled by the right UPDATE, return value = rows updated', async () => {
    const ids = await add(4);
    const [c] = await claim();
    assert.equal(await finish(c.claim_token, [ids[0], ids[1]], [ids[2]], 'x'), 3);
    assert.ok((await get(ids[0])).dispatched_at);
    assert.ok((await get(ids[1])).dispatched_at);
    assert.equal((await get(ids[2])).dispatched_at, null);
    const left = await get(ids[3]);   // not reported by the worker
    assert.equal(left.dispatched_at, null);
    assert.equal(left.claim_token, c.claim_token, 'stays leased until the lease expires');
  });

  test('an id listed as delivered AND failed counts as failed', async () => {
    const [id] = await add(1);
    const [c] = await claim();
    assert.equal(await finish(c.claim_token, [id], [id], 'email HTTP 500'), 1);
    const n = await get(id);
    assert.equal(n.dispatched_at, null);
    assert.equal(n.last_error, 'email HTTP 500');
  });

  test('missing error text gets a default message', async () => {
    const [id] = await add(1);
    const [c] = await claim();
    await finish(c.claim_token, [], [id], null);
    assert.equal((await get(id)).last_error, 'delivery failed');
  });

  test('wrong token or null token changes nothing', async () => {
    const [id] = await add(1);
    const [c] = await claim();
    assert.equal(await finish('00000000-0000-0000-0000-000000000000', [id], []), 0);
    assert.equal(await finish(null, [id], []), 0);
    const n = await get(id);
    assert.equal(n.dispatched_at, null);
    assert.equal(n.claim_token, c.claim_token);
  });

  test('ids outside the worker\'s claim are ignored', async () => {
    const [mine] = await add(1);
    const [c] = await claim();
    const [other] = await add(1);           // created after the claim, never claimed
    assert.equal(await finish(c.claim_token, [mine, other], []), 1);
    assert.equal((await get(other)).dispatched_at, null);
  });

  test('finishing twice with the same token has no further effect', async () => {
    const [id] = await add(1);
    const [c] = await claim();
    assert.equal(await finish(c.claim_token, [], [id], 'first'), 1);
    assert.equal(await finish(c.claim_token, [id], []), 0);
    assert.equal((await get(id)).dispatched_at, null);
  });

  test('STALE WORKER cannot acknowledge another worker\'s claim', async () => {
    const [id] = await add(1);
    const [a] = await claim();                       // worker A
    ok(await expireLease([id]));                      // A stalls past its lease
    const [b] = await claim();                       // worker B re-claims
    assert.notEqual(a.claim_token, b.claim_token);
    assert.equal(await finish(a.claim_token, [id], []), 0, 'A cannot mark it delivered');
    assert.equal(await finish(a.claim_token, [], [id], 'A failed'), 0, 'A cannot release it');
    let n = await get(id);
    assert.equal(n.dispatched_at, null);
    assert.equal(n.claim_token, b.claim_token, 'still owned by B');
    assert.equal(n.attempts, 2);
    assert.equal(await finish(b.claim_token, [id], []), 1, 'B acknowledges');
    n = await get(id);
    assert.ok(n.dispatched_at);
  });

  test('gives up after the 5th failed attempt and keeps the last error', async () => {
    const [id] = await add(1);
    for (let i = 1; i <= 5; i++) {
      const rows = await claim();
      assert.deepEqual(rows.map((r) => r.id), [id], `claimed on attempt ${i}`);
      await finish(rows[0].claim_token, [], [id], `fail ${i}`);
      const n = await get(id);
      assert.equal(n.attempts, i);
      assert.equal(Boolean(n.dispatched_at), i === 5);
    }
    assert.equal((await get(id)).last_error, 'fail 5');
    assert.equal((await claim()).length, 0, 'not claimed any more');
  });

  test('a notification already delivered is never changed again', async () => {
    const [id] = await add(1);
    const [c] = await claim();
    await finish(c.claim_token, [id], []);
    const before = await get(id);
    assert.equal(await finish(c.claim_token, [], [id], 'late'), 0);
    assert.deepEqual(await get(id), before);
  });
});
