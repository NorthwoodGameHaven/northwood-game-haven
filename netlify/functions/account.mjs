// netlify/functions/account.mjs
// NGH-BUILD 2026-09-11a — Rewards account (Lightspeed X-Series customer) for the app
// ---------------------------------------------------------------------
// Passwordless sign-in: a 6-digit code is emailed (Resend) to the address on
// the customer's X-Series record. Codes are sha256-hashed in `login_codes`,
// expire after 10 minutes, allow 5 attempts, and at most 3 sends per 10 min
// per email. A verified email yields a stateless session token
//   <customerId>.<expMs>.<hmac(ADMIN_SECRET, customerId|expMs)>   (30 days)
// sent back in header X-NGH-Session. When the email has no X-Series customer
// yet, the session is bound to the pseudo id "email:<addr>" with customer:null
// so the app can show sign-up; /signup then creates the customer (loyalty on)
// and re-issues a real session.
//
// API (after /api/account):
//   POST /start    PUBLIC  {email}                  → {ok} (emails a code; never reveals whether the email exists)
//   POST /verify   PUBLIC  {email, code}            → {session, customer|null}
//   POST /signup   session {first_name,last_name,phone,marketing}  → {session, customer}
//   GET  /me       session → {customer, loyalty:{ratio,currency}, purchases, bookings, registrations, orders}
//   PUT  /me       session {first_name,last_name,phone,email,do_not_email} → {customer}
//   POST /logout   session → {ok}  (tokens are stateless; the app just forgets it)
//   POST /delete-request  PUBLIC  {email, name?, note?} → {ok}
//        Queues an account-deletion request and emails the shop + the requester.
//        Deletes nothing itself — a Guru actions it. Public on purpose: Google
//        Play requires a deletion URL that works without the app.
// ---------------------------------------------------------------------
import crypto from 'node:crypto';
import { sql, ensureSchema } from './_shared/db.mjs';
import { reviewOn, reviewCode, reviewId, isReviewEmail, isReviewSession, reviewCustomer, reviewBundle } from './_shared/review-account.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { ticketUrl } from './_shared/ticket.mjs';
import * as core from './_shared/lightspeed-core.mjs';
import { ensureLsSchema, getConnection, findCustomerByEmail, getCustomer, createCustomer, updateCustomer,
         customerGroupName, getRetailer, customerSales, LsError } from './_shared/lightspeed.mjs';

const { jsonX: json, badX: bad, preflightX: preflight } = core;
const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const SEND_LIMIT = 3, SEND_WINDOW_MS = 10 * 60_000;

