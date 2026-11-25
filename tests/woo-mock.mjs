// A small fake WooCommerce REST API (wc/v3) for tests/woo-sync.test.mjs.
// Synthetic catalogue shaped like eko-store.com (no real prices).
import http from 'node:http';

export const KEY = 'ck_test_key';
export const SECRET = 'cs_test_secret';
const img = (n) => `https://eko-store.example/wp-content/uploads/${n}.jpg`;
const meta = (w) => (w == null ? [] : [{ id: 1, key: 'wholesale_customer_wholesale_price', value: String(w) }]);

export function catalogue() {
  const categories = [
    { id: 10, name: 'Ngrohës Uji', parent: 0 },
    { id: 11, name: 'Bufer Akumulues', parent: 10 },
    { id: 20, name: 'Instalime', parent: 0 },
    { id: 21, name: 'Instalime Uji', parent: 20 },
    { id: 22, name: 'Fontan Muri', parent: 21 },
    { id: 30, name: 'Sanitari', parent: 0 },
  ];
  const products = [
    { id: 2742, type: 'simple', status: 'publish', catalog_visibility: 'visible', sku: '35', name: 'Fontan muri Visam Slim80',
      short_description: '<p>Fontan muri <strong>Slim</strong> &amp; i hollë.</p>', description: '',
      regular_price: '0', categories: [{ id: 20, name: 'Instalime' }, { id: 22, name: 'Fontan Muri' }, { id: 21, name: 'Instalime Uji' }],
      images: [{ src: img('fontan-1') }, { src: img('fontan-2') }], manage_stock: false, stock_status: 'instock', meta_data: meta(65) },
    { id: 2795, type: 'simple', status: 'publish', catalog_visibility: 'visible', sku: '576', name: 'Wc guacë me fontanë 21A',
      short_description: '', description: '<ul><li>Dalja P</li><li>Qeramikë</li></ul>',
      regular_price: '130', categories: [{ id: 30, name: 'Sanitari' }], images: [{ src: img('wc-21a') }],
      manage_stock: true, stock_quantity: 4, stock_status: 'instock', meta_data: meta(100) },
    { id: 2738, type: 'variable', status: 'publish', catalog_visibility: 'visible', sku: '', name: 'Akumulues (Buffer) për sistemet e ngrohjes 50&#8211;150 L',
      short_description: '<p>Akumulues termik.</p>', description: '', regular_price: '',
      categories: [{ id: 10, name: 'Ngrohës Uji' }, { id: 11, name: 'Bufer Akumulues' }],
      images: [{ src: img('buffer') }], manage_stock: false, stock_status: 'instock', meta_data: [] },
    { id: 2600, type: 'grouped', status: 'publish', catalog_visibility: 'visible', sku: 'G1', name: 'Grup', categories: [], images: [], meta_data: [] },
    { id: 2601, type: 'simple', status: 'draft', catalog_visibility: 'visible', sku: 'DRAFT-1', name: 'Draft', regular_price: '5',
      categories: [], images: [], manage_stock: false, stock_status: 'instock', meta_data: meta(4) },
  ];
  const variations = {
    2738: [
      { id: 2853, sku: '936', status: 'publish', purchasable: true, regular_price: '0', description: '<p>50 litra, montim në mur.</p>',
        attributes: [{ name: 'Litra', option: '50L' }], image: { src: img('buffer-50') }, manage_stock: false, stock_status: 'instock', meta_data: meta(117) },
      { id: 2854, sku: '970', status: 'publish', purchasable: true, regular_price: '', description: '',
        attributes: [{ name: 'Litra', option: '80L' }], image: null, manage_stock: false, stock_status: 'outofstock', meta_data: meta(139) },
      { id: 2893, sku: '', status: 'publish', purchasable: true, regular_price: '160', description: '',
        attributes: [{ name: 'Litra', option: '150L me këmb' }], image: null, manage_stock: false, stock_status: 'instock', meta_data: meta(198) },
      { id: 2899, sku: '999X', status: 'private', purchasable: true, regular_price: '10', description: '',
        attributes: [{ name: 'Litra', option: '1L' }], image: null, manage_stock: false, stock_status: 'instock', meta_data: meta(9) },
    ],
  };
  return { categories, products, variations };
}

/** Starts the fake API. `state.requests` records every call; options change its behaviour. */
export function startWooMock(port = 8099) {
  const state = { ...catalogue(), requests: [], orders: [], nextOrder: 5001, rejectHeaderAuth: false, failOrders: 0, refuse403: 0,
    customers: [{ id: 77, email: 'known@test.local' }] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname.replace(/^\/wp-json\/wc\/v3\//, '');
      const auth = req.headers.authorization ?? '';
      const headerOk = auth === `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString('base64')}` && !state.rejectHeaderAuth;
      const queryOk = url.searchParams.get('consumer_key') === KEY && url.searchParams.get('consumer_secret') === SECRET;
      state.requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), headerAuth: !!auth, body: raw });
      const send = (status, data, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(data));
      };
      if (state.refuse403 > 0) {   // like a hosting firewall refusing a burst
        state.refuse403--;
        res.writeHead(403, { 'Content-Type': 'text/html' });
        return res.end('<html><head><title>403 Forbidden</title></head><body>Blocked</body></html>');
      }
      if (!headerOk && !queryOk) return send(401, { code: 'woocommerce_rest_cannot_view' });
      const page = Number(url.searchParams.get('page') ?? '1');
      const list = (arr) => send(200, page === 1 ? arr : [], { 'X-WP-TotalPages': '1' });
      let m;
      if (req.method === 'GET' && path === 'products/categories') return list(state.categories);
      if (req.method === 'GET' && path === 'products') return list(state.products);
      if (req.method === 'GET' && (m = path.match(/^products\/(\d+)\/variations$/))) return list(state.variations[m[1]] ?? []);
      if (req.method === 'GET' && (m = path.match(/^products\/(\d+)$/))) {
        const id = Number(m[1]);
        const p = state.products.find((x) => x.id === id);
        if (p) return send(200, p);
        for (const [parent, vs] of Object.entries(state.variations)) {
          if (vs.some((v) => v.id === id)) return send(200, { id, type: 'variation', parent_id: Number(parent) });
        }
        return send(404, { code: 'woocommerce_rest_product_invalid_id' });
      }
      if (req.method === 'GET' && path === 'customers') return list(state.customers.filter((c) => c.email === url.searchParams.get('email')));
      if (req.method === 'POST' && path === 'orders') {
        if (state.failOrders > 0) { state.failOrders--; return send(500, { code: 'internal_error', message: 'boom' }); }
        const o = { id: state.nextOrder++, ...JSON.parse(raw) };
        state.orders.push(o);
        return send(201, o);
      }
      if (req.method === 'PUT' && (m = path.match(/^orders\/(\d+)$/))) {
        const o = state.orders.find((x) => x.id === Number(m[1]));
        if (!o) return send(404, { code: 'woocommerce_rest_shop_order_invalid_id' });
        Object.assign(o, JSON.parse(raw));
        return send(200, o);
      }
      return send(404, { code: 'rest_no_route' });
    });
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve({ state, close: () => server.close() })));
}
