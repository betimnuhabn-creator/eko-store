// WooCommerce (eko-store.com) ⇄ EKO Store app. Server only: the WooCommerce
// keys and the service key never leave Supabase.
//
// Calls:
//   * WooCommerce webhook (product created / updated / deleted / restored):
//       header X-WC-Webhook-Signature = base64(HMAC-SHA256(body, WOO_WEBHOOK_SECRET))
//       → that product (and its sizes) is read from WooCommerce and saved.
//   * PC panel "Sinkronizo me faqen" (Authorization: administrator's session):
//       POST { action: "sync" } → full catalogue now.
//   * Scheduler (pg_cron, every minute, empty POST, no key — like dispatch-notifications):
//       copies pending app orders, wholesale changes and app price changes to WooCommerce;
//       full catalogue at most once an hour.
//       It cannot force anything else.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   WOO_URL              https://eko-store.com
//   WOO_CONSUMER_KEY     ck_…   (WooCommerce → Settings → Advanced → REST API, Read/Write)
//   WOO_CONSUMER_SECRET  cs_…
//   WOO_WEBHOOK_SECRET   the "Secret" typed in the WooCommerce webhooks
//
// Mapping: a simple product = one app product; a variable product = one app
// product per size (variation) "Name – 80L". Regular price → retail price,
// Wholesale Suite price (meta wholesale_customer_wholesale_price) → wholesale
// price, deepest category, photos, stock, published → active.
// Back to the website: only the prices an administrator changes in the app / panel
// (woo_price_jobs; Regular price and the Wholesale Suite meta).

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
const WOO = (Deno.env.get('WOO_URL') ?? '').replace(/\/+$/, '');
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

// ---------------------------------------------------------------------------
// WooCommerce REST API
// ---------------------------------------------------------------------------
function wooConfigured(): boolean {
  // https only; plain http just for a local test stack
  const okUrl = /^https:\/\/[^\s/]+/.test(WOO) || /^http:\/\/(host\.docker\.internal|localhost|127\.0\.0\.1)(:\d+)?$/.test(WOO);
  return okUrl && !!Deno.env.get('WOO_CONSUMER_KEY') && !!Deno.env.get('WOO_CONSUMER_SECRET');
}

let useQueryAuth = false;   // some hosts drop the Authorization header → keys as query parameters (HTTPS only)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
// Website firewalls (e.g. Bluehost) refuse bursts of requests with 403/429:
// at most ~3 requests per second, and a refused request is tried again later.
const GAP_MS = 350;
const RETRY_MS = [2000, 5000, 10000, 20000];

async function woo(path: string, init: RequestInit = {}): Promise<{ status: number; data: any; total_pages: number; reason: string }> {
  const ck = Deno.env.get('WOO_CONSUMER_KEY') ?? '';
  const cs = Deno.env.get('WOO_CONSUMER_SECRET') ?? '';
  const call = async (query: boolean) => {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const url = new URL(`${WOO}/wp-json/wc/v3/${path}`);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'EKO-Store-App-Sync/1.0',
    };
    if (query) {
      url.searchParams.set('consumer_key', ck);
      url.searchParams.set('consumer_secret', cs);
    } else {
      headers.Authorization = `Basic ${btoa(`${ck}:${cs}`)}`;
    }
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) } });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* firewall pages are HTML */ }
    const reason = data?.code ? String(data.code)
      : text.trim().startsWith('<') ? `html:${(text.match(/<title>([^<]{0,80})/i)?.[1] ?? '').trim() || 'page'}`
      : text.slice(0, 80);
    return { status: res.status, data, total_pages: Number(res.headers.get('x-wp-totalpages') ?? '1') || 1, reason };
  };
  let r = await call(useQueryAuth);
  if (!useQueryAuth && r.status === 401 && WOO.startsWith('https://')) {
    r = await call(true);
    if (r.status !== 401) useQueryAuth = true;
  }
  for (const delay of RETRY_MS) {
    if (r.status !== 403 && r.status !== 429 && r.status !== 503) break;
    console.warn('woo-sync', `${path.split('?')[0]}: HTTP ${r.status} ${r.reason} → retry in ${delay / 1000}s`);
    await sleep(delay);
    r = await call(useQueryAuth);
  }
  return r;
}

