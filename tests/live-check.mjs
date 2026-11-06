// Smoke test against a REAL Supabase project, using ONLY the publishable/anon key
// (the same access the Android and web apps have).
//
//   node tests/live-check.mjs setup    # guest + retail checks, creates test accounts
//   (approve the business test account in the admin panel, or with SQL)
//   node tests/live-check.mjs verify   # wholesale price + wholesale order checks
//
// Reads EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY from the
// environment or from .env. Test account details are kept in
// .live-check.json (git-ignored) so `verify` can log in again.
// Test accounts use the domain set in LIVE_CHECK_DOMAIN (default eko-test.invalid).
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!URL || !KEY) throw new Error('Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
if (/^sb_secret_/.test(KEY) || /service_role/.test(Buffer.from(KEY.split('.')[1] ?? '', 'base64').toString())) {
  throw new Error('This is a SECRET key. Use the publishable/anon key.');
}

const STATE = '.live-check.json';
const domain = process.env.LIVE_CHECK_DOMAIN ?? 'eko-test.invalid';
const mode = process.argv[2] ?? 'setup';
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const delivery = { name: 'Test EKO', phone: '+38344000000', address: 'Adresë testimi 1', city: 'Prishtinë', note: 'TEST – mos e dërgo', payment_method: 'cash_on_delivery' };

let failures = 0;
const pass = (m) => console.log(`  ✔ ${m}`);
const fail = (m) => (failures++, console.log(`  ✖ ${m}`));
const check = (cond, m, detail = '') => (cond ? pass(m) : fail(`${m}${detail ? ` — ${detail}` : ''}`));

async function login(email, password) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email, password });
  return { c, error };
}

async function setup() {
  console.log(`Project: ${URL}\n\n1. Database setup`);
  const guest = client();
  const cats = await guest.from('categories').select('id');
  check(!cats.error, 'categories table exists (migration has run)', cats.error?.message);
  const list = await guest.rpc('list_products');
  check(!list.error, 'list_products() is available', list.error?.message);
  if (list.error) return;
  const direct = await guest.from('products').select('wholesale_price').limit(1);
  check(!!direct.error, 'products table cannot be read directly (RLS/grants)');
  const bucket = await fetch(`${URL}/storage/v1/object/public/product-images/__probe__.jpg`);
  const bucketBody = await bucket.text();
  check(!/bucket not found/i.test(bucketBody) && bucket.status < 500, 'storage bucket product-images exists', `HTTP ${bucket.status} ${bucketBody.slice(0, 80)}`);

  console.log('\n2. Guest');
  const products = list.data ?? [];
  check(products.length > 0, `catalog has products (${products.length})`, 'add at least one product in the admin panel');
  check(products.every((p) => p.price === null && p.wholesale_price === null), 'guests see no prices');
  if (!products.length) return;
  const product = products[0];

  console.log('\n3. Retail customer');
  const stamp = Date.now();
  const accounts = {
    retail: { email: `retail.${stamp}@${domain}`, password: `Eko-${stamp}-r!` },
    biz: { email: `biz.${stamp}@${domain}`, password: `Eko-${stamp}-b!` },
    product_id: product.id,
  };
  writeFileSync(STATE, JSON.stringify(accounts, null, 2));

  const r = client();
  const su = await r.auth.signUp({
    email: accounts.retail.email,
    password: accounts.retail.password,
    options: { data: { full_name: 'Test Pakicë', phone: '+38344000001', language: 'sq' } },
  });
  check(!su.error, 'retail registration accepted', su.error?.message);
  if (su.error) return;
  if (!su.data.session) {
    fail('registration needs e-mail confirmation — turn off "Confirm email" while testing, or confirm the test users with SQL (see README)');
    return;
  }
  const prof = await r.from('profiles').select('role,wholesale_status,full_name').single();
  check(prof.data?.role === 'retail' && prof.data?.full_name === 'Test Pakicë', 'profile created automatically', JSON.stringify(prof.data ?? prof.error));
  const rl = (await r.rpc('list_products')).data ?? [];
  const rp = rl.find((p) => p.id === product.id);
  check(rp?.price != null && rp?.wholesale_price === null, `retail sees retail price only (${rp?.price} €)`);
  const sneaky = await r.from('profiles').update({ role: 'admin' }).eq('id', su.data.user.id);
  const after = await r.from('profiles').select('role').single();
  check(after.data?.role === 'retail', 'customer cannot make themselves admin', sneaky.error?.message);
  const order = await r.rpc('place_order', {
    p_lines: [{ product_id: product.id, quantity: 2, unit_price: 0.01 }],
    p_delivery: delivery,
  });
  check(!order.error, `retail order placed (#${order.data?.order_number})`, order.error?.message);
  if (order.data) {
    check(Number(order.data.total) === Number((rp.price * 2).toFixed(2)), `order total calculated on the server (${order.data.total} €), client price ignored`);
    accounts.retail_order = order.data;
  }
  const others = await r.from('orders').select('id');
  check((others.data ?? []).length === 1, 'customer sees only their own orders');

  console.log('\n4. Business customer (wholesale request)');
  const b = client();
  const bs = await b.auth.signUp({
    email: accounts.biz.email,
    password: accounts.biz.password,
    options: { data: { full_name: 'Test Shumicë', phone: '+38344000002', requested_wholesale: true, business_name: 'TEST Biznes SHPK', business_number: '000000000', language: 'sq' } },
  });
  check(!bs.error && !!bs.data.session, 'business registration accepted', bs.error?.message);
  if (bs.data?.session) {
    const bp = await b.from('profiles').select('role,wholesale_status').single();
    check(bp.data?.role === 'retail' && bp.data?.wholesale_status === 'pending', 'wholesale request is pending');
    const bl = (await b.rpc('list_products')).data ?? [];
    const bpp = bl.find((p) => p.id === product.id);
    check(bpp?.price === rp?.price, 'pending business still sees retail price');
    accounts.biz.user_id = bs.data.user.id;
  }
  writeFileSync(STATE, JSON.stringify(accounts, null, 2));

  // Ask the notification sender to deliver (push/e-mail) – harmless if not deployed.
  const fn = await fetch(`${URL}/functions/v1/dispatch-notifications`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}' });
  console.log(`\n  ℹ dispatch-notifications: HTTP ${fn.status}${fn.status === 404 ? ' (function not deployed yet)' : ''}`);
  console.log(`\nNext: approve "TEST Biznes SHPK" (${accounts.biz.email}) in Admin → Klientët, then run: node tests/live-check.mjs verify`);
}

