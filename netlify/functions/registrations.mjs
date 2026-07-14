// netlify/functions/registrations.mjs
// Event registrations (multi-ticket aware).
//   GET  /registrations?event=<id>&date=<yyyy-mm-dd>   -> PUBLIC summary: people counts only
//   GET  /registrations?mine=<email>                   -> PUBLIC: that email's own regs (full + ticketUrl)
//   GET  /registrations                                -> ADMIN: all regs (full detail)
//   POST /registrations {registration}                 -> PUBLIC: create (qty tickets + attendee names)
//   PATCH /registrations/:id {fields}                  -> ADMIN: approve/unapprove/cancel
//   PATCH /registrations/:id?token=<cancelToken>       -> CUSTOMER: reduce qty (partial refund) / edit names
//   DELETE /registrations/:id                          -> customer self-cancel (by token) or admin
//
// A registration row now represents a PARTY: reg.qty people under one ticket.
// Capacity (min/max) counts PEOPLE (sum of qty), not rows.
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import { refundPaymentIntent } from './_shared/stripe.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { computeRegTotals, ticketUrl, siteBase, money } from './_shared/ticket.mjs';

function newId() { return 'REG-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100); }

// Server-side email (no guest auth restriction — runs with server privileges).
async function sendMail(to, subject, text, opts) {
  opts = opts || {};
  try {
    await sendBrandedMail(to, subject, { heading: opts.heading || '', bodyText: text, buttons: opts.buttons || [], image: opts.image });
  } catch (e) { console.error('[registrations] email failed', e); }
}
function fmtT(t){ if(!t) return ''; const p=String(t).split(':'); let h=+p[0], m=p[1], ap=h>=12?'PM':'AM', hh=h%12; if(hh===0)hh=12; return hh+':'+m+' '+ap; }
function regQty(d){ return Math.max(1, parseInt(d && d.qty, 10) || 1); }
function sumPeople(list){ return list.reduce((n, d) => n + regQty(d), 0); }

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[registrations] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/registrations/, '').split('/').filter(Boolean);
  const id = parts[0] ? decodeURIComponent(parts[0]) : null;

  if (req.method === 'GET') {
    const isAdmin = requireAdmin(req);
    const eventId = url.searchParams.get('event');
    const occDate = url.searchParams.get('date');
    const mine = (url.searchParams.get('mine') || '').trim().toLowerCase();

    if (isAdmin && !eventId && !mine) {
      const rows = await sql`SELECT data FROM registrations ORDER BY created_at ASC`;
      return json(rows.map(r => r.data));
    }
    if (mine) {
      const rows = await sql`SELECT data FROM registrations ORDER BY created_at ASC`;
      const list = rows.map(r => r.data)
        .filter(d => d.email && d.email.trim().toLowerCase() === mine && d.status !== 'canceled')
        .map(d => Object.assign({}, d, { ticketUrl: ticketUrl(d.id) }));
      return json(list);
    }
    // public summary for one event occurrence: PEOPLE counts only
    // (approved people count toward fire/cap)
    if (eventId) {
      const rows = await sql`SELECT data FROM registrations WHERE event_id = ${eventId} ORDER BY created_at ASC`;
      let all = rows.map(r => r.data).filter(d => d.status !== 'canceled');
      if (occDate) all = all.filter(d => d.occDate === occDate);
      const approved = all.filter(d => d.status !== 'unapproved');
      return json({ total: sumPeople(all), approved: sumPeople(approved) });
    }
    return bad('event or mine parameter required', 400);
  }

  if (req.method === 'POST') {
    let reg; try { reg = await req.json(); } catch { return bad('Invalid JSON'); }
    const isAdmin = requireAdmin(req);
    const adminManual = !!(reg.manual && isAdmin);   // admin walk-in / phone registration
    // Online registrations require an email; admin-created ones only need a name.
    if (!reg.eventId || !reg.name) return bad('eventId and name required');
    if (!adminManual && !reg.email) return bad('eventId, name, email required');
    // ---- party size + attendee names ----
    let qty = Math.max(1, Math.min(20, parseInt(reg.qty, 10) || 1));
    let attendees = Array.isArray(reg.attendees) ? reg.attendees.map(a => String(a || '').trim()).filter(Boolean) : [];
    if (!attendees.length) attendees = [reg.name];
    if (attendees[0] !== reg.name) attendees.unshift(reg.name);
    attendees = attendees.slice(0, qty);
    if (attendees.length !== qty && !adminManual) return bad('please provide a name for each of the ' + qty + ' tickets');
    while (attendees.length < qty) attendees.push('Guest of ' + reg.name);
    // verify the event exists and registration is enabled, enforce cap server-side
    const evRows = await sql`SELECT data FROM events WHERE id = ${reg.eventId}`;
    if (!evRows.length) return bad('event not found', 404);
    const ev = evRows[0].data;
    const r = ev.registration || {};
    if (!r.enabled) return bad('registration is not open for this event', 400);
    // Capacity: customers are hard-blocked at the cap; admin may intentionally overbook.
    // Counts PEOPLE (sum of qty across registrations), not rows.
    if (r.max && !adminManual) {
      const existing = await sql`SELECT data FROM registrations WHERE event_id = ${reg.eventId}`;
      let live = existing.map(x => x.data).filter(d => d.status !== 'canceled' && d.status !== 'unapproved');
      if (reg.occDate) live = live.filter(d => d.occDate === reg.occDate);
      const seated = sumPeople(live);
      if (seated >= r.max) return bad('this event is full', 409);
      if (seated + qty > r.max) return bad('only ' + (r.max - seated) + ' spot' + ((r.max - seated) === 1 ? '' : 's') + ' left for this event — please lower your ticket count', 409);
    }
    reg.id = newId();
    reg.status = 'approved';          // default approved
    reg.cancelToken = Math.random().toString(36).slice(2, 12);
    reg.feePaid = false;
    reg.qty = qty;
    reg.attendees = attendees;
    reg.checkedIn = 0;
    reg.submitted = new Date().toISOString();
    if (adminManual) { reg.source = 'admin'; reg.manual = true; }
    // Always record per-person cost + title so a payment link/invoice can be generated later.
    if (reg.cost == null) reg.cost = Number(r.cost) || 0;
    if (!reg.eventTitle) reg.eventTitle = ev.title || 'NGH Event';
    // Price snapshot (per-person × qty + tax + processing fee). The checkout
    // function recomputes authoritatively; this is for emails/UI.
    reg.totals = computeRegTotals(Math.round((Number(reg.cost) || 0) * 100), qty);
    await sql`INSERT INTO registrations (id, event_id, occ_date, data)
              VALUES (${reg.id}, ${reg.eventId}, ${reg.occDate || null}, ${JSON.stringify(reg)}::jsonb)`;

    // Confirmation emails (registrant + staff) — server-side, so both addresses allowed.
    const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
    const when = (reg.occDate || ev.date) + (ev.allDay ? '' : (', ' + fmtT(ev.start) + '–' + fmtT(ev.end)));
    const cost = Number(reg.cost) || 0;
    const partyLine = qty > 1 ? ('Tickets: ' + qty + ' (' + attendees.join(', ') + ')\n') : '';
    const t = reg.totals;
    const costLine = cost > 0
      ? ('Total due: ' + money(t.totalCents) + ' — ' + qty + ' × ' + money(Math.round(cost * 100)) + ' + ' + money(t.taxCents) + ' sales tax + ' + money(t.feeCents) + ' processing fee.\nPayment is due no later than 1 hour before the event starts — pay online, or in person at the shop.')
      : 'This event is free.';
    // Only email the registrant if we actually have an address (admin manual adds may not).
    if (reg.email) {
      const freeTicketBits = cost > 0
        ? { note: '\n\nYour ticket (with entry QR code) will be emailed the moment your payment is complete.', buttons: [] }
        : { note: '\n\nYour ticket is attached below — show the QR code at the door. Manage or cancel any time from the ticket page.', buttons: [{ label: '🎟️ View Your Ticket', url: ticketUrl(reg.id), primary: true }] };
      await sendMail(reg.email, "You're registered: " + (ev.title || 'NGH Event'),
        'Hi ' + reg.name + ',\n\nYou are registered for ' + (ev.title || 'NGH Event') + ' on ' + when + ' at Northwood Game Haven.\n\n' + partyLine + costLine + freeTicketBits.note + '\n\nSee you at the table!\n— Northwood Game Haven',
        { heading: "You're registered!", buttons: freeTicketBits.buttons,
          image: cost > 0 ? undefined : { url: ticketUrl(reg.id) + '/qr.png', alt: 'Your entry QR code', width: 220 } });
    }
    await sendMail(adminEmail, 'New registration: ' + (ev.title || 'NGH Event'),
      'New event registration' + (adminManual ? ' (added by staff)' : '') + '\n\nEvent: ' + (ev.title || 'NGH Event') + '\nWhen: ' + when + '\nName: ' + reg.name + '\nTickets: ' + qty + (qty > 1 ? (' — ' + attendees.join(', ')) : '') + '\nEmail: ' + (reg.email || '—') + '\nPhone: ' + (reg.phone || '—') + '\nComments: ' + (reg.comments || '—') + '\nInvoice requested: ' + (reg.wantsInvoice ? 'YES' : 'no') + '\n' + costLine);

    // ---- Auto "event confirmed to fire" notification ----
    // If this registration just brought the approved PEOPLE count up to (or
    // past) the minimum, notify every approved registrant that the event is on.
    const minToFire = r.min || 0;
    if (minToFire > 0) {
      const allRows = await sql`SELECT data FROM registrations WHERE event_id = ${reg.eventId}`;
      let approved = allRows.map(x => x.data).filter(d => d.status !== 'canceled' && d.status !== 'unapproved');
      if (reg.occDate) approved = approved.filter(d => d.occDate === reg.occDate);
      const nowPeople = sumPeople(approved);
      const beforePeople = nowPeople - qty;
      // fire exactly once: when the people count first reaches the minimum
      if (beforePeople < minToFire && nowPeople >= minToFire) {
        const base = siteBase();
        for (const a of approved) {
          const aTotals = a.totals || computeRegTotals(Math.round((Number(a.cost) || 0) * 100), regQty(a));
          let payLine;
          let payBtns = [];
          if (aTotals.totalCents > 0 && !a.feePaid) {
            // Durable pay link: GET /create-checkout mints a fresh session on
            // every click, so the link never expires.
            const link = base + '/api/create-checkout?kind=registration&id=' + encodeURIComponent(a.id);
            payLine = 'Your total is ' + money(aTotals.totalCents) + (regQty(a) > 1 ? (' for ' + regQty(a) + ' tickets') : '') + ' (includes sales tax + processing fee). Pay online now using the button below — or pay in person no later than 1 hour before the event begins. Unpaid spots may be released. Your ticket with entry QR code arrives by email as soon as payment completes.';
            payBtns = [{ label: 'Pay ' + money(aTotals.totalCents) + ' Now', url: link, primary: true }];
          } else if (aTotals.totalCents > 0 && a.feePaid) {
            payLine = 'Your payment is already complete — your ticket QR is your entry pass. Thanks!';
          } else {
            payLine = 'This event is free — just show up and play!';
          }
          await sendMail(a.email, '✅ Confirmed: ' + (ev.title || 'NGH Event') + ' is happening!',
            'Hi ' + a.name + ',\n\nGood news — ' + (ev.title || 'NGH Event') + ' on ' + when + ' has reached the minimum number of players and is confirmed to happen!\n\n' + payLine + '\n\nSee you at Northwood Game Haven!\n— NGH',
            { heading: 'Your event is confirmed! 🎉', buttons: payBtns });
        }
        console.log('[registrations] fire-notification sent to', approved.length, 'registrations for', reg.eventId, reg.occDate || '');
      }
    }

    return json(Object.assign({}, reg, { ticketUrl: ticketUrl(reg.id) }), 201);
  }

  if (req.method === 'PATCH' && id) {
    const token = url.searchParams.get('token') || '';
    const isAdmin = requireAdmin(req);
    let fields; try { fields = await req.json(); } catch { return bad('Invalid JSON'); }
    const rows = await sql`SELECT data FROM registrations WHERE id = ${id}`;
    if (!rows.length) return bad('not found', 404);
    const prev = rows[0].data;

    // ---- customer self-service modify (token-authorized) ----
    // Allowed: reduce qty (auto partial refund of the proportional share of
    // what was actually paid) and/or update attendee names.
    if (!isAdmin) {
      if (!token || prev.cancelToken !== token) return bad('unauthorized', 401);
      if (prev.status === 'canceled') return bad('this registration is canceled', 400);
      const reg = Object.assign({}, prev);
      const oldQty = regQty(prev);
      let changed = [];

      if (fields.qty != null) {
        const newQty = Math.max(1, parseInt(fields.qty, 10) || 1);
        if (newQty > oldQty) return bad('to add tickets, please submit a new registration for the extra people', 400);
        if (newQty < oldQty) {
          const removed = oldQty - newQty;
          reg.qty = newQty;
          reg.attendees = (Array.isArray(prev.attendees) ? prev.attendees : [prev.name]).slice(0, newQty);
          reg.totals = computeRegTotals(Math.round((Number(reg.cost) || 0) * 100), newQty);
          reg.checkedIn = Math.min(Number(prev.checkedIn) || 0, newQty);
          // Partial refund: proportional share of what was actually charged.
          if (prev.feePaid && Number(prev.amountPaidCents) > 0) {
            const refundCents = Math.floor(Number(prev.amountPaidCents) * removed / oldQty);
            const pi = prev.paymentPI || prev.feePI || null;
            if (pi && refundCents > 0) {
              try {
                await refundPaymentIntent(pi, refundCents);
                reg.amountPaidCents = Number(prev.amountPaidCents) - refundCents;
                reg.partialRefunds = (prev.partialRefunds || []).concat([{ at: new Date().toISOString(), amountCents: refundCents, removedQty: removed }]);
                changed.push(money(refundCents) + ' refunded to your card for the ' + removed + ' released ticket' + (removed === 1 ? '' : 's'));
              } catch (e) {
                console.error('[registrations] partial refund failed', e);
                reg.refundError = String(e && e.message || e);
                changed.push('refund of ' + money(refundCents) + ' could not be processed automatically — we will handle it manually');
              }
            }
          }
          changed.unshift('ticket count reduced from ' + oldQty + ' to ' + newQty);
        }
      }
      if (Array.isArray(fields.attendees)) {
        const names = fields.attendees.map(a => String(a || '').trim()).filter(Boolean).slice(0, regQty(reg));
        if (names.length === regQty(reg)) { reg.attendees = names; if (!changed.length) changed.push('attendee names updated'); }
      }
      if (!changed.length) return bad('nothing to change', 400);

      await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${id}`;

      // Confirmation email (updated ticket) + staff heads-up
      const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
      if (reg.email) {
        await sendMail(reg.email, 'Updated: ' + (reg.eventTitle || 'NGH Event') + ' registration',
          'Hi ' + reg.name + ',\n\nYour registration for ' + (reg.eventTitle || 'NGH Event') + (reg.occDate ? (' on ' + reg.occDate) : '') + ' has been updated:\n\n• ' + changed.join('\n• ') + '\n\nYour ticket QR code stays the same and now admits ' + regQty(reg) + (regQty(reg) === 1 ? ' person' : ' people') + '.\n\n— Northwood Game Haven',
          { heading: 'Registration updated', buttons: [{ label: '🎟️ View Your Ticket', url: ticketUrl(reg.id), primary: true }],
            image: { url: ticketUrl(reg.id) + '/qr.png', alt: 'Your entry QR code', width: 200 } });
      }
      await sendMail(adminEmail, 'Registration modified: ' + (reg.eventTitle || 'NGH Event'),
        reg.name + ' (' + (reg.email || '—') + ') modified registration ' + reg.id + ':\n\n• ' + changed.join('\n• '));
      return json(Object.assign({}, reg, { ticketUrl: ticketUrl(reg.id), changed }));
    }

    // ---- admin PATCH (unchanged behavior) ----
    const reg = Object.assign({}, prev, fields, { id });
    // If this PATCH cancels the registration, auto-refund any payment that was made.
    if (fields.status === 'canceled' && prev.status !== 'canceled') {
      await maybeRefund(reg);
      await sendCancelEmail(reg);
    }
    await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${id}`;
    return json(reg);
  }

  if (req.method === 'DELETE' && id) {
    // customer self-cancel with token, or admin
    const token = url.searchParams.get('token') || '';
    const rows = await sql`SELECT data FROM registrations WHERE id = ${id}`;
    if (!rows.length) return noContent();
    const reg = rows[0].data;
    const isAdmin = requireAdmin(req);
    if (!isAdmin && reg.cancelToken !== token) return bad('unauthorized', 401);
    if (reg.status !== 'canceled') {
      await maybeRefund(reg);
      reg.status = 'canceled';
      reg.canceledAt = new Date().toISOString();
      await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${id}`;
      await sendCancelEmail(reg);
    } else {
      await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${id}`;
    }
    return json(reg);
  }

  return bad('Method not allowed', 405);
};

