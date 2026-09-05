// netlify/functions/_shared/boxoffice.mjs — NGH-BUILD 11a (Box Office)
// Shared helpers for in-store / door ticket sales, sales totals, and
// "first N buyers" promo coupons. Used by boxoffice.mjs and stripe-webhook.mjs.
//
// Event settings live in event.registration (all additive, all optional):
//   max            capacity — real seat cap (customers hard-blocked; staff may override)
//   min            minimum people for the event to fire (independent of max)
//   cost           online per-person price
//   salesOnline    false = hide the website form ("tickets sold in store")
//   salesInStore   false = hide the in-store sell button in Box Office
//   doorPrice      per-person price for walk-up door sales (default = cost)
//   promo          { firstN, label, kind }  e.g. { firstN: 20, label: "Free soda", kind: "soda" }
//
// Registration rows gain: source ('online'|'instore'|'door'|'comp'), paidVia,
// posRef, promoCoupons[] (coupon ids), admitted-at-sale check-ins.
import crypto from 'node:crypto';
import { sql } from './db.mjs';
import { sendBrandedMail } from './email.mjs';
import { ticketUrl, siteBase, money } from './ticket.mjs';

let schemaReady = false;
export async function ensureBoxOfficeSchema() {
  if (schemaReady) return;
  await sql`CREATE TABLE IF NOT EXISTS coupons (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    reg_id TEXT,
    kind TEXT NOT NULL DEFAULT 'soda',
    label TEXT NOT NULL DEFAULT 'Free soda',
    status TEXT NOT NULL DEFAULT 'issued',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    redeemed_at TIMESTAMPTZ,
    redeemed_by TEXT,
    data JSONB NOT NULL DEFAULT '{}'::jsonb
  )`;
  await sql`CREATE INDEX IF NOT EXISTS coupons_event_idx ON coupons (event_id)`;
  schemaReady = true;
}

// ---- coupon codes (signed like tickets: unguessable, nothing extra stored) ----
function secret() { return process.env.ADMIN_SECRET || process.env.ADMIN_CODE || 'change-me'; }
export function couponSig(id) {
  return crypto.createHmac('sha256', secret()).update('coupon:' + String(id)).digest('hex').slice(0, 16);
}
export function couponCode(id) { return String(id) + '.' + couponSig(id); }
export function parseCouponCode(input) {
  let s = String(input || '').trim();
  const m = /\/coupon\/([A-Za-z0-9\-]+\.[a-f0-9]{16})/.exec(s);
  if (m) s = m[1];
  const mm = /^([A-Za-z0-9\-]+)\.([a-f0-9]{16})$/.exec(s);
  if (!mm) return null;
  const [, id, sig] = mm;
  const good = couponSig(id);
  try { if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null; } catch { return null; }
  return id;
}
export function couponUrl(id) { return siteBase() + '/coupon/' + couponCode(id); }
export function newCouponId() {
  return 'CPN-' + Date.now().toString(36).toUpperCase().slice(-5) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}
export function isCouponScan(input) {
  const s = String(input || '').trim();
  return /\/coupon\//.test(s) || /^CPN-/i.test(s);
}

export function regQty(d) { return Math.max(1, parseInt(d && d.qty, 10) || 1); }
export function sumPeople(list) { return list.reduce((n, d) => n + regQty(d), 0); }
export function normSource(d) {
  if (d.source === 'instore' || d.source === 'door' || d.source === 'comp') return d.source;
  if (d.source === 'admin' || d.manual) return 'instore';
  return 'online';
}
export function isPaidOrFree(d) { return !!d.feePaid || !(Number(d.cost) > 0); }

