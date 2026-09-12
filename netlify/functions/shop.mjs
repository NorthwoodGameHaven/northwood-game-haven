// netlify/functions/shop.mjs
// NGH-BUILD 2026-09-11a — Order-ahead shop backed by the X-Series catalog
// ---------------------------------------------------------------------
// The catalog is a Neon-cached copy of the store's X-Series products +
// on-hand inventory (synced by POST /sync or the shop-sync scheduled function
// every 30 min, using X-Series version cursors). Prices are shown INCLUDING
// tax, exactly as at the register. Orders are written to X-Series through
// recordSale(): "pay at pickup" → a PARKED sale (note ORDER AHEAD ORD-xxxx)
// that staff retrieve at the register; "pay online" → Stripe Checkout, and
// the webhook records a CLOSED sale paid with the "Online — Stripe" type.
//
// API (after /api/shop):
//   GET  /catalog                 PUBLIC  {products, types, brands, syncedAt}   ETag/304
//   GET  /product/:id             PUBLIC  {product}
//   POST /sync                    admin   pull products + inventory (?full=1 resets the cursors)
//   POST /orders                  PUBLIC  {session?, name, email, phone, items:[{id,qty}], pickupAt, note, pay:'online'|'pickup'}
//                                         → {order, checkoutUrl?}
//   GET  /orders                  admin   queue  (?status=new,paid,parked,ready | ?all=1)
//   GET  /orders/:id              PUBLIC with ?t=<order token> | admin
//   POST /orders/:id/status       admin   {status:'ready'|'picked_up'|'canceled'}
// ---------------------------------------------------------------------
import { sql, requireAdmin } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { createCheckoutSession } from './_shared/stripe.mjs';
import * as core from './_shared/lightspeed-core.mjs';
import { ensureLsSchema, getConnection, listProductsPage, listInventoryPage, listProductTypes, listBrands, getTaxRate, recordSale, refundSale } from './_shared/lightspeed.mjs';
// NGH-BUILD 2026-09-12k: pickup orders had no refund path at all — cancelling
// one flipped its status and kept the customer's money, leaving the Lightspeed
// sale (and its loyalty) standing. Same gap bookings and registrations had.
import { refundPaymentIntent } from './_shared/stripe.mjs';

const { jsonX: json, badX: bad, preflightX: preflight } = core;
const PAGE = 500, MAX_PAGES = 40;
const ACTIVE_STATUSES = ['new', 'paid', 'parked', 'ready'];
function adminEmail() { return process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com'; }
function money(n) { return '$' + (Number(n) || 0).toFixed(2); }
async function readJson(req) { try { return await req.json(); } catch { return null; } }

// ---- catalog sync (also run by shop-sync.mjs on a schedule) ----------------
export async function syncCatalog({ full = false } = {}) {
  const t0 = Date.now();
  await ensureLsSchema();
  if (!(await getConnection())) return { ok: false, error: 'Lightspeed is not connected' };
  const [types, brands, taxRate] = await Promise.all([
    listProductTypes().catch(e => { console.error('[shop] product_types', e.message); return []; }),
    listBrands().catch(e => { console.error('[shop] brands', e.message); return []; }),
    getTaxRate()
  ]);
  const lookups = { types: new Map(types.map(t => [t.id, t.name])), brands: new Map(brands.map(b => [b.id, b.name])), taxRate };

  // products — cursor = highest version we hold (X-Series `after` is exclusive)
  let cursor = 0, nProducts = 0;
  if (!full) { const r = await sql`SELECT COALESCE(max(version), 0)::bigint AS v FROM ls_products`; cursor = Number(r[0].v) || 0; }
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, version } = await listProductsPage(cursor, PAGE);
    if (!data.length) break;
    const rows = data.map(p => { const n = core.normalizeProduct(p, lookups); return { id: n.id, data: n, version: n.version }; });
    await sql`INSERT INTO ls_products (id, data, version, updated_at)
              SELECT t.id, t.data, t.version, now() FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS t(id text, data jsonb, version bigint)
              ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, version = EXCLUDED.version, updated_at = now()`;
    nProducts += rows.length;
    const next = Math.max(Number(version && version.max) || 0, ...rows.map(r => r.version));
    if (data.length < PAGE || !next || next <= cursor) break;
    cursor = next;
  }
  // inventory
  let icursor = 0, nInv = 0;
  if (!full) { const r = await sql`SELECT COALESCE(max(version), 0)::bigint AS v FROM ls_inventory`; icursor = Number(r[0].v) || 0; }
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, version } = await listInventoryPage(icursor, 1000);
    if (!data.length) break;
    const rows = data.filter(i => i.product_id && i.outlet_id).map(i => ({
      product_id: String(i.product_id), outlet_id: String(i.outlet_id),
      current_amount: Number(i.current_amount != null ? i.current_amount : i.inventory_level) || 0, version: Number(i.version) || 0
    }));
    if (rows.length) await sql`INSERT INTO ls_inventory (product_id, outlet_id, current_amount, version)
              SELECT t.product_id, t.outlet_id, t.current_amount, t.version
              FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS t(product_id text, outlet_id text, current_amount numeric, version bigint)
              ON CONFLICT (product_id, outlet_id) DO UPDATE SET current_amount = EXCLUDED.current_amount, version = EXCLUDED.version`;
    nInv += rows.length;
    const next = Math.max(Number(version && version.max) || 0, ...rows.map(r => r.version));
    if (data.length < 1000 || !next || next <= icursor) break;
    icursor = next;
  }
  const out = { ok: true, products: nProducts, inventory: nInv, full, ms: Date.now() - t0 };
  console.log('[shop] sync', JSON.stringify(out));
  return out;
}

