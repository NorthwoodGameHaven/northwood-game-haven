// netlify/functions/boxoffice.mjs — NGH-BUILD 11a (Box Office)
// Staff ticketing on top of the existing registrations engine.
//
//   GET  /boxoffice/summary?event=<id>&date=<yyyy-mm-dd>   ADMIN  sales totals + registration list
//   GET  /boxoffice/public?event=<id>&date=                PUBLIC counts for the event page (no PII)
//   POST /boxoffice/sell                                   ADMIN  in-store / door / comp sale
//        { eventId, occDate?, mode:'instore'|'door'|'comp', name?, email?, phone?, qty,
//          paid:bool, paidVia:'cash'|'card'|'pos'|'comp', priceEach?, posRef?, admitNow:bool, override:bool }
//   POST /boxoffice/paid      { regId, paidVia, amountCents?, posRef? }   ADMIN  mark paid → ticket email + promo
//   POST /boxoffice/resend    { regId }                                   ADMIN  re-send ticket (or hold) email
//   POST /boxoffice/redeem    { code, by? }                               ADMIN  redeem a coupon (one-time)
//   GET  /boxoffice/coupons?event=<id>                                    ADMIN  coupon list
//   GET  /boxoffice/coupon/<code>          PUBLIC branded coupon page
//   GET  /boxoffice/coupon/<code>/qr.png   PUBLIC coupon QR (email-safe PNG)
//   GET  /boxoffice/coupon/<code>/status   PUBLIC {status}
import QRCode from 'qrcode';
import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { computeRegTotals, ticketUrl, money } from './_shared/ticket.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import {
  ensureBoxOfficeSchema, parseCouponCode, couponUrl, issuePromoCoupons,
  sendPaidTicketEmail, sendHoldEmail, salesSummary, regQty, sumPeople, normSource, isPaidOrFree
} from './_shared/boxoffice.mjs';

