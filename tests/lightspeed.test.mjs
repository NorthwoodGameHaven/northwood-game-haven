// tests/lightspeed.test.mjs — NGH-BUILD 2026-09-11a
// Run:  node --test /home/claude/ngh-app/tests/
// Pure helpers are tested directly (lightspeed-core.mjs). The I/O modules are
// loaded through _mock-hooks.mjs (in-memory db/email/stripe/ticket mocks) with
// globalThis.fetch stubbed, so token refresh, 401 re-read, recordSale, the
// account/shop handlers and the Stripe webhook all run for real.
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import crypto from 'node:crypto';

process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SITE_URL = 'https://gamehaven.guru';
process.env.LIGHTSPEED_CLIENT_ID = 'cid';
process.env.LIGHTSPEED_CLIENT_SECRET = 'csecret';
process.env.LIGHTSPEED_DOMAIN = 'teststore';
process.env.LIGHTSPEED_OUTLET_ID = 'outlet-1';
process.env.LIGHTSPEED_REGISTER_ID = 'reg-1';
process.env.LIGHTSPEED_USER_ID = 'user-web';
process.env.LIGHTSPEED_PAYMENT_TYPE_ONLINE = 'pt-online';
process.env.LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT = 'pt-onaccount';
process.env.LIGHTSPEED_TAX_ID = 'tax-wi';
delete process.env.LIGHTSPEED_TOKEN;

const core = await import('../netlify/functions/_shared/lightspeed-core.mjs');
register('./_mock-hooks.mjs', import.meta.url);
const ls = await import('../netlify/functions/_shared/lightspeed.mjs');
const accountFn = (await import('../netlify/functions/account.mjs')).default;
const shopFn = (await import('../netlify/functions/shop.mjs')).default;
const lightspeedFn = (await import('../netlify/functions/lightspeed.mjs')).default;
const webhookFn = (await import('../netlify/functions/stripe-webhook.mjs')).default;
const checkoutFn = (await import('../netlify/functions/create-checkout.mjs')).default;

const M = globalThis.__mock;
const SECRET = 'test-admin-secret';
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- fetch stub: ordered routes [{match(url, init), reply(url, init)}] -----------
let routes = [], calls = [];
const jres = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); calls.push({ url: u, init });
  for (const r of routes) if (r.match(u, init)) return r.reply(u, init);
  return jres({ error: 'unrouted ' + u }, 599);
};
function resetMocks() {
  routes = []; calls = [];
  M.db.handlers = []; M.db.calls = [];
  M.mail.length = 0; M.stripe.sessions.length = 0;
}
function tokenRow(over = {}) { return { access_token: 'A1', refresh_token: 'R1', expires: nowSec() + 3600, domain_prefix: 'teststore', ...over }; }
function dbTokens(getRow) { M.db.handlers.push((t) => { if (!t.startsWith('SELECT data FROM integration_tokens')) return undefined; const r = getRow(); return r ? [{ data: r }] : []; }); }
const auth = (init) => (init.headers || {}).Authorization;
const req = (method, path, { body, headers, raw } = {}) => new Request('https://gamehaven.guru' + path, {
  method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: raw != null ? raw : (body != null ? JSON.stringify(body) : undefined)
});

// =====================================================================================
describe('core: tokens & OAuth state', () => {
  test('normalizeTokenResponse uses expires, else expires_in, keeps previous refresh token', () => {
    const t = core.normalizeTokenResponse({ access_token: 'a', refresh_token: 'r', expires: 1_800_000_000, domain_prefix: 'shop' }, 'x', 1000);
    assert.equal(t.expires, 1_800_000_000); assert.equal(t.domain_prefix, 'shop'); assert.equal(t.refresh_token, 'r');
    const t2 = core.normalizeTokenResponse({ access_token: 'a2', expires_in: 3600 }, 'shop', 1000, { refresh_token: 'old' });
    assert.equal(t2.expires, 4600); assert.equal(t2.refresh_token, 'old'); assert.equal(t2.domain_prefix, 'shop');
  });
  test('tokenNeedsRefresh: < 120 s left → refresh', () => {
    assert.equal(core.tokenNeedsRefresh({ access_token: 'a', expires: 1000 + 119 }, 1000), true);
    assert.equal(core.tokenNeedsRefresh({ access_token: 'a', expires: 1000 + 121 }, 1000), false);
    assert.equal(core.tokenNeedsRefresh(null, 1000), true);
  });
  test('state round-trips, rejects tamper and > 10 min age', () => {
    const s = core.signState(SECRET, 5_000_000);
    assert.ok(core.verifyState(SECRET, s, 5_000_000 + 60_000));
    assert.equal(core.verifyState(SECRET, s, 5_000_000 + 11 * 60_000), false);
    assert.equal(core.verifyState('other', s, 5_000_000), false);
    assert.equal(core.verifyState(SECRET, s.slice(0, -1) + 'f', 5_000_000), false);
  });
  test('authorizeUrl carries the spec scopes and redirect', () => {
    const u = new URL(core.authorizeUrl({ clientId: 'cid', redirectUri: 'https://gamehaven.guru/api/lightspeed/callback', state: 'st' }));
    assert.equal(u.origin + u.pathname, 'https://secure.retail.lightspeed.app/connect');
    assert.equal(u.searchParams.get('scope'), core.SCOPES);
    assert.ok(core.SCOPES.includes('sales:write') && core.SCOPES.includes('retailer:read'));
    assert.equal(u.searchParams.get('response_type'), 'code');
  });
  test('apiUrl: versioned vs legacy root', () => {
    assert.equal(core.apiUrl('shop', '2.0', 'customers/abc'), 'https://shop.retail.lightspeed.app/api/2.0/customers/abc');
    assert.equal(core.apiUrl('shop', null, 'register_sales'), 'https://shop.retail.lightspeed.app/api/register_sales');
    assert.equal(core.apiUrl('shop', '2.0', 'search', { type: 'customers', email: 'a@b.co' }), 'https://shop.retail.lightspeed.app/api/2.0/search?type=customers&email=a%40b.co');
  });
});

describe('core: sessions, order tokens, codes', () => {
  test('session token format <id>.<expMs>.<hmac> and verification', () => {
    const tok = core.issueSession(SECRET, 'cust-123', 30, 1_000_000);
    const [id, exp, mac] = tok.split('.');
    assert.equal(id, 'cust-123'); assert.equal(Number(exp), 1_000_000 + 30 * 86_400_000);
    assert.equal(mac, crypto.createHmac('sha256', SECRET).update('cust-123|' + exp).digest('hex'));
    assert.deepEqual(core.verifySession(SECRET, tok, 1_000_001).customerId, 'cust-123');
    assert.equal(core.verifySession(SECRET, tok, 1_000_000 + 31 * 86_400_000), null);
    assert.equal(core.verifySession('nope', tok, 1_000_001), null);
    assert.equal(core.verifySession(SECRET, 'cust-999.' + exp + '.' + mac, 1_000_001), null);
  });
  test('pseudo email session (dots in the id) parses from the right', () => {
    const tok = core.issueSession(SECRET, core.pseudoId('Jane.Doe@Example.com'));
    const s = core.verifySession(SECRET, tok);
    assert.equal(s.pseudo, true); assert.equal(s.email, 'jane.doe@example.com'); assert.equal(s.customerId, null);
  });
  test('order token', () => {
    const sig = core.orderSig(SECRET, 'ORD-AB12');
    assert.equal(sig.length, 20);
    assert.ok(core.verifyOrderSig(SECRET, 'ORD-AB12', sig));
    assert.equal(core.verifyOrderSig(SECRET, 'ORD-AB13', sig), false);
  });
  test('codes: 6 digits, sha256 hash bound to the email', () => {
    for (let i = 0; i < 20; i++) assert.match(core.genCode(), /^\d{6}$/);
    assert.equal(core.hashCode('A@B.co', '123456'), crypto.createHash('sha256').update('a@b.co:123456').digest('hex'));
  });
});

