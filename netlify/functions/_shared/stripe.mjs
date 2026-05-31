// netlify/functions/_shared/stripe.mjs
// Minimal Stripe REST client using fetch (no npm dependency).
// Stripe's API accepts application/x-www-form-urlencoded bodies with
// bracketed keys for nested data, e.g. line_items[0][price_data][currency].

const STRIPE_API = 'https://api.stripe.com/v1';

function secretKey() {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error('STRIPE_SECRET_KEY is not set');
  return k;
}

// Flatten a nested object/array into Stripe's bracketed form-encoding.
function encodeForm(obj, prefix, out) {
  out = out || [];
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const val = obj[key];
    const k = prefix ? `${prefix}[${key}]` : key;
    if (val === null || val === undefined) continue;
    if (typeof val === 'object') {
      encodeForm(val, k, out);
    } else {
      out.push(encodeURIComponent(k) + '=' + encodeURIComponent(val));
    }
  }
  return out;
}

async function stripeRequest(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': 'Bearer ' + secretKey(),
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };
  if (body) opts.body = encodeForm(body).join('&');
  const res = await fetch(STRIPE_API + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : ('Stripe ' + res.status);
    const err = new Error(msg);
    err.stripe = data;
    throw err;
  }
  return data;
}

// Create a Checkout Session for a one-time payment.
// items: [{ name, amountCents, qty }]
export async function createCheckoutSession({ items, successUrl, cancelUrl, customerEmail, metadata }) {
  const body = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    // Cards + Apple Pay / Google Pay are enabled automatically by Checkout
    // when "automatic_payment_methods" style is used; listing 'card' is the
    // baseline and wallets ride along on the hosted page.
    'payment_method_types[0]': 'card'
  };
  if (customerEmail) body.customer_email = customerEmail;
  (items || []).forEach((it, i) => {
    body[`line_items[${i}][quantity]`] = it.qty || 1;
    body[`line_items[${i}][price_data][currency]`] = 'usd';
    body[`line_items[${i}][price_data][unit_amount]`] = it.amountCents;
    body[`line_items[${i}][price_data][product_data][name]`] = it.name;
  });
  if (metadata) {
    for (const mk in metadata) body[`metadata[${mk}]`] = metadata[mk];
    // also stash on the payment_intent so refunds/charges carry context
    for (const mk in metadata) body[`payment_intent_data[metadata][${mk}]`] = metadata[mk];
  }
  return stripeRequest('POST', '/checkout/sessions', body);
}

export async function retrieveSession(id) {
  return stripeRequest('GET', '/checkout/sessions/' + encodeURIComponent(id), null);
}

// Refund a payment_intent (full refund by default).
export async function refundPaymentIntent(paymentIntentId) {
  return stripeRequest('POST', '/refunds', { payment_intent: paymentIntentId });
}

// Verify a Stripe webhook signature (HMAC-SHA256 over "timestamp.payload").
// Avoids needing the stripe npm package.
import crypto from 'node:crypto';
export function verifyWebhook(rawBody, sigHeader, signingSecret) {
  if (!sigHeader || !signingSecret) return false;
  const parts = {};
  sigHeader.split(',').forEach(kv => { const [k, v] = kv.split('='); parts[k] = v; });
  const t = parts['t']; const v1 = parts['v1'];
  if (!t || !v1) return false;
  const signedPayload = t + '.' + rawBody;
  const expected = crypto.createHmac('sha256', signingSecret).update(signedPayload, 'utf8').digest('hex');
  // constant-time compare
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    if (a.length !== b.length) return false;
    if (!crypto.timingSafeEqual(a, b)) return false;
  } catch (e) { return false; }
  // optional: reject very old timestamps (>5 min) to prevent replay
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (age > 300) return false;
  return true;
}
