// netlify/functions/stripe-webhook.mjs
// Receives Stripe events. On checkout.session.completed we mark the
// corresponding booking (fee or deposit) or registration as PAID.
// The signature is verified so only genuine Stripe calls are trusted.
//
// IMPORTANT: this function must read the RAW request body for signature
// verification — do not JSON.parse before verifying.
import { sql, ensureSchema, json, bad } from './_shared/db.mjs';
import { verifyWebhook } from './_shared/stripe.mjs';

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
          r.feePaid = true; r.paymentPI = paymentIntent;
          await sql`UPDATE registrations SET data = ${JSON.stringify(r)}::jsonb WHERE id = ${r.id}`;
          console.log('[stripe-webhook] registration', r.id, 'marked paid');
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
