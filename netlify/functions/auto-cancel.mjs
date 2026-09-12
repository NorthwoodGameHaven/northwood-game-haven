// netlify/functions/auto-cancel.mjs
// Scheduled (cron) function — runs nightly. Two jobs:
//
//   1. UNPAID SWEEP — NGH-BUILD 2026-09-12p, RULES REWRITTEN.
//
//      THE DEPOSIT NEVER CANCELS ANYBODY. EVER. It is payable on the day, it
//      is refundable, and it is not a reason to take somebody's room away. It
//      appears below exactly once, as something that can SAVE a booking.
//      Robyn paid her booking fee, owed only the day-of deposit, and got
//      cancelled anyway. That is the bug this file exists to never repeat.
//
//      NOTHING IS CANCELLED BEFORE THE BOOKING HAS ACTUALLY HAPPENED. The old
//      rule cancelled at a pay-by deadline the day before, which meant a guest
//      who was going to settle up at the counter lost their room the night
//      before while nobody was watching. The only bookings this touches now
//      are ones where the room was held, the fee was never paid, and the time
//      has already come and gone.
//
//      Specifically, a booking is auto-cancelled only when ALL of these hold:
//        • status is approved
//        • the BOOKING FEE is not recorded as paid, on account, or settled
//        • NOTHING ELSE is paid either — any deposit or on-account marker on
//          the record spares it (the deposit can only help, never hurt)
//        • the booking's END time (start + hours, America/Chicago) is in the
//          past. Not the start time: this cron runs @daily = midnight UTC =
//          7 PM Central, so cancelling at the start time would have released
//          a 6 PM booking at 7 PM with the guests sitting in the room. If a
//          booking has no start time, the end of its day is used.
//
//      Guests are only emailed if the booking ended within the last
//      GUEST_EMAIL_GRACE_H hours. Older no-shows are closed out quietly and
//      listed in the ops digest — nobody needs a cancellation notice for a
//      party that was three weeks ago.
//
//      Kill switch: set AUTO_CANCEL_ENABLED=0 in the Netlify environment and
//      trigger a deploy. The sweep then only reports, and cancels nothing.
//
//   2. DAILY OPS DIGEST (closes SOP §6.6/§6.7 gaps — "auto-cancel never
//      notifies staff" and the manual zombie-draft sweep): email ADMIN_EMAIL
//      a summary of anything that needs eyes today:
//        • unpaid approved bookings past their pay-by date (chase, or reject
//          by hand — nothing is cancelled for you)
//        • zombie draft events (>14 days old, still holding rooms)
//        • min-to-fire events within 48h that haven't met minimum
//          (EO run/cancel decision due per WI-105 §3)
//        • unpaid seats on events within 7 days (chase or release)
//      The digest is only sent when there is something to report.
//
// Schedule is configured in netlify.toml ([functions."auto-cancel"]).
import { sql, ensureSchema } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { expandOccurrences, eventRoomsOf, roomLabel } from './_shared/conflicts.mjs';

const ZOMBIE_DRAFT_DAYS = 14;
const STORE_TZ = 'America/Chicago';
const GUEST_EMAIL_GRACE_H = 48;   // don't email about a booking older than this

// NGH-BUILD 2026-09-12p: kill switch. Set AUTO_CANCEL_ENABLED=0 (or false/no/off)
// in Netlify and trigger a deploy to make this sweep report-only.
const AUTO_CANCEL_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.AUTO_CANCEL_ENABLED ?? '').trim());

// How far America/Chicago is from UTC at a given instant, in ms. Derived from
// the runtime's own tz database rather than hardcoding -5/-6, so CST/CDT and
// any future rule change are handled without a code edit.
function tzOffsetMs(at, tz = STORE_TZ) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(at)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return asUTC - at.getTime();
}