function sessionOf(req, url, body) {
  const t = req.headers.get(core.SESSION_HEADER.toLowerCase()) || (body && body.session) || url.searchParams.get('session') || '';
  return t ? core.verifySession(core.secret(), t) : null;
}
function cleanPhone(s) { return String(s || '').replace(/[^\d+()\-\s.]/g, '').trim().slice(0, 30); }
function cleanName(s) { return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80); }
async function readJson(req) { try { return await req.json(); } catch { return null; } }

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/account/, '').split('/').filter(Boolean);
  const head = parts[0] || '';
  try {
    await ensureSchema();
    await ensureLsSchema();

    // ---- POST /start ----
    if (head === 'start' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String((body && body.email) || '').trim().toLowerCase();
      if (!core.validEmail(email)) return bad('please enter a valid email address');
      // The review address has a fixed code, so there is nothing to generate
      // and nothing to send. Answer exactly as we would for anybody else — the
      // reviewer taps "Send code" and moves to the code screen as normal.
      if (isReviewEmail(email)) return json({ ok: true, expiresInSec: CODE_TTL_MS / 1000 });
      const rows = await sql`SELECT sent_count, window_start FROM login_codes WHERE email = ${email}`;
      const now = Date.now();
      let sent = 0, windowStart = now;
      if (rows.length && rows[0].window_start) {
        const ws = new Date(rows[0].window_start).getTime();
        if (now - ws < SEND_WINDOW_MS) { sent = Number(rows[0].sent_count) || 0; windowStart = ws; }
      }
      if (sent >= SEND_LIMIT) return bad('too many codes requested — please wait a few minutes and try again', 429);
      const code = core.genCode();
      const hash = core.hashCode(email, code);
      const expires = new Date(now + CODE_TTL_MS).toISOString();
      await sql`INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_count, window_start)
                VALUES (${email}, ${hash}, ${expires}, 0, ${sent + 1}, ${new Date(windowStart).toISOString()})
                ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0,
                  sent_count = EXCLUDED.sent_count, window_start = EXCLUDED.window_start`;
      const mail = await sendBrandedMail(email, 'Your Northwood Game Haven sign-in code: ' + code, {
        heading: 'Your sign-in code',
        bodyText: 'Hi,\n\nHere is your one-time code for the Northwood Game Haven app:\n\n' + code + '\n\n' +
          'It expires in 10 minutes. If you didn’t request it you can safely ignore this email.\n\n— Northwood Game Haven'
      });
      if (mail && mail.ok === false) { console.error('[account] code email failed', email); return bad('we could not send the email — please try again', 502); }
      return json({ ok: true, expiresInSec: CODE_TTL_MS / 1000 });
    }

    // ---- POST /verify ----
    if (head === 'verify' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String((body && body.email) || '').trim().toLowerCase();
      const code = String((body && body.code) || '').replace(/\D/g, '');
      if (!core.validEmail(email) || code.length !== 6) return bad('enter the 6-digit code from your email');
      if (isReviewEmail(email)) {
        // Attempts are still counted, in the same table and against the same
        // ceiling as a real sign-in, so this is not an unrated 6-digit oracle.
        const att = await sql`SELECT attempts FROM login_codes WHERE email = ${email}`;
        if (att.length && Number(att[0].attempts) >= MAX_ATTEMPTS) return bad('too many incorrect attempts — request a new code', 429);
        if (!core.safeEq(reviewCode(), code)) {
          await sql`INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_count, window_start)
                    VALUES (${email}, NULL, NULL, 1, 0, now())
                    ON CONFLICT (email) DO UPDATE SET attempts = login_codes.attempts + 1`;
          return bad('incorrect code', 400);
        }
        await sql`UPDATE login_codes SET attempts = 0 WHERE email = ${email}`;
        return json({ session: core.issueSession(core.secret(), reviewId()), customer: reviewCustomer(), email });
      }
      const rows = await sql`SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ${email}`;
      if (!rows.length || !rows[0].code_hash) return bad('no code has been sent to that email — request a new one');
      const row = rows[0];
      if (Date.now() > new Date(row.expires_at).getTime()) return bad('that code has expired — request a new one', 400);
      if (Number(row.attempts) >= MAX_ATTEMPTS) return bad('too many incorrect attempts — request a new code', 429);
      if (!core.safeEq(row.code_hash, core.hashCode(email, code))) {
        await sql`UPDATE login_codes SET attempts = attempts + 1 WHERE email = ${email}`;
        return bad('incorrect code', 400);
      }
      await sql`UPDATE login_codes SET code_hash = NULL, expires_at = NULL, attempts = 0 WHERE email = ${email}`;
      let customer = null;
      try { if (await getConnection()) customer = await findCustomerByEmail(email); }
      catch (e) { console.error('[account] customer lookup failed', e && e.message); return bad('our rewards system is temporarily unavailable — please try again shortly', 502); }
      if (customer) customer.customer_group = customer.customer_group || await customerGroupName(customer.customer_group_id);
      const id = customer ? customer.id : core.pseudoId(email);
      return json({ session: core.issueSession(core.secret(), id), customer, email });
    }

    // ---- POST /delete-request  PUBLIC ----
    // NGH-BUILD 2026-09-12y. Google Play requires an in-app path AND a public
    // web URL for account-deletion requests, so this route deliberately does
    // NOT require a session: site/account-delete.html has to work for somebody
    // who has uninstalled the app or cannot get in. The app sends its session
    // when it has one, purely so the record says who was signed in.
    //
    // Nothing is deleted here. A Guru actions it by hand — the customer's sales
    // history lives in Lightspeed and some of it has to be kept for tax, so an
    // automated purge is the wrong shape. This writes the queue row and sends
    // the two emails.
    if (head === 'delete-request' && req.method === 'POST') {
      const b = (await readJson(req)) || {};
      const email = String(b.email || '').trim().toLowerCase();
      if (!core.validEmail(email)) return bad('please enter a valid email address');
      const name = cleanName(b.name);
      const note = String(b.note || '').trim().slice(0, 1000);
      const sess = sessionOf(req, url, b);

      // Three per hour per address. Over that we still answer ok — the reply
      // must not become a way to probe which addresses have accounts, and a
      // frustrated double-tap should not page the shop four times.
      const recent = await sql`SELECT count(*)::int AS n FROM deletion_requests
        WHERE email = ${email} AND created_at > now() - interval '1 hour'`;
      if (recent.length && recent[0].n >= 3) return json({ ok: true, queued: false });

      const id = 'del_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
      const record = {
        id, email, name, note,
        source: sess ? 'app' : 'web',
        signedInAs: sess ? (sess.pseudo ? null : sess.customerId) : null,
        requestedAt: new Date().toISOString()
      };
      await sql`INSERT INTO deletion_requests (id, email, status, data)
                VALUES (${id}, ${email}, 'open', ${JSON.stringify(record)}::jsonb)`;

      const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
      await sendBrandedMail(adminEmail, 'Account deletion request — ' + email, {
        heading: 'Someone has asked to be deleted',
        bodyText:
          'A customer has asked us to delete their Haven account.\n\n' +
          'Email: ' + email + '\n' +
          (name ? 'Name they gave: ' + name + '\n' : '') +
          'Came from: ' + (sess ? 'inside the app, signed in' : 'the website form') + '\n' +
          (record.signedInAs ? 'Lightspeed customer id: ' + record.signedInAs + '\n' : '') +
          (note ? '\nWhat they said:\n' + note + '\n' : '') +
          '\nRequest id: ' + id + '\n\n' +
          'We tell people this is done within 30 days. What to remove: their ' +
          'Lightspeed customer record (or its personal fields), and any bookings ' +
          'or event registrations held under that address. Completed sales have ' +
          'to be kept for tax — the privacy page says so.\n\n— Northwood Game Haven',
        replyTo: email
      }).catch((e) => { console.error('[account] deletion admin mail failed', e && e.message); });

      // Confirmation to the requester. Deliberately worded so that it is not a
      // disclosure: it confirms the REQUEST, never that an account exists.
      await sendBrandedMail(email, 'We got your deletion request', {
        heading: 'Your request is with us',
        bodyText:
          'Hi' + (name ? ' ' + name : '') + ',\n\n' +
          'We have received your request to delete your Northwood Game Haven ' +
          'account and the personal details attached to it. A person here will ' +
          'take care of it within 30 days and email you when it is done.\n\n' +
          'Records of completed purchases are kept for tax and accounting, as ' +
          'described at gamehaven.guru/privacy — everything else goes.\n\n' +
          'If you did not make this request, reply to this email and we will ' +
          'stop it.\n\nReference: ' + id + '\n\n— Northwood Game Haven'
      }).catch((e) => { console.error('[account] deletion confirmation mail failed', e && e.message); });

      return json({ ok: true, queued: true, id });
    }

    // ---- everything below needs a session ----
    const bodyForSession = (req.method === 'POST' || req.method === 'PUT') ? await readJson(req) : null;
    const s = sessionOf(req, url, bodyForSession);
    if (!s) return bad('unauthorized', 401);

    if (head === 'logout' && req.method === 'POST') return json({ ok: true });

    // ---- POST /signup ----
    if (head === 'signup' && req.method === 'POST') {
      const b = bodyForSession || {};
      // The review session is not pseudo, so without this it would fall past
      // the getCustomer() miss below and create a REAL Lightspeed customer.
      // The reviewer should never reach signup — /verify hands them a customer
      // — but a stray call must not write to the POS.
      if (isReviewSession(s)) return json({ session: core.issueSession(core.secret(), reviewId()), customer: reviewCustomer(), existing: true });
      if (!s.pseudo) {
        const existing = await getCustomer(s.customerId).catch(() => null);
        if (existing) return json({ session: core.issueSession(core.secret(), existing.id), customer: existing, existing: true });
      }
      const email = s.pseudo ? s.email : '';
      if (!core.validEmail(email)) return bad('sign in again to create your account');
      const first = cleanName(b.first_name), last = cleanName(b.last_name);
      if (!first) return bad('first name is required');
      let customer = await findCustomerByEmail(email);       // race guard: someone may have created it meanwhile
      if (!customer) {
        customer = await createCustomer({
          first_name: first, last_name: last, email, phone: cleanPhone(b.phone), mobile: cleanPhone(b.phone),
          enable_loyalty: true, do_not_email: !b.marketing
        });
        console.log('[account] created customer', customer && customer.id);
      }
      customer.customer_group = customer.customer_group || await customerGroupName(customer.customer_group_id);
      return json({ session: core.issueSession(core.secret(), customer.id), customer });
    }

    // ---- GET /me ----
    if (head === 'me' && req.method === 'GET') {
      // Before anything reaches Lightspeed — this id is not a customer there.
      if (isReviewSession(s)) return json(reviewBundle());
      if (s.pseudo) return json({ customer: null, email: s.email, loyalty: null, purchases: [], bookings: [], registrations: [], orders: [] });
      let customer;
      try { customer = await getCustomer(s.customerId); }
      catch (e) { if (e instanceof LsError && e.status === 404) return bad('account not found — sign in again', 401); throw e; }
      customer.customer_group = customer.customer_group || await customerGroupName(customer.customer_group_id);
      const email = customer.email || '';
      const out = { customer, loyalty: null, purchases: [], bookings: [], registrations: [], orders: [] };
      const soft = async (label, fn) => { try { return await fn(); } catch (e) { console.error('[account] ' + label + ' failed', e && e.message); return null; } };

      out.loyalty = await soft('retailer', async () => { const r = await getRetailer(); return { ratio: r.loyaltyRatio, currency: r.currency }; });
      out.purchases = (await soft('purchases', async () => {
        const sales = await customerSales(customer.id);
        const ids = [...new Set(sales.flatMap(x => (x.line_items || []).map(li => li.product_id)).filter(Boolean))];
        const names = new Map();
        if (ids.length) {
          const rows = await sql`SELECT id, data->>'name' AS name FROM ls_products WHERE id = ANY(${ids})`;
          rows.forEach(r => names.set(r.id, r.name));
        }
        return sales.map(x => core.normalizeSale(x, names)).slice(0, 20);
      })) || [];
      if (email) {
        out.bookings = (await soft('bookings', async () => {
          const rows = await sql`SELECT data FROM bookings WHERE lower(data->>'email') = lower(${email}) ORDER BY date DESC LIMIT 10`;
          return rows.map(r => r.data).map(b => ({ id: b.id, date: b.date, start: b.start, hours: b.hours, endLabel: b.endLabel || '',
            rooms: (b.rooms || []).map(core.roomLabel), status: b.status, payment: b.payment || '', feePaid: !!b.feePaid, depositPaid: !!b.depositPaid,
            costBooking: b.costBooking, deposit: b.deposit, birthdayParty: !!b.birthdayParty }));
        })) || [];
        out.registrations = (await soft('registrations', async () => {
          const rows = await sql`SELECT data FROM registrations WHERE lower(data->>'email') = lower(${email}) ORDER BY occ_date DESC NULLS LAST, created_at DESC LIMIT 10`;
          return rows.map(r => r.data).map(r => ({ id: r.id, eventId: r.eventId, eventTitle: r.eventTitle, occDate: r.occDate, qty: r.qty,
            status: r.status, feePaid: !!r.feePaid, payment: r.payment || '', ticketUrl: r.feePaid || !r.cost ? ticketUrl(r.id) : null }));
        })) || [];
        out.orders = (await soft('orders', async () => {
          const rows = await sql`SELECT id, data, status, created_at FROM shop_orders WHERE lower(data->>'email') = lower(${email}) ORDER BY created_at DESC LIMIT 10`;
          return rows.map(r => ({ id: r.id, status: r.status, createdAt: r.created_at, total: r.data.total, pay: r.data.pay, pickupAt: r.data.pickupAt,
            items: (r.data.items || []).map(i => ({ name: i.name, qty: i.qty, price: i.price })), token: core.orderSig(core.secret(), r.id) }));
        })) || [];
      }
      return json(out);
    }

    // ---- PUT /me ----
    if (head === 'me' && req.method === 'PUT') {
      // The reviewer may well try the profile form. Let it succeed visibly and
      // change nothing — writing to Lightspeed under a fake id would 404, and
      // an error here reads as a broken app.
      if (isReviewSession(s)) return json({ customer: reviewCustomer() });
      if (s.pseudo) return bad('create your account first', 400);
      const b = bodyForSession || {};
      const fields = {};
      if (b.first_name != null) { fields.first_name = cleanName(b.first_name); if (!fields.first_name) return bad('first name is required'); }
      if (b.last_name != null) fields.last_name = cleanName(b.last_name);
      if (b.phone != null) { fields.phone = cleanPhone(b.phone); fields.mobile = fields.phone; }
      if (b.email != null) { const e = String(b.email).trim().toLowerCase(); if (!core.validEmail(e)) return bad('invalid email'); fields.email = e; }
      if (b.do_not_email != null) fields.do_not_email = !!b.do_not_email;
      if (!Object.keys(fields).length) return bad('nothing to update');
      if (fields.email) {
        const other = await findCustomerByEmail(fields.email);
        if (other && other.id !== s.customerId) return bad('that email already belongs to another rewards account', 409);
      }
      const customer = await updateCustomer(s.customerId, fields);
      customer.customer_group = customer.customer_group || await customerGroupName(customer.customer_group_id);
      return json({ customer });
    }

    return bad('not found', 404);
  } catch (e) {
    console.error('[account] error', e);
    if (e instanceof LsError && e.status === 0) return bad('rewards accounts are not connected yet', 503);
    return bad('Server error: ' + String((e && e.message) || e), 500);
  }
};
