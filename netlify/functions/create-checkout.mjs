// netlify/functions/create-checkout.mjs
// Creates a Stripe Checkout Session for either a booking payment or an
// event registration payment. Amounts are computed SERVER-SIDE from the
// stored record — never trusted from the client.
//
// POST /create-checkout
//   { kind:"booking", id:<bookingId>, part:"fee"|"deposit" }
//   { kind:"registration", id:<registrationId> }
//
// Registrations charge: (per-person × qty) + sales tax + processing fee.
// The processing fee is a gross-up so that after Stripe's cut
// (STRIPE_FEE_PERCENT% + STRIPE_FEE_FIXED_CENTS, default 2.9% + 30¢) the
// net deposit equals subtotal + tax exactly.
import { sql, ensureSchema, json, bad, preflight } from './_shared/db.mjs';
import { createCheckoutSession } from './_shared/stripe.mjs';
import { loyaltyDiscountForEmail } from './_shared/lightspeed.mjs';
import { computeRegTotals, taxPercent, ticketCode } from './_shared/ticket.mjs';

function siteBase(req) {
  // Prefer an explicit configured base; fall back to the request origin.
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, '');
  try { const u = new URL(req.url); return u.origin; } catch { return 'https://gamehaven.guru'; }
}

// Deposit schedule mirrors the front end.
const DEPOSIT = { 1: 40, 2: 80, 3: 100 };
const KARAOKE_DEPOSIT_ADD = 25;
// Sales tax applied to the booking FEE (incl. paid add-ons) only — never the
// refundable deposit. Override with SALES_TAX_PERCENT; default 5.5% (WI 5% +
// Chippewa County 0.5%). Set to 0 to disable online tax collection.
const SALES_TAX_PERCENT = (process.env.SALES_TAX_PERCENT != null && process.env.SALES_TAX_PERCENT !== '')
  ? Number(process.env.SALES_TAX_PERCENT) : 5.5;
function bookingDeposit(b) {
  const n = Math.min((b.rooms || []).length, 3);
  let dep = DEPOSIT[n] || 0;
  if ((b.addons || []).some(a => a.id === 'karaoke')) dep += KARAOKE_DEPOSIT_ADD;
  return dep;
}

