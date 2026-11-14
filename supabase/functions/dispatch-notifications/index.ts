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

// Constant-time string comparison.
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// True only for calls made with this project's server key (operators, tests).
// The app and the database scheduler call without it: they get only {ok:true}.
function isInternal(req: Request) {
  let key: string;
  try { key = serverKey(); } catch { return false; }
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  return [req.headers.get('apikey') ?? '', bearer].some((v) => v !== '' && same(v, key));
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const eur = (v: unknown) => `${Number(v ?? 0).toFixed(2)} €`;
// "100€", "85,50€" — short form used in promotional texts.
const shortEur = (v: unknown) => {
  const n = Number(v ?? 0);
  return `${Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',')}€`;
};
export const isPromo = (type: string) => type.startsWith('promo_');

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
    // ---- promotional (category 'promo'): never contain prices of another tier;
    //      the database only stores the recipient's own prices in `d`.
    case 'promo_new_product': {
      const name = sq ? d.name : d.name_en || d.name;
      return {
        title: sq ? 'EKO Store – Produkt i ri!' : 'EKO Store – New product!',
        body: sq ? `Shikoni produktin tonë më të ri: ${name}.` : `Check out our newest product: ${name}.`,
      };
    }
    case 'promo_offer': {
      const title = sq ? d.title : d.title_en || d.title;
      return {
        title: sq ? 'EKO Store – Ofertë speciale!' : 'EKO Store – Special offer!',
        body: sq ? `Përfitoni nga çmimet promocionale: ${title}.` : `Enjoy our promotional prices: ${title}.`,
      };
    }
    case 'promo_price_down':
    case 'promo_price_up': {
      const name = sq ? d.name : d.name_en || d.name;
      const down = type === 'promo_price_down';
      return {
        title: sq ? (down ? 'EKO Store – Ulje çmimi!' : 'EKO Store – Ndryshim çmimi!') : (down ? 'EKO Store – Price drop!' : 'EKO Store – Price change!'),
        body: sq
          ? `Produkti ${name} nga ${shortEur(d.old)} tani ${shortEur(d.new)}.`
          : `${name}: from ${shortEur(d.old)} now ${shortEur(d.new)}.`,
      };
    }
    default:
      return { title: 'EKO Store', body: '' };
  }
}

function route(type: string, d: Record<string, any>, role: string) {
  if (isPromo(type)) return d.offer_id ? `/offers/${d.offer_id}` : d.product_id ? `/product/${d.product_id}` : '/offers';
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
        to, title, body, sound: 'default', priority: 'high',
        // Separate Android channels: customers can mute promotions without losing order updates.
        channelId: isPromo(n.type) ? 'promotions' : 'default',
        data: { url: route(n.type, n.data as any, n.recipient_role), notification_id: n.id, category: isPromo(n.type) ? 'promo' : 'order' },
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
  for (const n of items.filter((x) => x.recipient_role === 'admin' && !isPromo(x.type))) {
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

// Public endpoint (Verify JWT OFF): the app calls it right after an action and
// the database scheduler every minute. It reads NOTHING from the request; it can
// only deliver what the database has already queued (under the database's rules),
// leased so that concurrent calls never send anything twice. Anonymous callers
// learn nothing: no counts, no error details. Only POST runs a dispatch.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405, headers: { ...cors, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    });
  }
  const internal = isInternal(req);
  try {
    // Leases the notifications; they are NOT marked delivered yet.
    // Promotions: record offers that just became live and turn waiting promo
    // events into notifications (opt-in, daily cap, test mode — all enforced
    // in the database). Skipped silently if the offers migration is not installed.
    await rpc('process_offer_activations', {}).catch(() => null);
    await rpc('promo_fanout', { p_limit: 20 }).catch(() => null);
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
    const result = internal
      ? { ok: true, claimed: items.length, delivered: delivered.length, failed: failed.length, sent: out.sent }
      : { ok: true };
    return new Response(JSON.stringify(result), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    // Claimed notifications are retried automatically after their 5-minute lease.
    // The caller may be anyone (the function is public and takes no input), so
    // details go to the function logs only, never into the response.
    console.error(e);
    return new Response(JSON.stringify({ error: 'dispatch failed' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