// ---- catalog queries --------------------------------------------------------
async function catalogRows(outletId, onlyId) {
  return sql`SELECT p.id, p.data, p.version, p.updated_at, COALESCE(i.current_amount, 0) AS stock
             FROM ls_products p
             LEFT JOIN ls_inventory i ON i.product_id = p.id AND i.outlet_id = ${outletId}
             WHERE COALESCE((p.data->>'deleted')::boolean, false) = false
               AND COALESCE((p.data->>'active')::boolean, true) = true
               AND (p.data->>'price') IS NOT NULL
               AND (COALESCE((p.data->>'hasInventory')::boolean, true) = false OR COALESCE(i.current_amount, 0) > 0)
               AND (${onlyId || null}::text IS NULL OR p.id = ${onlyId || null})
             ORDER BY p.data->>'name'`;
}

// ---- order helpers -----------------------------------------------------------
function publicOrder(id, data, status, createdAt) {
  const o = { ...data, id, status, createdAt: data.createdAt || createdAt };
  delete o.paymentPI; delete o.checkoutSessionId;
  return o;
}
function itemLines(o) { return (o.items || []).map(i => '  • ' + i.name + ' × ' + i.qty + ' — ' + money(i.lineTotal)).join('\n'); }
async function emailOrderConfirmation(o, { paid } = {}) {
  if (!o.email) return;
  const payLine = paid ? 'Paid online: ' + money(o.total) + ' (includes ' + money(o.taxIncluded) + ' sales tax).'
    : 'Pay at pickup: ' + money(o.total) + ' (includes ' + money(o.taxIncluded) + ' sales tax) — cash, card, or loyalty at the counter.';
  try {
    await sendBrandedMail(o.email, (paid ? '✅ Order confirmed — ' : 'Order received — ') + o.id, {
      heading: paid ? 'Thanks — your order is confirmed!' : 'We’ve got your order!',
      bodyText: 'Hi ' + (o.name || 'there') + ',\n\nOrder ' + o.id + (o.pickupAt ? ' — pickup ' + (o.pickupLabel || o.pickupAt) : '') + '\n\n' + itemLines(o) + '\n\n' + payLine +
        (o.note ? '\n\nYour note: ' + o.note : '') + '\n\nWe’ll email you when it’s ready. Just give the order number (or your name) at the counter.\n\n— Northwood Game Haven',
      buttons: [{ label: 'View order', url: core.siteBase() + '/app/shop.html?order=' + encodeURIComponent(o.id) + '&t=' + core.orderSig(core.secret(), o.id), primary: true }]
    });
  } catch (e) { console.error('[shop] confirmation email failed', e && e.message); }
}
async function emailStaffNewOrder(o, { paid } = {}) {
  try {
    await sendBrandedMail(adminEmail(), '🛍️ New pickup order ' + o.id + ' — ' + (o.name || '—') + ' — ' + money(o.total) + (paid ? ' (PAID online)' : ' (pay at pickup)'), {
      heading: 'New order-ahead ' + o.id,
      bodyText: 'Name: ' + (o.name || '—') + '\nEmail: ' + (o.email || '—') + '\nPhone: ' + (o.phone || '—') + '\nPickup: ' + (o.pickupLabel || o.pickupAt || 'ASAP') +
        '\nPayment: ' + (paid ? 'PAID online (Stripe) — closed sale in Lightspeed' : 'pay at pickup — PARKED sale in Lightspeed (retrieve at the register)') +
        '\n\n' + itemLines(o) + '\n\nTotal: ' + money(o.total) + (o.note ? '\n\nNote: ' + o.note : '') +
        (o.sale && o.sale.saleId ? '\nLightspeed sale: ' + o.sale.saleId : (o.sale && o.sale.error ? '\n⚠️ Lightspeed write failed: ' + o.sale.error + ' (replay from the Guru Lightspeed page)' : '')),
      buttons: [{ label: 'Open order queue', url: core.siteBase() + '/app/shop-orders.html', primary: true }],
      replyTo: o.email || undefined
    });
  } catch (e) { console.error('[shop] staff email failed', e && e.message); }
}
export { emailOrderConfirmation, emailStaffNewOrder };

