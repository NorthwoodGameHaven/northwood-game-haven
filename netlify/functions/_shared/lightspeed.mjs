// netlify/functions/_shared/lightspeed.mjs
// NGH-BUILD 2026-09-11a — Lightspeed Retail X-Series (formerly Vend) client.
// ---------------------------------------------------------------------
// Rewrite of the old personal-token helper. Backward compatible:
// `loyaltyDiscountForEmail(email)` behaves exactly as before, but every call
// now goes through the shared OAuth client (`lsFetch`).
//
// Auth: OAuth tokens live in Neon `integration_tokens (provider='lightspeed')`
// as {access_token, refresh_token, expires (epoch s), domain_prefix}. The client
// refreshes when < 120 s remain; refresh ROTATES both tokens, so on a 401 we
// re-read the row first (another instance may have refreshed) and only then
// refresh ourselves. A LIGHTSPEED_TOKEN personal token (Plus plan) bypasses
// OAuth entirely when set (needs LIGHTSPEED_DOMAIN).
//
// Exports:
//   ensureLsSchema()                        creates the integration tables
//   getConnection() / saveTokens() / clearTokens()
//   authorizeUrl(state) / exchangeCode(code, domainPrefix, redirectUri)
//   lsFetch(path, {method, body, version, query})   throws LsError on !ok
//   findCustomerByEmail / getCustomer / createCustomer / updateCustomer / customerGroupName
//   listReference() / getRetailer() / getTaxRate()
//   listProductsPage / listInventoryPage / listProductTypes / listBrands / searchProducts
//   customerSales(customerId) / findProductBySku(sku)
//   recordSale({...})  → {ok, saleId, skipped, error}  (never throws)
//   loyaltyDiscountForEmail(email)          unchanged contract
// Secrets are never logged; the client secret is only ever read from process.env.
// ---------------------------------------------------------------------
import { sql } from './db.mjs';
import * as core from './lightspeed-core.mjs';