// Cancellation confirmation to the customer + staff notification.
// Canceling frees the party's seats automatically (all counts sum live qty).
async function sendCancelEmail(reg) {
  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
  const qty = regQty(reg);
  const refundLine = reg.refunded
    ? 'Your payment' + (reg.amountPaidCents ? (' of ' + money(reg.amountPaidCents)) : '') + ' has been refunded to your card. Refunds usually appear within 5–10 business days.'
    : (reg.refundError ? 'We hit a snag refunding your payment automatically — we\u2019ll process it manually and follow up.' : 'No online payment was on file, so there is nothing to refund.');
  if (reg.email) {
    await sendMail(reg.email, 'Canceled: ' + (reg.eventTitle || 'NGH Event') + ' registration',
      'Hi ' + reg.name + ',\n\nYour registration for ' + (reg.eventTitle || 'NGH Event') + (reg.occDate ? (' on ' + reg.occDate) : '') + (qty > 1 ? (' (' + qty + ' tickets)') : '') + ' has been canceled and your ticket QR code is no longer valid.\n\n' + refundLine + '\n\nWe hope to see you at another event soon!\n— Northwood Game Haven',
      { heading: 'Registration canceled' });
  }
  await sendMail(adminEmail, 'Registration canceled: ' + (reg.eventTitle || 'NGH Event'),
    reg.name + ' (' + (reg.email || '—') + ') canceled registration ' + reg.id + (qty > 1 ? (' — ' + qty + ' seats released') : '') + '.' + (reg.refunded ? (' Refunded ' + money(reg.amountPaidCents || 0) + '.') : ''));
}

// Refund a registration's payment if one was made and not already refunded.
// Resilient: refunds whenever we have a payment intent OR can recover one,
// regardless of the current feePaid flag (so "mark unpaid" can't block it).
async function maybeRefund(reg) {
  if (reg.refunded) return;
  let pi = reg.paymentPI || reg.feePI || null;
  if (!pi && reg.checkoutSessionId) {
    try {
      const { retrieveSession } = await import('./_shared/stripe.mjs');
      const sess = await retrieveSession(reg.checkoutSessionId);
      pi = sess && sess.payment_intent;
    } catch (e) { console.error('[registrations] session lookup failed', e); }
  }
  if (!pi) return; // nothing was actually paid online
  try {
    await refundPaymentIntent(pi);
    reg.refunded = true; reg.refundedAt = new Date().toISOString(); reg.feePaid = false;
    console.log('[registrations] refunded', reg.id, pi);
  } catch (e) {
    console.error('[registrations] refund failed', e);
    reg.refundError = String(e && e.message || e);
  }
}