// ---- promo: first N PAID (or free-event) seats get one coupon each ----
// Deterministic and idempotent per registration: coupons are minted at the
// moment a registration becomes paid, in that order, until firstN is exhausted.
export async function issuePromoCoupons(reg, ev) {
  const promo = (ev && ev.registration && ev.registration.promo) || {};
  const firstN = Math.max(0, parseInt(promo.firstN, 10) || 0);
  if (!firstN || reg.status === 'canceled' || !isPaidOrFree(reg)) return [];
  if (Array.isArray(reg.promoCoupons) && reg.promoCoupons.length) return []; // already issued
  await ensureBoxOfficeSchema();
  const issued = await sql`SELECT COUNT(*)::int AS n FROM coupons WHERE event_id = ${reg.eventId} AND status <> 'void'`;
  const already = issued.length ? issued[0].n : 0;
  const room = Math.max(0, firstN - already);
  const n = Math.min(room, regQty(reg));
  if (n <= 0) return [];
  const label = String(promo.label || 'Free soda').slice(0, 80);
  const kind = String(promo.kind || 'soda').slice(0, 30);
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = newCouponId();
    const data = { eventTitle: reg.eventTitle || (ev && ev.title) || 'NGH Event', occDate: reg.occDate || (ev && ev.date) || null, name: reg.name || '', rank: already + i + 1, firstN };
    await sql`INSERT INTO coupons (id, event_id, reg_id, kind, label, status, data)
              VALUES (${id}, ${reg.eventId}, ${reg.id}, ${kind}, ${label}, 'issued', ${JSON.stringify(data)}::jsonb)`;
    ids.push(id);
  }
  reg.promoCoupons = ids;
  reg.promoRank = already + 1;
  await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${reg.id}`;
  if (reg.email) {
    try { await sendCouponEmail(reg, ids, label, firstN); }
    catch (e) { console.error('[boxoffice] coupon email failed', e); }
  }
  return ids;
}

export async function sendCouponEmail(reg, ids, label, firstN) {
  const many = ids.length > 1;
  const buttons = ids.map((id, i) => ({ label: (many ? ('Coupon ' + (i + 1) + ' — ') : '') + '🎁 ' + label, url: couponUrl(id), primary: i === 0 }));
  await sendBrandedMail(reg.email, '🎁 You\u2019re in the first ' + firstN + ' — ' + label + '!', {
    heading: 'A little something extra 🎁',
    bodyText:
      'Hi ' + reg.name + ',\n\n' +
      'You were one of the first ' + firstN + ' to grab tickets for ' + (reg.eventTitle || 'our event') + (reg.occDate ? (' on ' + reg.occDate) : '') + ' — so ' + (many ? 'each of your ' + ids.length + ' tickets gets' : 'you get') + ' a ' + label.toLowerCase() + ' on us.\n\n' +
      'Show the coupon QR below at The Raft or the counter. One-time use — the QR is scanned and retired on the spot.\n\n' +
      (many ? 'Each coupon has its own link and QR (buttons below). ' : '') +
      'See you at the show!\n— Northwood Game Haven',
    image: { url: couponUrl(ids[0]) + '/qr.png', alt: 'Your coupon QR code', width: 220 },
    buttons
  });
}

// ---- in-store / door ticket emails ----
export async function sendPaidTicketEmail(r) {
  const qty = regQty(r);
  const tUrl = ticketUrl(r.id);
  const names = Array.isArray(r.attendees) && r.attendees.length ? r.attendees.join(', ') : r.name;
  const paid = Number(r.amountPaidCents) > 0 ? ('Paid in store: ' + money(r.amountPaidCents) + (r.paidVia ? (' (' + r.paidVia + ')') : '') + '.') : 'Paid.';
  await sendBrandedMail(r.email, '🎟️ Your ticket for ' + (r.eventTitle || 'NGH Event'), {
    heading: 'Here\u2019s your ticket! 🎟️',
    bodyText:
      'Hi ' + r.name + ',\n\n' +
      'Thanks for grabbing ' + (qty === 1 ? 'a ticket' : qty + ' tickets') + ' for ' + (r.eventTitle || 'NGH Event') + (r.occDate ? (' on ' + r.occDate) : '') + ' at Northwood Game Haven.\n\n' +
      paid + '\nAdmits: ' + qty + (qty === 1 ? ' person' : ' people') + ' (' + names + ')\n\n' +
      'Show the QR code below at the door — one scan checks in your whole party. Open your ticket any time to print it or add it to your phone.\n\n' +
      'See you at the show!\n— Northwood Game Haven',
    image: { url: tUrl + '/qr.png', alt: 'Your entry QR code', width: 240 },
    buttons: [{ label: '🎟️ View / Print Your Ticket', url: tUrl, primary: true }]
  });
}
export async function sendHoldEmail(r) {
  const qty = regQty(r);
  const due = r.totals && r.totals.totalCents ? money(r.totals.totalCents) : (Number(r.cost) > 0 ? money(Math.round(Number(r.cost) * 100) * qty) : null);
  const link = siteBase() + '/api/create-checkout?kind=registration&id=' + encodeURIComponent(r.id);
  await sendBrandedMail(r.email, 'Your spot is held: ' + (r.eventTitle || 'NGH Event'), {
    heading: 'We\u2019re holding your spot 🎟️',
    bodyText:
      'Hi ' + r.name + ',\n\n' +
      'We\u2019ve reserved ' + (qty === 1 ? 'a ticket' : qty + ' tickets') + ' for ' + (r.eventTitle || 'NGH Event') + (r.occDate ? (' on ' + r.occDate) : '') + '.\n\n' +
      (due ? ('Balance due: ' + due + '. Pay at the counter any time, or online with the button below. Your ticket with entry QR arrives the moment payment is complete.') : 'No payment is due — your ticket is on its way.') +
      '\n\n— Northwood Game Haven',
    buttons: due ? [{ label: 'Pay ' + due + ' Online', url: link, primary: true }] : []
  });
}

// ---- sales summary for one event occurrence ----
export async function salesSummary(ev, occDate) {
  const r = (ev && ev.registration) || {};
  const rows = await sql`SELECT data FROM registrations WHERE event_id = ${ev.id} ORDER BY created_at ASC`;
  let all = rows.map(x => x.data).filter(d => d.status !== 'canceled');
  if (occDate) all = all.filter(d => !d.occDate || d.occDate === occDate);
  const approved = all.filter(d => d.status !== 'unapproved');
  const by = { online: 0, instore: 0, door: 0, comp: 0 };
  let paidSeats = 0, unpaidSeats = 0, checkedIn = 0, revenueCents = 0;
  for (const d of approved) {
    const q = regQty(d);
    by[normSource(d)] += q;
    if (isPaidOrFree(d)) paidSeats += q; else unpaidSeats += q;
    checkedIn += Math.min(q, Number(d.checkedIn) || 0);
    if (d.feePaid) revenueCents += Number(d.amountPaidCents) || 0;
  }
  const sold = sumPeople(approved);
  const max = Math.max(0, parseInt(r.max, 10) || 0);
  const min = Math.max(0, parseInt(r.min, 10) || 0);
  let promo = null;
  const firstN = Math.max(0, parseInt(r.promo && r.promo.firstN, 10) || 0);
  if (firstN) {
    await ensureBoxOfficeSchema();
    const c = await sql`SELECT status, COUNT(*)::int AS n FROM coupons WHERE event_id = ${ev.id} GROUP BY status`;
    const cnt = {}; for (const row of c) cnt[row.status] = row.n;
    const issued = (cnt.issued || 0) + (cnt.redeemed || 0);
    promo = { firstN, label: (r.promo && r.promo.label) || 'Free soda', kind: (r.promo && r.promo.kind) || 'soda', issued, redeemed: cnt.redeemed || 0, left: Math.max(0, firstN - issued) };
  }
  return {
    eventId: ev.id, title: ev.title, date: occDate || ev.date,
    capacity: max, min, sold, remaining: max ? Math.max(0, max - sold) : null,
    soldOut: !!(max && sold >= max), fired: min ? sold >= min : true,
    bySource: by, paidSeats, unpaidSeats, checkedIn, revenueCents,
    cost: Number(r.cost) || 0, doorPrice: r.doorPrice != null && r.doorPrice !== '' ? Number(r.doorPrice) : (Number(r.cost) || 0),
    salesOnline: r.salesOnline !== false, salesInStore: r.salesInStore !== false,
    registrationEnabled: !!r.enabled, promo
  };
}