export class LsError extends Error {
  constructor(msg, status, body) { super(msg); this.name = 'LsError'; this.status = status || 0; this.body = body; }
}
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- schema ---------------------------------------------------------------
let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710' || c === '42701'; }
async function createIfMissing(stmt) { try { await stmt; } catch (e) { if (!isAlreadyExists(e)) throw e; } }
export async function ensureLsSchema() {
  if (_ready) return;
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS integration_tokens (
    provider    TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS ls_products (
    id          TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    version     BIGINT,
    updated_at  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS ls_inventory (
    product_id     TEXT,
    outlet_id      TEXT,
    current_amount NUMERIC,
    version        BIGINT,
    PRIMARY KEY (product_id, outlet_id)
  )`);
  await createIfMissing(sql`ALTER TABLE ls_inventory ADD COLUMN IF NOT EXISTS version BIGINT`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS shop_orders (
    id          TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    status      TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS login_codes (
    email        TEXT PRIMARY KEY,
    code_hash    TEXT,
    expires_at   TIMESTAMPTZ,
    attempts     INT DEFAULT 0,
    sent_count   INT DEFAULT 0,
    window_start TIMESTAMPTZ
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS ls_sales_log (
    source_id   TEXT PRIMARY KEY,
    sale_id     TEXT,
    kind        TEXT,
    error       TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
  )`);
  // Columns beyond the spec's minimal shapes (harmless if the tables were pre-created from the spec).
  await createIfMissing(sql`ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS sent_count INT DEFAULT 0`);
  await createIfMissing(sql`ALTER TABLE login_codes ADD COLUMN IF NOT EXISTS window_start TIMESTAMPTZ`);
  await createIfMissing(sql`ALTER TABLE ls_sales_log ADD COLUMN IF NOT EXISTS error TEXT`);
  _ready = true;
}

// ---- tokens ----------------------------------------------------------------
const PROVIDER = 'lightspeed';
async function readTokens() {
  await ensureLsSchema();
  const r = await sql`SELECT data FROM integration_tokens WHERE provider = ${PROVIDER}`;
  return r.length ? r[0].data : null;
}
export async function saveTokens(data) {
  await ensureLsSchema();
  await sql`INSERT INTO integration_tokens (provider, data, updated_at) VALUES (${PROVIDER}, ${JSON.stringify(data)}::jsonb, now())
            ON CONFLICT (provider) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
  return data;
}
export async function clearTokens() { await ensureLsSchema(); await sql`DELETE FROM integration_tokens WHERE provider = ${PROVIDER}`; }

// Returns {mode:'personal'|'oauth', domain, access_token, refresh_token?, expires?} or null.
export async function getConnection() {
  const c = core.cfg();
  if (c.personalToken && c.domain) return { mode: 'personal', domain: c.domain, access_token: c.personalToken, expires: null };
  const row = await readTokens();
  if (!row || !row.access_token) return null;
  return { mode: 'oauth', domain: c.domain || row.domain_prefix || '', ...row };
}

export function authorizeUrl(state) {
  const c = core.cfg();
  return core.authorizeUrl({ clientId: c.clientId, redirectUri: core.redirectUri(), state, scopes: core.SCOPES });
}
async function tokenRequest(domain, form) {
  const res = await fetch(core.tokenUrl(domain), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams(form).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const why = (data && (data.error_description || data.error || data.message)) || '';
    throw new LsError('Lightspeed token request failed (' + res.status + (why ? ': ' + String(why).slice(0, 120) : '') + ')', res.status);
  }
  return data;
}
export async function exchangeCode(code, domainPrefix, redirectUri) {
  const c = core.cfg();
  const domain = domainPrefix || c.domain;
  if (!domain) throw new LsError('missing domain_prefix', 400);
  if (!c.clientId || !process.env.LIGHTSPEED_CLIENT_SECRET) throw new LsError('LIGHTSPEED_CLIENT_ID / LIGHTSPEED_CLIENT_SECRET not set', 500);
  const data = await tokenRequest(domain, {
    code, client_id: c.clientId, client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
    grant_type: 'authorization_code', redirect_uri: redirectUri || core.redirectUri()
  });
  return saveTokens(core.normalizeTokenResponse(data, domain, nowSec()));
}
async function refreshTokens(row) {
  const c = core.cfg();
  const domain = c.domain || (row && row.domain_prefix);
  if (!row || !row.refresh_token || !c.clientId || !process.env.LIGHTSPEED_CLIENT_SECRET || !domain) {
    throw new LsError('Lightspeed token expired and cannot be refreshed — reconnect from the Guru Lightspeed page', 401);
  }
  const data = await tokenRequest(domain, {
    refresh_token: row.refresh_token, client_id: c.clientId, client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });
  console.log('[lightspeed] access token refreshed');
  return saveTokens(core.normalizeTokenResponse(data, domain, nowSec(), row));
}

// ---- core fetch -------------------------------------------------------------
// version: undefined → LIGHTSPEED_API_VERSION (default 2.0); null/'' → legacy root (/api/<path>).
export async function lsFetch(path, opts = {}) {
  const { method = 'GET', body, query } = opts;
  const c = core.cfg();
  const version = opts.version === undefined ? c.version : opts.version;
  let conn = await getConnection();
  if (!conn) throw new LsError('Lightspeed is not connected', 0);
  if (conn.mode === 'oauth' && core.tokenNeedsRefresh(conn, nowSec())) conn = { ...conn, ...(await refreshTokens(conn)) };

  const url = core.apiUrl(conn.domain, version, path, query);
  const doFetch = (token) => fetch(url, {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', ...(body != null ? { 'Content-Type': 'application/json' } : {}) },
    body: body != null ? JSON.stringify(body) : undefined
  });

  let res = await doFetch(conn.access_token);
  if (res.status === 401 && conn.mode === 'oauth' && opts.retry !== false) {
    // Another instance may already have rotated the tokens: re-read before refreshing.
    const fresh = await readTokens();
    const tok = (fresh && fresh.access_token && fresh.access_token !== conn.access_token) ? fresh : await refreshTokens(fresh || conn);
    res = await doFetch(tok.access_token);
  }
  if (res.status === 429 && opts.retry !== false) {
    const wait = Math.min(5000, Math.max(500, (Number(res.headers.get('retry-after')) || 1) * 1000));
    await new Promise(r => setTimeout(r, wait));
    res = await doFetch((await getConnection() || conn).access_token);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const why = data && (data.error_description || data.message || data.error || (data.errors && JSON.stringify(data.errors)));
    throw new LsError('Lightspeed ' + method + ' ' + path + ' → ' + res.status + (why ? ' (' + String(why).slice(0, 200) + ')' : ''), res.status, data);
  }
  return data;
}
const listOf = d => (d && (Array.isArray(d.data) ? d.data : (Array.isArray(d) ? d : []))) || [];
const oneOf = d => (d && (d.data || d)) || null;
const enc = s => encodeURIComponent(String(s));

// ---- customers ---------------------------------------------------------------
export async function findCustomerByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const list = listOf(await lsFetch('search', { query: { type: 'customers', email: e } }));
  const cust = list.find(x => String(x.email || '').toLowerCase() === e && !x.deleted_at) || null;
  return cust ? core.normalizeCustomer(cust) : null;
}
export async function getCustomer(id) { return core.normalizeCustomer(oneOf(await lsFetch('customers/' + enc(id)))); }
export async function createCustomer(fields) {
  const c = core.cfg();
  const body = { enable_loyalty: true, ...fields };
  if (!body.customer_group_id && c.customerGroupId) body.customer_group_id = c.customerGroupId;
  return core.normalizeCustomer(oneOf(await lsFetch('customers', { method: 'POST', body })));
}
export async function updateCustomer(id, fields) {
  return core.normalizeCustomer(oneOf(await lsFetch('customers/' + enc(id), { method: 'PUT', body: fields })));
}
let _groups = { at: 0, map: new Map() };
export async function customerGroupName(groupId) {
  if (!groupId) return '';
  if (Date.now() - _groups.at > 600_000 || !_groups.map.has(groupId)) {
    try {
      const list = listOf(await lsFetch('customer_groups'));
      _groups = { at: Date.now(), map: new Map(list.map(g => [g.id, g.name || g.group_name || ''])) };
    } catch (e) { console.error('[lightspeed] customer_groups', e.message); }
  }
  return _groups.map.get(groupId) || '';
}

// ---- reference data (cached in module scope) -----------------------------------
let _retailer = null, _taxRate = null, _taxAt = 0;
export async function getRetailer() {
  if (_retailer) return _retailer;
  let r = oneOf(await lsFetch('retailer'));
  r = (r && r.retailer) || r || {};
  // NGH-BUILD 2026-09-12a: 2.0 nests loyalty as `loyalty: {enabled, ratio}` —
  // there is no top-level `loyalty_ratio`, and the legacy /api/retailer fallback
  // below 404s on this store, so the ratio always resolved to 0 and no sale ever
  // carried loyalty_value. Read the nested shape first.
  let ratio = Number(r.loyalty && r.loyalty.ratio);
  const loyaltyEnabled = r.loyalty ? r.loyalty.enabled !== false : true;
  if (!isFinite(ratio)) ratio = Number(r.loyalty_ratio);
  if (!isFinite(ratio)) {
    // Older accounts: the legacy endpoint carries loyalty_ratio.
    try { const lg = await lsFetch('retailer', { version: null }); const rr = (lg && (lg.retailer || lg.data || lg)) || {}; ratio = Number(rr.loyalty_ratio); } catch { /* ignore */ }
  }
  if (!isFinite(ratio)) ratio = Number(process.env.LIGHTSPEED_LOYALTY_RATIO) || 0;
  // Loyalty switched off store-wide (Setup → Loyalty) earns nothing, whatever the ratio says.
  if (!loyaltyEnabled) ratio = 0;
  _retailer = { id: r.id || '', name: r.name || '', domain: r.domain_prefix || '', currency: r.default_currency || r.currency || 'USD', loyaltyRatio: ratio, loyaltyEnabled };
  return _retailer;
}
export async function getTaxRate() {
  if (_taxRate != null && Date.now() - _taxAt < 3_600_000) return _taxRate;
  const c = core.cfg();
  const taxes = listOf(await lsFetch('taxes'));
  const t = taxes.find(x => x.id === c.taxId) || taxes.find(x => x.is_default) || null;
  if (!t) {
    const pct = process.env.SALES_TAX_PERCENT;
    _taxRate = (pct != null && pct !== '') ? Number(pct) / 100 : 0.055;
  } else _taxRate = core.taxRateOf(t);
  _taxAt = Date.now();
  return _taxRate;
}
export async function listReference() {
  const [outlets, registers, users, paymentTypes, taxes, retailer] = await Promise.all([
    lsFetch('outlets'), lsFetch('registers'), lsFetch('users'), lsFetch('payment_types'), lsFetch('taxes'), getRetailer()
  ]);
  return {
    outlets: listOf(outlets).map(o => ({ id: o.id, name: o.name })),
    registers: listOf(registers).map(r => ({ id: r.id, name: r.name, outlet_id: r.outlet_id })),
    users: listOf(users).map(u => ({ id: u.id, username: u.username, display_name: u.display_name || u.name || '' })),
    payment_types: listOf(paymentTypes).map(p => ({ id: p.id, name: p.name, payment_type_id: p.payment_type_id })),
    taxes: listOf(taxes).map(t => ({ id: t.id, name: t.name, rate: core.taxRateOf(t), is_default: !!t.is_default })),
    retailer
  };
}

// ---- catalog ----------------------------------------------------------------------
export async function listProductsPage(after = 0, pageSize = 500) {
  const d = await lsFetch('products', { query: { after: after || 0, page_size: pageSize, include_images: 'true' } });
  return { data: listOf(d), version: (d && d.version) || null };
}
export async function listInventoryPage(after = 0, pageSize = 1000) {
  const d = await lsFetch('inventory', { query: { after: after || 0, page_size: pageSize } });
  return { data: listOf(d), version: (d && d.version) || null };
}
export async function listProductTypes() { return listOf(await lsFetch('product_types')).map(t => ({ id: t.id, name: t.name })); }
export async function listBrands() { return listOf(await lsFetch('brands')).map(b => ({ id: b.id, name: b.name })); }
export async function searchProducts(q) {
  return listOf(await lsFetch('search', { query: { type: 'products', name: q, page_size: 50 } })).map(p => core.normalizeProduct(p));
}
export async function customerSales(customerId) {
  return listOf(await lsFetch('search', { query: { type: 'sales', customer_id: customerId, page_size: 20, order_by: 'sale_date', order_direction: 'desc' } }));
}
// SKU → {id, name, sku}: Neon cache first (ls_products), then the API. Module-scope memo.
const _skuCache = new Map();
export async function findProductBySku(sku) {
  const s = String(sku || '').trim();
  if (!s) return null;
  if (_skuCache.has(s)) return _skuCache.get(s);
  let hit = null;
  try {
    await ensureLsSchema();
    const rows = await sql`SELECT id, data FROM ls_products WHERE data->>'sku' = ${s} AND COALESCE((data->>'deleted')::boolean, false) = false LIMIT 1`;
    if (rows.length) hit = { id: rows[0].id, name: rows[0].data.name, sku: s };
  } catch (e) { console.error('[lightspeed] sku cache lookup failed', e.message); }
  if (!hit) {
    // NGH-BUILD 2026-09-12a: X-Series `search?type=products&sku=` misses SKUs that
    // contain a hyphen (verified live: sku=10022 hits, sku=NGH-ROOM does not), so
    // fall back to the free-text `q=` search and match the SKU ourselves.
    const exact = x => String(x.sku || '').toLowerCase() === s.toLowerCase() && !x.deleted_at;
    let p = listOf(await lsFetch('search', { query: { type: 'products', sku: s } })).find(exact) || null;
    if (!p) p = listOf(await lsFetch('search', { query: { type: 'products', q: s } })).find(exact) || null;
    if (p) hit = { id: String(p.id), name: p.name, sku: s };
  }
  if (hit) _skuCache.set(s, hit);
  return hit;
}

// ---- record a sale --------------------------------------------------------------------
// opts: { sourceId, kind, customer:{email,firstName,lastName,phone}, lines:[{sku|productId, name, qty, priceIncTax, loyalty, taxable}],
//         payment:'online'|'onaccount'|null, state:'closed'|'parked', note, saleDate, force }
// Idempotent on sourceId via ls_sales_log. Never throws.
export async function recordSale(opts) {
  const sourceId = String((opts && opts.sourceId) || '');
  const kind = String((opts && opts.kind) || 'sale');
  const out = { ok: false, saleId: null, skipped: false, error: null, sourceId };
  try {
    if (!sourceId) throw new Error('sourceId required');
    await ensureLsSchema();
    const prev = await sql`SELECT sale_id FROM ls_sales_log WHERE source_id = ${sourceId}`;
    if (prev.length && prev[0].sale_id && !opts.force) { out.ok = true; out.skipped = true; out.saleId = prev[0].sale_id; return out; }

    const c = core.cfg();
    if (!c.registerId) throw new Error('LIGHTSPEED_REGISTER_ID not set');
    if (opts.payment === 'online' && !c.paymentTypeOnline) throw new Error('LIGHTSPEED_PAYMENT_TYPE_ONLINE not set');
    // NGH-BUILD 2026-09-12a: X-Series exposes no "On Account" payment type
    // (GET payment_types on the live store lists Cash, Lightspeed Payments,
    // Store Credit, Gift Card and custom types only — on-account is a sale
    // STATUS, not a payment type). So an ONACCOUNT sale posts with an empty
    // payments array and the balance lands on the customer's account.
    // LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT stays optional for stores that do have
    // a custom type; buildSalePayload only adds the payment line when it's set.

    // customer: match by email, else create with loyalty enabled
    let customer = null;
    const cu = opts.customer || {};
    if (cu.email) {
      customer = await findCustomerByEmail(cu.email);
      if (!customer) {
        customer = await createCustomer({ first_name: cu.firstName || '', last_name: cu.lastName || '', email: String(cu.email).trim().toLowerCase(),
          phone: cu.phone || '', mobile: cu.phone || '', enable_loyalty: true });
        console.log('[lightspeed] created customer', customer && customer.id, 'for', kind, sourceId);
      }
    }
    // products
    const lines = [];
    for (const l of (opts.lines || [])) {
      if (!l) continue;
      let productId = l.productId || null;
      if (!productId && l.sku) {
        const p = await findProductBySku(l.sku);
        if (!p) throw new Error('product SKU ' + l.sku + ' not found in Lightspeed');
        productId = p.id;
      }
      if (!productId) continue;
      lines.push({ ...l, productId });
    }
    if (!lines.length) throw new Error('no sale lines');

    const [taxRate, retailer] = await Promise.all([getTaxRate(), getRetailer()]);
    const { body, total } = core.buildSalePayload({
      sourceId, state: opts.state || 'closed', payment: opts.payment || null, note: opts.note, saleDate: opts.saleDate,
      customerId: customer ? customer.id : null, lines, taxRate,
      loyaltyRatio: retailer.loyaltyRatio, loyaltyEnabled: !!(customer && customer.enable_loyalty)
    }, c);
    // Legacy path (NOT versioned): https://{domain}.retail.lightspeed.app/api/register_sales
    const resp = await lsFetch('register_sales', { method: 'POST', body, version: null });
    const sale = (resp && (resp.register_sale || resp.data || resp)) || {};
    const saleId = sale.id ? String(sale.id) : null;
    if (!saleId) throw new Error('sale created but no id in response');
    await sql`INSERT INTO ls_sales_log (source_id, sale_id, kind, error, created_at) VALUES (${sourceId}, ${saleId}, ${kind}, NULL, now())
              ON CONFLICT (source_id) DO UPDATE SET sale_id = EXCLUDED.sale_id, kind = EXCLUDED.kind, error = NULL, created_at = now()`;
    console.log('[lightspeed] sale recorded', kind, sourceId, '→', saleId, body.status, total);
    out.ok = true; out.saleId = saleId; out.customerId = customer ? customer.id : null; out.total = total;
    return out;
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    console.error('[lightspeed] recordSale failed', kind, sourceId, msg);
    out.error = msg;
    try {
      await sql`INSERT INTO ls_sales_log (source_id, sale_id, kind, error, created_at) VALUES (${sourceId}, NULL, ${kind}, ${msg}, now())
                ON CONFLICT (source_id) DO UPDATE SET error = EXCLUDED.error, kind = EXCLUDED.kind, created_at = now() WHERE ls_sales_log.sale_id IS NULL`;
    } catch (e2) { console.error('[lightspeed] sales log write failed', e2 && e2.message); }
    return out;
  }
}

// ---- reverse a recorded sale (NGH-BUILD 2026-09-12c) ----------------------------------
// X-Series has no void for a CLOSED sale — the correction is a RETURN, i.e. a
// second sale with negative quantities against the same products, register,
// user and payment type. Negating the lines also negates `loyalty_value`, which
// is what takes the points back off the customer; nothing else does that.
//
// opts: { sourceId, kind, lines, payment, note, customerEmail }
//   sourceId  the ORIGINAL sale's source id (e.g. 'NGH-123:fee'). The return is
//             logged as '<sourceId>:refund' so a double-click can't double-reverse.
//   lines     same shape recordSale takes; quantities are negated here.
// Never throws — returns { ok, saleId, skipped, error }.
export async function refundSale(opts) {
  const sourceId = String((opts && opts.sourceId) || '');
  const kind = String((opts && opts.kind) || 'refund');
  const refundId = sourceId + ':refund';
  const out = { ok: false, saleId: null, skipped: false, error: null, sourceId: refundId };
  try {
    if (!sourceId) throw new Error('sourceId required');
    await ensureLsSchema();

    const prev = await sql`SELECT sale_id FROM ls_sales_log WHERE source_id = ${refundId}`;
    if (prev.length && prev[0].sale_id) { out.ok = true; out.skipped = true; out.saleId = prev[0].sale_id; return out; }
    // Refuse to reverse a sale we never recorded — otherwise we'd mint a credit
    // against nothing and hand the customer negative loyalty out of thin air.
    const orig = await sql`SELECT sale_id FROM ls_sales_log WHERE source_id = ${sourceId}`;
    if (!orig.length || !orig[0].sale_id) throw new Error('no recorded sale for ' + sourceId + ' — nothing to reverse');

    const c = core.cfg();
    if (!c.registerId) throw new Error('LIGHTSPEED_REGISTER_ID not set');

    let customer = null;
    if (opts.customerEmail) customer = await findCustomerByEmail(opts.customerEmail);

    const lines = [];
    for (const l of (opts.lines || [])) {
      if (!l) continue;
      let productId = l.productId || null;
      if (!productId && l.sku) { const p = await findProductBySku(l.sku); if (!p) throw new Error('product SKU ' + l.sku + ' not found in Lightspeed'); productId = p.id; }
      if (!productId) continue;
      const qty = Number(l.qty) || 0;
      if (qty <= 0) continue;
      lines.push({ ...l, productId, qty });            // sign is applied by buildSalePayload
    }
    if (!lines.length) throw new Error('no lines to reverse');

    const [taxRate, retailer] = await Promise.all([getTaxRate(), getRetailer()]);
    const { body, total } = core.buildSalePayload({
      sourceId: refundId, state: 'closed', payment: opts.payment || 'online',
      note: opts.note || ('Refund of ' + sourceId), saleDate: null,
      customerId: customer ? customer.id : null, lines, taxRate,
      loyaltyRatio: retailer.loyaltyRatio, loyaltyEnabled: !!(customer && customer.enable_loyalty),
      sign: -1
    }, c);

    const resp = await lsFetch('register_sales', { method: 'POST', body, version: null });
    const sale = (resp && (resp.register_sale || resp.data || resp)) || {};
    const saleId = sale.id ? String(sale.id) : null;
    if (!saleId) throw new Error('return created but no id in response');
    await sql`INSERT INTO ls_sales_log (source_id, sale_id, kind, error, created_at) VALUES (${refundId}, ${saleId}, ${kind}, NULL, now())
              ON CONFLICT (source_id) DO UPDATE SET sale_id = EXCLUDED.sale_id, kind = EXCLUDED.kind, error = NULL, created_at = now()`;
    console.log('[lightspeed] return recorded', kind, refundId, '→', saleId, total);
    out.ok = true; out.saleId = saleId; out.total = total;
    return out;
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    console.error('[lightspeed] refundSale failed', kind, refundId, msg);
    out.error = msg;
    try {
      await sql`INSERT INTO ls_sales_log (source_id, sale_id, kind, error, created_at) VALUES (${refundId}, NULL, ${kind}, ${msg}, now())
                ON CONFLICT (source_id) DO UPDATE SET error = EXCLUDED.error, kind = EXCLUDED.kind, created_at = now() WHERE ls_sales_log.sale_id IS NULL`;
    } catch (e2) { console.error('[lightspeed] sales log write failed', e2 && e2.message); }
    return out;
  }
}

// ---- loyalty group discount (unchanged contract) -------------------------------------------
// Returns { percent, groupName, source } — safe to call even if unconfigured.
export async function loyaltyDiscountForEmail(email) {
  const { map } = core.cfg();
  if (!Object.keys(map).length) return { percent: 0, groupName: '', source: 'disabled' };
  try {
    if (!(await getConnection())) return { percent: 0, groupName: '', source: 'disabled' };
    const cust = await findCustomerByEmail(email);
    if (!cust) return { percent: 0, groupName: '', source: 'not_found' };
    const gname = cust.customer_group || await customerGroupName(cust.customer_group_id);
    const pct = map[(gname || '').toLowerCase()] || 0;
    return { percent: pct, groupName: gname, source: pct ? 'group' : 'no_match' };
  } catch (e) {
    console.error('[lightspeed] discount lookup failed', e && e.message);
    return { percent: 0, groupName: '', source: 'error' };
  }
}
