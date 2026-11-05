// Sends queued notifications (table public.notifications) as
//   * Expo push notifications  -> every registered device of the recipient
//   * e-mail via Resend        -> administrators only (when RESEND_API_KEY is set)
//
// The app calls this function right after an action that creates notifications
// (new order, wholesale request, order status change...). Calling it is always
// safe: each notification is claimed atomically and sent at most once.
//
// Secrets (supabase secrets set ...):
//   RESEND_API_KEY      optional, enables admin e-mails
//   EMAIL_FROM          e.g. "EKO Store <porosi@eko-shpk.com>" (verified Resend domain)
//   ADMIN_EMAILS        optional, comma-separated extra recipients for admin e-mails
//   EXPO_ACCESS_TOKEN   optional, only if "enhanced push security" is enabled in Expo
//   APP_URL             optional, link to the web app shown in e-mails

// Calls a database function with the service role (no external imports needed).
async function rpc(name: string, body: unknown) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

async function sendPush(items: Claimed[]) {
  const messages = items.flatMap((n) => {
    const { title, body } = render(n.type, n.data as any, n.recipient_language);
    return n.push_tokens.map((to) => ({
      to, title, body, sound: 'default', channelId: 'default', priority: 'high',
      data: { url: route(n.type, n.data as any, n.recipient_role), notification_id: n.id },
    }));
  });
  if (!messages.length) return { sent: 0, invalid: [] as string[] };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const token = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  const invalid: string[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST', headers, body: JSON.stringify(chunk),
    });
    const json = await res.json().catch(() => ({}));
    (json.data ?? []).forEach((ticket: any, k: number) => {
      if (ticket?.details?.error === 'DeviceNotRegistered') invalid.push(chunk[k].to);
    });
  }
  return { sent: messages.length, invalid };
}

async function sendAdminEmails(items: Claimed[]) {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('EMAIL_FROM');
  if (!key || !from) return 0;
  const extra = (Deno.env.get('ADMIN_EMAILS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const appUrl = Deno.env.get('APP_URL') ?? '';
  // One e-mail per event (not per admin): group by type + payload.
  const events = new Map<string, Claimed[]>();
  for (const n of items.filter((x) => x.recipient_role === 'admin')) {
    const k = n.type + JSON.stringify(n.data);
    events.set(k, [...(events.get(k) ?? []), n]);
  }
  let sent = 0;
  for (const group of events.values()) {
    const n = group[0];
    const to = [...new Set([...group.map((g) => g.recipient_email).filter(Boolean), ...extra])];
    if (!to.length) continue;
    const { title, body } = render(n.type, n.data as any, 'sq');
    const link = appUrl ? `${appUrl.replace(/\/$/, '')}${route(n.type, n.data as any, 'admin')}` : '';
    const html = `<div style="font-family:Arial,sans-serif"><h2 style="color:#1565C0">${title}</h2><p>${body}</p>${
      link ? `<p><a href="${link}">Hap në EKO Store / Open in EKO Store</a></p>` : ''}</div>`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: `EKO Store: ${title}`, html }),
    });
    if (res.ok) sent++;
    else console.error('resend', res.status, await res.text());
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const items = ((await rpc('claim_notifications', { p_limit: 200 })) ?? []) as Claimed[];
    const push = await sendPush(items).catch((e) => (console.error('push', e), { sent: 0, invalid: [] }));
    if (push.invalid.length) await rpc('forget_push_tokens', { p_tokens: push.invalid });
    const emails = await sendAdminEmails(items).catch((e) => (console.error('email', e), 0));
    return new Response(JSON.stringify({ claimed: items.length, push: push.sent, emails }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