function newRegId() { return 'REG-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export default async (req) => {
  try { return await handler(req); }
  catch (e) {
    console.error('[boxoffice] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();
  await ensureBoxOfficeSchema();
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/boxoffice/, '').split('/').filter(Boolean);
  const action = parts[0] || '';

  // ================= PUBLIC: coupon page / QR / status =================
  if (req.method === 'GET' && action === 'coupon' && parts[1]) {
    const id = parseCouponCode(decodeURIComponent(parts[1]));
    const sub = parts[2] || '';
    if (!id) return sub === 'qr.png' ? bad('not found', 404) : couponPage(null, 'That coupon link is not valid.');
    const rows = await sql`SELECT id, event_id, kind, label, status, redeemed_at, data FROM coupons WHERE id = ${id}`;
    if (!rows.length) return sub === 'qr.png' ? bad('not found', 404) : couponPage(null, 'That coupon no longer exists.');
    const c = rows[0];
    if (sub === 'status') return json({ id: c.id, status: c.status, label: c.label, redeemedAt: c.redeemed_at });
    if (sub === 'qr.png') {
      const png = await QRCode.toBuffer(couponUrl(c.id), { type: 'png', width: 480, margin: 2, color: { dark: '#132a1d', light: '#ffffff' } });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }
    return couponPage(c);
  }

  // ================= PUBLIC: counts for the website event card =================
  if (req.method === 'GET' && action === 'public') {
    const eventId = url.searchParams.get('event');
    if (!eventId) return bad('event required');
    const ev = await loadEvent(eventId); if (!ev) return bad('event not found', 404);
    const s = await salesSummary(ev, url.searchParams.get('date') || null);
    return json({ sold: s.sold, capacity: s.capacity, remaining: s.remaining, soldOut: s.soldOut, min: s.min, fired: s.fired,
      salesOnline: s.salesOnline, salesInStore: s.salesInStore, doorPrice: s.doorPrice,
      promo: s.promo ? { firstN: s.promo.firstN, label: s.promo.label, left: s.promo.left } : null });
  }

  // ---- everything below is staff-only ----
  if (!requireAdmin(req)) return bad('unauthorized', 401);

  if (req.method === 'GET' && action === 'summary') {
    const eventId = url.searchParams.get('event');
    if (!eventId) return bad('event required');
    const ev = await loadEvent(eventId); if (!ev) return bad('event not found', 404);
    const occDate = url.searchParams.get('date') || null;
    const s = await salesSummary(ev, occDate);
    const rows = await sql`SELECT data FROM registrations WHERE event_id = ${eventId} ORDER BY created_at ASC`;
    let regs = rows.map(r => r.data);
    if (occDate) regs = regs.filter(d => !d.occDate || d.occDate === occDate);
    s.regs = regs.map(d => ({
      id: d.id, name: d.name, email: d.email || '', phone: d.phone || '', qty: regQty(d), attendees: d.attendees || [d.name],
      status: d.status, source: normSource(d), feePaid: !!d.feePaid, paidVia: d.paidVia || (d.paymentPI ? 'stripe' : ''),
      amountPaidCents: Number(d.amountPaidCents) || 0, cost: Number(d.cost) || 0, checkedIn: Number(d.checkedIn) || 0,
      submitted: d.submitted, paidAt: d.paidAt || null, promoCoupons: d.promoCoupons || [], posRef: d.posRef || '',
      ticketUrl: ticketUrl(d.id), ticketEmailSent: !!d.ticketEmailSent
    }));
    return json(s);
  }

  if (req.method === 'GET' && action === 'coupons') {
    const eventId = url.searchParams.get('event');
    if (!eventId) return bad('event required');
    const rows = await sql`SELECT id, reg_id, kind, label, status, created_at, redeemed_at, redeemed_by, data FROM coupons WHERE event_id = ${eventId} ORDER BY created_at ASC`;
    return json(rows.map(c => ({ id: c.id, regId: c.reg_id, kind: c.kind, label: c.label, status: c.status, createdAt: c.created_at, redeemedAt: c.redeemed_at, redeemedBy: c.redeemed_by, name: (c.data && c.data.name) || '', rank: c.data && c.data.rank, url: couponUrl(c.id) })));
  }

  // ================= SELL: in-store / door / comp =================
  if (req.method === 'POST' && action === 'sell') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    const mode = ['instore', 'door', 'comp'].includes(b.mode) ? b.mode : 'instore';
    if (!b.eventId) return bad('eventId required');
    const ev = await loadEvent(b.eventId); if (!ev) return bad('event not found', 404);
    const r = ev.registration || {};
    const qty = Math.max(1, Math.min(50, parseInt(b.qty, 10) || 1));
    const name = String(b.name || '').trim() || (mode === 'door' ? 'Door sale' : (mode === 'comp' ? 'Comp' : ''));
    if (!name) return bad('name required for in-store sales');
    const email = String(b.email || '').trim().toLowerCase();
    if (email && email.indexOf('@') < 0) return bad('that email does not look right');
    // capacity — staff may override deliberately
    if (r.max && !b.override) {
      const s = await salesSummary(ev, b.occDate || null);
      if (s.sold >= r.max) return json({ error: 'Sold out — ' + s.sold + ' of ' + r.max + ' seats. Tick "override capacity" to oversell on purpose.', code: 'soldout', sold: s.sold, capacity: r.max }, 409);
      if (s.sold + qty > r.max) return json({ error: 'Only ' + (r.max - s.sold) + ' seat' + ((r.max - s.sold) === 1 ? '' : 's') + ' left. Lower the quantity or tick "override capacity".', code: 'capacity', sold: s.sold, capacity: r.max }, 409);
    }
    const defaultPrice = mode === 'door'
      ? (r.doorPrice != null && r.doorPrice !== '' ? Number(r.doorPrice) : (Number(r.cost) || 0))
      : (Number(r.cost) || 0);
    const priceEach = mode === 'comp' ? 0 : (b.priceEach != null && b.priceEach !== '' ? Math.max(0, Number(b.priceEach) || 0) : defaultPrice);
    const paid = mode === 'comp' ? true : (!!b.paid || priceEach === 0);
    let attendees = Array.isArray(b.attendees) ? b.attendees.map(a => String(a || '').trim()).filter(Boolean) : [];
    if (!attendees.length || attendees[0] !== name) attendees.unshift(name);
    attendees = attendees.slice(0, qty);
    while (attendees.length < qty) attendees.push('Guest of ' + name);

    const reg = {
      id: newRegId(), eventId: ev.id, eventTitle: ev.title || 'NGH Event', occDate: b.occDate || null,
      name, email, phone: String(b.phone || '').trim(), comments: String(b.notes || '').trim(),
      qty, attendees, status: 'approved', cancelToken: Math.random().toString(36).slice(2, 12),
      source: mode, manual: true, soldBy: String(b.by || 'guru').slice(0, 40),
      cost: priceEach, totals: computeRegTotals(Math.round(priceEach * 100), qty),
      feePaid: paid, paidVia: paid ? (mode === 'comp' ? 'comp' : String(b.paidVia || 'cash')) : '',
      paidAt: paid ? new Date().toISOString() : null,
      amountPaidCents: paid ? (b.amountCents != null ? Math.max(0, Math.round(Number(b.amountCents))) : Math.round(priceEach * 100) * qty) : 0,
      posRef: String(b.posRef || '').trim(), checkedIn: b.admitNow ? qty : 0, admittedAt: b.admitNow ? new Date().toISOString() : null,
      submitted: new Date().toISOString(), ticketEmailSent: false
    };
    await sql`INSERT INTO registrations (id, event_id, occ_date, data)
              VALUES (${reg.id}, ${reg.eventId}, ${reg.occDate || null}, ${JSON.stringify(reg)}::jsonb)`;

    const coupons = await issuePromoCoupons(reg, ev); // also emails the coupon if we have an address
    let emailed = false;
    if (email) {
      try {
        if (paid) { await sendPaidTicketEmail(reg); reg.ticketEmailSent = true; emailed = true; }
        else { await sendHoldEmail(reg); emailed = true; }
        await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${reg.id}`;
      } catch (e) { console.error('[boxoffice] sale email failed', e); }
    }
    const after = await salesSummary(ev, b.occDate || null);
    return json({ ok: true, reg: Object.assign({}, reg, { ticketUrl: ticketUrl(reg.id), qrUrl: ticketUrl(reg.id) + '/qr.png' }),
      coupons: coupons.map(id => ({ id, url: couponUrl(id), qrUrl: couponUrl(id) + '/qr.png' })), emailed, summary: after }, 201);
  }

  // ================= mark paid (cash / card at counter / POS) =================
  if (req.method === 'POST' && action === 'paid') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    const rows = await sql`SELECT data FROM registrations WHERE id = ${String(b.regId || '')}`;
    if (!rows.length) return bad('registration not found', 404);
    const reg = rows[0].data;
    if (reg.status === 'canceled') return bad('that registration is canceled');
    const ev = await loadEvent(reg.eventId);
    const wasPaid = !!reg.feePaid;
    reg.feePaid = true;
    reg.paidVia = String(b.paidVia || 'cash').slice(0, 20);
    reg.paidAt = reg.paidAt || new Date().toISOString();
    if (b.posRef) reg.posRef = String(b.posRef).trim();
    reg.amountPaidCents = b.amountCents != null ? Math.max(0, Math.round(Number(b.amountCents))) : (reg.amountPaidCents || Math.round((Number(reg.cost) || 0) * 100) * regQty(reg));
    await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${reg.id}`;
    const coupons = ev ? await issuePromoCoupons(reg, ev) : [];
    let emailed = false;
    if (reg.email && !reg.ticketEmailSent) {
      try { await sendPaidTicketEmail(reg); reg.ticketEmailSent = true; emailed = true;
        await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${reg.id}`; }
      catch (e) { console.error('[boxoffice] paid email failed', e); }
    }
    return json({ ok: true, wasPaid, emailed, coupons: coupons.map(id => ({ id, url: couponUrl(id) })) });
  }

  // ================= resend ticket / hold email =================
  if (req.method === 'POST' && action === 'resend') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    const to = String(b.email || '').trim().toLowerCase();
    const rows = await sql`SELECT data FROM registrations WHERE id = ${String(b.regId || '')}`;
    if (!rows.length) return bad('registration not found', 404);
    const reg = rows[0].data;
    if (to) reg.email = to; // staff can attach/correct an address at resend time
    if (!reg.email) return bad('no email on this registration — add one first');
    if (isPaidOrFree(reg)) { await sendPaidTicketEmail(reg); reg.ticketEmailSent = true; }
    else await sendHoldEmail(reg);
    await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${reg.id}`;
    return json({ ok: true, sent: reg.email, kind: isPaidOrFree(reg) ? 'ticket' : 'hold' });
  }

  // ================= redeem coupon (one-time) =================
  if (req.method === 'POST' && action === 'redeem') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    const id = parseCouponCode(b.code);
    if (!id) return bad('Not a valid coupon code.', 404);
    const rows = await sql`SELECT id, event_id, kind, label, status, redeemed_at, redeemed_by, data FROM coupons WHERE id = ${id}`;
    if (!rows.length) return bad('Coupon not found.', 404);
    const c = rows[0];
    const base = { id: c.id, label: c.label, kind: c.kind, name: (c.data && c.data.name) || '', eventTitle: (c.data && c.data.eventTitle) || '', rank: c.data && c.data.rank };
    if (c.status === 'redeemed') return json(Object.assign(base, { ok: false, status: 'redeemed', redeemedAt: c.redeemed_at, redeemedBy: c.redeemed_by, error: 'ALREADY REDEEMED' }), 409);
    if (c.status === 'void') return json(Object.assign(base, { ok: false, status: 'void', error: 'VOIDED' }), 409);
    await sql`UPDATE coupons SET status = 'redeemed', redeemed_at = now(), redeemed_by = ${String(b.by || 'guru').slice(0, 40)} WHERE id = ${id}`;
    return json(Object.assign(base, { ok: true, status: 'redeemed', redeemedAt: new Date().toISOString() }));
  }

  return bad('not found', 404);
}

async function loadEvent(id) {
  const rows = await sql`SELECT data FROM events WHERE id = ${id}`;
  return rows.length ? rows[0].data : null;
}

function couponPage(c, err) {
  const ok = !!c;
  const title = ok ? c.label : 'Coupon';
  const status = ok ? c.status : 'invalid';
  const body = ok
    ? '<div class="qr"><img src="' + esc(couponUrl(c.id)) + '/qr.png" alt="coupon QR"></div>' +
      '<div class="lbl">🎁 ' + esc(c.label) + '</div>' +
      '<div class="sub">' + esc((c.data && c.data.eventTitle) || '') + (c.data && c.data.rank ? ' · buyer #' + esc(c.data.rank) : '') + '</div>' +
      (status === 'redeemed' ? '<div class="used">✅ Redeemed ' + esc(String(c.redeemed_at || '').slice(0, 16).replace('T', ' ')) + '</div>' : '<div class="live">Show this at The Raft or the counter — one-time use.</div>')
    : '<div class="used">' + esc(err || 'Invalid coupon') + '</div>';
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>NGH · ' + esc(title) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Alfa+Slab+One&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet">' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#132a1d;color:#f6efdd;font-family:Nunito,sans-serif;text-align:center}' +
    '.card{background:#1e3d2b;border:3px solid #c9973a;border-radius:18px;padding:26px 22px;max-width:360px;width:92%}' +
    '.brand{font-family:"Alfa Slab One",serif;color:#e8b84b;font-size:1.3rem;margin-bottom:8px}.qr img{width:240px;height:240px;background:#fff;padding:10px;border-radius:12px}' +
    '.lbl{font-family:"Alfa Slab One",serif;font-size:1.5rem;color:#e8b84b;margin-top:14px}.sub{opacity:.8;font-size:.9rem;margin-top:4px}' +
    '.live{margin-top:14px;background:#2e7d32;color:#fff;border-radius:10px;padding:10px;font-weight:800}.used{margin-top:14px;background:#7a2431;color:#fff;border-radius:10px;padding:10px;font-weight:800}</style></head>' +
    '<body><div class="card"><div class="brand">Northwood Game Haven</div>' + body + '</div></body></html>';
  return new Response(html, { status: ok ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