// NGH-BUILD 2026-09-11a: customers send an ISO instant; show it in store time
// ("Fri Sep 12, 5:30 PM") in emails, the Guru queue and the Lightspeed parked-sale note.
function pickupLabel(v) {
  const raw = String(v || '').trim().slice(0, 60);
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime()) || !/\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/shop/, '').split('/').filter(Boolean);
  const head = parts[0] || '';
  const c = core.cfg();
  try {
    await ensureLsSchema();

    // ---- PUBLIC: catalog ----
    if (head === 'catalog' && req.method === 'GET') {
      const meta = await sql`SELECT COALESCE(max(version), 0)::bigint AS v, count(*)::int AS n, max(updated_at) AS synced FROM ls_products`;
      const inv = await sql`SELECT COALESCE(max(version), 0)::bigint AS v FROM ls_inventory`;
      const etag = '"cat-' + meta[0].v + '-' + inv[0].v + '-' + meta[0].n + '"';
      const hdr = { 'ETag': etag, 'Cache-Control': 'public, max-age=60' };
      if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ...hdr, 'Access-Control-Allow-Origin': '*' } });
      const rows = await catalogRows(c.outletId, null);
      const products = rows.map(r => core.catalogItem(r, r.stock));
      const types = [...new Set(products.map(p => p.type).filter(Boolean))].sort();
      const brands = [...new Set(products.map(p => p.brand).filter(Boolean))].sort();
      return json({ products, types, brands, syncedAt: meta[0].synced, count: products.length }, 200, hdr);
    }
    if (head === 'product' && parts[1] && req.method === 'GET') {
      const rows = await catalogRows(c.outletId, String(parts[1]).slice(0, 80));
      if (!rows.length) return bad('product not found', 404);
      return json({ product: core.catalogItem(rows[0], rows[0].stock) });
    }

    // ---- ADMIN: sync ----
    if (head === 'sync' && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const r = await syncCatalog({ full: url.searchParams.get('full') === '1' });
      return json(r, r.ok ? 200 : 503);
    }

    // ---- orders ----
    if (head === 'orders') {
      const id = parts[1] ? String(parts[1]).toUpperCase().slice(0, 12) : '';
      const sub = parts[2] || '';

      // POST /orders — create
      if (!id && req.method === 'POST') {
        const b = (await readJson(req)) || {};
        const sessTok = b.session || req.headers.get(core.SESSION_HEADER.toLowerCase()) || '';
        const s = sessTok ? core.verifySession(core.secret(), sessTok) : null;
        const pay = b.pay === 'online' ? 'online' : (b.pay === 'pickup' ? 'pickup' : null);
        if (!pay) return bad('pay must be "online" or "pickup"');
        const name = String(b.name || '').trim().slice(0, 80);
        const email = String(b.email || (s && s.email) || '').trim().toLowerCase();
        const phone = String(b.phone || '').trim().slice(0, 30);
        if (!name) return bad('name is required');
        if (!core.validEmail(email)) return bad('a valid email is required');
        const reqItems = Array.isArray(b.items) ? b.items.slice(0, 50) : [];
        if (!reqItems.length) return bad('your cart is empty');
        const wanted = new Map();
        for (const it of reqItems) {
          const pid = String((it && it.id) || '').slice(0, 80); const qty = Math.min(20, Math.max(0, parseInt(it && it.qty, 10) || 0));
          if (pid && qty) wanted.set(pid, (wanted.get(pid) || 0) + qty);
        }
        if (!wanted.size) return bad('your cart is empty');
        const rows = await sql`SELECT p.id, p.data, COALESCE(i.current_amount, 0) AS stock FROM ls_products p
                               LEFT JOIN ls_inventory i ON i.product_id = p.id AND i.outlet_id = ${c.outletId}
                               WHERE p.id = ANY(${[...wanted.keys()]})`;
        const items = [];
        for (const [pid, qty] of wanted) {
          const r = rows.find(x => x.id === pid);
          const d = r && r.data;
          if (!d || d.deleted || d.active === false || d.price == null) return bad('an item in your cart is no longer available: ' + pid);
          if (d.hasInventory && Number(r.stock) < qty) return bad('only ' + Math.max(0, Number(r.stock)) + ' left of ' + d.name);
          items.push({ id: pid, sku: d.sku, name: d.name, qty, price: core.round2(d.price), lineTotal: core.round2(d.price * qty) });
        }
        const taxRate = await getTaxRate().catch(() => 0.055);
        const totals = core.computeOrderTotals(items, taxRate);
        if (totals.total < 0.5 && pay === 'online') return bad('order total is too small to pay online');
        let oid = core.newOrderId();
        for (let i = 0; i < 5; i++) { const dup = await sql`SELECT 1 FROM shop_orders WHERE id = ${oid}`; if (!dup.length) break; oid = core.newOrderId(); }
        const order = {
          id: oid, name, email, phone, items, subtotal: totals.subtotal, taxIncluded: totals.taxIncluded, total: totals.total, taxRate,
          pickupAt: String(b.pickupAt || '').trim().slice(0, 60), pickupLabel: pickupLabel(b.pickupAt), note: String(b.note || '').trim().slice(0, 500), pay,
          customerId: s && s.customerId ? s.customerId : null, status: pay === 'pickup' ? 'parked' : 'new', paid: false,
          createdAt: new Date().toISOString()
        };
        await sql`INSERT INTO shop_orders (id, data, status, created_at) VALUES (${oid}, ${JSON.stringify(order)}::jsonb, ${order.status}, now())`;

        if (pay === 'pickup') {
          const res = await recordSale({
            sourceId: oid, kind: 'order', customer: core.customerOf(order), lines: core.orderSaleLines(order),
            payment: null, state: 'parked', note: 'ORDER AHEAD ' + oid + (order.pickupAt ? ' · pickup ' + (order.pickupLabel || order.pickupAt) : '') + ' · ' + name
          });
          order.sale = { saleId: res.saleId, error: res.error, at: new Date().toISOString() };
          await sql`UPDATE shop_orders SET data = ${JSON.stringify(order)}::jsonb WHERE id = ${oid}`;
          await emailOrderConfirmation(order, { paid: false });
          await emailStaffNewOrder(order, { paid: false });
          return json({ order: { ...order, token: core.orderSig(core.secret(), oid) } });
        }
        // online → Stripe Checkout (prices already include tax; no separate tax line)
        const base = core.siteBase();
        const tok = core.orderSig(core.secret(), oid);
        const session = await createCheckoutSession({
          items: items.map(i => ({ name: i.name, amountCents: Math.round(i.price * 100), qty: i.qty })),
          successUrl: base + '/app/shop.html?paid=1&order=' + encodeURIComponent(oid) + '&t=' + tok,
          cancelUrl: base + '/app/shop.html?canceled=1&order=' + encodeURIComponent(oid) + '&t=' + tok,
          customerEmail: email,
          metadata: { kind: 'order', orderId: oid }
        });
        order.checkoutSessionId = session.id;
        await sql`UPDATE shop_orders SET data = ${JSON.stringify(order)}::jsonb WHERE id = ${oid}`;
        return json({ order: { ...publicOrder(oid, order, order.status), token: tok }, checkoutUrl: session.url });
      }

      // GET /orders — admin queue
      if (!id && req.method === 'GET') {
        if (!requireAdmin(req)) return bad('unauthorized', 401);
        const all = url.searchParams.get('all') === '1';
        const statuses = all ? core.ORDER_STATUSES : String(url.searchParams.get('status') || ACTIVE_STATUSES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
        const rows = await sql`SELECT id, data, status, created_at FROM shop_orders WHERE status = ANY(${statuses}) ORDER BY created_at DESC LIMIT 200`;
        return json({ orders: rows.map(r => publicOrder(r.id, r.data, r.status, r.created_at)), serverNow: Date.now() });
      }

      if (id) {
        const rows = await sql`SELECT id, data, status, created_at FROM shop_orders WHERE id = ${id}`;
        if (!rows.length) return bad('order not found', 404);
        const row = rows[0];
        const admin = requireAdmin(req);

        // GET /orders/:id — customer (with token) or admin
        if (!sub && req.method === 'GET') {
          if (!admin && !core.verifyOrderSig(core.secret(), id, url.searchParams.get('t'))) return bad('unauthorized', 401);
          return json({ order: publicOrder(row.id, row.data, row.status, row.created_at), serverNow: Date.now() });
        }
        // POST /orders/:id/refund — admin  — NGH-BUILD 2026-09-12k
        // { cancel?:bool, reason?:string, lightspeedOnly?:bool }
        // Refunds the Stripe charge and posts a matching Lightspeed return, so
        // revenue, tax and the customer's loyalty all come back off.
        if (sub === 'refund' && req.method === 'POST') {
          if (!admin) return bad('unauthorized', 401);
          const b = (await readJson(req)) || {};
          const o = row.data;
          const lsOnly = !!b.lightspeedOnly;
          const prior = o.refund || null;

          // A pay-at-pickup order was never charged, and its Lightspeed sale is
          // PARKED — a parked sale cannot be returned, it has to be discarded at
          // the register. Say so rather than pretending we handled it.
          if (!o.paid || !o.paymentPI) {
            o.status = b.cancel === false ? o.status : 'canceled';
            o.history = [...(o.history || []), { status: o.status, at: new Date().toISOString(), note: 'canceled — nothing was charged' }];
            o.parkedSaleNeedsVoiding = !!(o.sale && o.sale.saleId);
            await sql`UPDATE shop_orders SET data = ${JSON.stringify(o)}::jsonb, status = ${o.status} WHERE id = ${id}`;
            return json({ order: publicOrder(id, o, o.status, row.created_at), refunded: false,
              note: o.parkedSaleNeedsVoiding
                ? 'Nothing was charged. The parked Lightspeed sale for this order still exists — discard it at the register (Sell → Retrieve sale).'
                : 'Nothing was charged.' });
          }

          if (prior && !lsOnly) return json({ order: publicOrder(id, o, o.status, row.created_at), refunded: false, note: 'already refunded' });
          if (lsOnly && !prior) return bad('no prior refund to retry', 400);
          if (lsOnly && !prior.lightspeedError) return json({ order: publicOrder(id, o, o.status, row.created_at), note: 'Lightspeed already reversed' });

          const cents = Number(o.amountPaidCents) || Math.round(Number(o.total) * 100);
          let stripeRefundId = lsOnly ? (prior && prior.stripeRefundId) || null : null;
          if (!lsOnly) {
            try { const r = await refundPaymentIntent(o.paymentPI, cents); stripeRefundId = (r && r.id) || null; }
            catch (e) { return bad('stripe refund failed: ' + (e && e.message ? e.message : String(e)), 502); }
          }
          const rev = await refundSale({
            sourceId: o.id, kind: 'order-refund', amountCents: cents, payment: 'online',
            note: 'Refund — ORDER AHEAD ' + o.id + (b.reason ? ' · ' + String(b.reason).slice(0, 200) : '')
          });
          o.paid = false;
          o.refund = { at: new Date().toISOString(), amountCents: cents, stripeRefundId,
            lightspeedSaleId: rev.saleId || null, lightspeedError: rev.error || null, reason: b.reason || null };
          if (b.cancel !== false) { o.status = 'canceled'; o.history = [...(o.history || []), { status: 'canceled', at: new Date().toISOString() }]; }
          await sql`UPDATE shop_orders SET data = ${JSON.stringify(o)}::jsonb, status = ${o.status} WHERE id = ${id}`;

          if (o.email) {
            try {
              await sendBrandedMail(o.email, 'Refunded: your Northwood Game Haven order ' + id, {
                heading: 'Order refunded',
                bodyText: 'Hi ' + (o.name || 'there') + ',\n\nYour order ' + id + ' has been canceled and ' + money(cents / 100)
                  + ' has been refunded to your original payment method.\n\n' + itemLines(o)
                  + '\n\nRefunds usually appear on a card within 5–10 business days, depending on your bank.'
                  + (b.reason ? ('\n\n' + String(b.reason).slice(0, 500)) : '')
                  + '\n\n— Northwood Game Haven'
              });
            } catch (e) { console.error('[shop] refund email failed', e && e.message); }
          }
          console.log('[shop] refund', id, cents, 'lightspeed:', rev.ok ? 'reversed' : ('FAILED ' + rev.error));
          return json({ order: publicOrder(id, o, o.status, row.created_at), refunded: true,
            stripeRefundId, lightspeed: rev.ok ? 'reversed' : ('FAILED: ' + rev.error) });
        }

        // POST /orders/:id/status — admin
        if (sub === 'status' && req.method === 'POST') {
          if (!admin) return bad('unauthorized', 401);
          const b = (await readJson(req)) || {};
          const status = String(b.status || '');
          if (!['ready', 'picked_up', 'canceled'].includes(status)) return bad('status must be ready | picked_up | canceled');
          const o = row.data;
          // NGH-BUILD 2026-09-12k: refuse to "cancel" a paid order through the
          // plain status route — that used to keep the customer's money silently.
          if (status === 'canceled' && o.paid && o.paymentPI && !o.refund) {
            return bad('this order is paid — use POST /orders/' + id + '/refund to cancel and refund it', 409);
          }
          o.status = status;
          o.history = [...(o.history || []), { status, at: new Date().toISOString() }];
          await sql`UPDATE shop_orders SET data = ${JSON.stringify(o)}::jsonb, status = ${status} WHERE id = ${id}`;
          if (status === 'ready' && o.email) {
            try {
              await sendBrandedMail(o.email, '🛍️ Your order ' + id + ' is ready for pickup', {
                heading: 'Ready when you are!',
                bodyText: 'Hi ' + (o.name || 'there') + ',\n\nYour order ' + id + ' is packed and waiting at the counter.\n\n' + itemLines(o) + '\n\n' +
                  (o.paid ? 'It’s already paid — just give your name or order number.' : 'Total due at pickup: ' + money(o.total) + '.') + '\n\nSee you soon!\n— Northwood Game Haven'
              });
            } catch (e) { console.error('[shop] ready email failed', e && e.message); }
          }
          return json({ order: publicOrder(id, o, status, row.created_at) });
        }
      }
    }

    return bad('not found', 404);
  } catch (e) {
    console.error('[shop] error', e);
    return bad('Server error: ' + String((e && e.message) || e), 500);
  }
};