describe('core: sale payload', () => {
  test('splits inc-tax prices, applies loyalty, maps state → status and payments', () => {
    const { body, total, status } = core.buildSalePayload({
      sourceId: 'NGH-1:fee', state: 'closed', payment: 'online', note: 'n', saleDate: '2026-09-11T15:04:05Z', customerId: 'c1',
      lines: [{ productId: 'p-room', name: 'Room booking', qty: 1, priceIncTax: 105.5, loyalty: true },
              { productId: 'p-dep', name: 'Deposit', qty: 1, priceIncTax: 40, loyalty: false, taxable: false }],
      taxRate: 0.055, loyaltyRatio: 0.05, loyaltyEnabled: true
    });
    assert.equal(status, 'CLOSED'); assert.equal(body.status, 'CLOSED');
    assert.equal(body.source_id, 'NGH-1:fee'); assert.equal(body.register_id, 'reg-1'); assert.equal(body.user_id, 'user-web'); assert.equal(body.customer_id, 'c1');
    assert.equal(body.sale_date, '2026-09-11 15:04:05');
    const [room, dep] = body.register_sale_products;
    assert.equal(room.price, 100); assert.equal(room.tax, 5.5); assert.equal(room.tax_id, 'tax-wi'); assert.equal(room.loyalty_value, 5);
    assert.deepEqual(room.attributes, [{ name: 'line_note', value: 'Room booking' }]);
    assert.equal(dep.price, 40); assert.equal(dep.tax, 0); assert.equal(dep.tax_id, undefined); assert.equal(dep.loyalty_value, undefined);
    assert.equal(total, 145.5);
    assert.deepEqual(body.register_sale_payments, [{ retailer_payment_type_id: 'pt-online', amount: 145.5, payment_date: '2026-09-11 15:04:05' }]);
  });
  test('parked sale has no payments; on-account uses ONACCOUNT + on-account payment type; no loyalty when disabled', () => {
    const lines = [{ productId: 'p1', qty: 2, priceIncTax: 10.55 }];
    const parked = core.buildSalePayload({ sourceId: 'ORD-1', state: 'parked', payment: null, lines, taxRate: 0.055, loyaltyRatio: 0.1, loyaltyEnabled: false });
    assert.equal(parked.body.status, 'SAVED'); assert.deepEqual(parked.body.register_sale_payments, []); assert.equal(parked.body.register_sale_products[0].loyalty_value, undefined);
    assert.equal(parked.total, 21.1);
    const oa = core.buildSalePayload({ sourceId: 'REG-1', state: 'closed', payment: 'onaccount', lines, taxRate: 0.055 });
    assert.equal(oa.body.status, 'ONACCOUNT');
    assert.deepEqual(oa.body.register_sale_payments.map(p => p.retailer_payment_type_id), ['pt-onaccount']);
  });
  test('booking / registration / order line builders', () => {
    const b = { id: 'NGH-77', rooms: ['holt', 'den'], date: '2026-10-01', costBooking: 100, deposit: 105, addons: [{ id: 'karaoke', title: 'Karaoke Equipment' }], name: 'Jane Doe', email: 'j@d.co', phone: '555' };
    const fee = core.bookingSaleLines(b, 'fee', 10550);
    assert.equal(fee[0].sku, 'NGH-ROOM'); assert.equal(fee[0].name, "Room booking — The Holt, Stash's Den 2026-10-01"); assert.equal(fee[0].priceIncTax, 105.5); assert.equal(fee[0].loyalty, true);
    assert.equal(fee[1].sku, 'NGH-KARAOKE'); assert.equal(fee[1].priceIncTax, 0);
    const dep = core.bookingSaleLines(b, 'deposit', null);
    assert.deepEqual(dep, [{ sku: 'NGH-DEPOSIT', name: 'Refundable deposit — NGH-77', qty: 1, priceIncTax: 105, loyalty: false, taxable: false }]);
    assert.equal(core.bookingSaleLines({ ...b, addons: [] }, 'fee', null)[0].priceIncTax, 105.5);   // fallback: costBooking + 5.5% tax
    const r = { id: 'REG-1', eventTitle: 'Commander Night', occDate: '2026-10-02', qty: 3, paidBreakdown: { subtotalCents: 3000, taxCents: 165, feeCents: 125, totalCents: 3290 } };
    const rl = core.registrationSaleLines(r);
    assert.equal(rl.length, 1); assert.equal(rl[0].sku, 'NGH-EVENT'); assert.equal(rl[0].name, 'Commander Night 2026-10-02 × 3'); assert.equal(rl[0].qty, 3);
    assert.equal(rl[0].priceIncTax, core.round2(3290 / 3 / 100));
    process.env.LIGHTSPEED_SKU_FEE = 'NGH-FEE';
    const rl2 = core.registrationSaleLines(r);
    delete process.env.LIGHTSPEED_SKU_FEE;
    assert.equal(rl2.length, 2); assert.equal(rl2[0].priceIncTax, 10.55); assert.equal(rl2[1].sku, 'NGH-FEE'); assert.equal(rl2[1].priceIncTax, 1.25);
    const ol = core.orderSaleLines({ items: [{ id: 'p1', sku: 'S1', name: 'Dice', qty: 2, price: 12.99 }] });
    assert.deepEqual(ol, [{ productId: 'p1', sku: 'S1', name: 'Dice', qty: 2, priceIncTax: 12.99, loyalty: true }]);
    assert.deepEqual(core.customerOf(b), { email: 'j@d.co', firstName: 'Jane', lastName: 'Doe', phone: '555' });
  });
});

describe('core: catalog normalizer & order totals', () => {
  test('normalizeProduct / catalogItem', () => {
    const p = { id: 'p1', name: 'Catan', variant_name: '', sku: 'CAT-1', price_excluding_tax: 47.39, price_including_tax: 50, active: true, has_inventory: true,
      product_type_id: 't1', brand_id: 'b1', tags: [{ name: 'Strategy' }], description: '<p>Trade &amp; build</p>', images: [{ url: 'https://i/full.jpg', sizes: { thumb: 'https://i/t.jpg' } }], version: 42, deleted_at: null };
    const n = core.normalizeProduct(p, { types: new Map([['t1', 'Board Games']]), brands: new Map([['b1', 'Kosmos']]), taxRate: 0.055 });
    assert.equal(n.price, 50); assert.equal(n.priceExTax, 47.39); assert.equal(n.type, 'Board Games'); assert.equal(n.brand, 'Kosmos');
    assert.deepEqual(n.tags, ['Strategy']); assert.equal(n.description, 'Trade & build'); assert.equal(n.image, 'https://i/full.jpg'); assert.equal(n.thumb, 'https://i/t.jpg');
    assert.equal(n.deleted, false); assert.equal(n.hasInventory, true); assert.equal(n.version, 42);
    const n2 = core.normalizeProduct({ id: 'p2', name: 'Sleeves', price_excluding_tax: 10, has_inventory: false, deleted_at: '2026-01-01', is_active: false }, { taxRate: 0.055 });
    assert.equal(n2.price, 10.55); assert.equal(n2.deleted, true); assert.equal(n2.active, false); assert.equal(n2.hasInventory, false);
    const item = core.catalogItem({ data: n }, 3);
    assert.equal(item.stock, 3); assert.equal(core.catalogItem({ data: n2 }, 0).stock, null);
  });
  test('computeOrderTotals (tax included) and order ids', () => {
    const t = core.computeOrderTotals([{ price: 10.55, qty: 2 }, { price: 5, qty: 1 }], 0.055);
    assert.equal(t.subtotal, 26.1); assert.equal(t.total, 26.1); assert.equal(t.count, 3); assert.equal(t.taxIncluded, 1.36);
    for (let i = 0; i < 10; i++) assert.match(core.newOrderId(), /^ORD-[A-HJ-NP-Z2-9]{4}$/);
  });
  test('normalizeSale / normalizeCustomer', () => {
    const s = core.normalizeSale({ id: 's1', sale_date: '2026-09-01', status: 'CLOSED', total_price: 100, total_tax: 5.5, line_items: [{ product_id: 'p1', quantity: 2, price: 50 }] }, new Map([['p1', 'Catan']]));
    assert.equal(s.total, 105.5); assert.deepEqual(s.items, [{ productId: 'p1', name: 'Catan', qty: 2, price: 100 }]);
    const c = core.normalizeCustomer({ id: 'c1', first_name: 'A', enable_loyalty: 1, loyalty_balance: '12.50', customer_group: { name: 'VIP' } });
    assert.equal(c.enable_loyalty, true); assert.equal(c.loyalty_balance, 12.5); assert.equal(c.customer_group, 'VIP');
  });
});

