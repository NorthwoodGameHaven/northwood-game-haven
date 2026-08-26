// netlify/functions/reminders.mjs — T-1 registrant reminder emails
// NGH-BUILD 2026-08-26c
//
// Every morning (9 AM Central, via the schedule below) this job finds every
// event occurrence happening TOMORROW and sends each registrant a
// "see you tomorrow" email: what, when, where, a ticket-page link, and a
// payment nudge if their balance is open. Industry-standard no-show killer —
// SOP §6.4 (v2.6), WI-105 §1.
//
// Safety rails:
//   - Only approved, non-canceled registrations with an email address.
//   - Idempotent: each registration is stamped data.remindedFor = <occDate>;
//     re-runs (or a manual trigger) never double-send for the same date.
//   - Per-email failures are logged and skipped, never fatal; hard cap per run.
//   - GET  /reminders?dry=1   (admin Bearer) -> preview list, nothing sent
//     GET  /reminders?run=1   (admin Bearer) -> manual run (same rails)
//     Scheduled invocations (no query string) run normally.

import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { expandOccurrences } from './_shared/conflicts.mjs';
import { ticketUrl } from './_shared/ticket.mjs';

const MAX_SENDS_PER_RUN = 200;

function chiDay(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
}
function fmtT(t) { if (!t) return ''; const p = String(t).split(':'); let h = +p[0], m = p[1], ap = h >= 12 ? 'PM' : 'AM', hh = h % 12; if (hh === 0) hh = 12; return hh + ':' + m + ' ' + ap; }
function regQty(d) { return Math.max(1, parseInt(d && d.qty, 10) || 1); }
function human(ds) { return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }

async function collect(tomorrow) {
  const evRows = await sql`SELECT data FROM events`;
  const events = evRows.map(r => r.data).filter(e => e && e.id && e.status !== 'draft');
  const dueEvents = [];
  for (const ev of events) {
    if (expandOccurrences(ev).some(o => o.date === tomorrow)) dueEvents.push(ev);
  }
  const out = [];
  for (const ev of dueEvents) {
    const rows = await sql`SELECT id, data FROM registrations WHERE event_id = ${ev.id}`;
    for (const r of rows) {
      const d = r.data || {};
      const st = String(d.status || '').toLowerCase();
      if (st === 'canceled' || st === 'cancelled' || st === 'unapproved' || st === 'rejected' || st === 'removed') continue;
      if (!d.email || !String(d.email).trim()) continue;
      const occ = d.occDate || ev.date;                 // undated regs belong to a single-date event
      if (occ !== tomorrow) continue;
      if (d.remindedFor === tomorrow) continue;         // idempotence stamp
      out.push({ id: r.id, d, ev });
    }
  }
  return out;
}

function buildMail(d, ev, tomorrow) {
  const when = human(tomorrow) + (ev.allDay ? ' — all day' : (', ' + fmtT(ev.start) + '–' + fmtT(ev.end)));
  const where = ev.offsite
    ? (ev.offsiteLocation || 'offsite — see the event page')
    : 'Northwood Game Haven · 115 W Spring St, Chippewa Falls';
  const qty = regQty(d);
  const paidCents = Number(d.amountPaidCents) || 0;
  const owes = (Number((d.totals && d.totals.totalCents)) || 0) > paidCents && (Number(d.cost) || 0) > 0;
  let bodyText =
    'See you tomorrow, ' + (String(d.name || '').split(' ')[0] || 'friend') + '! You\u2019re registered' +
    (qty > 1 ? (' (' + qty + ' tickets)') : '') + ' for:\n\n' +
    (ev.title || 'NGH event') + '\n' + when + '\n' + where + '\n\n' +
    'Show the QR code on your ticket page at the door \u2014 check-in takes seconds.';
  if (owes) bodyText += '\n\nHeads up: your balance is still open. Pay from your ticket page or in person \u2014 no later than 1 hour before start, please.';
  bodyText += '\n\nCan\u2019t make it after all? You can cancel from the ticket page and your spot goes to someone else (refunds are automatic).\n\nStay curious. \U0001f9a6';
  return {
    subject: '\U0001f3b2 See you tomorrow \u2014 ' + (ev.title || 'your NGH event'),
    heading: 'See you tomorrow!',
    bodyText,
    buttons: [{ label: '\U0001f39f\ufe0f View Your Ticket', url: ticketUrl(d.id), primary: true }]
  };
}

async function run(dry) {
  await ensureSchema();
  const tomorrow = chiDay(1);
  const due = await collect(tomorrow);
  const results = { tomorrow, due: due.length, sent: 0, skipped: 0, failed: 0, preview: [] };
  for (const item of due.slice(0, MAX_SENDS_PER_RUN)) {
    const { id, d, ev } = item;
    const mail = buildMail(d, ev, tomorrow);
    if (dry) { results.preview.push({ regId: id, to: d.email, event: ev.title, subject: mail.subject }); continue; }
    try {
      const r = await sendBrandedMail(String(d.email).trim(), mail.subject, mail);
      if (r && r.ok) {
        d.remindedFor = tomorrow;
        await sql`UPDATE registrations SET data = ${JSON.stringify(d)}::jsonb WHERE id = ${id}`;
        results.sent++;
      } else { results.failed++; console.error('[reminders] send failed', id, r); }
    } catch (e) { results.failed++; console.error('[reminders] error', id, e && e.message); }
  }
  results.skipped = Math.max(0, due.length - MAX_SENDS_PER_RUN);
  console.log('[reminders]', JSON.stringify({ tomorrow, due: results.due, sent: results.sent, failed: results.failed, dry: !!dry }));
  return results;
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const wantsDry = url.searchParams.get('dry');
    const wantsRun = url.searchParams.get('run');
    if (req.method === 'OPTIONS') return preflight();
    if (wantsDry || wantsRun) {                         // manual paths are admin-only
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      return json(await run(!!wantsDry));
    }
    // Scheduled invocation (Netlify cron) — run for real.
    return json(await run(false));
  } catch (e) {
    console.error('[reminders] fatal', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

// Netlify reads this named export to register the cron schedule.
// 14:00 UTC = 9 AM Central (CDT).
export const config = { schedule: '0 14 * * *' };
