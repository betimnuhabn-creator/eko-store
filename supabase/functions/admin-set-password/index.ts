// Sets a new password for a CUSTOMER, on behalf of the main administrator
// (PC panel → Klientët → Fjalëkalimi). Server only: the service key never
// leaves Supabase.
//
// Who may use it — all checked here, on the server:
//   * the caller's Supabase session is valid (Authorization: Bearer <user JWT>);
//   * the caller's e-mail is listed in the secret PASSWORD_ADMIN_EMAILS
//     (comma-separated; NOT every admin) AND the profile role is 'admin';
//     if the secret is missing, nobody may use it;
//   * the caller re-authenticates with their own password (admin_password).
// Target: only customers (never an administrator, never oneself).
// The new password is never stored, logged or returned. After Supabase has
// changed it, the database records an audit row (admin, customer, time),
// sets "must change password" and ends the customer's old sessions.
//
// POST { action: "check" }                                   → { allowed }
// POST { action: "set", user_id, password, admin_password }  → { ok: true }
//
// Secrets: PASSWORD_ADMIN_EMAILS (Supabase → Edge Functions → Secrets).

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

async function profile(id: string): Promise<{ id: string; role: string; email: string } | null> {
  const res = await fetch(`${BASE}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=id,role,email`, { headers: serviceHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ?? null;
}

function allowedEmails(): string[] {
  return (Deno.env.get('PASSWORD_ADMIN_EMAILS') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Main administrator? (secret list + admin role in the database). */
async function isMainAdmin(user: { id: string; email: string }): Promise<boolean> {
  if (!allowedEmails().includes(user.email)) return false;
  return (await profile(user.id))?.role === 'admin';
}

/** Re-authentication with the administrator's own password; the extra session is closed at once. */
async function reauthenticate(email: string, password: string): Promise<boolean> {
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
  return true;
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
    const allowed = await isMainAdmin(user);
    if (body.action === 'check') return reply(200, { allowed });
    if (body.action !== 'set') return reply(400, { error: 'bad_request' });
    if (!allowed) return reply(403, { error: 'not_allowed' });

    const userId = String(body.user_id ?? '');
    const password = typeof body.password === 'string' ? body.password : '';
    const adminPassword = typeof body.admin_password === 'string' ? body.admin_password : '';
    if (!UUID.test(userId)) return reply(400, { error: 'bad_request' });
    if (password.length < 8 || password.length > 72) return reply(400, { error: 'password_length' });
    if (!adminPassword || !(await reauthenticate(user.email, adminPassword))) return reply(401, { error: 'reauth_failed' });

    const target = await profile(userId);
    if (!target) return reply(404, { error: 'not_found' });
    if (target.role === 'admin' || target.id === user.id) return reply(403, { error: 'target_not_allowed' });

    // Supabase Auth Admin API: set the password.
    const upd = await fetch(`${BASE}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: serviceHeaders(),
      body: JSON.stringify({ password }),
    });
    if (!upd.ok) {
      const e = await upd.json().catch(() => ({}));
      const code = String(e.error_code ?? e.code ?? '');
      return reply(upd.status === 422 ? 422 : 500, { error: code === 'weak_password' ? 'weak_password' : 'update_failed' });
    }
    // Audit (no password), "must change password", end old sessions.
    const rec = await fetch(`${BASE}/rest/v1/rpc/record_admin_password_change`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: JSON.stringify({ p_admin: user.id, p_customer: userId }),
    });
    if (!rec.ok) return reply(500, { error: 'audit_failed', password_changed: true });
    return reply(200, { ok: true });
  } catch {
    // Never log the request (it contains passwords).
    return reply(500, { error: 'server_error' });
  }
});