// =====================================================================================
describe('lsFetch: OAuth token handling', () => {
  beforeEach(resetMocks);

  test('refreshes before the call when < 120 s remain and saves the rotated tokens', async () => {
    let row = tokenRow({ expires: nowSec() + 30 });
    dbTokens(() => row);
    M.db.handlers.push((t, v) => { if (t.startsWith('INSERT INTO integration_tokens')) { row = JSON.parse(v[1]); return []; } });
    routes.push({ match: u => u.endsWith('/api/1.0/token'), reply: (u, init) => {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'R1'); assert.equal(form.get('client_secret'), 'csecret');
      return jres({ access_token: 'A2', refresh_token: 'R2', expires: nowSec() + 86400, domain_prefix: 'teststore' });
    } });
    routes.push({ match: u => u.includes('/api/2.0/outlets'), reply: (u, init) => auth(init) === 'Bearer A2' ? jres({ data: [{ id: 'o1', name: 'Main' }] }) : jres({}, 401) });
    const d = await ls.lsFetch('outlets');
    assert.deepEqual(d.data, [{ id: 'o1', name: 'Main' }]);
    assert.equal(row.access_token, 'A2'); assert.equal(row.refresh_token, 'R2');
    assert.equal(calls.filter(c => c.url.endsWith('/api/1.0/token')).length, 1);
  });

  test('on 401 re-reads the row first — uses the token another instance already rotated, no refresh call', async () => {
    let reads = 0;
    dbTokens(() => (reads++ === 0 ? tokenRow({ access_token: 'A1' }) : tokenRow({ access_token: 'A3', refresh_token: 'R3' })));
    routes.push({ match: u => u.includes('/api/2.0/customers/c1'), reply: (u, init) => auth(init) === 'Bearer A3' ? jres({ data: { id: 'c1', email: 'x@y.z' } }) : jres({ error: 'expired' }, 401) });
    const c = await ls.getCustomer('c1');
    assert.equal(c.id, 'c1');
    assert.equal(calls.filter(c => c.url.endsWith('/api/1.0/token')).length, 0);
    assert.deepEqual(calls.filter(c => c.url.includes('customers/c1')).map(c => auth(c.init)), ['Bearer A1', 'Bearer A3']);
  });

  test('on 401 with an unchanged row it refreshes itself and retries once', async () => {
    let row = tokenRow();
    dbTokens(() => row);
    M.db.handlers.push((t, v) => { if (t.startsWith('INSERT INTO integration_tokens')) { row = JSON.parse(v[1]); return []; } });
    routes.push({ match: u => u.endsWith('/api/1.0/token'), reply: () => jres({ access_token: 'A4', refresh_token: 'R4', expires_in: 3600 }) });
    routes.push({ match: u => u.includes('/api/2.0/registers'), reply: (u, init) => auth(init) === 'Bearer A4' ? jres({ data: [] }) : jres({}, 401) });
    const d = await ls.lsFetch('registers');
    assert.deepEqual(d, { data: [] });
    assert.equal(row.access_token, 'A4'); assert.equal(row.refresh_token, 'R4');
  });

  test('throws LsError (with status, without leaking tokens) when not connected / API error', async () => {
    dbTokens(() => null);
    await assert.rejects(ls.lsFetch('outlets'), e => e instanceof ls.LsError && e.status === 0);
    M.db.handlers = []; dbTokens(() => tokenRow());
    routes.push({ match: () => true, reply: () => jres({ error: 'boom' }, 500) });
    await assert.rejects(ls.lsFetch('outlets'), e => e instanceof ls.LsError && e.status === 500 && /boom/.test(e.message) && !/A1|R1/.test(e.message));
  });

  test('LIGHTSPEED_TOKEN personal token bypasses OAuth entirely', async () => {
    process.env.LIGHTSPEED_TOKEN = 'personal-xyz';
    try {
      routes.push({ match: u => u.includes('/api/2.0/outlets'), reply: (u, init) => jres({ data: [], seen: auth(init) }) });
      const d = await ls.lsFetch('outlets');
      assert.equal(d.seen, 'Bearer personal-xyz');
      assert.equal(M.db.calls.filter(c => c.text.includes('integration_tokens')).length, 0);
    } finally { delete process.env.LIGHTSPEED_TOKEN; }
  });

  test('exchangeCode posts the form to /api/1.0/token on the callback domain and stores the row', async () => {
    let saved = null;
    M.db.handlers.push((t, v) => { if (t.startsWith('INSERT INTO integration_tokens')) { saved = JSON.parse(v[1]); return []; } });
    routes.push({ match: u => u === 'https://newstore.retail.lightspeed.app/api/1.0/token', reply: (u, init) => {
      const f = new URLSearchParams(init.body);
      assert.equal(f.get('grant_type'), 'authorization_code'); assert.equal(f.get('code'), 'the-code'); assert.equal(f.get('redirect_uri'), 'https://gamehaven.guru/api/lightspeed/callback');
      assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
      return jres({ access_token: 'AX', refresh_token: 'RX', expires: 1_900_000_000, domain_prefix: 'newstore' });
    } });
    await ls.exchangeCode('the-code', 'newstore', 'https://gamehaven.guru/api/lightspeed/callback');
    assert.equal(saved.access_token, 'AX'); assert.equal(saved.domain_prefix, 'newstore'); assert.equal(saved.expires, 1_900_000_000);
  });
});

// ---- shared X-Series stub used by recordSale / handler tests -------------------------
function stubStore({ customers = [], products = [], saleReply, taxes } = {}) {
  routes.push({ match: u => u.includes('/api/2.0/search?') && u.includes('type=customers'), reply: u => {
    const email = new URL(u).searchParams.get('email');
    return jres({ data: customers.filter(c => c.email === email) });
  } });
  routes.push({ match: (u, i) => u.endsWith('/api/2.0/customers') && i.method === 'POST', reply: (u, i) => {
    const b = JSON.parse(i.body); const c = { id: 'c-new', enable_loyalty: true, ...b }; customers.push(c); return jres({ data: c });
  } });
  routes.push({ match: u => /\/api\/2\.0\/customers\/[^/?]+$/.test(u) && !u.includes('search'), reply: (u, i) => {
    const id = u.split('/').pop(); const c = customers.find(x => x.id === id);
    if (!c) return jres({ error: 'not found' }, 404);
    if (i.method === 'PUT') Object.assign(c, JSON.parse(i.body));
    return jres({ data: c });
  } });
  // NGH-BUILD 2026-09-12a: mirrors the live X-Series quirk — `sku=` only matches
  // SKUs with no hyphen (verified against the Northwood store), while `q=` does
  // a free-text match. findProductBySku must fall back to q= or every NGH-* line
  // fails to resolve.
  routes.push({ match: u => u.includes('type=products') && u.includes('sku='), reply: u => {
    const sku = new URL(u).searchParams.get('sku');
    return jres({ data: sku.includes('-') ? [] : products.filter(p => p.sku === sku) });
  } });
  routes.push({ match: u => u.includes('type=products') && u.includes('q='), reply: u => {
    const q = (new URL(u).searchParams.get('q') || '').toLowerCase();
    return jres({ data: products.filter(p => String(p.sku || '').toLowerCase().includes(q) || String(p.name || '').toLowerCase().includes(q)) });
  } });
  // NGH-BUILD 2026-09-12a: real X-Series 2.0 shape — no top-level `rate`, a `rates[]`
  // array of components (WI State 5% + Chippewa County 0.5%). taxRateOf must sum them.
  routes.push({ match: u => u.includes('/api/2.0/taxes'), reply: () => jres({ data: taxes || [{ id: 'tax-wi', name: 'WI', rates: [{ id: 'r-state', rate: 0.05 }, { id: 'r-county', rate: 0.005 }] }] }) });
  // NGH-BUILD 2026-09-12a: 2.0 nests loyalty as {enabled, ratio}; there is no top-level loyalty_ratio.
  routes.push({ match: u => u.includes('/api/2.0/retailer'), reply: () => jres({ data: { id: 'r1', name: 'NGH', default_currency: 'USD', loyalty: { enabled: true, ratio: 0.05 } } }) });
  routes.push({ match: u => u.includes('/api/2.0/customer_groups'), reply: () => jres({ data: [{ id: 'g1', name: 'VIP' }] }) });
  routes.push({ match: (u, i) => u === 'https://teststore.retail.lightspeed.app/api/register_sales' && i.method === 'POST', reply: (u, i) => (saleReply || (() => jres({ register_sale: { id: 'sale-1' } })))(JSON.parse(i.body)) });
}

