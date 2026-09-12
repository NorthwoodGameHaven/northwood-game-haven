// netlify/functions/_shared/lightspeed-core.mjs
// NGH-BUILD 2026-09-11a — Lightspeed Retail X-Series integration: PURE helpers.
// ---------------------------------------------------------------------
// Everything in here is side-effect free (no DB, no fetch) so it can be unit
// tested with plain `node --test`. The I/O client lives in lightspeed.mjs.
//
//   cfg()                         env → config (never includes the client secret)
//   apiUrl / tokenUrl / authorizeUrl
//   normalizeTokenResponse / tokenNeedsRefresh
//   signState / verifyState       OAuth `state` (HMAC, 10-min expiry)
//   issueSession / verifySession  app session token  <customerId>.<expMs>.<hmac>
//   orderSig / verifyOrderSig     public order-lookup token
//   genCode / hashCode            6-digit email sign-in codes
//   splitIncTax / buildSalePayload  legacy /api/register_sales body builder
//   bookingSaleLines / registrationSaleLines / orderSaleLines
//   normalizeProduct / normalizeCustomer / normalizeSale
//   computeOrderTotals / newOrderId / splitName / roomLabel
//   jsonX / preflightX            JSON responses whose CORS allows X-NGH-Session
// ---------------------------------------------------------------------
import crypto from 'node:crypto';

export const SCOPES = 'customers:read customers:write products:read inventory:read sales:read sales:write payment_types:read taxes:read registers:read outlets:read users:read retailer:read';
export const AUTHORIZE_ENDPOINT = 'https://secure.retail.lightspeed.app/connect';
export const LOYALTY_PAYMENT_TYPE_ID = 106;   // a payment whose type has payment_type_id 106 = loyalty redemption
export const SESSION_HEADER = 'X-NGH-Session';
export const STATE_MAX_AGE_MS = 10 * 60_000;
export const SESSION_DAYS = 30;

export function secret() { return process.env.ADMIN_SECRET || process.env.ADMIN_CODE || 'change-me'; }

function parseMap(s) {
  if (!s) return {};
  try { const o = JSON.parse(s); const out = {}; for (const k in o) out[k.toLowerCase()] = Number(o[k]) || 0; return out; }
  catch { return {}; }
}

// Config from env. The client secret is deliberately NOT read here — only the
// token exchange / refresh code touches process.env.LIGHTSPEED_CLIENT_SECRET.
export function cfg() {
  const e = process.env;
  return {
    clientId: e.LIGHTSPEED_CLIENT_ID || '',
    domain: e.LIGHTSPEED_DOMAIN || '',
    version: e.LIGHTSPEED_API_VERSION || '2.0',
    personalToken: e.LIGHTSPEED_TOKEN || '',
    outletId: e.LIGHTSPEED_OUTLET_ID || '',
    registerId: e.LIGHTSPEED_REGISTER_ID || '',
    userId: e.LIGHTSPEED_USER_ID || '',
    paymentTypeOnline: e.LIGHTSPEED_PAYMENT_TYPE_ONLINE || '',
    paymentTypeOnAccount: e.LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT || '',
    taxId: e.LIGHTSPEED_TAX_ID || '',
    taxIdNone: e.LIGHTSPEED_TAX_ID_NONE || '',          // optional: "No Tax" id for the refundable deposit line
    customerGroupId: e.LIGHTSPEED_CUSTOMER_GROUP_ID || '', // optional: default group for app sign-ups
    onAccountStatus: e.LIGHTSPEED_ONACCOUNT_STATUS || 'ONACCOUNT',
    sku: {
      room: e.LIGHTSPEED_SKU_ROOM || 'NGH-ROOM',
      deposit: e.LIGHTSPEED_SKU_DEPOSIT || 'NGH-DEPOSIT',
      karaoke: e.LIGHTSPEED_SKU_KARAOKE || 'NGH-KARAOKE',
      event: e.LIGHTSPEED_SKU_EVENT || 'NGH-EVENT',
      fee: e.LIGHTSPEED_SKU_FEE || ''                    // optional: record the Stripe processing fee as its own line
    },
    map: parseMap(e.LOYALTY_GROUP_DISCOUNTS || '')
  };
}

export function siteBase() { return (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, ''); }
export function redirectUri() { return process.env.LIGHTSPEED_REDIRECT_URI || (siteBase() + '/api/lightspeed/callback'); }

