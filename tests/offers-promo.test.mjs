// Offers ("Ofertat e Momentit") + promotional notifications — database tests.
//   npx supabase start && npx supabase db reset && node --test --test-concurrency=1 tests/offers-promo.test.mjs
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { client, delivery, denied, makeAdmin, ok, service, signUp, sql } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (secondsFromNow) => new Date(Date.now() + secondsFromNow * 1000).toISOString();
let admin, retail, whole, tester, testerWhole, quiet, noToken, run;

async function product(sku, retailPrice, wholesalePrice, extra = {}) {
  const id = ok(await admin.c.rpc('admin_save_product', {
    p: { sku: `${sku}-${run}`, name: `Produkt ${sku}`, name_en: `Product ${sku}`, retail_price: retailPrice, wholesale_price: wholesalePrice, stock: 5, ...extra },
  }));
  return id;
}
const save = async (id, sku, r, w, extra = {}) =>
  ok(await admin.c.rpc('admin_save_product', { p: { id, sku: `${sku}-${run}`, name: `Produkt ${sku}`, name_en: `Product ${sku}`, retail_price: r, wholesale_price: w, stock: 5, ...extra } }));
const offer = async (items, starts = -60, ends = 3600, extra = {}) =>
  ok(await admin.c.rpc('admin_save_offer', {
    p: { title_sq: `Oferta ${Math.random().toString(36).slice(2, 6)}`, title_en: 'Offer', starts_at: iso(starts), ends_at: iso(ends), items, ...extra },
  }));
const priceOf = async (u, id) => ok(await (u ? u.c : client()).rpc('list_products')).find((p) => p.id === id);
const settings = (p) => admin.c.rpc('admin_set_promo_settings', { p });
const fanout = () => service.rpc('promo_fanout', { p_limit: 200 });
const promoFor = async (u, filter = {}) => {
  let q = service.from('notifications').select('type,data,category,event_id').eq('recipient_id', u.id).eq('category', 'promo');
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  return ok(await q);
};
const events = async (productId) => ok(await service.from('promo_events').select('*').eq('product_id', productId).order('created_at'));

before(async () => {
  run = Date.now().toString(36);
  // The local scheduler would fan out in the background; pause it so tests are deterministic.
  sql("select cron.alter_job(jobid, active := false) from cron.job where jobname like 'eko-%'");
  admin = await makeAdmin('promo-admin');
  retail = await signUp('promo-retail');
  whole = await signUp('promo-whole', { requested_wholesale: true, business_name: 'Shumica SHPK' });
  ok(await admin.c.rpc('admin_review_wholesale', { p_user: whole.id, p_approve: true }));
  tester = await signUp('promo-tester');
  testerWhole = await signUp('promo-tester-ws', { requested_wholesale: true, business_name: 'Tester Shumice' });
  ok(await admin.c.rpc('admin_review_wholesale', { p_user: testerWhole.id, p_approve: true }));
  quiet = await signUp('promo-quiet'); // opted out
  noToken = await signUp('promo-notoken'); // opted in but never allowed push
  for (const u of [retail, whole, tester, testerWhole, noToken]) {
    ok(await u.c.rpc('set_my_promo_preferences', { p_new_products: true, p_offers: true, p_price_changes: true }));
  }
  for (const u of [retail, whole, tester, testerWhole, quiet]) {
    ok(await u.c.rpc('register_push_token', { p_token: `ExponentPushToken[${u.id.slice(0, 8)}-${run}]`, p_platform: 'android' }));
  }
  for (const u of [tester, testerWhole]) ok(await admin.c.rpc('admin_set_promo_tester', { p_user: u.id, p_tester: true }));
});
after(() => sql("select cron.alter_job(jobid, active := true) from cron.job where jobname like 'eko-%'"));
beforeEach(async () => {
  // Default for tests: delivery on, no debounce, generous cap, test mode off unless a test says so.
  ok(await settings({ enabled: true, test_only: false, debounce_minutes: 0, daily_cap: 50 }));
  // Flush anything queued by earlier tests.
  ok(await fanout());
});