describe('refundSale (NGH-BUILD 2026-09-12c)', () => {
  beforeEach(() => { resetMocks(); dbTokens(() => tokenRow()); });

  test('posts a RETURN with negative quantities and negative loyalty, logged under <sourceId>:refund', async () => {
    let posted = null, logged = null;
    stubStore({ customers: [{ id: 'c1', email: 'jane@d.co', enable_loyalty: true }], products: [{ id: 'p-room', sku: 'NGH-ROOM' }, { id: 'p-kara', sku: 'NGH-KARAOKE' }],
      saleReply: b => { posted = b; return jres({ register_sale: { id: 'sale-ret' } }); } });
    // the original sale must exist in the log for a reversal to be allowed, and the
    // '<id>:refund' key must NOT — otherwise the idempotency guard short-circuits.
    M.db.handlers.unshift((t, v) => t.startsWith('SELECT sale_id FROM ls_sales_log')
      ? (String(v[0]).endsWith(':refund') ? [] : [{ sale_id: 'sale-9' }]) : undefined);
    M.db.handlers.push((t, v) => { if (t.startsWith('INSERT INTO ls_sales_log')) { logged = v; return []; } });

    const res = await ls.refundSale({
      sourceId: 'NGH-77:fee', kind: 'booking-refund', customerEmail: 'jane@d.co',
      lines: core.bookingSaleLines({ id: 'NGH-77', rooms: ['holt'], date: '2026-10-01', addons: [{ id: 'karaoke' }] }, 'fee', 10550),
      payment: 'online', note: 'Refund — NGH booking NGH-77 (fee)'
    });
    assert.equal(res.ok, true); assert.equal(res.saleId, 'sale-ret'); assert.equal(res.error, null);
    assert.equal(posted.source_id, 'NGH-77:fee:refund');
    // negative qty is what makes it a return; loyalty must go negative or points never come back
    assert.deepEqual(posted.register_sale_products.map(p => [p.product_id, p.quantity, p.price, p.loyalty_value]),
      [['p-room', -1, 100, -5], ['p-kara', -1, 0, 0]]);
    assert.equal(posted.register_sale_payments[0].amount, -105.5);
    assert.equal(logged[0], 'NGH-77:fee:refund'); assert.equal(logged[1], 'sale-ret');
  });

  test('refuses to reverse a sale that was never recorded — no credit out of thin air', async () => {
    stubStore({ products: [{ id: 'p-room', sku: 'NGH-ROOM' }] });
    M.db.handlers.unshift(t => t.startsWith('SELECT sale_id FROM ls_sales_log') ? [] : undefined);
    const posts = calls.filter(c => c.url.endsWith('/api/register_sales')).length;
    const r = await ls.refundSale({ sourceId: 'NGH-NOPE:fee', lines: [{ sku: 'NGH-ROOM', qty: 1, priceIncTax: 10 }] });
    assert.equal(r.ok, false); assert.match(r.error, /nothing to reverse/);
    assert.equal(calls.filter(c => c.url.endsWith('/api/register_sales')).length, posts);
  });

  test('idempotent: a second reversal of the same sale posts nothing', async () => {
    stubStore({ products: [{ id: 'p-room', sku: 'NGH-ROOM' }] });
    // the ':refund' key is already logged → the guard must short-circuit
    M.db.handlers.unshift((t, v) => t.startsWith('SELECT sale_id FROM ls_sales_log')
      ? (String(v[0]).endsWith(':refund') ? [{ sale_id: 'sale-ret' }] : [{ sale_id: 'sale-9' }]) : undefined);
    const posts = calls.filter(c => c.url.endsWith('/api/register_sales')).length;
    const r = await ls.refundSale({ sourceId: 'NGH-77:fee', lines: [{ sku: 'NGH-ROOM', qty: 1, priceIncTax: 10 }] });
    assert.deepEqual({ ok: r.ok, skipped: r.skipped, saleId: r.saleId }, { ok: true, skipped: true, saleId: 'sale-ret' });
    assert.equal(calls.filter(c => c.url.endsWith('/api/register_sales')).length, posts);
  });
});

describe('recordSale', () => {
  beforeEach(() => { resetMocks(); dbTokens(() => tokenRow()); });

  test('resolves SKUs, splits tax, adds loyalty, posts to the legacy path and logs the sale', async () => {
    const custs = [{ id: 'c1', email: 'jane@d.co', first_name: 'Jane', enable_loyalty: true, customer_group_id: 'g1' }];
    let posted = null, logged = null;
    stubStore({ customers: custs, products: [{ id: 'p-room', sku: 'NGH-ROOM', name: 'Room' }, { id: 'p-kara', sku: 'NGH-KARAOKE', name: 'Karaoke' }], saleReply: b => { posted = b; return jres({ register_sale: { id: 'sale-9' } }); } });
    M.db.handlers.push((t, v) => { if (t.startsWith('INSERT INTO ls_sales_log')) { logged = v; return []; } });
    const res = await ls.recordSale({
      sourceId: 'NGH-77:fee', kind: 'booking', customer: { email: 'jane@d.co', firstName: 'Jane', lastName: 'Doe' },
      lines: core.bookingSaleLines({ id: 'NGH-77', rooms: ['holt'], date: '2026-10-01', addons: [{ id: 'karaoke' }] }, 'fee', 10550),
      payment: 'online', state: 'closed', note: 'NGH booking NGH-77 (fee)'
    });
    assert.deepEqual({ ok: res.ok, saleId: res.saleId, skipped: res.skipped, error: res.error }, { ok: true, saleId: 'sale-9', skipped: false, error: null });
    assert.equal(posted.customer_id, 'c1'); assert.equal(posted.status, 'CLOSED'); assert.equal(posted.source_id, 'NGH-77:fee');
    assert.deepEqual(posted.register_sale_products.map(p => [p.product_id, p.price, p.tax, p.loyalty_value]), [['p-room', 100, 5.5, 5], ['p-kara', 0, 0, 0]]);
    assert.deepEqual(posted.register_sale_payments.map(p => [p.retailer_payment_type_id, p.amount]), [['pt-online', 105.5]]);
    assert.equal(logged[0], 'NGH-77:fee'); assert.equal(logged[1], 'sale-9'); assert.equal(logged[2], 'booking');
  });

  test('creates the customer when the email is unknown; skips when the source_id is already logged', async () => {
    const custs = [];
    stubStore({ customers: custs, products: [{ id: 'p-ev', sku: 'NGH-EVENT' }] });
    const r1 = await ls.recordSale({ sourceId: 'REG-5', kind: 'registration', customer: { email: 'new@p.com', firstName: 'New', lastName: 'Person', phone: '715' },
      lines: [{ sku: 'NGH-EVENT', name: 'Trivia × 2', qty: 2, priceIncTax: 10.55 }], payment: 'online', state: 'closed' });
    assert.equal(r1.ok, true); assert.equal(r1.customerId, 'c-new');
    assert.equal(custs[0].email, 'new@p.com'); assert.equal(custs[0].enable_loyalty, true); assert.equal(custs[0].first_name, 'New');
    M.db.handlers.unshift(t => t.startsWith('SELECT sale_id FROM ls_sales_log') ? [{ sale_id: 'sale-1' }] : undefined);
    const posts = calls.filter(c => c.url.endsWith('/api/register_sales')).length;
    const r2 = await ls.recordSale({ sourceId: 'REG-5', kind: 'registration', lines: [{ productId: 'p-ev', qty: 1, priceIncTax: 1 }] });
    assert.deepEqual({ ok: r2.ok, skipped: r2.skipped, saleId: r2.saleId }, { ok: true, skipped: true, saleId: 'sale-1' });
    assert.equal(calls.filter(c => c.url.endsWith('/api/register_sales')).length, posts);
  });

  test('never throws: unknown SKU → {ok:false,error} and an error row in ls_sales_log', async () => {
    stubStore({ products: [] });
    let logged = null;
    M.db.handlers.push((t, v) => { if (t.startsWith('INSERT INTO ls_sales_log')) { logged = v; return []; } });
    const r = await ls.recordSale({ sourceId: 'ORD-BAD1', kind: 'order', lines: [{ sku: 'NOPE-1', qty: 1, priceIncTax: 5 }], payment: null, state: 'parked' });
    assert.equal(r.ok, false); assert.match(r.error, /NOPE-1/);
    assert.equal(logged[0], 'ORD-BAD1'); assert.equal(logged[1], 'order'); assert.match(logged[2], /NOPE-1/);   // (source_id, NULL, kind, error)
    const r2 = await ls.recordSale({ sourceId: 'ORD-BAD2', kind: 'order', lines: [{ productId: 'p1', qty: 1, priceIncTax: 5 }], payment: 'online', state: 'closed' , customer: { email: 'x@y.z' } });
    routes.length = 0; // API down → still no throw
    const r3 = await ls.recordSale({ sourceId: 'ORD-BAD3', kind: 'order', lines: [{ productId: 'p1', qty: 1, priceIncTax: 5 }], customer: { email: 'x@y.z' } });
    assert.equal(r2.ok, true); assert.equal(r3.ok, false); assert.ok(r3.error);
  });

  test('loyaltyDiscountForEmail keeps its contract', async () => {
    process.env.LOYALTY_GROUP_DISCOUNTS = '{"VIP":10}';
    try {
      stubStore({ customers: [{ id: 'c1', email: 'vip@d.co', customer_group_id: 'g1' }] });
      assert.deepEqual(await ls.loyaltyDiscountForEmail('vip@d.co'), { percent: 10, groupName: 'VIP', source: 'group' });
      assert.deepEqual(await ls.loyaltyDiscountForEmail('nobody@d.co'), { percent: 0, groupName: '', source: 'not_found' });
    } finally { delete process.env.LOYALTY_GROUP_DISCOUNTS; }
    assert.deepEqual(await ls.loyaltyDiscountForEmail('vip@d.co'), { percent: 0, groupName: '', source: 'disabled' });
  });
});

