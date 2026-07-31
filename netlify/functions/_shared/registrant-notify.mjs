// netlify/functions/_shared/registrant-notify.mjs
// Automatic registrant notification for EVENT SCHEDULE CHANGES.
//
// Closes SOP §6.4 ("the system never emails registrants about changes"):
// whenever an event is edited or deleted in a way that affects people who
// registered, the SERVER now emails every affected registrant automatically —
// canceling an occurrence, bumping it for a Limited event or a booking,
// moving a date/time, splitting a series, or deleting the event outright.
//
// The admin console passes a transient `__change` hint on PUT /events/:id so
// the wording (and any auto-cancel/refund) matches the action taken:
//   { kind:'cancel-occurrence', dates:[...] }  occurrence(s) canceled → cancel
//                                              affected registrations, refund
//                                              online payments, email each
//   { kind:'bump', dates:[...] }               same, but "bumped" wording
//   { kind:'restore-occurrence', dates:[...] } date back on → invite re-register
//   { kind:'detach', fromDate, date, start, end }  one date changed → "updated"
//   { kind:'series-split', splitDate }         series edited from a date on →
//                                              notify + flag staff to follow up
//   (no hint)                                  server diffs old vs new and sends
//                                              a safe "schedule changed" notice;
//                                              nothing is auto-canceled.
//
// Every path also emails ADMIN_EMAIL a summary when staff follow-up is needed.
import { sendBrandedMail } from './email.mjs';
import { refundPaymentIntent, retrieveSession } from './stripe.mjs';
import { expandOccurrences } from './conflicts.mjs';
import { siteBase, money } from './ticket.mjs';

const PHONE = '(715) 861-3214';