describe('offer prices', () => {
  test('retail, wholesale and guest prices with a live offer', async () => {
    const id = await product('A', 100, 70);
    await offer([{ product_id: id, offer_price: 85 }]);
    const r = await priceOf(retail, id);
    assert.deepEqual([Number(r.price), Number(r.regular_price), Number(r.offer_price)], [85, 100, 85]);
    assert.equal(r.wholesale_price, null, 'retail never sees wholesale price');
    const w = await priceOf(whole, id);
    assert.deepEqual([Number(w.price), Number(w.regular_price), w.offer_price], [70, 70, null], 'retail offer above wholesale price: no wholesale offer');
    const g = await priceOf(null, id);
    assert.deepEqual([g.price, g.regular_price, g.offer_price], [null, null, null], 'guests see no prices');
    assert.ok(g.offer_id, 'guests can see that the product is on offer');
  });

  test('wholesale offer price; wholesale never pays more than the retail offer', async () => {
    const a = await product('W1', 100, 80);
    const b = await product('W2', 100, 90);
    await offer([{ product_id: a, offer_price: 95, offer_wholesale_price: 60 }, { product_id: b, offer_price: 75 }]);
    assert.equal(Number((await priceOf(whole, a)).price), 60);
    assert.equal(Number((await priceOf(whole, b)).price), 75, 'retail offer 75 < wholesale 90');
    assert.equal(Number((await priceOf(retail, a)).price), 95);
  });

  test('scheduled offer starts and expires on time, then the regular price returns', async () => {
    const id = await product('S', 50, 40);
    await offer([{ product_id: id, offer_price: 45 }], 3, 6);
    assert.equal(Number((await priceOf(retail, id)).price), 50, 'not started yet');
    await sleep(3500);
    assert.equal(Number((await priceOf(retail, id)).price), 45, 'started');
    await sleep(3000);
    assert.equal(Number((await priceOf(retail, id)).price), 50, 'expired -> regular price');
    assert.equal((await events(id)).filter((e) => e.kind === 'price').length, 0, 'offer start/end never creates price events');
  });

  test('inactive and cancelled offers do not apply; lowest of two live offers wins', async () => {
    const id = await product('C', 40, 30);
    const o1 = await offer([{ product_id: id, offer_price: 35 }]);
    const o2 = await offer([{ product_id: id, offer_price: 32 }]);
    assert.equal(Number((await priceOf(retail, id)).price), 32);
    ok(await admin.c.rpc('admin_set_offer_active', { p_id: o2, p_active: false }));
    assert.equal(Number((await priceOf(retail, id)).price), 35);
    ok(await admin.c.rpc('admin_cancel_offer', { p_id: o1 }));
    assert.equal(Number((await priceOf(retail, id)).price), 40);
    await denied(admin.c.rpc('admin_set_offer_active', { p_id: o1, p_active: true }), /OFFER_CANCELLED/);
  });

  test('checkout charges the current server-side price and records the offer', async () => {
    const id = await product('O', 20, 15);
    const off = await offer([{ product_id: id, offer_price: 17 }], -60, 4);
    const o1 = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: id, quantity: 2, unit_price: 0.01 }], p_delivery: delivery }));
    assert.equal(Number(o1.total), 34);
    const line = ok(await service.from('order_items').select('unit_price,offer_id').eq('order_id', o1.id).single());
    assert.deepEqual([Number(line.unit_price), line.offer_id], [17, off]);
    await sleep(4500);
    const o2 = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: id, quantity: 2 }], p_delivery: delivery }));
    assert.equal(Number(o2.total), 40, 'after expiry: regular price');
    // the earlier order keeps its price
    assert.equal(Number(ok(await service.from('orders').select('total').eq('id', o1.id).single()).total), 34);
  });

  test('list_offers: retail sees discount, guests see no prices, wholesale only real discounts', async () => {
    const a = await product('L1', 100, 80);
    const b = await product('L2', 100, 60);
    const o = await offer([{ product_id: a, offer_price: 75 }, { product_id: b, offer_price: 90 }]);
    const rows = ok(await retail.c.rpc('list_offers')).filter((x) => x.offer_id === o);
    assert.deepEqual(rows.map((x) => [Number(x.regular_price), Number(x.offer_price), x.discount_percent]).sort(), [[100, 75, 25], [100, 90, 10]]);
    const guest = ok(await client().rpc('list_offers')).filter((x) => x.offer_id === o);
    assert.equal(guest.length, 2);
    assert.ok(guest.every((x) => x.regular_price === null && x.offer_price === null && x.discount_percent === null));
    const ws = ok(await whole.c.rpc('list_offers')).filter((x) => x.offer_id === o);
    assert.deepEqual(ws.map((x) => [x.product_id, Number(x.regular_price), Number(x.offer_price)]), [[a, 80, 75]], 'wholesale sees only products where the offer beats their price');
  });
});