async function wooAll(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await woo(`${path}${sep}per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`WooCommerce ${path}: HTTP ${r.status} ${r.reason}`.trim());
    out.push(...r.data);
    if (page >= r.total_pages || r.data.length < 100) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', euro: '€', hellip: '…' };
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const num = (v: unknown): number | null => {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const meta = (o: any, key: string) => (Array.isArray(o?.meta_data) ? o.meta_data.find((m: any) => m?.key === key)?.value : undefined);

type Cat = { id: number; name: string; parent: number };
/** The deepest of the product's categories ("Instalime > Instalime Uji > Fontan Muri" → Fontan Muri). */
export function leafCategory(productCats: { id: number; name: string }[], all: Map<number, Cat>) {
  const depth = (id: number) => {
    let d = 0;
    for (let c = all.get(id); c && c.parent && d < 20; c = all.get(c.parent)) d++;
    return d;
  };
  let best: { id: number; name: string } | null = null;
  for (const c of productCats ?? []) if (!best || depth(c.id) > depth(best.id)) best = c;
  return best ? { woo_id: best.id, name: htmlToText(all.get(best.id)?.name ?? best.name) } : null;
}

function stockOf(o: any): number {
  if (o?.manage_stock && o?.stock_quantity != null) return Math.max(0, Math.floor(Number(o.stock_quantity) || 0));
  return o?.stock_status === 'instock' ? 999 : 0;
}

/** App rows for one WooCommerce product (one row, or one per size). */
export function mapProduct(p: any, variations: any[], cats: Map<number, Cat>): Json[] {
  const category = leafCategory(p.categories ?? [], cats);
  const images: string[] = (p.images ?? []).map((i: any) => i?.src).filter((s: any) => typeof s === 'string');
  const published = p.status === 'publish' && p.catalog_visibility !== 'hidden';
  const description = htmlToText(p.short_description) || htmlToText(p.description);
  const name = htmlToText(p.name);
  if (p.type === 'variable') {
    return variations.map((v) => {
      const label = (v.attributes ?? []).map((a: any) => htmlToText(a?.option)).filter(Boolean).join(', ');
      const vImg = typeof v.image?.src === 'string' ? [v.image.src] : [];
      return {
        woo_id: v.id,
        woo_parent_id: p.id,
        sku: v.sku || '',
        name: label ? `${name} – ${label}` : name,
        description: htmlToText(v.description) || description,
        category,
        images: [...new Set([...vImg, ...images])].slice(0, 10),
        retail_price: num(v.regular_price) ?? 0,
        wholesale_price: num(meta(v, 'wholesale_customer_wholesale_price')),
        stock: stockOf(v),
        active: published && v.status === 'publish' && v.purchasable !== false,
      };
    });
  }
  if (p.type !== 'simple') return [];   // grouped / external products are not sold in the app
  return [{
    woo_id: p.id,
    woo_parent_id: null,
    sku: p.sku || '',
    name,
    description,
    category,
    images: images.slice(0, 10),
    retail_price: num(p.regular_price) ?? 0,
    wholesale_price: num(meta(p, 'wholesale_customer_wholesale_price')),
    stock: stockOf(p),
    active: published,
  }];
}

async function categories(): Promise<Map<number, Cat>> {
  const list = await wooAll('products/categories');
  return new Map(list.map((c: any) => [c.id, { id: c.id, name: c.name, parent: c.parent }]));
}

async function rowsFor(p: any, cats: Map<number, Cat>): Promise<Json[]> {
  const variations = p.type === 'variable' ? await wooAll(`products/${p.id}/variations`) : [];
  return mapProduct(p, variations, cats);
}

// ---------------------------------------------------------------------------
// Website orders → app
// ---------------------------------------------------------------------------
/** The app's view of a WooCommerce order (app orders copied to the website: only their status). */
export function mapWooOrder(o: any): Json {
  const appNumber = meta(o, 'eko_app_order');
  if (appNumber) return { woo_order_id: o.id, app_order_number: String(appNumber), status: o.status };
  const b = o.billing ?? {}, sh = o.shipping ?? {};
  const join = (...x: unknown[]) => x.map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
  const qtyPrice = (l: any) => {
    const q = Math.max(1, Number(l.quantity) || 1);
    return { quantity: q, unit_price: Math.round(((Number(l.total) || 0) + (Number(l.total_tax) || 0)) / q * 100) / 100 };
  };
  return {
    woo_order_id: o.id,
    status: o.status,
    created_at: o.date_created_gmt ? `${o.date_created_gmt}Z` : null,
    email: b.email || '',
    name: join(sh.first_name || b.first_name, sh.last_name || b.last_name) || join(b.company),
    phone: b.phone || sh.phone || '',
    address: join(sh.address_1 || b.address_1, sh.address_2 || b.address_2),
    city: sh.city || b.city || '',
    note: o.customer_note || '',
    payment_method: o.payment_method || '',
    total: Number(o.total) || 0,
    lines: (o.line_items ?? []).map((l: any) => ({
      woo_product_id: l.product_id, woo_variation_id: l.variation_id, name: htmlToText(l.name), sku: l.sku || '', ...qtyPrice(l),
    })),
  };
}

/** Website orders created/changed since the last check (catches webhooks that did not arrive). */
async function pollOrders(): Promise<Json> {
  const startedAt = new Date().toISOString();
  const prev: string | null = await rpc('woo_orders_polled', { p_at: null });
  const since = new Date(new Date(prev ?? startedAt).getTime() - 10 * 60 * 1000).toISOString().slice(0, 19);
  const orders = await wooAll(`orders?modified_after=${encodeURIComponent(since)}&orderby=modified&order=asc`);
  const counts: Record<string, number> = {};
  for (const o of orders) {
    const r = await rpc('woo_import_order', { p: mapWooOrder(o) });
    counts[r?.action ?? 'unknown'] = (counts[r?.action ?? 'unknown'] ?? 0) + 1;
  }
  await rpc('woo_orders_polled', { p_at: startedAt });
  return counts;
}

async function fullSync(notify: boolean): Promise<Json> {
  const cats = await categories();
  const products = await wooAll('products?status=any');
  const rows: Json[] = [];
  for (const p of products) {
    if (p.status === 'trash') continue;
    rows.push(...(await rowsFor(p, cats)));
  }
  const result = await rpc('woo_apply_products', { p_items: rows, p_full: true, p_notify: notify });
  const summary = { kind: 'full', products: products.length, ...result };
  await rpc('woo_record_sync', { p_result: summary });
  return summary;
}

async function syncOne(id: number): Promise<Json> {
  const r = await woo(`products/${id}`);
  if (r.status === 404 || r.data?.status === 'trash') return { hidden: await rpc('woo_hide_product', { p_woo_id: id }) };
  if (r.status !== 200) throw new Error(`WooCommerce products/${id}: HTTP ${r.status} ${r.reason}`.trim());
  const p = r.data;
  if (p.type === 'variation' && p.parent_id) return syncOne(p.parent_id);
  const cats = await categories();
  const rows = await rowsFor(p, cats);
  return rpc('woo_apply_products', { p_items: rows, p_full: false, p_notify: true });
}

// ---------------------------------------------------------------------------
// Orders → WooCommerce
// ---------------------------------------------------------------------------
const STATUS: Record<string, string> = {
  new: 'processing', confirmed: 'processing', accepted: 'processing', preparing: 'processing', shipped: 'processing',
  delivered: 'completed', completed: 'completed', cancelled: 'cancelled',
};

export function orderPayload(o: Json, customerId: number) {
  const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
  const parts = String(o.name ?? '').trim().split(/\s+/);
  const person = { first_name: parts[0] ?? '', last_name: parts.slice(1).join(' '), company: o.business_name ?? '',
    address_1: o.address ?? '', city: o.city ?? '', country: 'XK', phone: o.phone ?? '' };
  return {
    status: STATUS[o.status] ?? 'processing',
    customer_id: customerId,
    payment_method: o.payment_method === 'bank_transfer' ? 'bacs' : 'cod',
    payment_method_title: o.payment_method === 'bank_transfer' ? 'Transfer bankar' : 'Pagesë në dorëzim',
    set_paid: false,
    billing: { ...person, email: o.email ?? '' },
    shipping: person,
    customer_note: [`Porosi nga aplikacioni EKO Store #${o.order_number}`, o.note].filter(Boolean).join('\n'),
    line_items: (o.items ?? []).map((i: Json) => {
      const total = money(Number(i.unit_price) * Number(i.quantity));
      const line: Json = { quantity: i.quantity, subtotal: total, total };
      if (i.woo_id && i.woo_parent_id) { line.product_id = i.woo_parent_id; line.variation_id = i.woo_id; }
      else if (i.woo_id) line.product_id = i.woo_id;
      else { line.name = i.name; line.sku = i.sku; }
      return line;
    }),
    meta_data: [
      { key: 'eko_app_order', value: String(o.order_number) },
      { key: 'eko_price_tier', value: o.price_tier },
    ],
  };
}

