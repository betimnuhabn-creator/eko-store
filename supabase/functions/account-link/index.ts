// One account for eko-store.com (WordPress) and the EKO Store app.
// Server only: the service key and the link secret never leave Supabase / the website.
//
// POST { action: "app_login", email, password }      (the app, after a failed login; no key)
//   → the website checks the password (secret-protected endpoint /wp-json/eko/v1/verify).
//     Right password → the app account is created, or its password set to this one.
//     Then the app logs in normally. Never for administrators.
// POST { action: "wp_login", email, password }       (the website; header X-EKO-Link: secret)
//   → checked with Supabase Auth; right → { ok, full_name, phone, business_name, wholesale }
//     so the website creates / updates its user.
// POST { action: "wholesale", email, wholesale }     (the website; header X-EKO-Link: secret)
//   → "Wholesale Customer" role set/removed on the website → approved/revoked in the app.
//
// Every login through the link: at most 10 per e-mail per 15 minutes.
// Secrets: WOO_URL (https://eko-store.com), EKO_LINK_SECRET (same value as in the WordPress snippet).

type Json = Record<string, any>;

function serverKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const single = Deno.env.get('SUPABASE_SECRET_KEY');
  if (single) return single;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    const k = keys.default ?? Object.values(keys)[0];
    if (typeof k === 'string') return k;
  } catch { /* fall through */ }
  throw new Error('No server key');
}

const BASE = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
// The website: WOO_URL (EKO_SITE_URL only overrides it for local tests).
const WOO = (Deno.env.get('EKO_SITE_URL') || Deno.env.get('WOO_URL') || '').replace(/\/+$/, '');
const SECRET = Deno.env.get('EKO_LINK_SECRET') ?? '';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: Json) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function serviceHeaders(): Record<string, string> {
  const key = serverKey();
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}
async function rpc(name: string, args: Json): Promise<any> {
  const res = await fetch(`${BASE}/rest/v1/rpc/${name}`, { method: 'POST', headers: serviceHeaders(), body: JSON.stringify(args) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${name}: ${data?.message ?? res.status}`);
  return data;
}

function sameSecret(given: string): boolean {
  if (!SECRET || SECRET.length < 16 || given.length !== SECRET.length) return false;
  let d = 0;
  for (let i = 0; i < SECRET.length; i++) d |= SECRET.charCodeAt(i) ^ given.charCodeAt(i);
  return d === 0;
}
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const okUrl = () => /^https:\/\/[^\s/]+$/.test(WOO) || /^http:\/\/(host\.docker\.internal|localhost|127\.0\.0\.1)(:\d+)?$/.test(WOO);

/** Password check with Supabase Auth; the session it creates is closed at once. */
async function supabasePasswordOk(email: string, password: string): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: serverKey(), 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return false;
  const s = await res.json().catch(() => ({}));
  if (s?.access_token) {
    await fetch(`${BASE}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: serverKey(), Authorization: `Bearer ${s.access_token}` } }).catch(() => undefined);
  }
  return true;
}

/** Password check on the website (WordPress snippet endpoint). */
async function websiteVerify(email: string, password: string): Promise<Json | null> {
  if (!okUrl() || !SECRET) return null;
  const res = await fetch(`${WOO}/wp-json/eko/v1/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EKO-Link': SECRET, 'User-Agent': 'EKO-Store-App-Link/1.0' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  const d = await res.json().catch(() => null);
  return d?.ok ? d : null;
}

async function appLogin(email: string, password: string): Promise<Response> {
  const info = await rpc('link_user_info', { p_email: email });
  if (info?.role === 'admin') return reply(200, { ok: false });                 // administrators are never linked
  const site = await websiteVerify(email, password);
  if (!site) return reply(200, { ok: false });
  const meta = { full_name: String(site.full_name ?? '').slice(0, 200), phone: String(site.phone ?? '').slice(0, 50) };
  let userId: string | null = info?.id ?? null;
  if (userId) {
    const r = await fetch(`${BASE}/auth/v1/admin/users/${userId}`, { method: 'PUT', headers: serviceHeaders(), body: JSON.stringify({ password }) });
    if (!r.ok) return reply(200, { ok: false, error: 'update_failed' });
  } else {
    const r = await fetch(`${BASE}/auth/v1/admin/users`, {
      method: 'POST', headers: serviceHeaders(),
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: meta }),
    });
    const u = await r.json().catch(() => ({}));
    if (!r.ok || !u?.id) return reply(200, { ok: false, error: 'create_failed' });
    userId = u.id;
  }
  if (site.wholesale === true) await rpc('link_set_wholesale', { p_user: userId, p_wholesale: true });
  return reply(200, { ok: true, created: !info });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  try {
    let body: Json;
    try { body = await req.json(); } catch { return reply(400, { error: 'bad_request' }); }
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    if (body.action === 'app_login') {
      if (!EMAIL.test(email) || password.length < 6 || password.length > 200) return reply(200, { ok: false });
      if (!(await rpc('link_rate_ok', { p_email: email }))) return reply(429, { error: 'too_many_attempts' });
      return await appLogin(email, password);
    }

    // calls from the website only
    if (!sameSecret(req.headers.get('x-eko-link') ?? '')) return reply(401, { error: 'not_allowed' });
    if (!EMAIL.test(email)) return reply(400, { error: 'bad_request' });
    const info = await rpc('link_user_info', { p_email: email });

    if (body.action === 'wp_login') {
      if (password.length < 6 || password.length > 200) return reply(200, { ok: false });
      if (!(await rpc('link_rate_ok', { p_email: email }))) return reply(429, { error: 'too_many_attempts' });
      if (!info || info.role === 'admin') return reply(200, { ok: false });
      if (!(await supabasePasswordOk(email, password))) return reply(200, { ok: false });
      return reply(200, { ok: true, full_name: info.full_name ?? '', phone: info.phone ?? '', business_name: info.business_name ?? '',
        wholesale: info.wholesale_status === 'approved' });
    }
    if (body.action === 'wholesale') {
      if (!info || info.role === 'admin') return reply(200, { ok: true, result: 'no_app_account' });
      return reply(200, { ok: true, result: await rpc('link_set_wholesale', { p_user: info.id, p_wholesale: body.wholesale === true }) });
    }
    return reply(400, { error: 'bad_request' });
  } catch (e) {
    console.error('account-link', String((e as Error)?.message ?? e).slice(0, 300));   // never the password
    return reply(500, { error: 'failed' });
  }
});