async function verify() {
  if (!existsSync(STATE)) throw new Error('Run setup first');
  const accounts = JSON.parse(readFileSync(STATE, 'utf8'));
  console.log(`Project: ${URL}\n\n5. Approved wholesale customer`);
  const { c, error } = await login(accounts.biz.email, accounts.biz.password);
  check(!error, 'business account logs in', error?.message);
  if (error) return;
  const prof = await c.from('profiles').select('role,wholesale_status').single();
  check(prof.data?.role === 'wholesale', `account approved (role=${prof.data?.role}, status=${prof.data?.wholesale_status})`);
  if (prof.data?.role !== 'wholesale') return;
  const notes = await c.from('notifications').select('type');
  check((notes.data ?? []).some((n) => n.type === 'wholesale_approved'), 'customer received "wholesale approved" notification');
  const list = (await c.rpc('list_products')).data ?? [];
  const p = list.find((x) => x.id === accounts.product_id);
  const g = (await client().rpc('list_products')).data?.find((x) => x.id === accounts.product_id);
  const r = await login(accounts.retail.email, accounts.retail.password);
  const rp = ((await r.c.rpc('list_products')).data ?? []).find((x) => x.id === accounts.product_id);
  check(p?.price != null && g?.price === null, `wholesale sees a price (${p?.price} €), guests do not`);
  check(p?.retail_price === null && p?.stock === null, 'wholesale customers do not get admin-only columns');
  console.log(`  ℹ retail price ${rp?.price} € · wholesale price ${p?.price} €`);
  check(Number(p?.price) <= Number(rp?.price), 'wholesale price is not higher than retail');
  const order = await c.rpc('place_order', { p_lines: [{ product_id: accounts.product_id, quantity: 5 }], p_delivery: delivery });
  check(!order.error, `wholesale order placed (#${order.data?.order_number})`, order.error?.message);
  if (order.data) {
    check(Number(order.data.total) === Number((p.price * 5).toFixed(2)), `wholesale order uses wholesale price (${order.data.total} €)`);
    const row = await c.from('orders').select('price_tier').eq('id', order.data.id).single();
    check(row.data?.price_tier === 'wholesale', 'order marked as wholesale');
  }
  await fetch(`${URL}/functions/v1/dispatch-notifications`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  console.log('\nTest orders are marked "TEST – mos e dërgo". Cancel them in Admin → Porositë, and remove the test users afterwards (see README).');
}

await (mode === 'verify' ? verify() : setup());
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
