// netlify/functions/_shared/ticket.mjs
// Shared ticketing helpers:
//   - signed ticket codes (unguessable, derived — nothing extra stored)
//   - registration money math (per-person × qty + sales tax + processing fee
//     gross-up so the NET after Stripe's cut equals subtotal + tax)
//   - Google Wallet "Save to Wallet" JWT link (optional; env-gated)
import crypto from 'node:crypto';

function secret() {
  return process.env.ADMIN_SECRET || process.env.ADMIN_CODE || 'change-me';
}

// ---- ticket codes ----
// code = "<regId>.<sig>" where sig = HMAC-SHA256(secret, "ticket:"+regId)[0..20)
export function ticketSig(regId) {
  return crypto.createHmac('sha256', secret()).update('ticket:' + String(regId)).digest('hex').slice(0, 20);
}
export function ticketCode(regId) { return String(regId) + '.' + ticketSig(regId); }
export function parseTicketCode(code) {
  const m = /^([A-Za-z0-9\-]+)\.([a-f0-9]{20})$/.exec(String(code || '').trim());
  if (!m) return null;
  const [, regId, sig] = m;
  const good = ticketSig(regId);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  } catch { return null; }
  return regId;
}
export function siteBase() {
  return (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
}
export function ticketUrl(regId) { return siteBase() + '/ticket/' + ticketCode(regId); }

// ---- money math ----
// Sales tax (default 5.5% — WI 5% + Chippewa Co 0.5%) applies to the ticket
// subtotal. The processing fee is a gross-up so that after Stripe takes
// 2.9% + 30¢ of the TOTAL charged, NGH nets subtotal + tax exactly:
//   total = ceil((net + fixed) / (1 - pct/100));  fee = total - net
export function taxPercent() {
  const v = process.env.SALES_TAX_PERCENT;
  return (v != null && v !== '') ? Number(v) : 5.5;
}
export function feePercent() {
  const v = process.env.STRIPE_FEE_PERCENT;
  return (v != null && v !== '') ? Number(v) : 2.9;
}
export function feeFixedCents() {
  const v = process.env.STRIPE_FEE_FIXED_CENTS;
  return (v != null && v !== '') ? Number(v) : 30;
}
export function computeRegTotals(perPersonCents, qty) {
  const q = Math.max(1, parseInt(qty, 10) || 1);
  const subtotalCents = Math.round(perPersonCents) * q;
  const taxCents = Math.round(subtotalCents * taxPercent() / 100);
  const netCents = subtotalCents + taxCents;
  const totalCents = netCents > 0
    ? Math.ceil((netCents + feeFixedCents()) / (1 - feePercent() / 100))
    : 0;
  return { qty: q, subtotalCents, taxCents, feeCents: totalCents - netCents, totalCents };
}
export function money(cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); }

// ---- Google Wallet (optional) ----
// Requires three env vars (see TICKETING-README):
//   GOOGLE_WALLET_ISSUER_ID   e.g. 3388000000012345678
//   GOOGLE_WALLET_SA_EMAIL    service-account email
//   GOOGLE_WALLET_SA_KEY      service-account private key (PEM; \n-escaped ok)
// Uses the "skinny JWT" flow: class + object are defined inline in the JWT,
// so no pre-registration API calls are needed. Returns null if unconfigured.
export function walletConfigured() {
  return !!(process.env.GOOGLE_WALLET_ISSUER_ID && process.env.GOOGLE_WALLET_SA_EMAIL && process.env.GOOGLE_WALLET_SA_KEY);
}
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function saneId(s) { return String(s || '').replace(/[^A-Za-z0-9_\-]/g, '_'); }

export function walletSaveUrl({ reg, ev }) {
  if (!walletConfigured()) return null;
  const issuer = process.env.GOOGLE_WALLET_ISSUER_ID;
  const saEmail = process.env.GOOGLE_WALLET_SA_EMAIL;
  const key = String(process.env.GOOGLE_WALLET_SA_KEY).replace(/\\n/g, '\n');
  const classId = issuer + '.' + saneId('ngh_' + (reg.eventId || 'event'));
  const objectId = issuer + '.' + saneId(reg.id);
  const url = ticketUrl(reg.id);
  const qty = Math.max(1, parseInt(reg.qty, 10) || 1);
  const title = (reg.eventTitle || (ev && ev.title) || 'NGH Event');
  const when = (reg.occDate || (ev && ev.date) || '');

  const klass = {
    id: classId,
    issuerName: 'Northwood Game Haven',
    reviewStatus: 'UNDER_REVIEW',
    eventName: { defaultValue: { language: 'en-US', value: title } },
    venue: {
      name: { defaultValue: { language: 'en-US', value: 'Northwood Game Haven' } },
      address: { defaultValue: { language: 'en-US', value: '115 W Spring St, Chippewa Falls, WI 54729' } }
    },
    hexBackgroundColor: '#2d5a3d'
  };
  const obj = {
    id: objectId,
    classId: classId,
    state: 'ACTIVE',
    barcode: { type: 'QR_CODE', value: url, alternateText: reg.id },
    ticketHolderName: reg.name || '',
    ticketNumber: reg.id,
    textModulesData: [
      { header: 'Date', body: when },
      { header: 'Admits', body: qty + (qty === 1 ? ' person' : ' people') }
    ]
  };
  const claims = {
    iss: saEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { eventTicketClasses: [klass], eventTicketObjects: [obj] }
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(key);
  return 'https://pay.google.com/gp/v/save/' + signingInput + '.' + b64url(signature);
}