describe('admin offer management', () => {
  test('validation: price must be below regular, valid dates, at least one product', async () => {
    const id = await product('V', 10, 8);
    await denied(admin.c.rpc('admin_save_offer', { p: { title_sq: 'x', starts_at: iso(0), ends_at: iso(60), items: [{ product_id: id, offer_price: 10 }] } }), /INVALID_OFFER_PRICE/);
    await denied(admin.c.rpc('admin_save_offer', { p: { title_sq: 'x', starts_at: iso(0), ends_at: iso(60), items: [{ product_id: id, offer_price: 9, offer_wholesale_price: 8 }] } }), /INVALID_OFFER_PRICE/);
    await denied(admin.c.rpc('admin_save_offer', { p: { title_sq: 'x', starts_at: iso(60), ends_at: iso(0), items: [{ product_id: id, offer_price: 9 }] } }), /INVALID_OFFER_DATES/);
    await denied(admin.c.rpc('admin_save_offer', { p: { title_sq: 'x', starts_at: iso(0), ends_at: iso(60), items: [] } }), /OFFER_ITEMS_REQUIRED/);
    await denied(admin.c.rpc('admin_save_offer', { p: { title_sq: '', starts_at: iso(0), ends_at: iso(60), items: [{ product_id: id, offer_price: 9 }] } }), /OFFER_TITLE_REQUIRED/);
  });

  test('edit / extend keeps the offer, list shows states', async () => {
    const id = await product('E', 10, 8);
    const o = await offer([{ product_id: id, offer_price: 9 }], -60, 60);
    const list = ok(await admin.c.rpc('admin_list_offers'));
    assert.equal(list.find((x) => x.id === o).state, 'live');
    ok(await admin.c.rpc('admin_save_offer', { p: { id: o, title_sq: 'Zgjatur', starts_at: iso(-60), ends_at: iso(86400), items: [{ product_id: id, offer_price: 8.5 }] } }));
    const x = ok(await admin.c.rpc('admin_list_offers')).find((y) => y.id === o);
    assert.equal(x.title_sq, 'Zgjatur');
    assert.equal(Number(x.items[0].offer_price), 8.5);
    const s = await offer([{ product_id: id, offer_price: 9 }], 3600, 7200);
    assert.equal(ok(await admin.c.rpc('admin_list_offers')).find((y) => y.id === s).state, 'scheduled');
  });

  test('only admins: customers and guests cannot manage offers or read offer tables directly', async () => {
    const id = await product('X', 10, 8);
    for (const c of [retail.c, whole.c]) {
      await denied(c.rpc('admin_save_offer', { p: { title_sq: 'x', starts_at: iso(0), ends_at: iso(60), items: [{ product_id: id, offer_price: 1 }] } }), /ADMIN_ONLY/);
      await denied(c.rpc('admin_list_offers'), /ADMIN_ONLY/);
      await denied(c.rpc('admin_set_promo_settings', { p: { enabled: true } }), /ADMIN_ONLY/);
      await denied(c.rpc('admin_set_promo_tester', { p_user: retail.id, p_tester: true }), /ADMIN_ONLY/);
      await denied(c.from('offers').select('*'));
      await denied(c.from('offer_items').select('*'));
      await denied(c.from('promo_events').select('*'));
      await denied(c.from('promo_settings').select('*'));
      await denied(c.rpc('promo_fanout', { p_limit: 1 }));
      await denied(c.rpc('process_offer_activations'));
    }
    await denied(client().rpc('admin_list_offers'));
    await denied(client().from('offers').select('*'));
    // a customer cannot make themselves a promo tester
    ok(await retail.c.rpc('update_my_profile', { p: { promo_tester: true } }));
    assert.equal(ok(await retail.c.from('profiles').select('promo_tester').single()).promo_tester, false);
  });
});

