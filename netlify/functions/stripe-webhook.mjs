// netlify/functions/stripe-webhook.mjs
// Receives Stripe events. On checkout.session.completed we mark the
// corresponding booking (fee or deposit) or registration as PAID.
// For registrations we also record the amount breakdown and send the
// payment-confirmation + ticket email (QR entry code, Wallet link,
// manage/cancel link).
// The signature is verified so only genuine Stripe calls are trusted.
//
// IMPORTANT: this function must read the RAW request body for signature
// verification — do not JSON.parse before verifying.
import { sql, ensureSchema, json, bad } from './_shared/db.mjs';
import { verifyWebhook } from './_shared/stripe.mjs';
import { issuePromoCoupons } from './_shared/boxoffice.mjs'; // NGH-BUILD 11a
import { sendBrandedMail } from './_shared/email.mjs';
import { ticketUrl, walletConfigured, money } from './_shared/ticket.mjs';

export default async (req) => {
  try {
    if (req.method !== 'POST') return bad('Method not allowed', 405);
    await ensureSchema();

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
          if (md.part === 'deposit') { b.depositPaid = true; b.depositPI = paymentIntent; }
          else { b.feePaid = true; b.feePI = paymentIntent; }
          if (b.feePaid && b.depositPaid) b.payment = 'paid';
          await sql`UPDATE bookings SET data = ${JSON.stringify(b)}::jsonb WHERE id = ${b.id}`;
          console.log('[stripe-webhook] booking', b.id, md.part, 'marked paid');
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
    heading: 'Payment confirmed — here\u2019s your ticket! 🎟️',
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