function adminEmail() { return process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com'; }
function fmtT(t) { if (!t) return ''; const p = String(t).split(':'); let h = +p[0]; const m = p[1], ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return hh + ':' + m + ' ' + ap; }
function whenLabel(ev, date) {
  return (date || ev.date) + (ev.allDay ? ' · All day' : (ev.start ? (' · ' + fmtT(ev.start) + '–' + fmtT(ev.end)) : ''));
}
function eventLink(ev, date) {
  return siteBase() + '/event/' + encodeURIComponent(ev.id) + (date ? ('?date=' + encodeURIComponent(date)) : '');
}
function occDatesOf(ev) { return expandOccurrences(ev).map(o => o.date); }
function regDate(reg, ev) { return reg.occDate || ev.date; }
function regQty(d) { return Math.max(1, parseInt(d && d.qty, 10) || 1); }

async function mail(to, subject, body) {
  try { return await sendBrandedMail(to, subject, body); }
  catch (e) { console.error('[registrant-notify] email failed', to, e); return { ok: false }; }
}

export async function activeRegsFor(sql, eventId) {
  const rows = await sql`SELECT data FROM registrations WHERE event_id = ${eventId}`;
  return rows.map(r => r.data).filter(d => d && d.status !== 'canceled');
}

// Refund any online payment on a registration (mirrors registrations.mjs logic).
async function maybeRefundReg(reg) {
  if (reg.refunded) return;
  let pi = reg.paymentPI || reg.feePI || null;
  if (!pi && reg.checkoutSessionId) {
    try { const sess = await retrieveSession(reg.checkoutSessionId); pi = sess && sess.payment_intent; }
    catch (e) { console.error('[registrant-notify] session lookup failed', e); }
  }
  if (!pi) return;
  try {
    await refundPaymentIntent(pi);
    reg.refunded = true; reg.refundedAt = new Date().toISOString(); reg.feePaid = false;
  } catch (e) {
    console.error('[registrant-notify] refund failed', reg.id, e);
    reg.refundError = String(e && e.message || e);
  }
}

function refundLine(reg) {
  if (reg.refunded) return 'Your payment' + (reg.amountPaidCents ? (' of ' + money(reg.amountPaidCents)) : '') + ' has been refunded to your card automatically (refunds usually appear within 5–10 business days).';
  if (reg.refundError) return 'We hit a snag refunding your payment automatically — we will process it manually and follow up with you.';
  return 'No online payment was on file, so there is nothing to refund.';
}

// Cancel one registration because its occurrence was canceled/bumped:
// refund → mark canceled → persist → email the registrant.
async function cancelRegForDate(sql, reg, ev, date, verb) {
  await maybeRefundReg(reg);
  reg.status = 'canceled';
  reg.canceledAt = new Date().toISOString();
  reg.cancelReason = 'occurrence-canceled';
  await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${reg.id}`;
  if (reg.email) {
    await mail(reg.email, '❌ Canceled: ' + (ev.title || 'NGH Event') + ' on ' + date, {
      heading: 'Event date canceled',
      bodyText: 'Hi ' + reg.name + ',\n\n' +
        'We’re sorry — the ' + date + ' session of ' + (ev.title || 'NGH Event') + ' at Northwood Game Haven has been ' + verb + '. Your registration' + (regQty(reg) > 1 ? (' (' + regQty(reg) + ' tickets)') : '') + ' for that date is canceled and any ticket QR code is no longer valid for it.\n\n' +
        refundLine(reg) + '\n\n' +
        'Other dates of this event (if any) are not affected. We’d love to see you at another session — the current calendar is always at gamehaven.guru/events.html.\n\n' +
        'Questions? Just reply to this email or call ' + PHONE + '.\n\n— Northwood Game Haven',
      buttons: [{ label: '📅 See upcoming events', url: siteBase() + '/events.html', primary: true }]
    });
  }
  return { id: reg.id, name: reg.name, email: reg.email || '—', qty: regQty(reg), date, refunded: !!reg.refunded, refundError: reg.refundError || null };
}

function summarize(list) {
  return list.map(x => '  • ' + x.date + ' — ' + x.name + ' (' + x.email + (x.qty > 1 ? (', ' + x.qty + ' tickets') : '') + ')' +
    (x.refunded ? ' — refunded' : (x.refundError ? ' — ⚠ REFUND FAILED: ' + x.refundError : ''))).join('\n');
}

async function adminSummary(subject, text) {
  await mail(adminEmail(), subject, { heading: '🛎️ Registrant auto-notification report', bodyText: text });
}

// ============================================================
// Main dispatcher — called from events.mjs after a successful PUT.
// prev = the event as stored BEFORE the update; next = as stored AFTER.
// hint = the console's transient __change object (may be null).
// Never throws (best-effort); returns a small report object.
// ============================================================
export async function notifyEventChange(sql, prev, next, hint) {
  const report = { canceled: 0, notified: 0 };
  try {
    const regs = await activeRegsFor(sql, prev.id);
    if (!regs.length) return report;
    const title = next.title || prev.title || 'NGH Event';
    const kind = hint && hint.kind;

    const prevDates = occDatesOf(prev);
    const nextDates = occDatesOf(next);
    const removed = prevDates.filter(d => nextDates.indexOf(d) < 0);

    // ---- occurrence(s) canceled or bumped: cancel + refund + email ----
    if (kind === 'cancel-occurrence' || kind === 'bump') {
      const dates = (hint.dates && hint.dates.length) ? hint.dates : removed;
      const verb = kind === 'bump' ? 'canceled to make room for another event' : 'canceled';
      const done = [];
      for (const reg of regs) {
        if (dates.indexOf(regDate(reg, prev)) >= 0) {
          done.push(await cancelRegForDate(sql, reg, next, regDate(reg, prev), verb));
        }
      }
      report.canceled = done.length; report.notified = done.length;
      if (done.length) {
        await adminSummary('Registrants auto-canceled: ' + title + ' (' + done.length + ')',
          'Occurrence cancellation of "' + title + '" (' + prev.id + ') auto-processed ' + done.length + ' registration(s):\n\n' + summarize(done) +
          '\n\nEach person was emailed automatically; online payments were refunded. Rows flagged REFUND FAILED need a manual Stripe refund today.');
      }
      // fall through: if times also changed for the remaining dates, notify those too
      const remaining = regs.filter(r => r.status !== 'canceled' && dates.indexOf(regDate(r, prev)) < 0);
      await notifyTimeChangeIfAny(prev, next, remaining, title, report);
      return report;
    }

    // ---- a canceled date was restored: invite prior registrants back ----
    if (kind === 'restore-occurrence') {
      const dates = hint.dates || [];
      const rows = await sql`SELECT data FROM registrations WHERE event_id = ${prev.id}`;
      const priors = rows.map(r => r.data).filter(d => d && d.status === 'canceled' && d.cancelReason === 'occurrence-canceled' && dates.indexOf(d.occDate || prev.date) >= 0);
      for (const p of priors) {
        if (!p.email) continue;
        await mail(p.email, '🎉 Back on: ' + title + ' on ' + (p.occDate || prev.date), {
          heading: 'That date is back on!',
          bodyText: 'Hi ' + p.name + ',\n\nGood news — the ' + (p.occDate || prev.date) + ' session of ' + title + ' at Northwood Game Haven is back on the calendar.\n\nYour earlier registration for that date was canceled (and refunded where applicable) when the date came off the schedule, so if you’d like to come, please register again — it only takes a minute.\n\n— Northwood Game Haven',
          buttons: [{ label: '🎟️ Re-register', url: eventLink(next, p.occDate || prev.date), primary: true }]
        });
        report.notified++;
      }
      return report;
    }

    // ---- one date detached / modified: "your session was updated" ----
    if (kind === 'detach') {
      const from = hint.fromDate || hint.date;
      const affected = regs.filter(r => regDate(r, prev) === from);
      for (const reg of affected) {
        if (!reg.email) continue;
        const newWhen = (hint.date || from) + (hint.start ? (' · ' + fmtT(hint.start) + '–' + fmtT(hint.end)) : '');
        await mail(reg.email, '🔄 Updated: ' + title + ' on ' + from, {
          heading: 'Your event session was updated',
          bodyText: 'Hi ' + reg.name + ',\n\nA change was made to the ' + from + ' session of ' + title + ' at Northwood Game Haven that you’re registered for.\n\nNew details: ' + newWhen + '\n\nYour registration and ticket remain valid — nothing else to do. If the new details don’t work for you, you can cancel from your ticket page for a full refund of any online payment.\n\nQuestions? Reply to this email or call ' + PHONE + '.\n\n— Northwood Game Haven',
          buttons: [{ label: '📅 View event', url: siteBase() + '/events.html', primary: true }]
        });
        report.notified++;
      }
      return report;
    }

    // ---- series split ("this and following" edit): notify + staff follow-up ----
    if (kind === 'series-split') {
      const split = hint.splitDate;
      const affected = regs.filter(r => regDate(r, prev) >= split);
      for (const reg of affected) {
        if (!reg.email) continue;
        await mail(reg.email, '🔄 Schedule change: ' + title, {
          heading: 'Schedule change for your event',
          bodyText: 'Hi ' + reg.name + ',\n\nThe schedule for ' + title + ' at Northwood Game Haven changed starting ' + split + ', which includes the date you registered for (' + regDate(reg, prev) + ').\n\nYour registration remains valid and a Game Guru will follow up with your date’s exact details. The current calendar is always at gamehaven.guru/events.html.\n\nIf the change doesn’t work for you, reply to this email or call ' + PHONE + ' and we’ll cancel and refund any online payment in full.\n\n— Northwood Game Haven',
          buttons: [{ label: '📅 See current schedule', url: siteBase() + '/events.html', primary: true }]
        });
        report.notified++;
      }
      if (affected.length) {
        await adminSummary('⚠ Follow up: series split affected ' + affected.length + ' registrant(s) — ' + title,
          'The series "' + title + '" (' + prev.id + ') was split at ' + split + '. Registrations from that date on still point at the ORIGINAL event and need review:\n\n' +
          affected.map(r => '  • ' + regDate(r, prev) + ' — ' + r.name + ' (' + (r.email || '—') + (regQty(r) > 1 ? (', ' + regQty(r) + ' tickets') : '') + ')').join('\n') +
          '\n\nEach was emailed "a Guru will follow up." Open View registrants on both events and confirm each person’s date, or cancel+refund as needed. No exceptions — this is the manual half of the auto-notification rule.');
      }
      return report;
    }

    // ---- no hint: safe generic handling ----
    // Single (non-recurring) event moved to a new date: migrate + notify.
    if (!prev.recurrence && !next.recurrence && prev.date !== next.date) {
      for (const reg of regs) {
        if (reg.occDate === prev.date || !reg.occDate) {
          reg.occDate = next.date;
          await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb, occ_date = ${next.date} WHERE id = ${reg.id}`;
        }
        if (!reg.email) continue;
        await mail(reg.email, '🔄 New date: ' + title + ' — now ' + whenLabel(next), {
          heading: 'Your event moved',
          bodyText: 'Hi ' + reg.name + ',\n\n' + title + ' at Northwood Game Haven has moved:\n\nOld: ' + whenLabel(prev) + '\nNew: ' + whenLabel(next) + '\n\nYour registration and ticket remain valid for the new date — nothing else to do. If the new date doesn’t work for you, cancel from your ticket page (or reply to this email) for a full refund of any online payment.\n\n— Northwood Game Haven',
          buttons: [{ label: '📅 View event', url: eventLink(next, next.date), primary: true }]
        });
        report.notified++;
      }
      return report;
    }
    // Dates disappeared without a console hint: notify (no auto-cancel) + flag staff.
    if (removed.length) {
      const affected = regs.filter(r => removed.indexOf(regDate(r, prev)) >= 0);
      for (const reg of affected) {
        if (!reg.email) continue;
        await mail(reg.email, '🔄 Schedule change: ' + title + ' on ' + regDate(reg, prev), {
          heading: 'Schedule change for your event',
          bodyText: 'Hi ' + reg.name + ',\n\nThe ' + regDate(reg, prev) + ' session of ' + title + ' at Northwood Game Haven is no longer on the calendar as originally scheduled. It may have been moved or canceled — a Game Guru will follow up with specifics.\n\nIf it was canceled, any online payment will be refunded in full. The current calendar is always at gamehaven.guru/events.html.\n\nQuestions? Reply to this email or call ' + PHONE + '.\n\n— Northwood Game Haven',
          buttons: [{ label: '📅 See current schedule', url: siteBase() + '/events.html', primary: true }]
        });
        report.notified++;
      }
      if (affected.length) {
        await adminSummary('⚠ Follow up: schedule change affected ' + affected.length + ' registrant(s) — ' + title,
          'Dates were removed from "' + title + '" (' + prev.id + ') without a console action hint. These registrants were told "a Guru will follow up" — resolve each (move, or cancel+refund) today:\n\n' +
          affected.map(r => '  • ' + regDate(r, prev) + ' — ' + r.name + ' (' + (r.email || '—') + ')').join('\n'));
      }
      // continue to time-change check for everyone else
      const remaining = regs.filter(r => removed.indexOf(regDate(r, prev)) < 0);
      await notifyTimeChangeIfAny(prev, next, remaining, title, report);
      return report;
    }
    // Otherwise: just a possible time change.
    await notifyTimeChangeIfAny(prev, next, regs, title, report);
    return report;
  } catch (e) {
    console.error('[registrant-notify] notifyEventChange failed', e);
    return report;
  }
}