async function customerIdFor(email: string | null): Promise<number> {
  if (!email) return 0;
  const r = await woo(`customers?email=${encodeURIComponent(email)}&role=all`);
  return r.status === 200 && Array.isArray(r.data) && r.data[0]?.id ? Number(r.data[0].id) : 0;
}

async function pushOrders(): Promise<Json> {
  const jobs: Json[] = await rpc('woo_claim_order_jobs', { p_limit: 10 });
  let sent = 0, failed = 0;
  for (const j of jobs) {
    let wooId: number | null = null;
    let error: string | null = null;
    try {
      const o = j.order;
      if (j.kind === 'create') {
        if (o.woo_order_id) wooId = o.woo_order_id;   // already there
        else {
          const r = await woo('orders', { method: 'POST', body: JSON.stringify(orderPayload(o, await customerIdFor(o.email))) });
          if (r.status !== 201 && r.status !== 200) throw new Error(`HTTP ${r.status} ${r.data?.code ?? ''} ${r.data?.message ?? ''}`.trim());
          wooId = Number(r.data.id);
        }
      } else {
        if (!o.woo_order_id) throw new Error('NOT_YET_CREATED');
        const r = await woo(`orders/${o.woo_order_id}`, { method: 'PUT', body: JSON.stringify({ status: STATUS[o.status] ?? 'processing' }) });
        if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.data?.code ?? ''}`.trim());
        wooId = o.woo_order_id;
      }
      sent++;
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 400);
      failed++;
    }
    await rpc('woo_finish_order_job', { p_job: j.job_id, p_woo_order_id: wooId, p_error: error });
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// Wholesale approved / revoked in the app → website role (WordPress snippet endpoint)
// ---------------------------------------------------------------------------
async function pushWholesale(): Promise<Json> {
  const secret = Deno.env.get('EKO_LINK_SECRET') ?? '';
  if (!secret) return { skipped: 'no_link_secret' };
  const jobs: Json[] = await rpc('link_claim_jobs', { p_limit: 20 });
  let sent = 0, failed = 0;
  for (const j of jobs) {
    let error: string | null = null;
    try {
      const site = (Deno.env.get('EKO_SITE_URL') || WOO).replace(/\/+$/, '');
      const res = await fetch(`${site}/wp-json/eko/v1/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-EKO-Link': secret, 'User-Agent': 'EKO-Store-App-Link/1.0' },
        body: JSON.stringify({ email: j.email, wholesale: j.wholesale }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sent++;
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 200);
      failed++;
    }
    await rpc('link_finish_job', { p_job: j.job_id, p_error: error });
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// Price changed by an administrator in the app / panel → website
// ---------------------------------------------------------------------------
const WHOLESALE_META = 'wholesale_customer_wholesale_price';
const priceText = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? String(Math.round(v * 100) / 100) : '';   // 0 → no price on the website
};

/** The WooCommerce update for one price job (only the prices that were changed in the app). */
export function pricePayload(j: Json): Json {
  const body: Json = {};
  if (j.retail) body.regular_price = priceText(j.retail_price);
  if (j.wholesale) {
    const w = priceText(j.wholesale_price);
    body.meta_data = [{ key: WHOLESALE_META, value: w }];
    if (!j.woo_parent_id && w) body.meta_data.push({ key: 'wholesale_customer_have_wholesale_price', value: 'yes' });
  }
  return body;
}

async function pushPrices(): Promise<Json> {
  const jobs: Json[] = await rpc('woo_claim_price_jobs', { p_limit: 20 });
  let sent = 0, failed = 0;
  for (const j of jobs) {
    let error: string | null = null;
    try {
      const path = j.woo_parent_id ? `products/${j.woo_parent_id}/variations/${j.woo_id}` : `products/${j.woo_id}`;
      const r = await woo(path, { method: 'PUT', body: JSON.stringify(pricePayload(j)) });
      if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.reason}`.trim());
      // a size got a wholesale price: the parent product is marked as having wholesale prices (Wholesale Suite)
      if (j.woo_parent_id && j.wholesale && priceText(j.wholesale_price)) {
        await woo(`products/${j.woo_parent_id}`, {
          method: 'PUT', body: JSON.stringify({ meta_data: [{ key: 'wholesale_customer_have_wholesale_price', value: 'yes' }] }),
        });
      }
      sent++;
    } catch (e) {
      error = String((e as Error)?.message ?? e).slice(0, 300);
      failed++;
    }
    await rpc('woo_finish_price_job', { p_job: j.job_id, p_rev: j.rev, p_error: error });
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------
async function isAdmin(req: Request): Promise<boolean> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || token.split('.').length !== 3) return false;
  const u = await fetch(`${BASE}/auth/v1/user`, { headers: { apikey: serverKey(), Authorization: `Bearer ${token}` } });
  if (!u.ok) return false;
  const id = (await u.json())?.id;
  if (!id) return false;
  const p = await fetch(`${BASE}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=role`, { headers: serviceHeaders() });
  return p.ok && (await p.json())?.[0]?.role === 'admin';
}

async function validWebhook(raw: string, signature: string): Promise<boolean> {
  const secret = Deno.env.get('WOO_WEBHOOK_SECRET') ?? '';
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  try {
    const raw = await req.text();
    const signature = req.headers.get('x-wc-webhook-signature') ?? '';
    const topic = req.headers.get('x-wc-webhook-topic') ?? '';

    // 0. WooCommerce "ping" when a webhook is saved: form body "webhook_id=<n>", no signature.
    //    Answered with 200 so that WooCommerce activates the webhook; nothing is read or changed.
    if (!signature && /^webhook_id=\d+$/.test(raw.trim())) return reply(200, { ok: true, ping: true });

    // 1. WooCommerce webhook
    if (signature || topic) {
      if (!(await validWebhook(raw, signature))) return reply(401, { error: 'bad_signature' });
      if (!wooConfigured()) return reply(200, { ok: true, skipped: 'not_configured' });
      let body: Json = {};
      try { body = JSON.parse(raw); } catch { return reply(200, { ok: true, ping: true }); }   // WooCommerce "ping" on save
      const id = Number(body?.id);
      if (topic.startsWith('order.')) {
        if (topic === 'order.deleted' || !Number.isInteger(id) || id <= 0) return reply(200, { ok: true, ignored: topic });
        return reply(200, { ok: true, result: await rpc('woo_import_order', { p: mapWooOrder(body) }) });
      }
      if (!topic.startsWith('product.') || !Number.isInteger(id) || id <= 0) return reply(200, { ok: true, ignored: topic });
      if (topic === 'product.deleted') return reply(200, { ok: true, hidden: await rpc('woo_hide_product', { p_woo_id: id }) });
      return reply(200, { ok: true, result: await syncOne(id) });
    }

    let body: Json = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return reply(400, { error: 'bad_request' }); }
    if (!wooConfigured()) return reply(200, { ok: true, skipped: 'not_configured' });

    // 2. Panel button (administrators only)
    if (body.action === 'sync') {
      if (!(await isAdmin(req))) return reply(403, { error: 'not_allowed' });
      const result = await fullSync(false);
      const orders = await pollOrders().catch((e) => ({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
      return reply(200, { ok: true, result, orders });
    }

    // 3. Scheduler tick (no key): only what is due
    const orders = await pushOrders();
    const wholesale = await pushWholesale().catch((e) => ({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
    const prices = await pushPrices().catch((e) => ({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
    const due: string = await rpc('woo_full_sync_due', {});
    const sync = due === 'no' ? null : await fullSync(due === 'due');   // the first catalogue: no promo notifications
    if (sync) await pollOrders().catch((e) => console.error('woo-sync orders', String((e as Error)?.message ?? e).slice(0, 300)));
    return reply(200, { ok: true, orders, wholesale, prices, synced: !!sync });
  } catch (e) {
    console.error('woo-sync', String((e as Error)?.message ?? e).slice(0, 300));
    return reply(500, { error: 'sync_failed' });
  }
});
