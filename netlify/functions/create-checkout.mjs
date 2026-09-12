// netlify/functions/create-checkout.mjs
// Creates a Stripe Checkout Session for either a booking payment or an
// event registration payment. Amounts are computed SERVER-SIDE from the
// stored record — never trusted from the client.
//
// POST /create-checkout
//   { kind:"booking", id:<bookingId>, part:"fee"|"deposit" }
//   { kind:"registration", id:<registrationId> }
//   { kind:"order", id:<orderId> }                       NGH-BUILD 2026-09-11a: shop order-ahead
//   + method:"onaccount" (bookings/registrations)        NGH-BUILD 2026-09-11a: Lightspeed on-account sale
//     → the sale is written to X-Series as an on-account sale, the record is
//       marked payment:'onaccount', and the customer is told a Lightspeed
//       Payments pay link / counter payment will follow. Returns {onaccount:true}
//       (POST) or 302 to the confirmation page (GET).
//
// Registrations charge: (per-person × qty) + sales tax + processing fee.
// The processing fee is a gross-up so that after Stripe's cut
// (STRIPE_FEE_PERCENT% + STRIPE_FEE_FIXED_CENTS, default 2.9% + 30¢) the
// net deposit equals subtotal + tax exactly.
import { sql, ensureSchema, json, bad, preflight } from './_shared/db.mjs';
import { createCheckoutSession } from './_shared/stripe.mjs';
import { loyaltyDiscountForEmail, recordSale, ensureLsSchema } from './_shared/lightspeed.mjs';   // NGH-BUILD 2026-09-11a: + recordSale
import { computeRegTotals, taxPercent, ticketCode } from './_shared/ticket.mjs';
import { sendBrandedMail } from './_shared/email.mjs';                                           // NGH-BUILD 2026-09-11a
import * as lscore from './_shared/lightspeed-core.mjs';                                          // NGH-BUILD 2026-09-11a

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

