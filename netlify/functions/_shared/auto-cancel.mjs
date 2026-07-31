// netlify/functions/auto-cancel.mjs
// Scheduled (cron) function — runs nightly. Two jobs:
//
//   1. AUTO-CANCEL: cancel any APPROVED booking still UNPAID after the
//      day-before-the-booking deadline, and email the guest. (Unchanged.)
//
//   2. DAILY OPS DIGEST (closes SOP §6.6/§6.7 gaps — "auto-cancel never
//      notifies staff" and the manual zombie-draft sweep): email ADMIN_EMAIL
//      a summary of anything that needs eyes today:
//        • bookings auto-canceled tonight (check refunds/rebooking)
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

export default async () => {
  await ensureSchema();
  const now = new Date();
  const rows = await sql`SELECT data FROM bookings WHERE status = 'approved'`;
  let canceled = 0;
  const canceledList = [];

  for (const row of rows) {
    const r = row.data;
    if (r.payment === 'paid') continue;
    const deadline = new Date(r.date + 'T00:00:00');
    deadline.setDate(deadline.getDate() - 1);
    deadline.setHours(23, 59, 59);
    if (now <= deadline) continue;

    const merged = { ...r, status: 'rejected', autoCanceled: true };
    await sql`UPDATE bookings SET data = ${JSON.stringify(merged)}::jsonb, status = 'rejected' WHERE id = ${r.id}`;
    canceled++;
    canceledList.push(`  • ${r.id} — ${r.name || '—'} · ${r.date} · ${(r.rooms || []).map(roomLabel).join(', ') || 'rooms?'}${r.birthdayParty ? ' · 🎂 BIRTHDAY PARTY' : ''} (${r.email || 'no email'})`);

    // best-effort guest email
    try {
      const recNote = r.groupId
        ? ` This was occurrence ${r.recIndex} of ${r.recTotal} in your recurring series; your other approved occurrences are NOT affected.`
        : '';
      await sendMail(r.email,
        `Your Northwood Game Haven booking ${r.id} was canceled (unpaid)`,
        `Hi ${r.name},\n\nYour booking ${r.id} for ${r.date} was automatically canceled because payment (including the deposit hold) wasn't received by the day before the booking.${recNote} Please submit a new request if you'd still like to come in.\n\n— NGH 🦦`);
    } catch (e) { console.warn('auto-cancel email failed', e); }
  }
  console.log(`[auto-cancel] canceled ${canceled} unpaid booking(s)`);

  // ---------- DAILY OPS DIGEST ----------
  try { await sendOpsDigest(now, canceledList); }
  catch (e) { console.error('[auto-cancel] ops digest failed', e); }

  return new Response(`canceled ${canceled}`, { status: 200 });
};

function ymd(d) { return d.toISOString().slice(0, 10); }
function fmtT(t) { if (!t) return ''; const p = String(t).split(':'); let h = +p[0]; const m = p[1], ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return hh + ':' + m + ' ' + ap; }
function regQty(d) { return Math.max(1, parseInt(d && d.qty, 10) || 1); }

async function sendOpsDigest(now, canceledList) {
  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
  const SITE = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
  const sections = [];

  // ---- 1. tonight's auto-cancellations ----
  if (canceledList.length) {
    sections.push('💳 AUTO-CANCELED UNPAID BOOKINGS (' + canceledList.length + ')\n' + canceledList.join('\n') +
      '\n  → Rooms are released. Follow up if any were expected to pay in person.');
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
  }).map(g => `  • ${g.occDate || '—'} — "${g.eventTitle || g.eventId}" · ${g.name}${regQty(g) > 1 ? (' ×' + regQty(g)) : ''} (${g.email || 'no email'}) — $${(Number(g.cost) * regQty(g)).toFixed(2)} due`);
  if (unpaid.length) {
    sections.push('🎟️ UNPAID SEATS — EVENT WITHIN 7 DAYS (' + unpaid.length + ')\n' + unpaid.join('\n') +
      '\n  → Chase with "Email payment link" per row (WI-105 §3). Releasing a seat is still a human decision — contact first, release second.');
  }

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
