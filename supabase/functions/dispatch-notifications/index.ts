// Sends queued notifications (table public.notifications) as
//   * Expo push notifications  -> every registered device of the recipient
//   * e-mail via Resend        -> administrators only (when RESEND_API_KEY is set)
//
// The app calls this function right after an action that creates notifications
// (new order, wholesale request, order status change...). Calling it is always
// safe: notifications are leased atomically, marked delivered only after a
// successful send, and retried (max 5 attempts) when sending fails.
//
// Secrets (supabase secrets set ...):
//   RESEND_API_KEY      optional, enables admin e-mails
//   EMAIL_FROM          e.g. "EKO Store <porosi@eko-shpk.com>" (verified Resend domain)
//   ADMIN_EMAILS        optional, comma-separated extra recipients for admin e-mails
//   EXPO_ACCESS_TOKEN   optional, only if "enhanced push security" is enabled in Expo
//   APP_URL             optional, link to the web app shown in e-mails
//   EXPO_PUSH_URL / RESEND_API_URL  optional overrides (used by the automated tests)

// Calls a database function with the service role (no external imports needed).
// Server-side key injected by Supabase into every Edge Function. Projects with
// the new API keys provide SUPABASE_SECRET_KEYS (JSON); older ones the legacy
// service_role JWT. Either works; it never leaves the server.
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
  throw new Error('No server key available in the Edge Function environment');
}

async function rpc(name: string, body: unknown) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = serverKey();
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  // Only a JWT (legacy key) belongs in Authorization; new sb_secret_ keys go in apikey only.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

type Claimed = {
  id: string;
  recipient_id: string;
  type: string;
  data: Record<string, unknown>;
  recipient_role: string;
  recipient_email: string;
  recipient_language: 'sq' | 'en';
  push_tokens: string[];
  attempts: number;
  claim_token: string;
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const eur = (v: unknown) => `${Number(v ?? 0).toFixed(2)} €`;

const STATUS: Record<string, { sq: string; en: string }> = {
  new: { sq: 'E re', en: 'New' },
  confirmed: { sq: 'E konfirmuar', en: 'Confirmed' },
  preparing: { sq: 'Në përgatitje', en: 'Being prepared' },
  shipped: { sq: 'E nisur', en: 'Shipped' },
  delivered: { sq: 'E dorëzuar', en: 'Delivered' },
  cancelled: { sq: 'E anuluar', en: 'Cancelled' },
};

export function render(type: string, d: Record<string, any>, lang: 'sq' | 'en') {
  const sq = lang === 'sq';
  switch (type) {
    case 'new_order':
      return {
        title: sq ? `Porosi e re #${d.order_number}` : `New order #${d.order_number}`,
        body: `${d.name ?? ''} · ${eur(d.total)}${d.tier === 'wholesale' ? (sq ? ' · shumicë' : ' · wholesale') : ''}`,
      };
    case 'order_cancelled':
      return {
        title: sq ? `Porosia #${d.order_number} u anulua` : `Order #${d.order_number} cancelled`,
        body: sq ? `Klienti ${d.name ?? ''} e anuloi porosinë.` : `Customer ${d.name ?? ''} cancelled the order.`,
      };
    case 'wholesale_request':
      return {
        title: sq ? 'Kërkesë e re për shumicë' : 'New wholesale request',
        body: `${d.name ?? ''} · ${d.email ?? ''} · ${d.phone ?? ''}`,
      };
    case 'new_customer':
      return {
        title: sq ? 'Klient i ri i regjistruar' : 'New customer registered',
        body: `${d.name ?? ''} · ${d.email ?? ''}`,
      };
    case 'order_status': {
      const s = STATUS[d.status]?.[lang] ?? d.status;
      return {
        title: sq ? `Porosia #${d.order_number}` : `Order #${d.order_number}`,
        body: sq ? `Statusi i ri: ${s}` : `New status: ${s}`,
      };
    }
    case 'wholesale_approved':
      return {
        title: sq ? 'Llogaria e shumicës u aprovua' : 'Wholesale account approved',
        body: sq ? 'Tani shihni çmimet e shumicës.' : 'You now see wholesale prices.',
      };
    case 'wholesale_rejected':
      return {
        title: sq ? 'Kërkesa për shumicë nuk u aprovua' : 'Wholesale request not approved',
        body: sq ? 'Për më shumë informacion na kontaktoni.' : 'Please contact us for more information.',
      };
    default:
      return { title: 'EKO Store', body: '' };
  }
}

function route(type: string, d: Record<string, any>, role: string) {
  if (d.order_id) return role === 'admin' ? `/admin/orders/${d.order_id}` : `/orders/${d.order_id}`;
  if (type === 'wholesale_request' || type === 'new_customer') return '/admin/customers';
  return '/notifications';
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Outcome = { failed: Map<string, string>; invalidTokens: string[]; sent: number };

// Expo push. A notification fails if any of its messages could not be handed
// to Expo (network error, HTTP error, or an error ticket other than
// DeviceNotRegistered — those tokens are simply removed).
async function sendPush(items: Claimed[], out: Outcome) {
  const messages = items.flatMap((n) => {
    const { title, body } = render(n.type, n.data as any, n.recipient_language);
    return n.push_tokens.map((to) => ({
      nid: n.id,
      msg: {
        to, title, body, sound: 'default', channelId: 'default', priority: 'high',
        data: { url: route(n.type, n.data as any, n.recipient_role), notification_id: n.id },
      },
    }));
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const token = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = Deno.env.get('EXPO_PUSH_URL') ?? 'https://exp.host/--/api/v2/push/send';
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chunk.map((c) => c.msg)) });
      if (!res.ok) throw new Error(`push HTTP ${res.status}`);
      const tickets: any[] = (await res.json()).data ?? [];
      chunk.forEach((c, k) => {
        const t = tickets[k];
        if (t?.status === 'ok') out.sent++;
        else if (t?.details?.error === 'DeviceNotRegistered') out.invalidTokens.push(c.msg.to);
        else out.failed.set(c.nid, `push: ${t?.details?.error ?? t?.message ?? 'no ticket'}`);
      });
    } catch (e) {
      chunk.forEach((c) => out.failed.set(c.nid, `push: ${(e as Error).message}`));
    }
  }
}