// NGH-BUILD 2026-09-11a: on-account = the same sale written to X-Series
// with the "On Account" payment type. X-Series has no API to take a card or mint
// a pay link, so a Guru sends the "Email receipt with pay link" from Sell →
// Sales history (Lightspeed Payments) or the customer pays at the counter.
function onAccountEnabled() { return !!process.env.LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT; }
async function onAccountEmail(email, name, what, amountCents, ref) {
  if (!email) return;
  try {
    await sendBrandedMail(email, 'Pay on account — ' + what, {
      heading: 'We’ve put this on your account',
      bodyText: 'Hi ' + (name || 'there') + ',\n\n' + what + ' (' + ref + ') — $' + (amountCents / 100).toFixed(2) + ' — has been added to your Northwood Game Haven customer account instead of being charged now.\n\n' +
        'A Game Guru will email you a secure pay link from our register system (Lightspeed Payments), or you can simply pay at the counter on your next visit. ' +
        'Your booking / registration stays confirmed in the meantime.\n\n— Northwood Game Haven'
    });
  } catch (e) { console.error('[create-checkout] on-account email failed', e && e.message); }
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
  try { await ensureLsSchema(); } catch (e) { console.error('[create-checkout] lightspeed schema (non-fatal)', e && e.message); }   // NGH-BUILD 2026-09-11a: card checkout must never depend on Lightspeed

  // Durable pay-links: a GET mints a FRESH Checkout Session on every click and
  // 302-redirects to Stripe, so links emailed days earlier never "expire".
  // POST keeps returning JSON {url} for the in-app pay buttons.
  let p, wantRedirect = false;
  if (req.method === 'GET') {
    const u = new URL(req.url);
    p = { kind: u.searchParams.get('kind'), id: u.searchParams.get('id'), part: u.searchParams.get('part'), method: u.searchParams.get('method') };   // NGH-BUILD 2026-09-11a: + method
    wantRedirect = true;
  } else if (req.method === 'POST') {
    try { p = await req.json(); } catch { return bad('Invalid JSON'); }
  } else {
    return bad('Method not allowed', 405);
  }
  const base = siteBase(req);
  const onAccount = p.method === 'onaccount';   // NGH-BUILD 2026-09-11a
  if (onAccount && !onAccountEnabled()) return bad('pay-on-account is not enabled', 400);

  if (p.kind === 'booking') {
    const rows = await sql`SELECT data FROM bookings WHERE id = ${p.id}`;
    if (!rows.length) return bad('booking not found', 404);
    const b = rows[0].data;
    if (b.status === 'rejected' || b.status === 'canceled') return bad('this booking is no longer active', 400);

    // NGH-BUILD 2026-09-11a: amount math factored into bookingPart() so the
    // on-account path can settle fee + deposit in one click (part=both).
    async function bookingPart(part) {
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
        if (b.feePaid) return { error: 'fee already paid' };
        if (b.feeOnAccount && !onAccount) return { error: 'the booking fee is already on your account — a Guru will send a pay link' };
        // Sales tax on the (discounted) fee + add-ons. Deposit is never taxed.
        if (SALES_TAX_PERCENT > 0) taxCents = Math.round(amount * (SALES_TAX_PERCENT / 100));
      } else {
        // Prefer the stored deposit (which reflects any admin waiver/reduction);
        // fall back to the computed schedule for older records.
        const dep = (b.deposit != null) ? b.deposit : bookingDeposit(b);
        amount = Math.round(dep * 100);
        label = 'Refundable deposit — ' + (b.id || '');
        if (b.depositPaid) return { error: 'deposit already paid' };
        if (b.depositOnAccount && !onAccount) return { error: 'the deposit is already on your account — a Guru will send a pay link' };
        if (dep === 0) return { error: 'deposit has been waived — nothing to pay' };
      }
      if (!amount || amount < 50) return { error: 'nothing to pay for this item' };
      return { amount, label, taxCents };
    }

    // NGH-BUILD 2026-09-11a: pay on account via Lightspeed (fee | deposit | both)
    if (onAccount) {
      const parts = p.part === 'both' ? ['fee', 'deposit'] : [p.part === 'deposit' ? 'deposit' : 'fee'];
      const done = [];
      let lastErr = null;
      for (const part of parts) {
        if (part === 'fee' ? b.feeOnAccount : b.depositOnAccount) { lastErr = 'already on account'; continue; }
        const a = await bookingPart(part);
        if (a.error) { lastErr = a.error; continue; }
        const totalCents = a.amount + a.taxCents;
        const res = await recordSale({
          sourceId: b.id + ':' + part, kind: 'booking', customer: lscore.customerOf(b),
          lines: lscore.bookingSaleLines(b, part, totalCents), payment: 'onaccount', state: 'closed',
          note: 'NGH booking ' + b.id + ' (' + part + ', on account)' + (b.date ? ' · ' + b.date : '') + (b.name ? ' · ' + b.name : '')
        });
        if (!res.ok) return bad('could not put this on account: ' + (res.error || 'Lightspeed error') + ' — please pay by card instead', 502);
        if (part === 'fee') { b.feeOnAccount = true; b.feePaidCents = totalCents; } else { b.depositOnAccount = true; b.depositPaidCents = totalCents; }
        b.payment = 'onaccount';
        b.onaccount = { ...(b.onaccount || {}), [part]: { saleId: res.saleId, at: new Date().toISOString(), cents: totalCents } };
        await sql`UPDATE bookings SET data = ${JSON.stringify(b)}::jsonb WHERE id = ${b.id}`;
        done.push({ part, saleId: res.saleId, amountCents: totalCents });
      }
      if (!done.length) return bad(lastErr || 'nothing to put on account', 400);
      const totalCents = done.reduce((t, d) => t + d.amountCents, 0);
      await onAccountEmail(b.email, b.name, done.length > 1 ? 'Booking fee + refundable deposit' : (done[0].part === 'fee' ? 'Booking fee' : 'Refundable deposit'), totalCents, b.id);
      const tag = done.length > 1 ? 'both' : done[0].part;
      const dest = base + '/booking.html?onaccount=' + tag + '&id=' + encodeURIComponent(b.id);
      return wantRedirect ? payRedirect(dest) : json({ onaccount: true, parts: done, part: tag, saleId: done[0].saleId, amountCents: totalCents, url: dest });
    }

    const part = p.part === 'deposit' ? 'deposit' : 'fee';
    const a = await bookingPart(part);
    if (a.error) return bad(a.error, 400);
    const { amount, label, taxCents } = a;

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
    if (r.payment === 'onaccount' && !onAccount) return bad('this registration is already on your account — a Guru will send a pay link', 400);   // NGH-BUILD 2026-09-11a
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

    // NGH-BUILD 2026-09-11a: pay on account via Lightspeed (no Stripe processing fee)
    if (onAccount) {
      if (r.payment === 'onaccount') return bad('already on account', 400);
      const goods = { subtotalCents: totals.subtotalCents, taxCents: totals.taxCents, feeCents: 0, totalCents: totals.subtotalCents + totals.taxCents, qty };
      const res = await recordSale({
        sourceId: r.id, kind: 'registration', customer: lscore.customerOf(r),
        lines: lscore.registrationSaleLines({ ...r, paidBreakdown: goods }), payment: 'onaccount', state: 'closed',
        note: 'NGH event registration ' + r.id + ' (on account) — ' + (r.eventTitle || '') + (r.occDate ? ' ' + r.occDate : '') + (r.name ? ' · ' + r.name : '')
      });
      if (!res.ok) return bad('could not put this on account: ' + (res.error || 'Lightspeed error') + ' — please pay by card instead', 502);
      r.payment = 'onaccount';
      r.onaccount = { saleId: res.saleId, at: new Date().toISOString(), cents: goods.totalCents };
      r.paidBreakdown = r.paidBreakdown || goods;
      await sql`UPDATE registrations SET data = ${JSON.stringify(r)}::jsonb WHERE id = ${r.id}`;
      await onAccountEmail(r.email, r.name, 'Event registration — ' + (r.eventTitle || 'NGH Event'), goods.totalCents, r.id);
      const dest = base + '/ticket/' + ticketCode(r.id) + '?onaccount=1';
      return wantRedirect ? payRedirect(dest) : json({ onaccount: true, saleId: res.saleId, amountCents: goods.totalCents, url: dest });
    }

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

  // NGH-BUILD 2026-09-11a: shop order-ahead (prices already include tax — no tax/fee lines)
  if (p.kind === 'order') {
    if (onAccount) return bad('shop orders cannot be put on account — choose pay online or pay at pickup', 400);
    const id = String(p.id || '').toUpperCase();
    const rows = await sql`SELECT data, status FROM shop_orders WHERE id = ${id}`;
    if (!rows.length) return bad('order not found', 404);
    const o = rows[0].data;
    if (rows[0].status === 'canceled') return bad('this order was canceled', 400);
    if (o.paid) return bad('already paid', 400);
    if (o.pay !== 'online') return bad('this order is set to pay at pickup', 400);
    const items = (o.items || []).map(i => ({ name: i.name, amountCents: Math.round(Number(i.price) * 100), qty: Number(i.qty) || 1 })).filter(i => i.amountCents > 0);
    if (!items.length) return bad('nothing to pay', 400);
    const tok = lscore.orderSig(lscore.secret(), id);
    const session = await createCheckoutSession({
      items,
      successUrl: base + '/app/shop.html?paid=1&order=' + encodeURIComponent(id) + '&t=' + tok,
      cancelUrl: base + '/app/shop.html?canceled=1&order=' + encodeURIComponent(id) + '&t=' + tok,
      customerEmail: o.email,
      metadata: { kind: 'order', orderId: id }
    });
    o.checkoutSessionId = session.id;
    await sql`UPDATE shop_orders SET data = ${JSON.stringify(o)}::jsonb WHERE id = ${id}`;
    return wantRedirect ? payRedirect(session.url) : json({ url: session.url, id: session.id });
  }

  return bad('unknown payment kind', 400);
};

// NGH-BUILD 2026-09-11a