describe('promotional notifications', () => {
  test('new product -> one notification to each opted-in customer with a push token', async () => {
    const id = await product('N', 30, 20);
    ok(await fanout());
    for (const u of [retail, whole, tester]) {
      const n = await promoFor(u, { type: 'promo_new_product' });
      assert.equal(n.filter((x) => x.data.product_id === id).length, 1, u.email);
    }
    assert.equal((await promoFor(quiet)).filter((x) => x.data.product_id === id).length, 0, 'opted out');
    assert.equal((await promoFor(noToken)).filter((x) => x.data.product_id === id).length, 0, 'no push permission');
    assert.equal((await promoFor(admin)).length, 0, 'admins are not marketing recipients');
    // inactive product published later -> notified at activation, once
    const hidden = await product('H', 30, 20, { active: false });
    ok(await fanout());
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === hidden).length, 0);
    await save(hidden, 'H', 30, 20, { active: true });
    await save(hidden, 'H', 30, 20, { active: false });
    await save(hidden, 'H', 30, 20, { active: true });
    ok(await fanout());
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === hidden).length, 1, 'no duplicate on re-activation');
  });

  test('price decrease and increase: correct type, name, old/new price for the recipient tier only', async () => {
    const id = await product('P', 100, 70);
    ok(await fanout());
    await save(id, 'P', 85, 65);
    ok(await fanout());
    const r = (await promoFor(retail)).find((x) => x.data.product_id === id && x.type.startsWith('promo_price'));
    assert.equal(r.type, 'promo_price_down');
    assert.deepEqual([Number(r.data.old), Number(r.data.new)], [100, 85]);
    assert.equal(r.data.name, `Produkt P`);
    // Exactly these fields, and only the retail prices (wholesale was 70 -> 65).
    assert.deepEqual(Object.keys(r.data).sort(), ['name', 'name_en', 'new', 'old', 'product_id']);
    assert.ok(![70, 65].includes(Number(r.data.old)) && ![70, 65].includes(Number(r.data.new)), 'no wholesale prices for retail');
    const w = (await promoFor(whole)).find((x) => x.data.product_id === id && x.type.startsWith('promo_price'));
    assert.deepEqual([w.type, Number(w.data.old), Number(w.data.new)], ['promo_price_down', 70, 65], 'wholesale gets wholesale prices');
    await save(id, 'P', 95, 65);
    ok(await fanout());
    const up = (await promoFor(retail)).filter((x) => x.data.product_id === id && x.type === 'promo_price_up');
    assert.deepEqual(up.map((x) => [Number(x.data.old), Number(x.data.new)]), [[85, 95]]);
    assert.equal((await promoFor(whole)).filter((x) => x.data.product_id === id && x.type === 'promo_price_up').length, 0, 'wholesale price unchanged -> wholesale not notified');
  });

  test('rapid edits are merged into one notification; editing back to the old price sends nothing', async () => {
    ok(await settings({ debounce_minutes: 5 }));
    const id = await product('M', 50, 40);
    sql(`update public.promo_events set updated_at = now() - interval '10 minutes' where product_id = '${id}'`);
    ok(await fanout());
    await save(id, 'M', 48, 40);
    await save(id, 'M', 45, 40);
    await save(id, 'M', 44, 40);
    ok(await fanout());
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === id && x.type.startsWith('promo_price')).length, 0, 'still waiting (debounce)');
    assert.equal((await events(id)).filter((e) => e.kind === 'price').length, 1, 'one merged event');
    sql(`update public.promo_events set updated_at = now() - interval '10 minutes' where product_id = '${id}' and status = 'pending'`);
    ok(await fanout());
    const n = (await promoFor(retail)).filter((x) => x.data.product_id === id && x.type.startsWith('promo_price'));
    assert.deepEqual(n.map((x) => [x.type, Number(x.data.old), Number(x.data.new)]), [['promo_price_down', 50, 44]]);
    // back and forth -> nothing
    await save(id, 'M', 60, 40);
    await save(id, 'M', 44, 40);
    const ev = (await events(id)).filter((e) => e.kind === 'price');
    assert.equal(ev.at(-1).status, 'skipped');
  });

  test('offer becoming active -> one notification; reactivate / extend / expiry -> none', async () => {
    const id = await product('F', 20, 15);
    ok(await fanout());
    const o = await offer([{ product_id: id, offer_price: 18 }], 2, 3600);
    ok(await fanout());
    assert.equal((await promoFor(retail, { type: 'promo_offer' })).filter((x) => x.data.offer_id === o).length, 0, 'scheduled: not yet');
    await sleep(2500);
    ok(await service.rpc('process_offer_activations'));
    ok(await fanout());
    const first = (await promoFor(retail, { type: 'promo_offer' })).filter((x) => x.data.offer_id === o);
    assert.equal(first.length, 1, 'notified when it became active');
    ok(await admin.c.rpc('admin_set_offer_active', { p_id: o, p_active: false }));
    ok(await admin.c.rpc('admin_set_offer_active', { p_id: o, p_active: true }));
    ok(await admin.c.rpc('admin_save_offer', { p: { id: o, title_sq: 'Zgjatur', starts_at: iso(-10), ends_at: iso(86400), items: [{ product_id: id, offer_price: 17 }] } }));
    ok(await service.rpc('process_offer_activations'));
    ok(await fanout());
    assert.equal((await promoFor(retail, { type: 'promo_offer' })).filter((x) => x.data.offer_id === o).length, 1, 'no duplicates');
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === id && x.type.startsWith('promo_price')).length, 0, 'offer price is not a "price change"');
  });

  test('master switch OFF: events are suppressed, nobody is notified (also not later)', async () => {
    ok(await settings({ enabled: false }));
    const id = await product('Off', 10, 8);
    ok(await fanout());
    assert.equal((await events(id))[0].status, 'suppressed');
    ok(await settings({ enabled: true }));
    ok(await fanout());
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === id).length, 0);
  });

  test('TEST MODE: only promo testers receive notifications, never real customers', async () => {
    ok(await settings({ test_only: true }));
    const id = await product('T', 10, 8);
    ok(await fanout());
    assert.equal((await promoFor(tester)).filter((x) => x.data.product_id === id).length, 1, 'retail tester');
    assert.equal((await promoFor(testerWhole)).filter((x) => x.data.product_id === id).length, 1, 'wholesale tester');
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === id).length, 0, 'real retail customer');
    assert.equal((await promoFor(whole)).filter((x) => x.data.product_id === id).length, 0, 'real wholesale customer');
  });

  test('per-type preferences and daily cap', async () => {
    ok(await retail.c.rpc('set_my_promo_preferences', { p_new_products: false, p_offers: true, p_price_changes: true }));
    const id = await product('Pref', 10, 8);
    ok(await fanout());
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === id).length, 0, 'new-product type switched off');
    ok(await retail.c.rpc('set_my_promo_preferences', { p_new_products: true, p_offers: true, p_price_changes: true }));
    // cap: count what retail already got in 24h, set cap to that -> next event skipped for retail
    const already = (await promoFor(retail)).length;
    ok(await settings({ daily_cap: already }));
    const id2 = await product('Cap', 10, 8);
    ok(await fanout());
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === id2).length, 0, 'daily cap reached');
  });

  test('fan-out twice never duplicates; order notifications stay separate', async () => {
    const id = await product('D', 10, 8);
    ok(await fanout());
    ok(await fanout());
    sql(`update public.promo_events set status = 'pending' where product_id = '${id}'`); // simulate a retry
    ok(await fanout());
    assert.equal((await promoFor(retail)).filter((x) => x.data.product_id === id).length, 1);
    const o = ok(await retail.c.rpc('place_order', { p_lines: [{ product_id: id, quantity: 1 }], p_delivery: delivery }));
    const adminNotes = ok(await service.from('notifications').select('category,type').eq('recipient_id', admin.id).eq('type', 'new_order'));
    assert.ok(adminNotes.length > 0 && adminNotes.every((x) => x.category === 'order'));
    assert.ok(o.id);
  });

  test('notifications are readable only by their recipient', async () => {
    const mine = ok(await retail.c.from('notifications').select('recipient_id'));
    assert.ok(mine.every((x) => x.recipient_id === retail.id));
  });
});
