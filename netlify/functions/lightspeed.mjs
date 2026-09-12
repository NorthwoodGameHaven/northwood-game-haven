// netlify/functions/lightspeed.mjs
// NGH-BUILD 2026-09-11a — Lightspeed X-Series connection + admin tools
// ---------------------------------------------------------------------
// One-time OAuth store connection (owner clicks "Connect Lightspeed" in the
// Guru Hub), connection health for /app/guru-lightspeed.html, and a replay
// tool for sales that failed to sync.
//
// API (after /api/lightspeed):
//   GET  /connect                 admin  → 302 to the Lightspeed consent screen
//                                         (Bearer header OR ?token= since it is a navigation)
//   GET  /callback                PUBLIC ← OAuth redirect: ?code&domain_prefix&state
//                                         verifies state (HMAC, 10 min), exchanges the code,
//                                         stores tokens, 302 → /app/guru-lightspeed.html?connected=1
//                                         (or ?error=…)
//   GET  /status                  admin  {connected, mode, domain, expires, env, reference, unsynced, catalog}
//   POST /disconnect              admin  forgets the stored tokens
//   POST /replay                  admin  {kind:'booking'|'registration'|'order', id, part?, force?}
//                                         re-runs recordSale for that record
//   GET  /unsynced                admin  ls_sales_log rows without a sale id
// ---------------------------------------------------------------------
import { sql, json, bad, preflight, requireAdmin, verifyToken } from './_shared/db.mjs';
import * as core from './_shared/lightspeed-core.mjs';
import { ensureLsSchema, getConnection, clearTokens, authorizeUrl, exchangeCode, listReference, recordSale } from './_shared/lightspeed.mjs';