// =====================================================================================
describe('account.mjs', () => {
  beforeEach(() => { resetMocks(); dbTokens(() => tokenRow()); });

  test('start → emails a 6-digit code (hashed row, rate-limit counters); verify → session; unknown email → pseudo session', async () => {
    let row = null;
    M.db.handlers.push((t, v) => {
      if (t.startsWith('SELECT sent_count')) return row ? [row] : [];
      if (t.startsWith('INSERT INTO login_codes')) { row = { email: v[0], code_hash: v[1], expires_at: v[2], attempts: 0, sent_count: v[3], window_start: v[4] }; return []; }
      if (t.startsWith('SELECT code_hash')) return row ? [row] : [];
      if (t.startsWith('UPDATE login_codes SET attempts')) { row.attempts++; return []; }
    });
    stubStore({ customers: [] });
    let res = await accountFn(req('POST', '/api/account/start', { body: { email: 'New.Person@Example.com' } }));
    assert.equal(res.status, 200);
    assert.equal(M.mail.length, 1); assert.equal(M.mail[0].to, 'new.person@example.com');
    const code = /\b(\d{6})\b/.exec(M.mail[0].bodyText)[1];
    assert.equal(row.code_hash, core.hashCode('new.person@example.com', code)); assert.equal(row.sent_count, 1);
    // wrong code counts an attempt
    res = await accountFn(req('POST', '/api/account/verify', { body: { email: 'new.person@example.com', code: code === '000000' ? '111111' : '000000' } }));
    assert.equal(res.status, 400); assert.equal(row.attempts, 1);
    // right code, no X-Series customer → pseudo session, customer null
    res = await accountFn(req('POST', '/api/account/verify', { body: { email: 'new.person@example.com', code } }));
    const j = await res.json();
    assert.equal(res.status, 200); assert.equal(j.customer, null);
    const s = core.verifySession(SECRET, j.session);
    assert.equal(s.pseudo, true); assert.equal(s.email, 'new.person@example.com');
    // rate limit: 3 sends per window
    await accountFn(req('POST', '/api/account/start', { body: { email: 'new.person@example.com' } }));
    await accountFn(req('POST', '/api/account/start', { body: { email: 'new.person@example.com' } }));
    res = await accountFn(req('POST', '/api/account/start', { body: { email: 'new.person@example.com' } }));
    assert.equal(res.status, 429); assert.equal(M.mail.length, 3);
    // CORS allows the session header
    assert.match((await accountFn(req('OPTIONS', '/api/account/me'))).headers.get('access-control-allow-headers'), /X-NGH-Session/);
  });

  test('signup creates the X-Series customer (loyalty on) and re-issues a real session; /me returns the profile + history', async () => {
    const custs = [];
    stubStore({ customers: custs });
    routes.push({ match: u => u.includes('type=sales'), reply: () => jres({ data: [{ id: 's1', sale_date: '2026-09-01', status: 'CLOSED', total_price: 20, total_tax: 1.1, line_items: [{ product_id: 'p1', quantity: 1, price: 20 }] }] }) });
    M.db.handlers.push((t) => {
      if (t.startsWith('SELECT id, data->>\'name\' AS name FROM ls_products')) return [{ id: 'p1', name: 'Catan' }];
      if (t.startsWith('SELECT data FROM bookings')) return [{ data: { id: 'NGH-1', date: '2026-10-01', rooms: ['holt'], status: 'approved', feePaid: true, feePI: 'pi_secret' } }];
      if (t.startsWith('SELECT data FROM registrations')) return [{ data: { id: 'REG-1', eventTitle: 'Trivia', occDate: '2026-10-02', qty: 2, feePaid: true } }];
      if (t.startsWith('SELECT id, data, status, created_at FROM shop_orders')) return [{ id: 'ORD-AAAA', status: 'ready', created_at: 'x', data: { total: 9.99, pay: 'pickup', items: [] } }];
    });
    const pseudo = core.issueSession(SECRET, core.pseudoId('new@p.com'));
    let res = await accountFn(req('POST', '/api/account/signup', { body: { session: pseudo, first_name: 'New', last_name: 'Person', phone: '715-555-0100', marketing: true } }));
    let j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.equal(j.customer.id, 'c-new'); assert.equal(custs[0].enable_loyalty, true); assert.equal(custs[0].do_not_email, false); assert.equal(custs[0].email, 'new@p.com');
    assert.equal(core.verifySession(SECRET, j.session).customerId, 'c-new');

    res = await accountFn(req('GET', '/api/account/me', { headers: { 'X-NGH-Session': j.session } }));
    j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.equal(j.customer.first_name, 'New'); assert.deepEqual(j.loyalty, { ratio: 0.05, currency: 'USD' });
    assert.equal(j.purchases[0].items[0].name, 'Catan'); assert.equal(j.purchases[0].total, 21.1);
    assert.equal(j.bookings[0].id, 'NGH-1'); assert.deepEqual(j.bookings[0].rooms, ['The Holt']); assert.equal(j.bookings[0].feePI, undefined);
    assert.equal(j.registrations[0].ticketUrl, 'https://gamehaven.guru/ticket/REG-1.sig5');
    assert.equal(j.orders[0].id, 'ORD-AAAA'); assert.equal(j.orders[0].token, core.orderSig(SECRET, 'ORD-AAAA'));

    res = await accountFn(req('PUT', '/api/account/me', { headers: { 'X-NGH-Session': j.session ?? '' } }));
    assert.equal(res.status, 401);
    const sess = core.issueSession(SECRET, 'c-new');
    res = await accountFn(req('PUT', '/api/account/me', { headers: { 'X-NGH-Session': sess }, body: { phone: '715-555-0199', do_not_email: true } }));
    j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j)); assert.equal(custs[0].phone, '715-555-0199'); assert.equal(custs[0].do_not_email, true);
    assert.equal((await accountFn(req('GET', '/api/account/me', { headers: { 'X-NGH-Session': 'bogus.1.2' } }))).status, 401);
  });
});

