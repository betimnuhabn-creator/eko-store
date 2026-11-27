// Deletes a CUSTOMER account on the server. The service key never leaves Supabase.
//
// Used by:
//   * the app (Llogaria → Fshi llogarinë time) and the public page
//     delete-account.html: a customer deletes THEIR OWN account;
//   * the PC panel (Klientët → Fshi klientin): an administrator deletes a customer.
//
// Checked here, on the server, for every call:
//   * the caller's Supabase session is valid (Authorization: Bearer <user JWT>);
//   * the caller re-enters their own password (re-authentication);
//   * customer: only their own account; an administrator account is never deleted here;
//   * administrator: profile role 'admin'; target must be a customer, never an
//     administrator and never themself.
// The deletion itself is public.delete_customer_account() (one transaction):
// push tokens, profile, notifications and the Auth account are removed, orders
// are kept for accounting (unlinked), and an audit row without personal data is
// written. Passwords are never stored, logged or returned.
//
// POST { action: "self", password }                         → { ok, orders_kept, open_orders }
// POST { action: "preview", user_id }               (admin) → { name, business_name, email, orders, open_orders }
// POST { action: "admin_delete", user_id, admin_password }  → { ok, orders_kept, open_orders }

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
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function serviceHeaders(): Record<string, string> {
  const key = serverKey();
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) h.Authorization = `Bearer ${key}`;
  return h;
}

/** The logged-in caller, verified by Supabase Auth. */
async function caller(req: Request): Promise<{ id: string; email: string } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || token.split('.').length !== 3) return null;
  const res = await fetch(`${BASE}/auth/v1/user`, { headers: { apikey: serverKey(), Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id && u?.email ? { id: u.id, email: String(u.email).toLowerCase() } : null;
}

type Prof = { id: string; role: string; email: string; full_name: string; business_name: string };
async function profile(id: string): Promise<Prof | null> {
  const res = await fetch(`${BASE}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,role,email,full_name,business_name`, { headers: serviceHeaders() });
  if (!res.ok) throw new Error('profile lookup failed');
  const rows = await res.json();
  return rows[0] ?? null;
}

async function orderCounts(id: string): Promise<{ orders: number; open_orders: number }> {
  const res = await fetch(`${BASE}/rest/v1/orders?customer_id=eq.${encodeURIComponent(id)}&select=status`, { headers: serviceHeaders() });
  if (!res.ok) throw new Error('orders lookup failed');
  const rows: { status: string }[] = await res.json();
  const open = ['new', 'confirmed', 'preparing', 'shipped', 'accepted'];
  return { orders: rows.length, open_orders: rows.filter((r) => open.includes(r.status)).length };
}

/** Re-authentication with the caller's own password; the extra session is closed at once. */
async function reauthenticate(email: string, password: string): Promise<boolean> {
  if (!password || password.length > 200) return false;
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: serverKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return false;
  const s = await res.json().catch(() => ({}));
  if (s?.access_token) {
    await fetch(`${BASE}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: serverKey(), Authorization: `Bearer ${s.access_token}` },
    }).catch(() => undefined);
  }
  return s?.user?.email ? String(s.user.email).toLowerCase() === email : true;
}

async function deleteAccount(userId: string, actorId: string): Promise<Response> {
  const res = await fetch(`${BASE}/rest/v1/rpc/delete_customer_account`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ p_user: userId, p_actor: actorId }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return reply(200, { ok: true, orders_kept: data.orders_kept ?? 0, open_orders: data.open_orders ?? 0 });
  const msg = String(data?.message ?? '');
  if (msg === 'NOT_FOUND') return reply(404, { error: 'not_found' });
  if (msg === 'TARGET_IS_ADMIN' || msg === 'NOT_ALLOWED') return reply(403, { error: 'target_not_allowed' });
  return reply(500, { error: 'delete_failed' });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  try {
    const user = await caller(req);
    if (!user) return reply(401, { error: 'not_logged_in' });
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return reply(400, { error: 'bad_request' });
    }
    const me = await profile(user.id);
    if (!me) return reply(404, { error: 'not_found' });

    if (body.action === 'self') {
      if (me.role === 'admin') return reply(403, { error: 'admin_cannot_delete' });
      const password = typeof body.password === 'string' ? body.password : '';
      if (!(await reauthenticate(user.email, password))) return reply(401, { error: 'reauth_failed' });
      return await deleteAccount(user.id, user.id);
    }

    if (body.action !== 'preview' && body.action !== 'admin_delete') return reply(400, { error: 'bad_request' });
    if (me.role !== 'admin') return reply(403, { error: 'not_allowed' });
    const userId = String(body.user_id ?? '');
    if (!UUID.test(userId)) return reply(400, { error: 'bad_request' });
    const target = await profile(userId);
    if (!target) return reply(404, { error: 'not_found' });
    if (target.role === 'admin' || target.id === user.id) return reply(403, { error: 'target_not_allowed' });

    if (body.action === 'preview') {
      return reply(200, { name: target.full_name, business_name: target.business_name, email: target.email, ...(await orderCounts(userId)) });
    }
    const adminPassword = typeof body.admin_password === 'string' ? body.admin_password : '';
    if (!(await reauthenticate(user.email, adminPassword))) return reply(401, { error: 'reauth_failed' });
    return await deleteAccount(userId, user.id);
  } catch {
    // Never log the request (it contains passwords).
    return reply(500, { error: 'server_error' });
  }
});
