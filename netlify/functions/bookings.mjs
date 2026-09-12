// netlify/functions/bookings.mjs
// Routes (all under /.netlify/functions):
//   GET    /bookings                      -> list all (admin only)
//   POST   /bookings        { bookings:[] } -> bulk insert (public; server-side conflict check)
//   PATCH  /bookings/:id    { ...patch }    -> update one (admin only)
//   PATCH  /bookings/group/:groupId {patch} -> update every instance in a series (admin only)
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { checkWindow, loadBlockers, describe, toMins as cToMins, MIN_GAP_MINS } from './_shared/conflicts.mjs';
// NGH-BUILD 2026-09-12c: booking refunds. Until this build, cancelling a PAID
// booking set status='rejected', emailed "we're unable to confirm your request"
// and silently kept the customer's money — there was no refund path for
// bookings anywhere in the codebase (only event registrations had one).
import { refundPaymentIntent } from './_shared/stripe.mjs';
import { refundSale } from './_shared/lightspeed.mjs';

const ROOM_IDS = ['holt', 'den', 'depths'];

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[bookings] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();

  const url = new URL(req.url);
  // path after the function name
  const parts = url.pathname.replace(/^.*\/bookings/, '').split('/').filter(Boolean);

  // ---- GET: list ----
  // Admin (authenticated) gets full records. Public callers get a SAFE subset
  // — only what's needed to show availability (date, time, rooms, status) with
  // no names, emails, phones, or notes. This lets the customer page check for
  // conflicts without exposing anyone's private details.
  //
  // Special case: GET /bookings?mine=<email> returns FULL detail for ONLY the
  // bookings matching that exact email (case-insensitive). This powers the
  // customer "see my own bookings" lookup without exposing anyone else's.
  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM bookings ORDER BY created_at ASC`;
    if (requireAdmin(req)) {
      return json(rows.map(r => r.data));
    }
    const mine = (url.searchParams.get('mine') || '').trim().toLowerCase();
    const active = rows.filter(r => r.data && r.data.status !== 'rejected');
    const publicRows = active.map(r => {
      const d = r.data;
      const isMine = mine && d.email && d.email.trim().toLowerCase() === mine;
      if (isMine) {
        // their own booking — full detail
        return Object.assign({}, d, { mine: true });
      }
      // someone else's — anonymized busy block
      return {
        id: d.id, status: d.status, date: d.date, start: d.start,
        hours: d.hours, rooms: d.rooms, groupId: d.groupId ? true : false,
        endLabel: d.endLabel, name: 'Reserved', mine: false
      };
    });
    return json(publicRows);
  }

  // ---- POST: bulk create (public) ----
  if (req.method === 'POST' && parts.length === 0) {
    let body;
    try { body = await req.json(); } catch { return bad('Invalid JSON'); }
    const list = Array.isArray(body?.bookings) ? body.bookings : [];
    if (!list.length) return bad('No bookings provided');

    // Server-side double-booking guard for non-recurring single submissions.
    // (Recurring requests are reviewed per-instance by staff, so we allow them
    //  through and let the admin resolve conflicts during approval.)
    for (const b of list) {
      if (!b.id || !b.date || !b.start || !b.hours || !Array.isArray(b.rooms)) {
        return bad('Malformed booking record');
      }
    }
    if (list.length === 1) {
      const b = list[0];
      const blockers = await loadBlockers(sql);
      const startM = cToMins(b.start);
      const { red, tight } = checkWindow(
        { date: b.date, startM, endM: startM + (Number(b.hours) || 1) * 60, rooms: b.rooms },
        blockers,
        { ignoreBookingId: b.id }
      );
      // Recurring-event occurrences don't hard-block a customer request —
      // a Game Guru adjudicates at approval (approve + cancel occurrence,
      // move the request, or reject). Bookings, blackouts, and one-time
      // events still block.
      const hardRed = red.filter(c => !(c.kind === 'event' && c.rec));
      if (hardRed.length) {
        return json({ error: 'Time conflicts with an existing booking, event, or blackout — ' + describe(hardRed), code: 'overlap', conflicts: hardRed }, 409);
      }
      if (tight.length && !body.allowTight) {
        return json({ error: 'Back-to-back with less than ' + MIN_GAP_MINS + ' minutes of changeover — ' + describe(tight), code: 'tight', conflicts: tight }, 409);
      }
    }

    for (const b of list) {
      await sql`INSERT INTO bookings (id, data, status, group_id, date)
                VALUES (${b.id}, ${JSON.stringify(b)}::jsonb, ${b.status || 'pending'}, ${b.groupId || null}, ${b.date})
                ON CONFLICT (id) DO NOTHING`;
    }
    // Notify the customer (acknowledgement) and the Game Guru (review request).
    // Best-effort: never fail the booking if email has a hiccup.
    try { await notifyNewBooking(list); } catch (e) { console.error('[bookings] notify email failed', e); }
    return json(list, 201);
  }

  // ---- POST /bookings/:id/refund (admin) — NGH-BUILD 2026-09-12e ----
  // { parts:['fee'|'deposit'], cancel?:bool, reason?:string, lightspeedOnly?:bool }
  // Refunds the Stripe charge for each requested part, reverses the matching
  // Lightspeed sale via the real returns API (which is what takes the loyalty
  // points back off), records an audit entry, and optionally cancels the
  // booking with an email that says what was actually refunded.
  // lightspeedOnly:true retries just the books after a failed reversal — the
  // Stripe refund is NOT repeated.
  if (req.method === 'POST' && parts[1] === 'refund' && parts[0]) {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    const id = decodeURIComponent(parts[0]);
    let p; try { p = await req.json(); } catch { return bad('Invalid JSON'); }
    const wanted = Array.isArray(p && p.parts) ? p.parts.filter(x => x === 'fee' || x === 'deposit') : [];
    if (!wanted.length && !p.cancel) return bad('nothing to do: pass parts:["fee"|"deposit"] and/or cancel:true');

    const rows = await sql`SELECT data FROM bookings WHERE id = ${id}`;
    if (!rows.length) return bad('Not found', 404);
    const b = rows[0].data;
    const results = [];

    for (const part of wanted) {
      const pi = part === 'deposit' ? b.depositPI : b.feePI;
      const cents = part === 'deposit' ? b.depositPaidCents : b.feePaidCents;
      const paid = part === 'deposit' ? b.depositPaid : b.feePaid;
      const prior = (b.refunds || []).find(r => r.part === part);
      // A prior entry whose Lightspeed leg failed can be retried with
      // lightspeedOnly:true — the customer already has their money, so the
      // Stripe refund must NOT run again; only the books need correcting.
      // Such a booking is already marked unpaid, so the `paid` guard below is
      // deliberately skipped on that path.
      const lsOnly = !!(p && p.lightspeedOnly);
      if (lsOnly && !prior) { results.push({ part, skipped: true, reason: 'no prior refund to retry' }); continue; }
      if (lsOnly && !prior.lightspeedError) { results.push({ part, skipped: true, reason: 'Lightspeed already reversed' }); continue; }
      if (prior && !lsOnly) { results.push({ part, skipped: true, reason: 'already refunded' }); continue; }
      if (!lsOnly) {
        if (!paid) { results.push({ part, skipped: true, reason: 'not paid' }); continue; }
        if (!pi) { results.push({ part, skipped: true, reason: 'no Stripe payment on record (paid in person or on account) — refund at the register' }); continue; }
      }

      // 1) money back first — if Stripe fails, change nothing else.
      let refundId = lsOnly ? (prior && prior.stripeRefundId) || null : null;
      if (!lsOnly) {
        try {
          const r = await refundPaymentIntent(pi, cents);
          refundId = (r && r.id) || null;
        } catch (e) {
          results.push({ part, ok: false, error: 'stripe refund failed: ' + (e && e.message ? e.message : String(e)) });
          continue;
        }
      }

      // 2) reverse in Lightspeed (never throws; a failure is reported, not fatal —
      //    the customer already has their money and must not be blocked on our books).
      const rev = await refundSale({
        sourceId: b.id + ':' + part, kind: 'booking-refund',
        amountCents: (cents != null ? cents : (prior && prior.amountCents) || null),
        payment: 'online', customerEmail: b.email,
        note: 'Refund — NGH booking ' + b.id + ' (' + part + ')' + (p.reason ? ' · ' + String(p.reason).slice(0, 200) : '')
      });

      // 3) record it
      if (part === 'deposit') b.depositPaid = false; else b.feePaid = false;
      b.payment = (b.feePaid || b.depositPaid) ? 'due' : 'refunded';
      if (prior) b.refunds = (b.refunds || []).filter(r => r !== prior);   // retry replaces the failed entry
      b.refunds = (b.refunds || []).concat([{
        at: new Date().toISOString(), part, amountCents: cents || null,
        stripeRefundId: refundId, lightspeedSaleId: rev.saleId || null,
        lightspeedError: rev.error || null, reason: p.reason || null
      }]);
      results.push({ part, ok: true, amountCents: cents || null, stripeRefundId: refundId, lightspeed: rev.ok ? 'reversed' : ('FAILED: ' + rev.error) });
    }

    if (p.cancel) b.status = 'canceled';
    await sql`UPDATE bookings SET data = ${JSON.stringify(b)}::jsonb, status = ${b.status || null} WHERE id = ${id}`;

    if (p.cancel && b.email) {
      const refunded = results.filter(r => r.ok);
      const money = refunded.length
        ? refunded.map(r => (r.part === 'fee' ? 'Booking fee' : 'Refundable deposit') + ': $' + ((r.amountCents || 0) / 100).toFixed(2)).join('\n  ')
        : null;
      try {
        await sendBrandedMail(b.email, 'Your Northwood Game Haven booking ' + b.id + ' has been canceled', {
          heading: 'Booking canceled',
          bodyText: 'Hi ' + (b.name || 'there') + ',\n\nYour booking ' + b.id + (b.date ? ' for ' + b.date : '') + ' has been canceled.\n\n'
            + (money ? ('The following has been refunded to your original payment method:\n  ' + money
                + '\n\nRefunds usually appear on a card within 5–10 business days, depending on your bank.\n\n')
              : 'No payment was refunded. If you believe that’s wrong, just reply to this email and we’ll sort it out.\n\n')
            + (p.reason ? (String(p.reason).slice(0, 500) + '\n\n') : '')
            + 'We’d still love to host you — reply any time and we’ll find a new date.\n\n— The Northwood Game Haven Crew 🦦'
        });
      } catch (e) { console.error('[bookings] cancellation email failed', e && e.message); }
    }

    console.log('[bookings] refund', id, JSON.stringify(results));
    return json({ id, status: b.status, results, booking: b });
  }

  // ---- PATCH: update one or group (admin) ----
  if (req.method === 'PATCH') {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    let patch;
    try { patch = await req.json(); } catch { return bad('Invalid JSON'); }

    // /bookings/group/:groupId
    if (parts[0] === 'group' && parts[1]) {
      const groupId = decodeURIComponent(parts[1]);
      const rows = await sql`SELECT data FROM bookings WHERE group_id = ${groupId}`;
      for (const row of rows) {
        const merged = { ...row.data, ...patch };
        await sql`UPDATE bookings
                  SET data = ${JSON.stringify(merged)}::jsonb,
                      status = ${merged.status || null}
                  WHERE id = ${merged.id}`;
      }
      return json({ updated: rows.length });
    }

    // /bookings/:id
    if (parts[0]) {
      const id = decodeURIComponent(parts[0]);
      const rows = await sql`SELECT data FROM bookings WHERE id = ${id}`;
      if (!rows.length) return bad('Not found', 404);
      const merged = { ...rows[0].data, ...patch };
      await sql`UPDATE bookings
                SET data = ${JSON.stringify(merged)}::jsonb,
                    status = ${merged.status || null}
                WHERE id = ${id}`;
      return json(merged);
    }
    return bad('Missing booking id');
  }

  return bad('Method not allowed', 405);
};

// ---- email notifications on a new booking request ----
function fmtT(t) { if (!t) return ''; const p = String(t).split(':'); let h = +p[0]; const m = p[1], ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return hh + ':' + m + ' ' + ap; }
function roomLabel(id) { return ({ holt: 'The Holt', den: "Stash's Den", depths: 'The Depths' })[id] || id; }

async function notifyNewBooking(list) {
  if (!list || !list.length) return;
  const first = list[0];
  const SITE = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
  const rooms = (first.rooms || []).map(roomLabel).join(', ') || '—';
  const dates = list.map(b => b.date).join(', ');
  const recurring = list.length > 1;
  const whenLine = (recurring ? (list.length + ' dates (' + dates + ')') : first.date) +
    ' · ' + fmtT(first.start) + (first.endLabel ? ('–' + first.endLabel) : '');
  const addonList = (first.addons || []).map(a => a.title + (a.qty ? (' ×' + a.qty) : '')).join(', ') || 'None';

  // 1) Customer acknowledgement
  if (first.email) {
    await sendBrandedMail(
      first.email,
      'We got your booking request — Northwood Game Haven',
      {
        heading: 'Request received! 🎲',
        bodyText:
          'Hi ' + (first.name || 'there') + ',\n\n' +
          'Thanks for your play-space booking request at Northwood Game Haven. A Game Guru will review it and reply within 1 business day to confirm your reservation and send secure links to pay your booking fee and refundable deposit.\n\n' +
          'What you requested:\n' +
          'Room(s): ' + rooms + '\n' +
          'When: ' + whenLine + '\n' +
          'Duration: ' + first.hours + ' hour(s)\n' +
          'Add-ons: ' + addonList + '\n\n' +
          'Questions? Just reply to this email or reach us at ' + adminEmail + '.\n\n' +
          '— The Northwood Game Haven Gurus',
        buttons: [{ label: 'Visit gamehaven.guru', url: SITE, primary: false }],
        replyTo: adminEmail
      }
    );
  }

  // 2) Game Guru notification
  await sendBrandedMail(
    adminEmail,
    (first.guruNotGuaranteed ? '\u26a0\ufe0f SHORT-NOTICE GURU \u2014 ' : '') + 'New booking request: ' + rooms + ' on ' + first.date,
    {
      heading: '📥 New Booking Request',
      bodyText:
        'A new play-space booking request was submitted.\n\n' +
        'Name: ' + (first.name || '—') + '\n' +
        'Email: ' + (first.email || '—') + '\n' +
        'Phone: ' + (first.phone || '—') + '\n' +
        'Max concurrent guests: ' + (first.guests || '—') + '\n\n' +
        'Room(s): ' + rooms + '\n' +
        'When: ' + whenLine + '\n' +
        'Duration: ' + first.hours + ' hour(s)\n' +
        (recurring ? ('Recurring: ' + list.length + ' occurrences\n') : '') +
        'Add-ons: ' + addonList + '\n' +
        'Military / first-responder discount: ' + (first.milRequested ? 'REQUESTED (verify ID)' : 'no') + '\n' +
        (first.guruNotGuaranteed
          ? ('\n\u26a0\ufe0f PRIVATE GURU \u2014 NOT GUARANTEED (<2 days notice). Fee NOT collected online ($' + (Number(first.guruFeeIfHonored) || 0).toFixed(2) + ' + tax if honored).\n' +
             'Coordinate staffing on the Guru Schedule FIRST, then Honor (emails guest a confirm + pay link) or Decline (notifies guest, no charge) from the Guru Console.\n')
          : '') +
        '\n' +
        'Review and approve in the Guru Console.',
      buttons: [{ label: 'Open Guru Console', url: SITE + '/booking.html?admin=1', primary: true }],
      replyTo: first.email || undefined
    }
  );
}