// =====================================================================================
describe('shop.mjs', () => {
  beforeEach(() => { resetMocks(); dbTokens(() => tokenRow()); });
  const catan = core.normalizeProduct({ id: 'p1', name: 'Catan', sku: 'CAT-1', price_including_tax: 50, price_excluding_tax: 47.39, has_inventory: true, version: 10 });
  const sleeves = core.normalizeProduct({ id: 'p2', name: 'Sleeves', sku: 'SLV-1', price_including_tax: 5, price_excluding_tax: 4.74, has_inventory: false, version: 11 });

  test('catalog: joined rows, types/brands, ETag → 304', async () => {
    M.db.handlers.push((t, v) => {
      if (t.includes('FROM ls_products') && t.includes('max(version)')) return [{ v: 11, n: 2, synced: '2026-09-11T00:00:00Z' }];
      if (t.startsWith('SELECT COALESCE(max(version), 0)::bigint AS v FROM ls_inventory')) return [{ v: 7 }];
      if (t.includes('FROM ls_products p')) { assert.equal(v[0], 'outlet-1'); return [{ id: 'p1', data: catan, stock: 3 }, { id: 'p2', data: sleeves, stock: 0 }]; }
    });
    let res = await shopFn(req('GET', '/api/shop/catalog'));
    const j = await res.json();
    assert.equal(res.status, 200); assert.equal(j.products.length, 2);
    assert.deepEqual(j.products.map(p => [p.id, p.price, p.stock]), [['p1', 50, 3], ['p2', 5, null]]);
    const etag = res.headers.get('etag'); assert.equal(etag, '"cat-11-7-2"');
    res = await shopFn(req('GET', '/api/shop/catalog', { headers: { 'If-None-Match': etag } }));
    assert.equal(res.status, 304);
    res = await shopFn(req('GET', '/api/shop/product/p1'));
    assert.equal((await res.json()).product.name, 'Catan');
  });

  test('pay-at-pickup order → parked sale in X-Series, emails, public token; status flow', async () => {
    const orders = new Map();
    M.db.handlers.push((t, v) => {
      if (t.includes('FROM ls_products p') && t.includes('ANY(')) return [{ id: 'p1', data: catan, stock: 3 }, { id: 'p2', data: sleeves, stock: 0 }];
      if (t.startsWith('SELECT 1 FROM shop_orders')) return [];
      if (t.startsWith('INSERT INTO shop_orders')) { orders.set(v[0], { id: v[0], data: JSON.parse(v[1]), status: v[2], created_at: 'now' }); return []; }
      if (t.startsWith('UPDATE shop_orders SET data')) { const o = orders.get(v[v.length - 1]); o.data = JSON.parse(v[0]); if (v.length > 2) o.status = v[1]; return []; }
      if (t.startsWith('SELECT id, data, status, created_at FROM shop_orders WHERE id')) return orders.has(v[0]) ? [orders.get(v[0])] : [];
      if (t.startsWith('SELECT id, data, status, created_at FROM shop_orders WHERE status')) return [...orders.values()].filter(o => v[0].includes(o.status));
    });
    let posted = null;
    stubStore({ customers: [{ id: 'c1', email: 'jane@d.co', enable_loyalty: true }], saleReply: b => { posted = b; return jres({ register_sale: { id: 'sale-park' } }); } });
    let res = await shopFn(req('POST', '/api/shop/orders', { body: { name: 'Jane Doe', email: 'jane@d.co', phone: '715', items: [{ id: 'p1', qty: 2 }, { id: 'p2', qty: 1 }], pickupAt: '5:30 PM', note: 'gift wrap', pay: 'pickup' } }));
    let j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    const o = j.order;
    assert.match(o.id, /^ORD-[A-Z2-9]{4}$/); assert.equal(o.status, 'parked'); assert.equal(o.total, 105); assert.equal(o.taxIncluded, 5.47);
    assert.equal(o.sale.saleId, 'sale-park'); assert.equal(o.token, core.orderSig(SECRET, o.id));
    assert.equal(posted.status, 'SAVED'); assert.equal(posted.source_id, o.id); assert.match(posted.note, new RegExp('^ORDER AHEAD ' + o.id));
    assert.deepEqual(posted.register_sale_payments, []); assert.equal(posted.customer_id, 'c1');
    assert.deepEqual(posted.register_sale_products.map(p => [p.product_id, p.quantity, p.price + p.tax]), [['p1', 2, 50], ['p2', 1, 5]]);
    assert.deepEqual(M.mail.map(m => m.to), ['jane@d.co', 'stash@northwoodgamehaven.com']);
    // stock guard
    res = await shopFn(req('POST', '/api/shop/orders', { body: { name: 'J', email: 'jane@d.co', items: [{ id: 'p1', qty: 4 }], pay: 'pickup' } }));
    assert.equal(res.status, 400); assert.match((await res.json()).error, /only 3 left/);
    // public read needs the token; admin doesn't
    assert.equal((await shopFn(req('GET', '/api/shop/orders/' + o.id))).status, 401);
    assert.equal((await shopFn(req('GET', '/api/shop/orders/' + o.id + '?t=' + o.token))).status, 200);
    res = await shopFn(req('GET', '/api/shop/orders', { headers: { Authorization: 'Bearer admin-ok' } }));
    assert.equal((await res.json()).orders[0].id, o.id);
    assert.equal((await shopFn(req('GET', '/api/shop/orders'))).status, 401);
    // status → ready emails the customer
    res = await shopFn(req('POST', '/api/shop/orders/' + o.id + '/status', { headers: { Authorization: 'Bearer admin-ok' }, body: { status: 'ready' } }));
    j = await res.json();
    assert.equal(j.order.status, 'ready'); assert.equal(orders.get(o.id).status, 'ready'); assert.match(M.mail.at(-1).subject, /ready for pickup/);
    assert.equal((await shopFn(req('POST', '/api/shop/orders/' + o.id + '/status', { headers: { Authorization: 'Bearer admin-ok' }, body: { status: 'bogus' } }))).status, 400);
  });

  test('pay-online order → Stripe Checkout with tax-inclusive line items and kind:order metadata; webhook closes the sale', async () => {
    const orders = new Map();
    M.db.handlers.push((t, v) => {
      if (t.includes('FROM ls_products p') && t.includes('ANY(')) return [{ id: 'p1', data: catan, stock: 3 }];
      if (t.startsWith('SELECT 1 FROM shop_orders')) return [];
      if (t.startsWith('INSERT INTO shop_orders')) { orders.set(v[0], { id: v[0], data: JSON.parse(v[1]), status: v[2] }); return []; }
      if (t.startsWith('UPDATE shop_orders SET data')) { const o = orders.get(v[v.length - 1]); o.data = JSON.parse(v[0]); if (v.length > 2) o.status = v[1]; return []; }
      if (t.startsWith('SELECT data, status FROM shop_orders')) return orders.has(v[0]) ? [orders.get(v[0])] : [];
    });
    let posted = null;
    stubStore({ customers: [{ id: 'c1', email: 'jane@d.co', enable_loyalty: true }], saleReply: b => { posted = b; return jres({ register_sale: { id: 'sale-closed' } }); } });
    let res = await shopFn(req('POST', '/api/shop/orders', { body: { name: 'Jane Doe', email: 'jane@d.co', items: [{ id: 'p1', qty: 1 }], pay: 'online' } }));
    let j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.equal(j.order.status, 'new'); assert.equal(j.checkoutUrl, 'https://checkout.stripe.test/cs_test_1');
    const cs = M.stripe.sessions[0];
    assert.deepEqual(cs.items, [{ name: 'Catan', amountCents: 5000, qty: 1 }]); assert.deepEqual(cs.metadata, { kind: 'order', orderId: j.order.id });
    assert.match(cs.successUrl, /\/app\/shop\.html\?paid=1&order=ORD-/);
    assert.equal(posted, null); assert.equal(M.mail.length, 0);
    // webhook
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec';
    const evt = { type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_intent: 'pi_1', amount_total: 5000, metadata: { kind: 'order', orderId: j.order.id } } } };
    const bg = [];
    res = await webhookFn(req('POST', '/api/stripe-webhook', { raw: JSON.stringify(evt), headers: { 'stripe-signature': 'good' } }), { waitUntil: p => bg.push(p) });
    assert.equal(res.status, 200);
    assert.equal(bg.length, 1);           // Lightspeed write + emails ran in the background via context.waitUntil
    await Promise.all(bg);
    const stored = orders.get(j.order.id);
    assert.equal(stored.status, 'paid'); assert.equal(stored.data.paid, true); assert.equal(stored.data.sale.saleId, 'sale-closed');
    assert.equal(posted.status, 'CLOSED'); assert.deepEqual(posted.register_sale_payments.map(p => [p.retailer_payment_type_id, p.amount]), [['pt-online', 50]]);
    assert.deepEqual(M.mail.map(m => m.to), ['jane@d.co', 'stash@northwoodgamehaven.com']);
    // Stripe retry → idempotent (no second sale, no second email)
    res = await webhookFn(req('POST', '/api/stripe-webhook', { raw: JSON.stringify(evt), headers: { 'stripe-signature': 'good' } }));
    assert.equal(calls.filter(c => c.url.endsWith('/api/register_sales')).length, 1); assert.equal(M.mail.length, 2);
    assert.equal((await webhookFn(req('POST', '/api/stripe-webhook', { raw: '{}', headers: { 'stripe-signature': 'bad' } }))).status, 400);
    // durable pay-link for the same order via create-checkout
    res = await checkoutFn(req('POST', '/api/create-checkout', { body: { kind: 'order', id: j.order.id } }));
    assert.equal(res.status, 400); assert.match((await res.json()).error, /already paid/);
  });
});

