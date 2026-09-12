// netlify/functions/stripe-webhook.mjs
// Receives Stripe events. On checkout.session.completed we mark the
// corresponding booking (fee or deposit) or registration as PAID.
// For registrations we also record the amount breakdown and send the
// payment-confirmation + ticket email (QR entry code, Wallet link,
// manage/cancel link).
// The signature is verified so only genuine Stripe calls are trusted.
//
// NGH-BUILD 2026-09-11a: also handles shop orders (kind:'order') and,
// after any booking part / registration / order is marked paid, records a
// CLOSED sale in Lightspeed X-Series via recordSale() (fire-and-forget with
// logging — a failed Lightspeed write never blocks marking the payment paid;
// replay from the Guru Lightspeed page).
//
// IMPORTANT: this function must read the RAW request body for signature
// verification — do not JSON.parse before verifying.
import { sql, ensureSchema, json, bad } from './_shared/db.mjs';
import { verifyWebhook } from './_shared/stripe.mjs';
import { issuePromoCoupons } from './_shared/boxoffice.mjs'; // NGH-BUILD 11a
import { sendBrandedMail } from './_shared/email.mjs';
import { ticketUrl, walletConfigured, money } from './_shared/ticket.mjs';
import { recordSale, ensureLsSchema } from './_shared/lightspeed.mjs';               // NGH-BUILD 2026-09-11a
import * as lscore from './_shared/lightspeed-core.mjs';                              // NGH-BUILD 2026-09-11a
import { emailOrderConfirmation, emailStaffNewOrder } from './shop.mjs';              // NGH-BUILD 2026-09-11a

// NGH-BUILD 2026-09-11a: background work. Netlify Functions 2.0 expose
// context.waitUntil() so the response isn't held up; when it's unavailable we
// simply await (recordSale never throws, so the webhook still returns 200).
async function fireAndForget(context, label, fn) {
  const p = Promise.resolve().then(fn).catch(e => console.error('[stripe-webhook] ' + label + ' failed', e && e.message));
  if (context && typeof context.waitUntil === 'function') { context.waitUntil(p); return; }
  await p;
}