// A wall-clock time in the store's timezone -> the actual instant it happened.
function storeInstant(dateStr, hh, mm, ss = 0) {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  if (!Y || !M || !D) return null;
  const guess = Date.UTC(Y, M - 1, D, hh, mm, ss);
  // One correction pass is exact everywhere except inside the DST spring-
  // forward gap, where the hour does not exist and either answer is fine.
  return new Date(guess - tzOffsetMs(new Date(guess)));
}

// When is this booking OVER? start + hours, in store time. A booking with no
// start time is treated as running to the end of its day, which is the latest
// (i.e. safest) reading — it can only delay a cancellation, never hasten one.
export function bookingEndsAt(r) {
  if (!r || !r.date) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(r.start || ''));
  if (!m || r.allDay) return storeInstant(r.date, 23, 59, 59);
  const hours = Number(r.hours);
  const durMin = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : 60;
  const endMin = (+m[1]) * 60 + (+m[2]) + durMin;
  // Past midnight stays on the booking's own date, capped at 23:59:59 — a late
  // session should not push the cancellation a whole extra day out.
  if (endMin >= 24 * 60) return storeInstant(r.date, 23, 59, 59);
  return storeInstant(r.date, Math.floor(endMin / 60), endMin % 60, 0);
}

// The ONLY payment question that can lead to a cancellation. Anything at all
// recorded against the booking — fee, deposit, on account — spares it.
export function nothingPaid(r) {
  return !(r.payment === 'paid' || r.payment === 'onaccount' ||
    r.feePaid === true || r.depositPaid === true ||
    r.feeOnAccount === true || r.depositOnAccount === true);
}

export default async () => {
  await ensureSchema();
  const now = new Date();
  const rows = await sql`SELECT data, created_at FROM bookings WHERE status = 'approved'`;
  // "today" in store-local time (America/Chicago); en-CA => YYYY-MM-DD
  const chiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
  let canceled = 0;
  const canceledList = [];
  const flaggedList = [];        // found, reported, deliberately left alone

  for (const row of rows) {
    const r = row.data;
    // GUARD 1 — anything paid, anywhere, in any form, is off limits. This
    // includes the deposit: the deposit can only ever save a booking.
    if (!nothingPaid(r)) {
      if (r.payment !== 'paid') console.log('[auto-cancel] SPARED partially-paid / on-account booking', r.id, '(fee:' + (r.feePaid === true) + ' deposit:' + (r.depositPaid === true) + ' onaccount:' + (r.payment === 'onaccount') + ') — needs staff follow-up');
      continue;
    }
    // GUARD 2 — the booking must be OVER. Not "past a pay-by deadline", not
    // "the day before". Over. Nobody's room disappears while it is still
    // theirs, and nobody is cancelled while they are sitting in it.
    const endsAt = bookingEndsAt(r);
    if (!endsAt || now <= endsAt) continue;

    const hoursSince = (now - endsAt) / 3600000;
    const line = `  • ${r.id} — ${r.name || '—'} · ${r.date}${r.start ? ' ' + fmtT(r.start) : ''} · ${(r.rooms || []).map(roomLabel).join(', ') || 'rooms?'}${r.birthdayParty ? ' · 🎂 BIRTHDAY PARTY' : ''} (${r.email || 'no email'})`;

    // Kill switch: report it and change nothing.
    if (!AUTO_CANCEL_ENABLED) {
      flaggedList.push(line + ' — booking fee never paid');
      console.log('[auto-cancel] REPORT ONLY (AUTO_CANCEL_ENABLED=0) —', r.id, 'left approved');
      continue;
    }

    const merged = { ...r, status: 'rejected', autoCanceled: true, autoCanceledAt: now.toISOString() };
    await sql`UPDATE bookings SET data = ${JSON.stringify(merged)}::jsonb, status = 'rejected' WHERE id = ${r.id}`;
    canceled++;
    canceledList.push(line + (hoursSince > GUEST_EMAIL_GRACE_H ? ' — closed out quietly, too old to email' : ''));

    // Guest email — best effort, and only while it is still news to them.
    if (hoursSince > GUEST_EMAIL_GRACE_H) {
      console.log('[auto-cancel]', r.id, 'ended', Math.round(hoursSince / 24), 'days ago — closing out without emailing the guest');
      continue;
    }
    try {
      const recNote = r.groupId
        ? ` This was occurrence ${r.recIndex} of ${r.recTotal} in your recurring series; your other approved occurrences are NOT affected.`
        : '';
      // The deposit is payable on the day and is NOT a reason to cancel.
      // Don't tell a guest it was, and don't imply it.
      await sendMail(r.email,
        `Your Northwood Game Haven booking ${r.id} was closed out (booking fee unpaid)`,
        `Hi ${r.name},\n\nYour booking ${r.id} for ${r.date} has been closed out because the booking fee was never paid.${recNote} The refundable deposit is payable on the day and had nothing to do with this.\n\nIf that's a mistake — you paid at the counter, or something went wrong on our end — just reply to this email and we'll put it right.\n\n— NGH 🦦`);
    } catch (e) { console.warn('auto-cancel email failed', e); }
  }
  console.log(`[auto-cancel] canceled ${canceled} unpaid booking(s); flagged ${flaggedList.length} for staff`);

  // ---------- DAILY OPS DIGEST ----------
  try { await sendOpsDigest(now, canceledList, chiToday, flaggedList); }
  catch (e) { console.error('[auto-cancel] ops digest failed', e); }

  return new Response(`canceled ${canceled}, flagged ${flaggedList.length}`, { status: 200 });
};