// ---- URLs -------------------------------------------------------------
export function apiUrl(domain, version, path, query) {
  const base = 'https://' + domain + '.retail.lightspeed.app/api/' + (version ? (String(version).replace(/\/$/, '') + '/') : '');
  const u = new URL(base + String(path || '').replace(/^\//, ''));
  if (query) for (const k in query) if (query[k] != null && query[k] !== '') u.searchParams.set(k, query[k]);
  return u.toString();
}
export function tokenUrl(domain) { return 'https://' + domain + '.retail.lightspeed.app/api/1.0/token'; }
export function authorizeUrl({ clientId, redirectUri, state, scopes }) {
  const u = new URL(AUTHORIZE_ENDPOINT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('scope', scopes || SCOPES);
  return u.toString();
}

// ---- tokens -----------------------------------------------------------
// X-Series token response: {access_token, token_type, expires (epoch s), expires_in, refresh_token, domain_prefix}.
// Refresh ROTATES both tokens; when a refresh response omits refresh_token we keep the previous one.
export function normalizeTokenResponse(t, domainPrefix, nowSec = Math.floor(Date.now() / 1000), prev = null) {
  t = t || {};
  let expires = Number(t.expires);
  if (!isFinite(expires) || expires <= 0) expires = t.expires_in ? nowSec + Number(t.expires_in) : nowSec + 3600;
  return {
    access_token: t.access_token || '',
    refresh_token: t.refresh_token || (prev && prev.refresh_token) || '',
    token_type: t.token_type || 'Bearer',
    expires,
    domain_prefix: t.domain_prefix || domainPrefix || (prev && prev.domain_prefix) || '',
    obtained_at: nowSec
  };
}
export function tokenNeedsRefresh(tok, nowSec = Math.floor(Date.now() / 1000), marginSec = 120) {
  if (!tok || !tok.access_token) return true;
  const exp = Number(tok.expires);
  if (!isFinite(exp)) return false;               // unknown expiry → rely on 401 handling
  return (exp - nowSec) < marginSec;
}

// ---- HMAC helpers -----------------------------------------------------
function hmac(sec, s) { return crypto.createHmac('sha256', sec).update(String(s)).digest('hex'); }
export function safeEq(a, b) {
  try { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
  catch { return false; }
}

// OAuth state: "<tsMs>.<nonce>.<hmac>" — verified statelessly, 10-minute window.
export function signState(sec, nowMs = Date.now()) {
  const body = nowMs + '.' + crypto.randomBytes(8).toString('hex');
  return body + '.' + hmac(sec, 'state:' + body);
}
export function verifyState(sec, state, nowMs = Date.now(), maxAgeMs = STATE_MAX_AGE_MS) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const [ts, nonce, mac] = parts;
  if (!/^\d+$/.test(ts) || !/^[0-9a-f]{16}$/.test(nonce)) return false;
  const age = nowMs - Number(ts);
  if (age < -60_000 || age > maxAgeMs) return false;
  return safeEq(mac, hmac(sec, 'state:' + ts + '.' + nonce));
}

// App session: "<customerId>.<expMs>.<hmac(secret, customerId|expMs)>".
// customerId may be the pseudo id "email:<addr>" (contains dots) — so parse from the RIGHT.
export function sessionMac(sec, id, exp) { return hmac(sec, String(id) + '|' + String(exp)); }
export function issueSession(sec, id, days = SESSION_DAYS, nowMs = Date.now()) {
  const exp = nowMs + days * 86_400_000;
  return String(id) + '.' + exp + '.' + sessionMac(sec, id, exp);
}
export function verifySession(sec, token, nowMs = Date.now()) {
  const t = String(token || '').trim();
  const i2 = t.lastIndexOf('.'); if (i2 < 0) return null;
  const i1 = t.lastIndexOf('.', i2 - 1); if (i1 < 1) return null;
  const id = t.slice(0, i1), exp = t.slice(i1 + 1, i2), mac = t.slice(i2 + 1);
  if (!/^\d+$/.test(exp) || nowMs > Number(exp)) return null;
  if (!safeEq(mac, sessionMac(sec, id, exp))) return null;
  const pseudo = id.startsWith('email:');
  return { customerId: pseudo ? null : id, id, exp: Number(exp), pseudo, email: pseudo ? id.slice(6) : null };
}
export function pseudoId(email) { return 'email:' + String(email || '').trim().toLowerCase(); }

// Public order token (lets the customer poll their own order without a session).
export function orderSig(sec, orderId) { return hmac(sec, 'order:' + String(orderId)).slice(0, 20); }
export function verifyOrderSig(sec, orderId, sig) { return !!sig && safeEq(sig, orderSig(sec, orderId)); }

// ---- sign-in codes ----------------------------------------------------
export function genCode() { return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); }
export function hashCode(email, code) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase() + ':' + String(code || '').trim()).digest('hex');
}
export function validEmail(s) { s = String(s || '').trim(); return s.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

// ---- money ------------------------------------------------------------
export function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
export function round5(n) { return Math.round((Number(n) || 0) * 100000) / 100000; }
// X-Series tax `rate` is a fraction (0.055); tolerate percent-style values too.
export function taxRateOf(tax) {
  const r = Number(tax && tax.rate);
  if (!isFinite(r) || r < 0) return 0;
  return r > 1 ? r / 100 : r;
}
// In-store prices include tax; the legacy sale API wants ex-tax unit price + unit tax.
export function splitIncTax(priceIncTax, rate) {
  const inc = Number(priceIncTax) || 0;
  const price = round5(inc / (1 + (Number(rate) || 0)));
  return { price, tax: round5(inc - price) };
}
export function fmtSaleDate(d) {
  const x = d ? new Date(d) : new Date();
  const p = n => String(n).padStart(2, '0');
  return x.getUTCFullYear() + '-' + p(x.getUTCMonth() + 1) + '-' + p(x.getUTCDate()) + ' ' + p(x.getUTCHours()) + ':' + p(x.getUTCMinutes()) + ':' + p(x.getUTCSeconds());
}

// Legacy 0.9 status values. recordSale's `state` ('closed'|'parked') maps to
// status CLOSED|SAVED; an on-account sale uses ONACCOUNT (override with
// LIGHTSPEED_ONACCOUNT_STATUS=CLOSED if the store prefers).
export function saleStatus(state, payment, c = cfg()) {
  if (payment === 'onaccount') return c.onAccountStatus;
  return state === 'parked' ? 'SAVED' : 'CLOSED';
}

// Build the POST /api/register_sales body. `lines` must already carry productId.
//   lines: [{productId, name, qty, priceIncTax, loyalty, taxable}]
export function buildSalePayload({ sourceId, state = 'closed', payment = null, note, saleDate, customerId, lines, taxRate = 0, loyaltyRatio = 0, loyaltyEnabled = false }, c = cfg()) {
  const products = [];
  let total = 0;
  for (const l of (lines || [])) {
    const qty = Number(l.qty) || 0;
    const inc = Number(l.priceIncTax);
    if (!l.productId || qty <= 0 || !isFinite(inc) || inc < 0) continue;
    const taxable = l.taxable !== false;
    const { price, tax } = taxable ? splitIncTax(inc, taxRate) : { price: round5(inc), tax: 0 };
    const row = { product_id: l.productId, quantity: qty, price, tax, price_set: 1 };
    const taxId = taxable ? c.taxId : c.taxIdNone;
    if (taxId) row.tax_id = taxId;
    if (loyaltyEnabled && l.loyalty !== false && loyaltyRatio > 0) row.loyalty_value = round2(price * qty * loyaltyRatio);
    if (l.name) row.attributes = [{ name: 'line_note', value: String(l.name).slice(0, 255) }];
    products.push(row);
    total += inc * qty;
  }
  total = round2(total);
  const status = saleStatus(state, payment, c);
  const when = fmtSaleDate(saleDate);
  const payments = [];
  if (payment === 'online' && c.paymentTypeOnline && status !== 'SAVED') payments.push({ retailer_payment_type_id: c.paymentTypeOnline, amount: total, payment_date: when });
  if (payment === 'onaccount' && c.paymentTypeOnAccount) payments.push({ retailer_payment_type_id: c.paymentTypeOnAccount, amount: total, payment_date: when });
  const body = {
    source_id: String(sourceId),
    register_id: c.registerId,
    user_id: c.userId || undefined,
    status,
    sale_date: when,
    note: note ? String(note).slice(0, 1000) : undefined,
    register_sale_products: products,
    register_sale_payments: payments
  };
  if (customerId) body.customer_id = customerId;
  return { body, total, status, lineCount: products.length };
}

// ---- sale lines for bookings / registrations / shop orders --------------
export function roomLabel(id) { return ({ holt: 'The Holt', den: "Stash's Den", depths: 'The Depths' })[id] || id; }
export function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
export function customerOf(rec) {
  const { firstName, lastName } = splitName(rec && rec.name);
  return { email: (rec && rec.email) || '', firstName, lastName, phone: (rec && rec.phone) || '' };
}
function bookingHasKaraoke(b) {
  return !!(b && (b.karaoke || (b.addons || []).some(a => a && a.id === 'karaoke')));
}
// paidCents = what Stripe actually charged for that part (fee incl. tax after
// any loyalty discount, or the deposit). Falls back to the stored amounts.
export function bookingSaleLines(b, part, paidCents, c = cfg()) {
  const taxPct = (process.env.SALES_TAX_PERCENT != null && process.env.SALES_TAX_PERCENT !== '') ? Number(process.env.SALES_TAX_PERCENT) : 5.5;
  if (part === 'deposit') {
    const cents = paidCents != null ? Number(paidCents) : Math.round((Number(b.deposit) || 0) * 100);
    return [{ sku: c.sku.deposit, name: 'Refundable deposit — ' + (b.id || ''), qty: 1, priceIncTax: round2(cents / 100), loyalty: false, taxable: false }];
  }
  const fallback = Math.round((Number(b.costBooking) || 0) * (1 + taxPct / 100) * 100);
  const cents = paidCents != null ? Number(paidCents) : fallback;
  const rooms = (b.rooms || []).map(roomLabel).join(', ') || 'room';
  const lines = [{ sku: c.sku.room, name: 'Room booking — ' + rooms + ' ' + (b.date || ''), qty: 1, priceIncTax: round2(cents / 100), loyalty: true }];
  if (bookingHasKaraoke(b)) {
    const k = (b.addons || []).find(a => a && a.id === 'karaoke') || {};
    lines.push({ sku: c.sku.karaoke, name: 'Karaoke add-on — ' + (b.date || ''), qty: 1, priceIncTax: round2(Number(k.price || k.cost || 0)), loyalty: true });
  }
  return lines;
}
export function registrationSaleLines(r, c = cfg()) {
  const qty = Math.max(1, parseInt(r.qty, 10) || 1);
  const bd = r.paidBreakdown || {};
  const title = (r.eventTitle || 'NGH Event') + (r.occDate ? (' ' + r.occDate) : '');
  const lines = [];
  let goodsCents = (Number(bd.subtotalCents) || 0) + (Number(bd.taxCents) || 0);
  const feeCents = Number(bd.feeCents) || 0;
  if (!goodsCents) goodsCents = Number(r.amountPaidCents) || Math.round((Number(r.cost) || 0) * qty * 100);
  if (feeCents > 0 && c.sku.fee) {
    lines.push({ sku: c.sku.event, name: title + ' × ' + qty, qty, priceIncTax: round2(goodsCents / qty / 100), loyalty: true });
    lines.push({ sku: c.sku.fee, name: 'Online processing fee', qty: 1, priceIncTax: round2(feeCents / 100), loyalty: false });
  } else {
    // no fee SKU configured → fold the processing fee into the ticket line so the sale total = amount paid
    const total = goodsCents + feeCents;
    lines.push({ sku: c.sku.event, name: title + ' × ' + qty, qty, priceIncTax: round2(total / qty / 100), loyalty: true });
  }
  return lines;
}
export function orderSaleLines(o) {
  return (o.items || []).map(it => ({ productId: it.id, sku: it.sku, name: it.name, qty: Number(it.qty) || 1, priceIncTax: round2(it.price), loyalty: true }));
}

// ---- catalog / customer normalizers --------------------------------------
function stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
function firstImage(p) {
  const imgs = Array.isArray(p.images) ? p.images : [];
  const im = imgs[0] || null;
  const url = p.image_url || (im && (im.url || (im.sizes && (im.sizes.original || im.sizes.standard)))) || '';
  const thumb = p.image_thumbnail_url || (im && im.sizes && (im.sizes.thumb || im.sizes.sm || im.sizes.ss)) || url;
  return { image: url || '', thumb: thumb || '' };
}
// X-Series 2.0 product → cached catalog row. `lookups` = {types:Map, brands:Map, taxRate}.
export function normalizeProduct(p, lookups = {}) {
  const types = lookups.types || new Map(), brands = lookups.brands || new Map();
  const rate = Number(lookups.taxRate) || 0;
  const ex = p.price_excluding_tax != null ? Number(p.price_excluding_tax) : null;
  let inc = p.price_including_tax != null ? Number(p.price_including_tax) : null;
  if (inc == null && ex != null) inc = round2(ex * (1 + rate));
  const variant = p.variant_name && !String(p.name || '').includes(p.variant_name) ? (' — ' + p.variant_name) : '';
  const tags = Array.isArray(p.tags) ? p.tags.map(t => (t && typeof t === 'object') ? (t.name || '') : String(t)).filter(Boolean) : [];
  const { image, thumb } = firstImage(p);
  const active = p.active != null ? !!p.active : (p.is_active != null ? !!p.is_active : true);
  return {
    id: String(p.id),
    name: String(p.name || '') + variant,
    sku: p.sku || '',
    handle: p.handle || '',
    price: inc != null && isFinite(inc) ? round2(inc) : null,
    priceExTax: ex != null && isFinite(ex) ? round2(ex) : null,
    image, thumb,
    typeId: p.product_type_id || null, type: types.get(p.product_type_id) || (p.type && p.type.name) || '',
    brandId: p.brand_id || null, brand: brands.get(p.brand_id) || (p.brand && p.brand.name) || '',
    tags,
    description: stripHtml(p.description).slice(0, 2000),
    active,
    deleted: !!p.deleted_at,
    hasInventory: p.has_inventory !== false,
    variantParentId: p.variant_parent_id || null,
    version: Number(p.version) || 0
  };
}
// Public catalog item (what /shop/catalog returns).
export function catalogItem(row, stock) {
  const d = row.data || row;
  return { id: d.id, name: d.name, sku: d.sku, price: d.price, priceExTax: d.priceExTax, image: d.image, thumb: d.thumb,
    type: d.type, brand: d.brand, stock: d.hasInventory ? Number(stock || 0) : null, tags: d.tags || [], description: d.description || '' };
}
export function normalizeCustomer(c) {
  if (!c) return null;
  return {
    id: String(c.id),
    customer_code: c.customer_code || '',
    first_name: c.first_name || '', last_name: c.last_name || '',
    email: c.email || '', phone: c.phone || '', mobile: c.mobile || '',
    customer_group_id: c.customer_group_id || null,
    customer_group: (c.customer_group && c.customer_group.name) || c.customer_group_name || '',
    enable_loyalty: !!c.enable_loyalty,
    loyalty_balance: Number(c.loyalty_balance) || 0,
    balance: Number(c.balance) || 0,
    do_not_email: !!c.do_not_email,
    version: c.version || null
  };
}
// X-Series 2.0 sale → purchase-history row. `names` = Map(productId → name).
export function normalizeSale(s, names = new Map()) {
  const items = (s.line_items || s.register_sale_products || []).map(li => ({
    productId: li.product_id, name: names.get(li.product_id) || li.name || 'Item',
    qty: Number(li.quantity) || 0, price: round2(li.price_total != null ? li.price_total : (Number(li.price) || 0) * (Number(li.quantity) || 0))
  }));
  const price = Number(s.total_price) || 0, tax = Number(s.total_tax) || 0;
  return { id: s.id, date: s.sale_date || s.created_at || '', status: s.status || '', invoice: s.invoice_number || '',
    total: round2(s.total_price_incl != null ? s.total_price_incl : price + tax), totalTax: round2(tax), loyalty: round2(s.total_loyalty || 0), items };
}

// ---- shop orders --------------------------------------------------------
export function computeOrderTotals(items, taxRate = 0) {
  let subtotal = 0, count = 0;
  for (const it of (items || [])) { subtotal += (Number(it.price) || 0) * (Number(it.qty) || 0); count += Number(it.qty) || 0; }
  subtotal = round2(subtotal);
  const taxIncluded = round2(subtotal - subtotal / (1 + (Number(taxRate) || 0)));
  return { subtotal, taxIncluded, total: subtotal, count };
}
export function newOrderId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 4; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return 'ORD-' + s;
}
export const ORDER_STATUSES = ['new', 'paid', 'parked', 'ready', 'picked_up', 'canceled'];

// ---- responses ------------------------------------------------------------
// db.mjs's json() only allows Content-Type/Authorization in CORS preflight; the
// app (Capacitor origin) also sends X-NGH-Session, so these variants allow it.
const CORS_X = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, ' + SESSION_HEADER,
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};
export function jsonX(body, status = 200, extra) {
  return new Response(body == null ? '' : JSON.stringify(body), { status, headers: { ...CORS_X, ...(extra || {}) } });
}
export function badX(msg, status = 400) { return jsonX({ error: msg }, status); }
export function preflightX() { return new Response(null, { status: 204, headers: CORS_X }); }   // null body: Node 22 rejects '' on 204