const GURU_PAGE = '/app/guru-lightspeed.html';
function redirect(url) { return new Response('', { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } }); }
function guruRedirect(params) {
  const u = new URL(core.siteBase() + GURU_PAGE);
  for (const k in params) u.searchParams.set(k, params[k]);
  return redirect(u.toString());
}
function isAdmin(req, url) {
  if (requireAdmin(req)) return true;
  const t = url.searchParams.get('token');
  return !!(t && verifyToken(t));
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/lightspeed/, '').split('/').filter(Boolean);
  const head = parts[0] || '';
  try {
    await ensureLsSchema();

    // ---- PUBLIC: OAuth callback ----
    if (head === 'callback' && req.method === 'GET') {
      const code = url.searchParams.get('code') || '';
      const state = url.searchParams.get('state') || '';
      const domainPrefix = url.searchParams.get('domain_prefix') || '';
      const oauthErr = url.searchParams.get('error');
      if (oauthErr) return guruRedirect({ error: String(oauthErr).slice(0, 80) });
      if (!core.verifyState(core.secret(), state)) return guruRedirect({ error: 'invalid or expired state — try connecting again' });
      if (!code) return guruRedirect({ error: 'no code returned' });
      try {
        const tok = await exchangeCode(code, domainPrefix, core.redirectUri());
        console.log('[lightspeed] connected store', tok.domain_prefix);
        return guruRedirect({ connected: '1', domain: tok.domain_prefix || '' });
      } catch (e) {
        console.error('[lightspeed] token exchange failed', e && e.message);
        return guruRedirect({ error: String((e && e.message) || 'token exchange failed').slice(0, 160) });
      }
    }

    // ---- everything else is admin ----
    if (!isAdmin(req, url)) return bad('unauthorized', 401);

    if (head === 'connect' && req.method === 'GET') {
      const c = core.cfg();
      if (!c.clientId) return bad('LIGHTSPEED_CLIENT_ID not set', 500);
      const state = core.signState(core.secret());
      return redirect(authorizeUrl(state));
    }

    if (head === 'status' && req.method === 'GET') {
      const c = core.cfg();
      const conn = await getConnection();
      const out = {
        connected: !!conn,
        mode: conn ? conn.mode : null,
        domain: conn ? conn.domain : (c.domain || null),
        expires: conn && conn.expires ? Number(conn.expires) : null,
        expiresInSec: conn && conn.expires ? Number(conn.expires) - Math.floor(Date.now() / 1000) : null,
        redirectUri: core.redirectUri(),
        scopes: core.SCOPES,
        env: {
          clientId: !!c.clientId, clientSecret: !!process.env.LIGHTSPEED_CLIENT_SECRET, apiVersion: c.version,
          outletId: c.outletId, registerId: c.registerId, userId: c.userId,
          paymentTypeOnline: c.paymentTypeOnline, paymentTypeOnAccount: c.paymentTypeOnAccount, taxId: c.taxId, sku: c.sku
        },
        reference: null, referenceError: null, unsynced: [], catalog: null
      };
      if (conn) {
        try { out.reference = await listReference(); }
        catch (e) { out.referenceError = String((e && e.message) || e).slice(0, 300); }
      }
      try {
        out.unsynced = await sql`SELECT source_id, kind, error, created_at FROM ls_sales_log WHERE sale_id IS NULL ORDER BY created_at DESC LIMIT 50`;
        const cat = await sql`SELECT count(*)::int AS products, max(version) AS version, max(updated_at) AS synced_at FROM ls_products`;
        out.catalog = cat[0] || null;
        const orders = await sql`SELECT status, count(*)::int AS n FROM shop_orders GROUP BY status`;
        out.orders = Object.fromEntries(orders.map(r => [r.status || 'unknown', r.n]));
      } catch (e) { console.error('[lightspeed] status db', e && e.message); }
      return json(out);
    }

    if (head === 'unsynced' && req.method === 'GET') {
      const rows = await sql`SELECT source_id, kind, error, created_at FROM ls_sales_log WHERE sale_id IS NULL ORDER BY created_at DESC LIMIT 200`;
      return json({ unsynced: rows });
    }

    if (head === 'disconnect' && req.method === 'POST') {
      await clearTokens();
      console.log('[lightspeed] disconnected');
      return json({ ok: true, connected: false });
    }

    if (head === 'replay' && req.method === 'POST') {
      let p; try { p = await req.json(); } catch { return bad('bad json'); }
      const kind = String((p && p.kind) || '');
      const id = String((p && p.id) || '').trim();
      if (!id) return bad('id required');
      const force = !!(p && p.force);
      const results = [];

      if (kind === 'booking') {
        const rows = await sql`SELECT data FROM bookings WHERE id = ${id}`;
        if (!rows.length) return bad('booking not found', 404);
        const b = rows[0].data;
        const wanted = p.part ? [String(p.part)] : ['fee', 'deposit'];
        for (const part of wanted) {
          const paid = part === 'deposit' ? b.depositPaid : b.feePaid;
          const onacct = part === 'deposit' ? b.depositOnAccount : b.feeOnAccount;
          if (!paid && !onacct && !force) { results.push({ part, skipped: true, reason: 'not paid' }); continue; }
          const cents = part === 'deposit' ? b.depositPaidCents : b.feePaidCents;
          results.push({ part, ...(await recordSale({
            sourceId: b.id + ':' + part, kind: 'booking', customer: core.customerOf(b),
            lines: core.bookingSaleLines(b, part, cents != null ? cents : null),
            payment: onacct && !paid ? 'onaccount' : 'online', state: 'closed',
            note: 'NGH booking ' + b.id + ' (' + part + ')' + (b.date ? ' · ' + b.date : ''), force
          })) });
        }
      } else if (kind === 'registration') {
        const rows = await sql`SELECT data FROM registrations WHERE id = ${id}`;
        if (!rows.length) return bad('registration not found', 404);
        const r = rows[0].data;
        if (!r.feePaid && r.payment !== 'onaccount' && !force) return json({ results: [{ skipped: true, reason: 'not paid' }] });
        results.push(await recordSale({
          sourceId: r.id, kind: 'registration', customer: core.customerOf(r), lines: core.registrationSaleLines(r),
          payment: (r.payment === 'onaccount' && !r.feePaid) ? 'onaccount' : 'online', state: 'closed',
          note: 'NGH event registration ' + r.id + ' — ' + (r.eventTitle || '') + (r.occDate ? ' ' + r.occDate : ''), force
        }));
      } else if (kind === 'order') {
        const rows = await sql`SELECT data, status FROM shop_orders WHERE id = ${id}`;
        if (!rows.length) return bad('order not found', 404);
        const o = rows[0].data;
        const st = rows[0].status;
        if (st === 'canceled' && !force) return json({ results: [{ skipped: true, reason: 'canceled' }] });
        const online = o.pay === 'online';
        if (online && !o.paid && !force) return json({ results: [{ skipped: true, reason: 'not paid' }] });
        const res = await recordSale({
          sourceId: o.id, kind: 'order', customer: core.customerOf(o), lines: core.orderSaleLines(o),
          payment: online ? 'online' : null, state: online ? 'closed' : 'parked',
          note: 'ORDER AHEAD ' + o.id + (o.pickupAt ? ' · pickup ' + o.pickupAt : '') + (o.name ? ' · ' + o.name : ''), force
        });
        if (res.ok) {
          o.sale = { saleId: res.saleId, at: new Date().toISOString(), replayed: true };
          await sql`UPDATE shop_orders SET data = ${JSON.stringify(o)}::jsonb WHERE id = ${o.id}`;
        }
        results.push(res);
      } else {
        return bad('kind must be booking | registration | order');
      }
      return json({ results });
    }

    return bad('not found', 404);
  } catch (e) {
    console.error('[lightspeed] error', e);
    return bad('Server error: ' + String((e && e.message) || e), 500);
  }
};
