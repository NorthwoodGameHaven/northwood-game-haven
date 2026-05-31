// netlify/functions/create-checkout.mjs
// Creates a Stripe Checkout Session for either a booking payment or an
// event registration payment. Amounts are computed SERVER-SIDE from the
// stored record — never trusted from the client.
//
// POST /create-checkout
//   { kind:"booking", id:<bookingId>, part:"fee"|"deposit" }
//   { kind:"registration", id:<registrationId> }
import { sql, ensureSchema, json, bad, preflight } from './_shared/db.mjs';
import { createCheckoutSession } from './_shared/stripe.mjs';
import { loyaltyDiscountForEmail } from './_shared/lightspeed.mjs';

function siteBase(req) {
  // Prefer an explicit configured base; fall back to the request origin.
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  try { const u = new URL(req.url); return u.origin; } catch { return 'https://gamehaven.guru'; }
}

// Deposit schedule mirrors the front end.
const DEPOSIT = { 1: 40, 2: 80, 3: 100 };
const KARAOKE_DEPOSIT_ADD = 25;
function bookingDeposit(b) {
  const n = Math.min((b.rooms || []).length, 3);
  let dep = DEPOSIT[n] || 0;
  if ((b.addons || []).some(a => a.id === 'karaoke')) dep += KARAOKE_DEPOSIT_ADD;
  return dep;
}

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[create-checkout] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return bad('Method not allowed', 405);
  await ensureSchema();

  let p; try { p = await req.json(); } catch { return bad('Invalid JSON'); }
  const base = siteBase(req);

  if (p.kind === 'booking') {
    const rows = await sql`SELECT data FROM bookings WHERE id = ${p.id}`;
    if (!rows.length) return bad('booking not found', 404);
    const b = rows[0].data;
    if (b.status === 'rejected' || b.status === 'canceled') return bad('this booking is no longer active', 400);

    const part = p.part === 'deposit' ? 'deposit' : 'fee';
    let amount, label;
    if (part === 'fee') {
      // booking fee after discount (taxes handled in person/where applicable)
      let fee = (b.costBooking != null ? b.costBooking : 0);
      // Apply loyalty group discount (server-side authority) to the FEE only,
      // never the refundable deposit.
      const ld = await loyaltyDiscountForEmail(b.email);
      let label2 = 'Booking fee — ' + (b.id || '');
      if (ld.percent > 0) {
        fee = Math.round(fee * (1 - ld.percent / 100) * 100) / 100;
        label2 = 'Booking fee (' + ld.percent + '% ' + (ld.groupName || 'loyalty') + ' discount) — ' + (b.id || '');
      }
      amount = Math.round(fee * 100);
      label = label2;
      if (b.feePaid) return bad('fee already paid', 400);
    } else {
      // Prefer the stored deposit (which reflects any admin waiver/reduction);
      // fall back to the computed schedule for older records.
      const dep = (b.deposit != null) ? b.deposit : bookingDeposit(b);
      amount = Math.round(dep * 100);
      label = 'Refundable deposit — ' + (b.id || '');
      if (b.depositPaid) return bad('deposit already paid', 400);
      if (dep === 0) return bad('deposit has been waived — nothing to pay', 400);
    }
    if (!amount || amount < 50) return bad('nothing to pay for this item', 400);

    const session = await createCheckoutSession({
      items: [{ name: label, amountCents: amount, qty: 1 }],
      successUrl: base + '/booking.html?paid=' + part + '&id=' + encodeURIComponent(b.id),
      cancelUrl: base + '/booking.html?canceled=1',
      customerEmail: b.email,
      metadata: { kind: 'booking', bookingId: b.id, part }
    });
    return json({ url: session.url, id: session.id });
  }

  if (p.kind === 'registration') {
    const rows = await sql`SELECT data FROM registrations WHERE id = ${p.id}`;
    if (!rows.length) return bad('registration not found', 404);
    const r = rows[0].data;
    if (r.status === 'canceled') return bad('registration is canceled', 400);
    if (r.feePaid) return bad('already paid', 400);
    let cost = (Number(r.cost) || 0);
    let regLabel = 'Event registration — ' + (r.eventTitle || r.eventId);
    const ld = await loyaltyDiscountForEmail(r.email);
    if (ld.percent > 0) {
      cost = Math.round(cost * (1 - ld.percent / 100) * 100) / 100;
      regLabel = 'Event registration (' + ld.percent + '% ' + (ld.groupName || 'loyalty') + ' discount) — ' + (r.eventTitle || r.eventId);
    }
    const amount = Math.round(cost * 100);
    if (!amount || amount < 50) return bad('this registration is free', 400);

    const session = await createCheckoutSession({
      items: [{ name: regLabel, amountCents: amount, qty: 1 }],
      successUrl: base + '/?reg_paid=1',
      cancelUrl: base + '/?reg_canceled=1',
      customerEmail: r.email,
      metadata: { kind: 'registration', registrationId: r.id }
    });
    return json({ url: session.url, id: session.id });
  }

  return bad('unknown payment kind', 400);
};
