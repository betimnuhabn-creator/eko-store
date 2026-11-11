// Shared helpers for the integration tests (local Supabase stack only).
import { createClient } from '@supabase/supabase-js';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

export const env = Object.fromEntries(
  execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .map((l) => l.match(/^(\w+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(env.API_URL ?? '')) {
  throw new Error('These tests only run against the LOCAL Supabase stack.');
}

export const URL = env.API_URL;
// The apps use the publishable key; the tests do the same for all user traffic.
export const KEY = env.PUBLISHABLE_KEY || env.ANON_KEY;
// Service role ONLY for test set-up (promoting the admin, inspecting state).
export const service = createClient(URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
export const run = Date.now() + Math.floor(Math.random() * 1000);

export async function signUp(name, meta = {}) {
  const c = client();
  const email = `${name}.${run}@test.local`;
  const { data, error } = await c.auth.signUp({
    email,
    password: 'secret123',
    options: { data: { full_name: name, phone: '+38344000000', ...meta } },
  });
  assert.ifError(error);
  assert.ok(data.session, 'local auth should auto-confirm');
  return { c, id: data.user.id, email, token: data.session.access_token };
}

export async function makeAdmin(name = 'admin') {
  const u = await signUp(name);
  const { error } = await service.from('profiles').update({ role: 'admin' }).eq('id', u.id);
  assert.ifError(error);
  return u;
}

// Main administrator for passwords (listed in PASSWORD_ADMIN_EMAILS in tests/functions.test.env).
export const MAIN_ADMIN = 'eko-main-admin@test.local';

/** The main administrator (fixed e-mail, listed in PASSWORD_ADMIN_EMAILS). */
export async function mainAdmin() {
  const c = client();
  let r = await c.auth.signInWithPassword({ email: MAIN_ADMIN, password: 'secret123' });
  if (r.error) {
    ok(await c.auth.signUp({ email: MAIN_ADMIN, password: 'secret123', options: { data: { full_name: 'Admin Kryesor' } } }));
    r = await c.auth.signInWithPassword({ email: MAIN_ADMIN, password: 'secret123' });
  }
  ok(await service.from('profiles').update({ role: 'admin' }).eq('id', r.data.user.id));
  return { c, id: r.data.user.id, email: MAIN_ADMIN, token: r.data.session.access_token };
}


export const ok = ({ data, error }) => {
  assert.ifError(error);
  return data;
};

export async function denied(promise, re) {
  const { data, error } = await promise;
  assert.ok(error, `expected an error, got data ${JSON.stringify(data)?.slice(0, 200)}`);
  if (re) assert.match(error.message, re);
}

/** Run SQL as the database owner (catalog inspection only). */
export function sql(query) {
  return execSync('psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -X -tA -v ON_ERROR_STOP=1', {
    input: query,
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: 'postgres' },
  }).trim();
}

export const delivery = {
  name: 'Bleri', phone: '+38344111222', address: 'Rr. Nëna Terezë 1', city: 'Prishtinë', payment_method: 'cash_on_delivery',
};

export async function productBySku(sku) {
  const { data } = await service.from('products').select('id,retail_price,wholesale_price').eq('sku', sku).single();
  return data;
}