export default async (req, context) => {   // NGH-BUILD 2026-09-11a: context for waitUntil
  try {
    if (req.method !== 'POST') return bad('Method not allowed', 405);
    await ensureSchema();
    try { await ensureLsSchema(); } catch (e) { console.error('[stripe-webhook] lightspeed schema (non-fatal)', e && e.message); }   // NGH-BUILD 2026-09-11a: never let Lightspeed block payment recording

    const raw = await req.text();
    const sig = req.headers.get('stripe-signature');
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    // If a signing secret is configured, enforce it. (During very early
    // testing you may not have set it yet; we refuse rather than trust blindly.)
    if (!secret) { console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set'); return bad('webhook not configured', 500); }
    if (!verifyWebhook(raw, sig, secret)) { console.warn('[stripe-webhook] bad signature'); return bad('invalid signature', 400); }

    let evt; try { evt = JSON.parse(raw); } catch { return bad('invalid json', 400); }

    if (evt.type === 'checkout.session.completed') {
      const s = evt.data.object;
      const md = s.metadata || {};
      const paymentIntent = s.payment_intent || null;

      if (md.kind === 'booking' && md.bookingId) {
        const rows = await sql`SELECT data FROM bookings WHERE id = ${md.bookingId}`;
        if (rows.length) {
          const b = rows[0].data;
          const part = md.part === 'deposit' ? 'deposit' : 'fee';                                   // NGH-BUILD 2026-09-11a
          const alreadyPaid = part === 'deposit' ? !!b.depositPaid : !!b.feePaid;                  // NGH-BUILD 2026-09-11a: idempotency vs Stripe retries
          if (md.part === 'deposit') { b.depositPaid = true; b.depositPI = paymentIntent; }
          else { b.feePaid = true; b.feePI = paymentIntent; }
          if (b.feePaid && b.depositPaid) b.payment = 'paid';
          // NGH-BUILD 2026-09-11a: remember what Stripe charged so replays record the same amount
          if (s.amount_total != null) { if (part === 'deposit') b.depositPaidCents = Number(s.amount_total); else b.feePaidCents = Number(s.amount_total); }
          await sql`UPDATE bookings SET data = ${JSON.stringify(b)}::jsonb WHERE id = ${b.id}`;
          console.log('[stripe-webhook] booking', b.id, md.part, 'marked paid');

          // NGH-BUILD 2026-09-11a: closed sale in Lightspeed (NGH-ROOM / NGH-DEPOSIT [+ NGH-KARAOKE])
          if (!alreadyPaid) {
            await fireAndForget(context, 'recordSale booking', () => recordSale({
              sourceId: b.id + ':' + part, kind: 'booking', customer: lscore.customerOf(b),
              lines: lscore.bookingSaleLines(b, part, s.amount_total != null ? Number(s.amount_total) : null),
              payment: 'online', state: 'closed',
              note: 'NGH booking ' + b.id + ' (' + part + ')' + (b.date ? ' · ' + b.date : '') + (b.name ? ' · ' + b.name : '')
            }));
          }
        }
      } else if (md.kind === 'registration' && md.registrationId) {
        const rows = await sql`SELECT data FROM registrations WHERE id = ${md.registrationId}`;
        if (rows.length) {
          const r = rows[0].data;
          const alreadySent = !!r.ticketEmailSent; // idempotency vs Stripe retries
          r.feePaid = true; r.paymentPI = paymentIntent; r.checkoutSessionId = s.id || r.checkoutSessionId;
          r.paidAt = r.paidAt || new Date().toISOString();
          // Authoritative amounts from the session + our checkout metadata.
          if (s.amount_total != null) r.amountPaidCents = Number(s.amount_total);
          r.paidBreakdown = {
            subtotalCents: Number(md.subtotalCents) || 0,
            taxCents: Number(md.taxCents) || 0,
            feeCents: Number(md.feeCents) || 0,
            totalCents: Number(md.totalCents) || Number(s.amount_total) || 0,
            qty: Number(md.qty) || Math.max(1, parseInt(r.qty, 10) || 1)
          };
          r.ticketEmailSent = true;
          await sql`UPDATE registrations SET data = ${JSON.stringify(r)}::jsonb WHERE id = ${r.id}`;
          console.log('[stripe-webhook] registration', r.id, 'marked paid,', s.amount_total, 'cents');

          if (!alreadySent && r.email) {
            try { await sendTicketEmail(r); }
            catch (e) { console.error('[stripe-webhook] ticket email failed', e); }
          }
          // NGH-BUILD 11a: first-N buyer promo coupons (event carries the promo settings)
          try {
            const evRows = await sql`SELECT data FROM events WHERE id = ${r.eventId}`;
            if (evRows.length) await issuePromoCoupons(r, evRows[0].data);
          } catch (e) { console.error('[stripe-webhook] promo coupon failed', e); }

          // NGH-BUILD 2026-09-11a: closed sale in Lightspeed (NGH-EVENT "<title> × qty")
          if (!alreadySent) {
            await fireAndForget(context, 'recordSale registration', () => recordSale({
              sourceId: r.id, kind: 'registration', customer: lscore.customerOf(r), lines: lscore.registrationSaleLines(r),
              payment: 'online', state: 'closed',
              note: 'NGH event registration ' + r.id + ' — ' + (r.eventTitle || '') + (r.occDate ? ' ' + r.occDate : '') + (r.name ? ' · ' + r.name : '')
            }));
          }
        }
      } else if (md.kind === 'order' && md.orderId) {
        // NGH-BUILD 2026-09-11a: order-ahead paid online → closed sale + emails
        const rows = await sql`SELECT data, status FROM shop_orders WHERE id = ${md.orderId}`;
        if (rows.length) {
          const o = rows[0].data;
          const alreadyPaid = !!o.paid;
          o.paid = true; o.paidAt = o.paidAt || new Date().toISOString(); o.paymentPI = paymentIntent; o.checkoutSessionId = s.id || o.checkoutSessionId;
          if (s.amount_total != null) o.amountPaidCents = Number(s.amount_total);
          if (rows[0].status === 'new' || !rows[0].status) o.status = 'paid';
          else o.status = rows[0].status;
          await sql`UPDATE shop_orders SET data = ${JSON.stringify(o)}::jsonb, status = ${o.status} WHERE id = ${o.id}`;
          console.log('[stripe-webhook] order', o.id, 'marked paid,', s.amount_total, 'cents');
          if (!alreadyPaid) {
            await fireAndForget(context, 'order post-payment', async () => {
              const res = await recordSale({
                sourceId: o.id, kind: 'order', customer: lscore.customerOf(o), lines: lscore.orderSaleLines(o),
                payment: 'online', state: 'closed',
                note: 'ORDER AHEAD ' + o.id + ' (paid online)' + (o.pickupAt ? ' · pickup ' + (o.pickupLabel || o.pickupAt) : '') + (o.name ? ' · ' + o.name : '')
              });
              o.sale = { saleId: res.saleId, error: res.error, at: new Date().toISOString() };
              await sql`UPDATE shop_orders SET data = ${JSON.stringify(o)}::jsonb WHERE id = ${o.id}`;
              await emailOrderConfirmation(o, { paid: true });
              await emailStaffNewOrder(o, { paid: true });
            });
          }
        }
      }
    }

    // Always 200 so Stripe doesn't retry endlessly for events we ignore.
    return json({ received: true });
  } catch (e) {
    console.error('[stripe-webhook] error', e);
    // Return 200 to avoid infinite retries on our own bugs; we log for review.
    return json({ received: true, error: String(e && e.message || e) });
  }
};

// Payment confirmation + ticket. QR is served as a hosted PNG (Gmail blocks
// data: URIs). The ticket page carries print/Wallet/manage-or-cancel actions.
async function sendTicketEmail(r) {
  const qty = Math.max(1, parseInt(r.qty, 10) || 1);
  const bd = r.paidBreakdown || {};
  const tUrl = ticketUrl(r.id);
  const names = Array.isArray(r.attendees) && r.attendees.length ? r.attendees.join(', ') : r.name;
  const breakdown = bd.totalCents
    ? ('Paid: ' + money(bd.totalCents) + ' — ' + qty + ' ticket' + (qty === 1 ? '' : 's') + ' ' + money(bd.subtotalCents) + ' + ' + money(bd.taxCents) + ' sales tax + ' + money(bd.feeCents) + ' processing fee.')
    : ('Paid: ' + money(r.amountPaidCents || 0) + '.');
  const buttons = [
    { label: '🎟️ View / Print Your Ticket', url: tUrl, primary: true }
  ];
  if (walletConfigured()) buttons.push({ label: 'Add to Google Wallet', url: tUrl + '/wallet' });
  buttons.push({ label: 'Modify or Cancel', url: tUrl + '#manage' });

  await sendBrandedMail(r.email, '✅ Payment received — your ticket for ' + (r.eventTitle || 'NGH Event'), {
    heading: 'Payment confirmed — here’s your ticket! 🎟️',
    bodyText:
      'Hi ' + r.name + ',\n\n' +
      'Your payment for ' + (r.eventTitle || 'NGH Event') + (r.occDate ? (' on ' + r.occDate) : '') + ' is complete.\n\n' +
      breakdown + '\n' +
      'Admits: ' + qty + (qty === 1 ? ' person' : ' people') + ' (' + names + ')\n\n' +
      'Show the QR code below at the door — one scan checks in your whole party. You can also open your ticket any time to print it, add it to Google Wallet, or change your ticket count / cancel (refunds are automatic).\n\n' +
      'See you at the table!\n— Northwood Game Haven',
    image: { url: tUrl + '/qr.png', alt: 'Your entry QR code', width: 240 },
    buttons
  });
}

// NGH-BUILD 11a
// NGH-BUILD 2026-09-11a