// 302 to Stripe — used for durable GET pay-links.
function payRedirect(url) {
  return new Response('', { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });
}
// Friendly HTML shown if a clicked pay-link can't proceed (already paid, canceled, etc.).
function payErrorPage(msg) {
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Payment link</title><body style="font-family:Georgia,serif;background:#f4f1e9;color:#23351f;margin:0;">'
    + '<div style="max-width:520px;margin:12vh auto;padding:28px 24px;background:#fff;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.12);text-align:center;">'
    + '<div style="font-size:2rem;">🦦</div><h1 style="font-family:Georgia,serif;color:#2d5a3d;font-size:1.3rem;">We couldn\u2019t open that payment</h1>'
    + '<p style="color:#555;line-height:1.5;">' + String(msg || 'This payment link is no longer valid.').replace(/[<>&]/g, '') + '</p>'
    + '<p style="color:#555;line-height:1.5;">If you\u2019ve already paid, you\u2019re all set. Otherwise reply to your confirmation email or call us and we\u2019ll sort it out.</p>'
    + '<p><a href="https://gamehaven.guru" style="color:#2d5a3d;font-weight:bold;">Northwood Game Haven →</a></p></div></body>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default async (req) => {
  try {
    const res = await _handler(req);
    // For clicked GET pay-links, render JSON errors as a friendly HTML page instead.
    if (req.method === 'GET' && res && res.status >= 400) {
      let msg = 'This payment link is no longer valid.';
      try { const j = await res.clone().json(); if (j && j.error) msg = j.error; } catch {}
      return payErrorPage(msg);
    }
    return res;
  }
  catch (e) {
    console.error('[create-checkout] error', e);
    if (req.method === 'GET') return payErrorPage('Something went wrong creating your payment. Please try again or contact us.');
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();

  // Durable pay-links: a GET mints a FRESH Checkout Session on every click and
  // 302-redirects to Stripe, so links emailed days earlier never "expire".
  // POST keeps returning JSON {url} for the in-app pay buttons.
  let p, wantRedirect = false;
  if (req.method === 'GET') {
    const u = new URL(req.url);
    p = { kind: u.searchParams.get('kind'), id: u.searchParams.get('id'), part: u.searchParams.get('part') };
    wantRedirect = true;
  } else if (req.method === 'POST') {
    try { p = await req.json(); } catch { return bad('Invalid JSON'); }
  } else {
    return bad('Method not allowed', 405);
  }
  const base = siteBase(req);

  if (p.kind === 'booking') {
    const rows = await sql`SELECT data FROM bookings WHERE id = ${p.id}`;
    if (!rows.length) return bad('booking not found', 404);
    const b = rows[0].data;
    if (b.status === 'rejected' || b.status === 'canceled') return bad('this booking is no longer active', 400);

    const part = p.part === 'deposit' ? 'deposit' : 'fee';
    let amount, label, taxCents = 0;
    if (part === 'fee') {
      // booking fee (incl. paid add-ons) after any loyalty discount; tax added below
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
      // Sales tax on the (discounted) fee + add-ons. Deposit is never taxed.
      if (SALES_TAX_PERCENT > 0) taxCents = Math.round(amount * (SALES_TAX_PERCENT / 100));
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

    const items = [{ name: label, amountCents: amount, qty: 1 }];
    if (taxCents > 0) items.push({ name: 'Sales tax (' + SALES_TAX_PERCENT + '%)', amountCents: taxCents, qty: 1 });
    const session = await createCheckoutSession({
      items: items,
      successUrl: base + '/booking.html?paid=' + part + '&id=' + encodeURIComponent(b.id),
      cancelUrl: base + '/booking.html?canceled=1',
      customerEmail: b.email,
      metadata: { kind: 'booking', bookingId: b.id, part, taxCents: String(taxCents) }
    });
    return wantRedirect ? payRedirect(session.url) : json({ url: session.url, id: session.id });
  }

  if (p.kind === 'registration') {
    const rows = await sql`SELECT data FROM registrations WHERE id = ${p.id}`;
    if (!rows.length) return bad('registration not found', 404);
    const r = rows[0].data;
    if (r.status === 'canceled') return bad('registration is canceled', 400);
    if (r.feePaid) return bad('already paid', 400);
    const qty = Math.max(1, parseInt(r.qty, 10) || 1);
    let perPerson = (Number(r.cost) || 0);
    let regLabel = 'Event registration — ' + (r.eventTitle || r.eventId);
    const ld = await loyaltyDiscountForEmail(r.email);
    if (ld.percent > 0) {
      perPerson = Math.round(perPerson * (1 - ld.percent / 100) * 100) / 100;
      regLabel = 'Event registration (' + ld.percent + '% ' + (ld.groupName || 'loyalty') + ' discount) — ' + (r.eventTitle || r.eventId);
    }
    const totals = computeRegTotals(Math.round(perPerson * 100), qty);
    if (!totals.totalCents || totals.totalCents < 50) return bad('this registration is free', 400);

    const items = [{ name: regLabel, amountCents: totals.subtotalCents / qty, qty: qty }];
    if (totals.taxCents > 0) items.push({ name: 'Sales tax (' + taxPercent() + '%)', amountCents: totals.taxCents, qty: 1 });
    if (totals.feeCents > 0) items.push({ name: process.env.SERVICE_FEE_LABEL || 'Processing fee', amountCents: totals.feeCents, qty: 1 });

    const session = await createCheckoutSession({
      items,
      // Land the customer on their ticket page after payment. The webhook
      // marks the registration paid and emails the ticket; the page shows a
      // "confirming" state for the second or two before the webhook lands.
      successUrl: base + '/ticket/' + ticketCode(r.id) + '?paid=1',
      cancelUrl: base + '/?reg_canceled=1',
      customerEmail: r.email,
      metadata: {
        kind: 'registration', registrationId: r.id, qty: String(qty),
        subtotalCents: String(totals.subtotalCents), taxCents: String(totals.taxCents),
        feeCents: String(totals.feeCents), totalCents: String(totals.totalCents)
      }
    });
    return wantRedirect ? payRedirect(session.url) : json({ url: session.url, id: session.id });
  }

  return bad('unknown payment kind', 400);
};
