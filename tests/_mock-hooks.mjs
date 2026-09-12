// NGH-BUILD 2026-09-11a
// tests/_mock-hooks.mjs — module customization hooks (node:module register()).
// Replaces the repo's _shared/db.mjs (needs @netlify/neon + a live Neon URL),
// email.mjs, ticket.mjs, stripe.mjs and boxoffice.mjs with in-memory mocks so
// the Lightspeed modules can be exercised end-to-end without the network.
// State lives on globalThis.__mock so the test file (main thread) can read it.

const MOCKS = {
  'db.mjs': `
    globalThis.__mock = globalThis.__mock || {};
    const M = globalThis.__mock; M.db = M.db || { handlers: [], calls: [] };
    export const sql = (strings, ...values) => {
      const text = strings.join('$').replace(/\\s+/g, ' ').trim();
      M.db.calls.push({ text, values });
      for (const h of M.db.handlers) { const r = h(text, values); if (r !== undefined) return Promise.resolve(r); }
      return Promise.resolve([]);
    };
    export async function ensureSchema() {}
    const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    export function json(body, status = 200) { return new Response(body == null ? '' : JSON.stringify(body), { status, headers: CORS }); }
    export function bad(msg, status = 400) { return json({ error: msg }, status); }
    /* NGH-BUILD 2026-09-12t: mirrors the real db.mjs. A null-body status must be
       given a null body or the Response constructor throws — keeping the mock
       faithful here is what lets a test catch that class of bug at all. */
    export function noContent() { return new Response(null, { status: 204, headers: CORS }); }
    export function preflight() { return new Response(null, { status: 204, headers: CORS }); }
    export function issueToken() { return 'admin-ok'; }
    export function verifyToken(t) { return t === 'admin-ok'; }
    export function requireAdmin(req) { return (req.headers.get('authorization') || '') === 'Bearer admin-ok'; }
  `,
  'email.mjs': `
    globalThis.__mock = globalThis.__mock || {};
    const M = globalThis.__mock; M.mail = M.mail || [];
    export function renderEmail(o) { return '<html>' + (o.bodyText || '') + '</html>'; }
    export async function sendBrandedMail(to, subject, opts) { M.mail.push({ to, subject, ...opts }); return { ok: true }; }
  `,
  'ticket.mjs': `
    export function ticketSig(id) { return 'sig' + String(id).length; }
    export function ticketCode(id) { return id + '.' + ticketSig(id); }
    export function parseTicketCode(c) { return String(c).split('.')[0]; }
    export function siteBase() { return 'https://gamehaven.guru'; }
    export function ticketUrl(id) { return siteBase() + '/ticket/' + ticketCode(id); }
    export function taxPercent() { return 5.5; }
    export function computeRegTotals(perPersonCents, qty) {
      const q = Math.max(1, parseInt(qty, 10) || 1); const subtotalCents = Math.round(perPersonCents) * q;
      const taxCents = Math.round(subtotalCents * 5.5 / 100); const net = subtotalCents + taxCents;
      const totalCents = net > 0 ? Math.ceil((net + 30) / (1 - 0.029)) : 0;
      return { qty: q, subtotalCents, taxCents, feeCents: totalCents - net, totalCents };
    }
    export function money(c) { return '$' + (Number(c || 0) / 100).toFixed(2); }
    export function walletConfigured() { return false; }
    export function walletSaveUrl() { return null; }
  `,
  'stripe.mjs': `
    globalThis.__mock = globalThis.__mock || {};
    const M = globalThis.__mock; M.stripe = M.stripe || { sessions: [] };
    export async function createCheckoutSession(o) { M.stripe.sessions.push(o); return { id: 'cs_test_' + M.stripe.sessions.length, url: 'https://checkout.stripe.test/cs_test_' + M.stripe.sessions.length }; }
    export async function retrieveSession(id) { return { id }; }
    export async function refundPaymentIntent() { return { id: 're_test' }; }
    export function verifyWebhook(raw, sig) { return sig === 'good'; }
  `,
  'boxoffice.mjs': `
    export async function issuePromoCoupons() { return null; }
  `
};

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const u = new URL(specifier, context.parentURL);
    const m = /\/_shared\/([a-z0-9-]+\.mjs)$/.exec(u.pathname);
    if (m && MOCKS[m[1]]) return { url: 'mock:' + m[1], shortCircuit: true };
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('mock:')) return { format: 'module', shortCircuit: true, source: MOCKS[url.slice(5)] };
  return next(url, context);
}