async function notifyTimeChangeIfAny(prev, next, regs, title, report) {
  const timeChanged = (prev.allDay !== next.allDay) || (prev.start !== next.start) || (prev.end !== next.end);
  if (!timeChanged || !regs.length) return;
  for (const reg of regs) {
    if (!reg.email) continue;
    await mail(reg.email, '🔄 New time: ' + title, {
      heading: 'Your event’s time changed',
      bodyText: 'Hi ' + reg.name + ',\n\nThe time for ' + title + ' at Northwood Game Haven changed' + (reg.occDate ? (' (your date: ' + reg.occDate + ')') : '') + ':\n\nOld: ' + (prev.allDay ? 'All day' : (fmtT(prev.start) + '–' + fmtT(prev.end))) + '\nNew: ' + (next.allDay ? 'All day' : (fmtT(next.start) + '–' + fmtT(next.end))) + '\n\nYour registration and ticket remain valid — nothing else to do. If the new time doesn’t work for you, cancel from your ticket page (or reply to this email) for a full refund of any online payment.\n\n— Northwood Game Haven',
      buttons: [{ label: '📅 View event', url: eventLink(next, reg.occDate), primary: true }]
    });
    report.notified++;
  }
}

// ============================================================
// Event DELETED: cancel + refund + email every active registrant,
// then send staff a summary. Called from events.mjs before the row
// is removed. Never throws.
// ============================================================
export async function notifyEventDeleted(sql, ev) {
  const report = { canceled: 0 };
  try {
    const regs = await activeRegsFor(sql, ev.id);
    if (!regs.length) return report;
    const done = [];
    for (const reg of regs) {
      await maybeRefundReg(reg);
      reg.status = 'canceled';
      reg.canceledAt = new Date().toISOString();
      reg.cancelReason = 'event-deleted';
      await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${reg.id}`;
      if (reg.email) {
        await mail(reg.email, '❌ Canceled: ' + (ev.title || 'NGH Event') + (reg.occDate ? (' on ' + reg.occDate) : ''), {
          heading: 'Event canceled',
          bodyText: 'Hi ' + reg.name + ',\n\nWe’re sorry — ' + (ev.title || 'NGH Event') + (reg.occDate ? (' on ' + reg.occDate) : '') + ' at Northwood Game Haven has been canceled, and your registration' + (regQty(reg) > 1 ? (' (' + regQty(reg) + ' tickets)') : '') + ' with it.\n\n' + refundLine(reg) + '\n\nWe’d love to see you at another event — the current calendar is always at gamehaven.guru/events.html.\n\nQuestions? Reply to this email or call ' + PHONE + '.\n\n— Northwood Game Haven',
          buttons: [{ label: '📅 See upcoming events', url: siteBase() + '/events.html', primary: true }]
        });
      }
      done.push({ id: reg.id, name: reg.name, email: reg.email || '—', qty: regQty(reg), date: reg.occDate || ev.date, refunded: !!reg.refunded, refundError: reg.refundError || null });
    }
    report.canceled = done.length;
    await adminSummary('Event deleted — ' + done.length + ' registrant(s) auto-canceled: ' + (ev.title || ev.id),
      '"' + (ev.title || 'NGH Event') + '" (' + ev.id + ') was deleted. The system canceled, refunded, and emailed these registrations automatically:\n\n' + summarize(done) +
      '\n\nRows flagged REFUND FAILED need a manual Stripe refund today.');
    return report;
  } catch (e) {
    console.error('[registrant-notify] notifyEventDeleted failed', e);
    return report;
  }
}