// Admin e-mails: one e-mail per event (all admins in "to"). If e-mail is not
// configured it is skipped; if sending fails, the event's notifications are retried.
async function sendAdminEmails(items: Claimed[], out: Outcome) {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('EMAIL_FROM');
  if (!key || !from) return;
  const extra = (Deno.env.get('ADMIN_EMAILS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const appUrl = Deno.env.get('APP_URL') ?? '';
  const url = Deno.env.get('RESEND_API_URL') ?? 'https://api.resend.com/emails';
  const events = new Map<string, Claimed[]>();
  for (const n of items.filter((x) => x.recipient_role === 'admin')) {
    const k = n.type + JSON.stringify(n.data);
    events.set(k, [...(events.get(k) ?? []), n]);
  }
  for (const group of events.values()) {
    const n = group[0];
    const to = [...new Set([...group.map((g) => g.recipient_email).filter(Boolean), ...extra])];
    if (!to.length) continue;
    const { title, body } = render(n.type, n.data as any, 'sq');
    const link = appUrl ? `${appUrl.replace(/\/$/, '')}${route(n.type, n.data as any, 'admin')}` : '';
    const html = `<div style="font-family:Arial,sans-serif"><h2 style="color:#0166B4">${esc(title)}</h2><p>${esc(body)}</p>${
      link ? `<p><a href="${esc(link)}">Hap në EKO Store / Open in EKO Store</a></p>` : ''}</div>`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject: `EKO Store: ${title}`, html }),
      });
      if (!res.ok) throw new Error(`email HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      out.sent++;
    } catch (e) {
      group.forEach((g) => out.failed.set(g.id, (e as Error).message));
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    // Leases the notifications; they are NOT marked delivered yet.
    const items = ((await rpc('claim_notifications', { p_limit: 200 })) ?? []) as Claimed[];
    const out: Outcome = { failed: new Map(), invalidTokens: [], sent: 0 };
    await sendPush(items, out);
    await sendAdminEmails(items, out);
    if (out.invalidTokens.length) await rpc('forget_push_tokens', { p_tokens: out.invalidTokens });
    const failed = [...out.failed.keys()];
    const delivered = items.map((n) => n.id).filter((id) => !out.failed.has(id));
    // Only this worker's claim is acknowledged (stale workers are ignored by the DB).
    if (items.length) await rpc('finish_notifications', {
      p_claim: items[0].claim_token,
      p_delivered: delivered,
      p_failed: failed,
      p_error: [...new Set(out.failed.values())].join('; ').slice(0, 500) || null,
    });
    return new Response(JSON.stringify({ claimed: items.length, delivered: delivered.length, failed: failed.length, sent: out.sent }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    // Claimed notifications are retried automatically after their 5-minute lease.
    console.error(e);
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