function ymd(d) { return d.toISOString().slice(0, 10); }
function fmtT(t) { if (!t) return ''; const p = String(t).split(':'); let h = +p[0]; const m = p[1], ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return hh + ':' + m + ' ' + ap; }
function regQty(d) { return Math.max(1, parseInt(d && d.qty, 10) || 1); }

async function sendOpsDigest(now, canceledList, chiToday, flaggedList = []) {
  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
  const SITE = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
  const sections = [];

  // ---- 1a. would have been closed out, but the kill switch is on ----
  if (flaggedList.length) {
    sections.push('💳 FINISHED BOOKINGS WHERE THE FEE WAS NEVER PAID (' + flaggedList.length + ') — NOTHING WAS CANCELED\n' + flaggedList.join('\n') +
      '\n  → AUTO_CANCEL_ENABLED is set to 0, so these are still APPROVED. Collect, write off, or reject by hand in the Guru Console.');
  }

  // ---- 1b. closed out overnight ----
  if (canceledList.length) {
    sections.push('🧾 CLOSED OUT — BOOKING FEE NEVER PAID, DATE ALREADY PASSED (' + canceledList.length + ')\n' + canceledList.join('\n') +
      '\n  → These had already happened (or not) before anything was touched. Nothing upcoming was cancelled, and the deposit was never part of it.' +
      '\n  → Guests were emailed only if the booking ended in the last ' + GUEST_EMAIL_GRACE_H + ' hours. Re-approve in the console if any of these actually paid at the counter.');
  }

  // ---- load events + registrations once ----
  const evRows = await sql`SELECT data, created_at FROM events`;
  const regRows = await sql`SELECT data FROM registrations`;
  const regs = regRows.map(r => r.data).filter(Boolean);

  // ---- 2. zombie drafts holding rooms (SOP §6.7 sweep, automated) ----
  const zombieCutoff = new Date(now.getTime() - ZOMBIE_DRAFT_DAYS * 86400000);
  const zombies = evRows.filter(r => {
    const e = r.data;
    if (!e || e.status !== 'draft') return false;
    if (!eventRoomsOf(e).length) return false;               // offsite = holds nothing
    const created = r.created_at ? new Date(r.created_at) : null;
    return created && created < zombieCutoff;
  }).map(r => {
    const e = r.data;
    const age = Math.floor((now - new Date(r.created_at)) / 86400000);
    return `  • ${e.id} — "${e.title || 'untitled'}" · ${e.date} · holding ${eventRoomsOf(e).map(roomLabel).join(', ')} · draft for ${age} days`;
  });
  if (zombies.length) {
    sections.push('🧟 ZOMBIE DRAFTS STILL HOLDING ROOMS (' + zombies.length + ', older than ' + ZOMBIE_DRAFT_DAYS + ' days)\n' + zombies.join('\n') +
      '\n  → Publish, re-date far-future/offsite, or delete — parked drafts silently block rooms (SOP §6.2).');
  }

  // ---- 3. min-to-fire not met within 48h (WI-105 §3 decision due) ----
  const in48 = new Date(now.getTime() + 48 * 3600000);
  const minAlerts = [];
  for (const r of evRows) {
    const e = r.data;
    if (!e || e.status === 'draft') continue;
    const rg = e.registration || {};
    if (!rg.enabled || !(rg.min > 0)) continue;
    for (const occ of expandOccurrences(e)) {
      const od = occ.date;
      if (od < ymd(now) || od > ymd(in48)) continue;
      let people = 0;
      for (const g of regs) {
        if (g.eventId !== e.id) continue;
        if (g.status === 'canceled' || g.status === 'unapproved') continue;
        if ((g.occDate || e.date) !== od) continue;
        people += regQty(g);
      }
      if (people < rg.min) {
        minAlerts.push(`  • ${od} — "${e.title || e.id}" ${e.allDay ? '' : (fmtT(e.start) + ' ')}has ${people}/${rg.min} needed to fire`);
      }
    }
  }
  if (minAlerts.length) {
    sections.push('🔥 MIN-TO-FIRE NOT MET — EVENT WITHIN 48H (' + minAlerts.length + ')\n' + minAlerts.join('\n') +
      '\n  → EO decides run/cancel per WI-105 §3. Canceling the occurrence in the console now auto-notifies and refunds registrants.');
  }

  // ---- 4. unpaid seats on events within 7 days ----
  const in7 = new Date(now.getTime() + 7 * 86400000);
  const evById = {}; evRows.forEach(r => { if (r.data) evById[r.data.id] = r.data; });
  const unpaid = regs.filter(g => {
    if (g.status === 'canceled') return false;
    if (g.feePaid) return false;
    const cost = Number(g.cost) || 0;
    if (cost <= 0) return false;
    const ev = evById[g.eventId];
    const od = g.occDate || (ev && ev.date);
    return od && od >= ymd(now) && od <= ymd(in7);
  }).map(g => `  • ${g.occDate || '—'} — "${g.eventTitle || g.eventId}" · ${g.name}${regQty(g) > 1 ? (' ×' + regQty(g)) : ''} (${g.email || 'no email'}) — $${(Number(g.cost) * regQty(g)).toFixed(2)} ${g.payment === 'onaccount' ? 'ON ACCOUNT in Lightspeed (send the pay link from Sales history)' : 'due'}`);   // NGH-BUILD 2026-09-11a
  if (unpaid.length) {
    sections.push('🎟️ UNPAID SEATS — EVENT WITHIN 7 DAYS (' + unpaid.length + ')\n' + unpaid.join('\n') +
      '\n  → Chase with "Email payment link" per row (WI-105 §3). Releasing a seat is still a human decision — contact first, release second.');
  }

  // ---- 5. Guru-not-guaranteed short-notice requests (2-day rule) ----
  try {
    const chiT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(now);
    const gnb = [];
    const bkRows = await sql`SELECT data FROM bookings WHERE status IN ('pending','approved')`;
    for (const b of bkRows) {
      const d = b.data;
      if (!d || !d.guruNotGuaranteed || d.guruResolved) continue;
      if (!d.date || d.date < chiT) continue;
      gnb.push(`  • ${d.id} — ${d.name || '—'} · ${d.date} ${fmtT(d.start)} · ${(d.rooms || []).map(roomLabel).join(', ') || 'rooms?'} · Guru fee if honored: $${Number(d.guruFeeIfHonored || 0).toFixed(2)} (${d.email || 'no email'})`);
    }
    let bdayRows = [];
    try { bdayRows = await sql`SELECT data FROM birthday_requests`; }
    catch (e) { /* table may not exist until the first birthday request */ }
    for (const b of bdayRows) {
      const d = b.data;
      if (!d || !d.guruNotGuaranteed) continue;
      if (['closed', 'canceled', 'cancelled', 'rejected', 'declined'].includes(String(d.status || '').toLowerCase())) continue;
      if (!d.date || d.date < chiT) continue;
      gnb.push(`  • ${d.id} — 🎂 ${d.package || 'birthday party'} · ${d.date} ${d.time || ''} · ${d.name || '—'} (${d.email || 'no email'})`);
    }
    if (gnb.length) {
      sections.push('🧙 PRIVATE GURU NOT GUARANTEED — SHORT-NOTICE (<2 DAYS) REQUESTS (' + gnb.length + ')\n' + gnb.join('\n') +
        '\n  → Coordinate Guru staffing NOW (Guru Schedule). If honored: confirm with the guest and collect the Guru fee separately (POS or payment link). If it can\'t be staffed: tell the guest ASAP — a room booking still stands without the Guru.');
    }
  } catch (e) { console.warn('[auto-cancel] guru-not-guaranteed digest section failed', e); }

  // ---- 5. short-notice Guru requests needing coordination / fee collection ----
  try {
    const bkRows = await sql`SELECT data FROM bookings WHERE status IN ('approved','pending')`;
    const guruItems = [];
    for (const r of bkRows) {
      const b = r.data;
      if (!b || !b.guruNotGuaranteed) continue;
      if (!b.date || b.date < chiToday) continue;                 // past = moot
      if (b.guruResolved === 'declined') continue;                // closed out
      const fee = (Number(b.guruFeeIfHonored) || 0).toFixed(2);
      if (b.guruResolved === 'honored') {
        if (!b.guruFeePaid) guruItems.push(`  \u2022 ${b.id} \u2014 ${b.name || '\u2014'} \u00b7 ${b.date} \u00b7 HONORED, Guru fee $${fee} + tax still DUE (pay link or POS)`);
      } else {
        guruItems.push(`  \u2022 ${b.id} \u2014 ${b.name || '\u2014'} \u00b7 ${b.date} \u00b7 pending coordination \u00b7 fee if honored $${fee} + tax`);
      }
    }
    if (guruItems.length) {
      sections.push('\ud83e\uddd9 SHORT-NOTICE PRIVATE GURU (' + guruItems.length + ')\n' + guruItems.join('\n') +
        '\n  \u2192 Check the Guru Schedule, then Honor (auto-emails confirm + pay link) or Decline (auto-notifies guest) in the Guru Console. Approval alone never promises the Guru.');
    }
  } catch (e) { console.warn('[auto-cancel] guru digest section failed', e); }

  if (!sections.length) { console.log('[auto-cancel] ops digest: nothing to report'); return; }

  await sendBrandedMail(adminEmail, `🦦 NGH Daily Ops Digest — ${sections.length} item group(s) need eyes`, {
    heading: '🗞️ Daily Ops Digest',
    bodyText: 'Good morning! The overnight sweep found the following. Full detail and every action lives in the Guru Console.\n\n' +
      sections.join('\n\n') +
      '\n\nThis digest is generated automatically by the nightly job (auto-cancel.mjs). It only arrives when something needs attention.',
    buttons: [{ label: 'Open Guru Console', url: SITE + '/booking.html?admin=1', primary: true }]
  });
  console.log('[auto-cancel] ops digest sent:', sections.length, 'sections');
}

async function sendMail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Northwood Game Haven <bookings@northwoodgamehaven.com>';
  if (!apiKey) { console.log('[auto-cancel] (no RESEND_API_KEY) would email', to); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text })
  });
}

// Netlify reads this named export to register the cron schedule.
export const config = { schedule: '@daily' };