// =====================================================================================
describe('stripe-webhook + create-checkout: bookings & registrations', () => {
  beforeEach(() => { resetMocks(); dbTokens(() => tokenRow()); process.env.STRIPE_WEBHOOK_SECRET = 'whsec'; });

  test('booking fee paid → NGH-ROOM (+NGH-KARAOKE) closed sale with source_id <id>:fee; deposit → NGH-DEPOSIT untaxed', async () => {
    const b = { id: 'NGH-77', name: 'Jane Doe', email: 'jane@d.co', rooms: ['holt'], date: '2026-10-01', costBooking: 100, deposit: 65, addons: [{ id: 'karaoke' }] };
    const posts = [];
    M.db.handlers.push((t, v) => {
      if (t.startsWith('SELECT data FROM bookings')) return [{ data: b }];
      if (t.startsWith('UPDATE bookings')) { Object.assign(b, JSON.parse(v[0])); return []; }
    });
    stubStore({ customers: [{ id: 'c1', email: 'jane@d.co', enable_loyalty: true }], products: [{ id: 'p-room', sku: 'NGH-ROOM' }, { id: 'p-kara', sku: 'NGH-KARAOKE' }, { id: 'p-dep', sku: 'NGH-DEPOSIT' }],
      saleReply: body => { posts.push(body); return jres({ register_sale: { id: 'sale-' + posts.length } }); } });
    const send = (part, cents) => webhookFn(req('POST', '/api/stripe-webhook', { raw: JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs', payment_intent: 'pi_' + part, amount_total: cents, metadata: { kind: 'booking', bookingId: 'NGH-77', part } } } }), headers: { 'stripe-signature': 'good' } }));
    await send('fee', 10550);
    assert.equal(b.feePaid, true); assert.equal(b.feePI, 'pi_fee'); assert.equal(b.feePaidCents, 10550); assert.equal(b.payment, undefined);
    assert.equal(posts[0].source_id, 'NGH-77:fee'); assert.equal(posts[0].status, 'CLOSED');
    assert.deepEqual(posts[0].register_sale_products.map(p => [p.product_id, p.price, p.tax, p.loyalty_value]), [['p-room', 100, 5.5, 5], ['p-kara', 0, 0, 0]]);
    assert.equal(posts[0].register_sale_products[0].attributes[0].value, 'Room booking — The Holt 2026-10-01');
    await send('deposit', 6500);
    assert.equal(b.depositPaid, true); assert.equal(b.payment, 'paid');
    assert.equal(posts[1].source_id, 'NGH-77:deposit');
    assert.deepEqual(posts[1].register_sale_products.map(p => [p.product_id, p.price, p.tax, p.loyalty_value, p.tax_id]), [['p-dep', 65, 0, undefined, undefined]]);
    await send('fee', 10550);   // Stripe retry → no third sale
    assert.equal(posts.length, 2);
  });

  test('registration paid → NGH-EVENT "<title> × qty" closed sale (fee folded in without LIGHTSPEED_SKU_FEE)', async () => {
    const r = { id: 'REG-9', name: 'Sam Smith', email: 'sam@s.co', eventId: 'ev1', eventTitle: 'Commander Night', occDate: '2026-10-02', qty: 2, cost: 10 };
    const posts = [];
    M.db.handlers.push((t, v) => {
      if (t.startsWith('SELECT data FROM registrations')) return [{ data: r }];
      if (t.startsWith('UPDATE registrations')) { Object.assign(r, JSON.parse(v[0])); return []; }
      if (t.startsWith('SELECT data FROM events')) return [];
    });
    stubStore({ customers: [], products: [{ id: 'p-ev', sku: 'NGH-EVENT' }], saleReply: body => { posts.push(body); return jres({ register_sale: { id: 'sale-r' } }); } });
    const md = { kind: 'registration', registrationId: 'REG-9', qty: '2', subtotalCents: '2000', taxCents: '110', feeCents: '94', totalCents: '2204' };
    await webhookFn(req('POST', '/api/stripe-webhook', { raw: JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs', payment_intent: 'pi_r', amount_total: 2204, metadata: md } } }), headers: { 'stripe-signature': 'good' } }));
    assert.equal(r.feePaid, true); assert.equal(r.ticketEmailSent, true);
    assert.equal(M.mail[0].to, 'sam@s.co'); assert.match(M.mail[0].subject, /ticket/);
    assert.equal(posts.length, 1); assert.equal(posts[0].source_id, 'REG-9'); assert.equal(posts[0].customer_id, 'c-new');
    const line = posts[0].register_sale_products[0];
    assert.equal(line.product_id, 'p-ev'); assert.equal(line.quantity, 2); assert.equal(line.attributes[0].value, 'Commander Night 2026-10-02 × 2');
    assert.equal(core.round2((line.price + line.tax) * 2), 22.04);
  });

  test('create-checkout method=onaccount writes an ONACCOUNT sale, marks the record and emails; kind=order builds Stripe items', async () => {
    const b = { id: 'NGH-88', name: 'Jane Doe', email: 'jane@d.co', rooms: ['den'], date: '2026-11-01', costBooking: 200, deposit: 40, status: 'approved' };
    const r = { id: 'REG-2', name: 'Sam Smith', email: 'sam@s.co', eventTitle: 'Trivia', qty: 1, cost: 10 };
    const o = { id: 'ORD-ZZZZ', email: 'jane@d.co', pay: 'online', items: [{ id: 'p1', name: 'Catan', qty: 2, price: 50 }] };
    const posts = [];
    M.db.handlers.push((t, v) => {
      if (t.startsWith('SELECT data FROM bookings')) return [{ data: b }];
      if (t.startsWith('UPDATE bookings')) { Object.assign(b, JSON.parse(v[0])); return []; }
      if (t.startsWith('SELECT data FROM registrations')) return [{ data: r }];
      if (t.startsWith('UPDATE registrations')) { Object.assign(r, JSON.parse(v[0])); return []; }
      if (t.startsWith('SELECT data, status FROM shop_orders')) return [{ data: o, status: 'new' }];
      if (t.startsWith('UPDATE shop_orders')) { Object.assign(o, JSON.parse(v[0])); return []; }
    });
    stubStore({ customers: [{ id: 'c1', email: 'jane@d.co', enable_loyalty: true }], products: [{ id: 'p-room', sku: 'NGH-ROOM' }, { id: 'p-ev', sku: 'NGH-EVENT' }],
      saleReply: body => { posts.push(body); return jres({ register_sale: { id: 'sale-oa' + posts.length } }); } });
    let res = await checkoutFn(req('POST', '/api/create-checkout', { body: { kind: 'booking', id: 'NGH-88', part: 'fee', method: 'onaccount' } }));
    let j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j)); assert.equal(j.onaccount, true); assert.equal(j.amountCents, 21100);
    assert.equal(b.payment, 'onaccount'); assert.equal(b.feeOnAccount, true); assert.equal(b.feePaid, undefined); assert.equal(b.onaccount.fee.saleId, 'sale-oa1');
    assert.equal(posts[0].status, 'ONACCOUNT'); assert.deepEqual(posts[0].register_sale_payments.map(p => [p.retailer_payment_type_id, p.amount]), [['pt-onaccount', 211]]);
    assert.equal(M.mail[0].to, 'jane@d.co'); assert.match(M.mail[0].bodyText, /pay link/);
    // second attempt (card) is refused now that it's on account; onaccount again → already
    assert.match((await (await checkoutFn(req('POST', '/api/create-checkout', { body: { kind: 'booking', id: 'NGH-88', part: 'fee' } }))).json()).error, /already on your account/);
    // GET pay-link → 302 to the confirmation page
    res = await checkoutFn(req('GET', '/api/create-checkout?kind=registration&id=REG-2&method=onaccount'));
    assert.equal(res.status, 302); assert.match(res.headers.get('location'), /\/ticket\/REG-2\.sig5\?onaccount=1$/);
    assert.equal(r.payment, 'onaccount'); assert.equal(posts[1].status, 'ONACCOUNT'); assert.equal(posts[1].register_sale_products[0].quantity, 1);
    assert.equal(core.round2(posts[1].register_sale_products[0].price + posts[1].register_sale_products[0].tax), 10.55);   // no Stripe fee on account
    // kind=order → Stripe session from the stored order
    res = await checkoutFn(req('POST', '/api/create-checkout', { body: { kind: 'order', id: 'ord-zzzz' } }));
    j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j)); assert.match(j.url, /checkout\.stripe\.test/);
    const cs = M.stripe.sessions.at(-1);
    assert.deepEqual(cs.items, [{ name: 'Catan', amountCents: 5000, qty: 2 }]); assert.deepEqual(cs.metadata, { kind: 'order', orderId: 'ORD-ZZZZ' }); assert.equal(o.checkoutSessionId, cs ? 'cs_test_' + M.stripe.sessions.length : null);
    // on-account disabled → 400 (needs BOTH switches off)
    delete process.env.LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT; delete process.env.LIGHTSPEED_ONACCOUNT;
    try { assert.equal((await checkoutFn(req('POST', '/api/create-checkout', { body: { kind: 'booking', id: 'NGH-88', part: 'deposit', method: 'onaccount' } }))).status, 400); }
    finally { process.env.LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT = 'pt-onaccount'; }
    // NGH-BUILD 2026-09-12a: LIGHTSPEED_ONACCOUNT alone switches it on, and with no
    // payment-type id the ONACCOUNT sale posts with an empty payments array — which is
    // how X-Series takes it, since on-account is a sale status and not a payment type.
    delete process.env.LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT; process.env.LIGHTSPEED_ONACCOUNT = 'true';
    try {
      const oa = core.buildSalePayload({ sourceId: 'OA-1', state: 'closed', payment: 'onaccount', lines: [{ productId: 'p1', qty: 1, priceIncTax: 25 }], taxRate: 0.055 });
      assert.equal(oa.body.status, 'ONACCOUNT');
      assert.deepEqual(oa.body.register_sale_payments, []);
      assert.equal((await checkoutFn(req('POST', '/api/create-checkout', { body: { kind: 'booking', id: 'NGH-88', part: 'deposit', method: 'onaccount' } }))).status, 200);
    } finally { process.env.LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT = 'pt-onaccount'; delete process.env.LIGHTSPEED_ONACCOUNT; }
  });

  test('create-checkout method=onaccount part=both settles fee + deposit as two ONACCOUNT sales in one click (NGH-BUILD 2026-09-11a)', async () => {
    const b = { id: 'NGH-99', name: 'Kyle K', email: 'kyle@k.co', rooms: ['holt'], date: '2026-11-02', costBooking: 100, deposit: 40, status: 'approved' };
    const posts = [];
    M.db.handlers.push((t, v) => {
      if (t.startsWith('SELECT data FROM bookings')) return [{ data: b }];
      if (t.startsWith('UPDATE bookings')) { Object.assign(b, JSON.parse(v[0])); return []; }
    });
    stubStore({ customers: [{ id: 'c9', email: 'kyle@k.co', enable_loyalty: true }], products: [{ id: 'p-room', sku: 'NGH-ROOM' }, { id: 'p-dep', sku: 'NGH-DEPOSIT' }],
      saleReply: body => { posts.push(body); return jres({ register_sale: { id: 'sale-b' + posts.length } }); } });
    const res = await checkoutFn(req('GET', '/api/create-checkout?kind=booking&id=NGH-99&part=both&method=onaccount'));
    assert.equal(res.status, 302); assert.match(res.headers.get('location'), /booking\.html\?onaccount=both&id=NGH-99$/);
    assert.equal(posts.length, 2); assert.deepEqual(posts.map(x => x.source_id), ['NGH-99:fee', 'NGH-99:deposit']);
    assert.equal(b.feeOnAccount, true); assert.equal(b.depositOnAccount, true); assert.equal(b.onaccount.deposit.saleId, 'sale-b2');
    assert.equal(M.mail.length, 1, 'one combined email'); assert.match(M.mail[0].subject, /fee \+ refundable deposit/);
    // nothing left → 400
    const again = await checkoutFn(req('POST', '/api/create-checkout', { body: { kind: 'booking', id: 'NGH-99', part: 'both', method: 'onaccount' } }));
    assert.equal(again.status, 400);
  });
});

// =====================================================================================
describe('lightspeed.mjs (connect / callback / status / replay)', () => {
  beforeEach(resetMocks);

  test('connect (admin) 302s to the consent screen with a signed state; callback verifies state, exchanges, redirects', async () => {
    assert.equal((await lightspeedFn(req('GET', '/api/lightspeed/connect'))).status, 401);
    let res = await lightspeedFn(req('GET', '/api/lightspeed/connect?token=admin-ok'));
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.host, 'secure.retail.lightspeed.app'); assert.equal(loc.searchParams.get('client_id'), 'cid');
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://gamehaven.guru/api/lightspeed/callback');
    const state = loc.searchParams.get('state');
    assert.ok(core.verifyState(SECRET, state));
    let saved = null;
    M.db.handlers.push((t, v) => { if (t.startsWith('INSERT INTO integration_tokens')) { saved = JSON.parse(v[1]); return []; } });
    routes.push({ match: u => u === 'https://mystore.retail.lightspeed.app/api/1.0/token', reply: () => jres({ access_token: 'AT', refresh_token: 'RT', expires: nowSec() + 86400, domain_prefix: 'mystore' }) });
    res = await lightspeedFn(req('GET', '/api/lightspeed/callback?code=abc&domain_prefix=mystore&state=' + encodeURIComponent(state)));
    assert.equal(res.status, 302); assert.equal(res.headers.get('location'), 'https://gamehaven.guru/app/guru-lightspeed.html?connected=1&domain=mystore');
    assert.equal(saved.access_token, 'AT'); assert.equal(saved.domain_prefix, 'mystore');
    res = await lightspeedFn(req('GET', '/api/lightspeed/callback?code=abc&domain_prefix=mystore&state=1.2.3'));
    assert.match(res.headers.get('location'), /guru-lightspeed\.html\?error=invalid/);
  });

  test('status reports connection + reference lists; disconnect clears; replay re-runs recordSale', async () => {
    let row = tokenRow();
    dbTokens(() => row);
    M.db.handlers.push((t) => {
      if (t.startsWith('DELETE FROM integration_tokens')) { row = null; return []; }
      if (t.startsWith('SELECT source_id, kind, error')) return [{ source_id: 'REG-1', kind: 'registration', error: 'x' }];
      if (t.startsWith('SELECT count(*)::int AS products')) return [{ products: 12, version: 99, synced_at: 's' }];
      if (t.startsWith('SELECT status, count(*)')) return [{ status: 'new', n: 2 }];
      if (t.startsWith('SELECT data FROM registrations')) return [{ data: { id: 'REG-1', name: 'S S', email: 'sam@s.co', eventTitle: 'Trivia', qty: 1, feePaid: true, paidBreakdown: { subtotalCents: 1000, taxCents: 55, feeCents: 61, totalCents: 1116 } } }];
    });
    ['outlets', 'registers', 'users', 'payment_types'].forEach(k => routes.push({ match: u => u.includes('/api/2.0/' + k), reply: () => jres({ data: [{ id: k + '-1', name: k, payment_type_id: 106 }] }) }));
    stubStore({ customers: [{ id: 'c1', email: 'sam@s.co' }], products: [{ id: 'p-ev', sku: 'NGH-EVENT' }] });
    let res = await lightspeedFn(req('GET', '/api/lightspeed/status', { headers: { Authorization: 'Bearer admin-ok' } }));
    let j = await res.json();
    assert.equal(j.connected, true); assert.equal(j.mode, 'oauth'); assert.equal(j.domain, 'teststore'); assert.equal(j.env.registerId, 'reg-1');
    assert.equal(j.reference.outlets[0].id, 'outlets-1'); assert.equal(j.reference.taxes[0].rate, 0.055); assert.equal(j.reference.retailer.loyaltyRatio, 0.05);
    assert.equal(j.unsynced[0].source_id, 'REG-1'); assert.equal(j.catalog.products, 12); assert.deepEqual(j.orders, { new: 2 });
    assert.ok(!JSON.stringify(j).includes('A1') && !JSON.stringify(j).includes('R1'));
    res = await lightspeedFn(req('POST', '/api/lightspeed/replay', { headers: { Authorization: 'Bearer admin-ok' }, body: { kind: 'registration', id: 'REG-1' } }));
    j = await res.json();
    assert.equal(j.results[0].ok, true); assert.equal(j.results[0].saleId, 'sale-1');
    res = await lightspeedFn(req('POST', '/api/lightspeed/disconnect', { headers: { Authorization: 'Bearer admin-ok' } }));
    assert.equal((await res.json()).connected, false);
    j = await (await lightspeedFn(req('GET', '/api/lightspeed/status', { headers: { Authorization: 'Bearer admin-ok' } }))).json();
    assert.equal(j.connected, false); assert.equal(j.reference, null);
  });
});
