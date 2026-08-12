// netlify/functions/_shared/promo.mjs
// Event-promotion task engine — shared by promo-tasks.mjs (Guru page API)
// and promo-digest.mjs (daily email). One source of truth for what needs
// promoting on any given day.
//
// TASK KINDS (deterministic ids so completion tracking survives recomputes):
//   weekly:<sunday>            — Sunday: share the week's calendar image to Facebook
//   daily:<date>               — every day: post tomorrow's events (otter lead-in + links)
//   vo:<eventId>               — list a SPECIAL event on Volume One (standing until done)
//   cd:<eventId>:<occ>:<k>w    — countdown post k weeks (1–4) before a special occurrence
//
// SPECIAL EVENT = not weekly/biweekly recurring. One-offs, annuals, and
// monthly-recurring (Speed Gaming Meet-up, Cookie Run Teach & Play, Team
// Trivia, …) all count. Drafts and private events are never promoted.
//
// "Done" state lives in the promo_tasks table (one row per completed task id).
import { expandOccurrences } from './conflicts.mjs';

export const BASE = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');

/* Assignment routing (per the promotion SOP):
 *   - weekly + daily posts       -> Sarah
 *   - event-tied tasks           -> the event's assigned Guru(s)
 *   - unassigned events          -> Dustin, plus an "assign a Guru" task
 * Task ids never include the assignee, so when a multi-Guru event's task is
 * completed by ANY of its Gurus it is complete for all of them. */
export const PROMO_WEEKLY_DAILY_GURU = process.env.PROMO_WEEKLY_DAILY_GURU || 'Sarah';
export const PROMO_FALLBACK_GURU = process.env.PROMO_FALLBACK_GURU || 'Dustin';
// Poster tasks apply to NEW events only - those created on/after this date.
export const POSTER_SINCE = process.env.PROMO_POSTER_SINCE || '2026-08-06';

/* ---------- promo_tasks schema (local; same race-swallow pattern as db.mjs) ---------- */
let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
export async function ensurePromoSchema(sql) {
  if (_ready) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS promo_tasks (
      id         TEXT PRIMARY KEY,
      done_at    TIMESTAMPTZ DEFAULT now(),
      data       JSONB
    )`;
  } catch (e) { if (!isAlreadyExists(e)) throw e; }
  _ready = true;
}

/* ---------- date helpers (all math on plain YMD strings, noon-anchored) ---------- */
export function chicagoToday() {
  // en-CA gives YYYY-MM-DD directly.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
}
function d(ymdStr) { return new Date(ymdStr + 'T12:00:00'); }
function ymd(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}
export function addDays(ymdStr, n) { const x = d(ymdStr); x.setDate(x.getDate() + n); return ymd(x); }
function dow(ymdStr) { return d(ymdStr).getDay(); }               // 0 = Sunday
function human(ymdStr) {
  return d(ymdStr).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
function fmtTime(t) {
  if (!t) return '';
  const p = String(t).split(':'); let h = +p[0]; const m = +p[1] || 0;
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12;
  return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
}
function timesOf(e) {
  if (e.allDay) return 'All day';
  if (!e.start) return '';
  return fmtTime(e.start) + (e.end ? '–' + fmtTime(e.end) : '');
}

/* ---------- classification ---------- */
export function isSpecial(e) {
  if (!e || e.status === 'draft' || e.private) return false;
  if (!e.recurrence) return true;                                   // one-off / annual
  const f = e.recurrence.freq;
  return f !== 'weekly' && f !== 'biweekly';                        // monthly modes count
}
function isPromotable(e) { return e && e.status !== 'draft' && !e.private; }

/* ---------- post-text composition (page prefill + email preview share this) ---------- */
export function eventUrl(e, occDate) {
  return BASE + '/event/' + encodeURIComponent(e.id) + (occDate ? ('?date=' + occDate) : '');
}
// Full event description, formatting preserved (trailing spaces trimmed, runs
// of blank lines collapsed) — NO truncation: the Guru sees everything in the
// editable box and trims what they don't want, instead of getting a mid-
// sentence "…" they can't recover from. (n is ignored, kept for call sites.)
function excerpt(s, n) {
  return String(s || '').replace(/\r\n?/g, '\n')
    .split('\n').map(l => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
export function dailyPostText(tomorrow, evs) {
  const lines = ['🦦 Check out what\'s happening tomorrow @ The Haven:', ''];
  evs.forEach(e => {
    lines.push('• ' + e.title + (timesOf(e) ? (' — ' + timesOf(e)) : ''));
    lines.push(eventUrl(e, tomorrow));
  });
  // Closing line AFTER the links: Facebook strips the preview-generating URL from
  // the post body when it's the last thing in the message — trailing text keeps
  // the links visible and clickable alongside the preview card.
  lines.push('');
  lines.push('🎲 115 W Spring St, Chippewa Falls — see you at the Haven!');
  return lines.join('\n');
}
export function countdownPostText(e, occDate, weeks) {
  const when = weeks === 1 ? 'ONE WEEK from today' : weeks + ' weeks out';
  const lines = ['🦦 ' + e.title + ' — ' + when + ', ' + human(occDate) + ' @ The Haven!'];
  const ex = excerpt(e.notes, 220);
  if (ex) { lines.push(''); lines.push(ex); }
  lines.push('');
  const reg = e.registration && e.registration.enabled;
  lines.push((reg ? 'Details & registration: ' : 'Details: ') + eventUrl(e, occDate));
  // Trailing text keeps the URL clickable in the body (see dailyPostText note).
  lines.push('');
  lines.push('🎲 See you at the Haven!');
  return lines.join('\n');
}

export function voListingText(e, occDate) {
  const L = [];
  L.push(e.title);
  L.push('Date: ' + human(occDate) + (e.recurrence ? '  (recurring — ' + e.recurrence.freq + ')' : ''));
  L.push('Time: ' + (timesOf(e) || 'see listing'));
  L.push('Location: Northwood Game Haven, 115 W Spring St, Chippewa Falls, WI');
  const ex = excerpt(e.notes, 600);
  if (ex) { L.push(''); L.push(ex); }
  L.push('');
  L.push('More info' + (e.registration && e.registration.enabled ? ' & registration' : '') + ': ' + eventUrl(e, occDate));
  return L.join('\n');
}

/* ---------- task computation ----------
 * Returns tasks relevant on `forDate` (YMD, America/Chicago):
 *   today[]    — tasks whose scheduled day is forDate
 *   overdue[]  — undone weekly/daily/cd tasks from the previous 7 days
 *   standing[] — undone Volume One listings (any upcoming special event)
 * Every task: { id, kind, day, label, text?, links:{...}, done, event? } */
export async function computeTasks(sql, forDate) {
  await ensurePromoSchema(sql);
  const evRows = await sql`SELECT data, created_at FROM events ORDER BY created_at ASC`;
  const createdAt = {};
  const events = evRows.map(r => {
    if (r.data && r.data.id) createdAt[r.data.id] = String(r.created_at).slice(0, 10);
    return r.data;
  }).filter(isPromotable);
  const doneRows = await sql`SELECT id FROM promo_tasks`;
  const done = new Set(doneRows.map(r => r.id));

  // Guru assignments (guru_data kind='assignment'): event-level row (date null)
  // wins; otherwise the union of per-date rows. none:true = explicitly no Guru.
  let asgRows = [];
  try { asgRows = await sql`SELECT data FROM guru_data WHERE kind = 'assignment'`; } catch (e) { /* table may not exist yet */ }
  const asgByEvent = {};
  asgRows.map(r => r.data).forEach(a => {
    if (!a || !a.eventId) return;
    (asgByEvent[a.eventId] = asgByEvent[a.eventId] || []).push(a);
  });
  function gurusFor(eventId) {
    const rows = asgByEvent[eventId] || [];
    const evLevel = rows.find(a => a.date == null);
    if (evLevel) return evLevel.none ? [] : (evLevel.gurus || []);
    const set = [];
    rows.forEach(a => { if (!a.none) (a.gurus || []).forEach(g => { if (set.indexOf(g) < 0) set.push(g); }); });
    return set;
  }
  function assigneesFor(eventId) {
    const g = gurusFor(eventId);
    return g.length ? g : [PROMO_FALLBACK_GURU];
  }

  // occurrence index: date -> events happening that date (horizon only)
  const horizonEnd = addDays(forDate, 62);
  const byDate = {};
  const specialOccs = [];                                           // {e, date}
  for (const e of events) {
    for (const occ of expandOccurrences(e)) {
      if (occ.date < addDays(forDate, -8) || occ.date > horizonEnd) continue;
      (byDate[occ.date] = byDate[occ.date] || []).push(e);
      if (isSpecial(e)) specialOccs.push({ e, date: occ.date });
    }
  }

  function tasksForDay(day) {
    const out = [];
    // 1) Sunday — share this week's calendar image
    if (dow(day) === 0) {
      out.push({
        id: 'weekly:' + day, kind: 'weekly', day, assignees: [PROMO_WEEKLY_DAILY_GURU],
        label: 'Share this week\'s event calendar (' + day + ' – ' + addDays(day, 6) + ') to Facebook',
        links: { open: BASE + '/events.html?view=week&date=' + day + '&share=1' }
      });
    }
    // 2) tomorrow's events post
    const tomorrow = addDays(day, 1);
    const evs = (byDate[tomorrow] || []);
    if (evs.length) {
      out.push({
        id: 'daily:' + day, kind: 'daily', day, assignees: [PROMO_WEEKLY_DAILY_GURU],
        label: 'Post tomorrow\'s events (' + human(tomorrow) + ') — ' + evs.length + ' event' + (evs.length > 1 ? 's' : ''),
        text: dailyPostText(tomorrow, evs),
        links: { facebook: 'https://www.facebook.com/' }
      });
    }
    // 3) countdown posts — k weeks before each special occurrence
    for (const { e, date } of specialOccs) {
      for (let k = 1; k <= 4; k++) {
        if (addDays(date, -7 * k) === day) {
          out.push({
            id: 'cd:' + e.id + ':' + date + ':' + k + 'w', kind: 'cd', day, assignees: assigneesFor(e.id),
            label: e.title + ' — ' + k + '-week countdown post (event ' + human(date) + ')',
            text: countdownPostText(e, date, k),
            links: {
              // Composer, not sharer.php — the sharer dialog hangs on "Posting…" and
              // can't take pasted text. Pasting the copied post (it contains the event
              // link) into the composer auto-expands the preview card.
              facebook: 'https://www.facebook.com/',
              details: eventUrl(e, date)
            },
            event: { id: e.id, title: e.title, occDate: date }
          });
        }
      }
    }
    out.forEach(t => { t.done = done.has(t.id); });
    return out;
  }

  const today = tasksForDay(forDate);
  const overdue = [];
  for (let i = 7; i >= 1; i--) {
    tasksForDay(addDays(forDate, -i)).forEach(t => { if (!t.done) overdue.push(t); });
  }

  // 4) Volume One listings — standing until done, regardless of event date.
  //    One task per special EVENT (not per occurrence); link opens its details.
  const standing = [];
  const seen = new Set();
  for (const { e, date } of specialOccs.sort((a, b) => a.date < b.date ? -1 : 1)) {
    if (date < forDate || seen.has(e.id)) continue;
    seen.add(e.id);
    const id = 'vo:' + e.id;
    if (done.has(id)) continue;
    standing.push({
      id, kind: 'vo', day: forDate, assignees: assigneesFor(e.id),
      label: 'List "' + e.title + '" (' + human(date) + ') on the Volume One calendar',
      text: voListingText(e, date),
      links: { details: eventUrl(e, date), volumeone: 'https://volumeone.org/events/submit' },
      event: { id: e.id, title: e.title, occDate: date },
      done: false
    });
  }

  // Per-event standing tasks: first upcoming occurrence drives the label/links.
  const firstUpcoming = {};
  for (const day in byDate) {
    if (day < forDate) continue;
    byDate[day].forEach(e => {
      if (!firstUpcoming[e.id] || day < firstUpcoming[e.id]) firstUpcoming[e.id] = day;
    });
  }
  events.forEach(e => {
    const nextOcc = firstUpcoming[e.id];
    if (!nextOcc) return;   // nothing upcoming in the horizon

    // 1) Unassigned event -> Dustin's first task: assign a Guru. Auto-clears the
    //    moment an assignment exists; can also be checked off manually.
    if (!gurusFor(e.id).length) {
      const aid = 'assign:' + e.id;
      if (!done.has(aid)) {
        standing.push({
          id: aid, kind: 'assign', day: forDate, assignees: [PROMO_FALLBACK_GURU],
          label: 'Assign a Guru to "' + e.title + '" (' + human(nextOcc) + ') - its promo tasks route to them',
          links: { edit: BASE + '/booking.html?editEvent=' + encodeURIComponent(e.id), details: eventUrl(e, nextOcc) },
          event: { id: e.id, title: e.title, occDate: nextOcc },
          done: false
        });
      }
    }

    // 2) NEW events (created on/after POSTER_SINCE): design, print & display a poster.
    if ((createdAt[e.id] || '') >= POSTER_SINCE) {
      const pid = 'poster:' + e.id;
      if (!done.has(pid)) {
        standing.push({
          id: pid, kind: 'poster', day: forDate, assignees: assigneesFor(e.id),
          label: 'Design, print & display the poster for "' + e.title + '" (first: ' + human(nextOcc) + ')',
          links: { details: eventUrl(e, nextOcc) },
          event: { id: e.id, title: e.title, occDate: nextOcc },
          done: false
        });
      }
    }

    // 3) Recurring series running low (<=4 upcoming occurrences): review & extend.
    //    The duplicate deep link opens the event editor prefilled as a copy with
    //    the start date set to the next date in the pattern AFTER the series
    //    ends - tweak details/images and publish the follow-on series.
    if (e.recurrence) {
      // Count remaining occurrences from the FULL series expansion — the 62-day
      // horizon index would under-count long monthly series and false-alarm.
      let upcoming = [];
      try { upcoming = expandOccurrences(e).map(o => o.date).filter(d => d >= forDate).sort(); } catch (err) { upcoming = []; }
      if (upcoming.length > 0 && upcoming.length <= 4) {
        const lastOcc = upcoming[upcoming.length - 1];
        let nextStart = addDays(lastOcc, e.recurrence.freq === 'biweekly' ? 14 : 7);
        try {
          const e2 = { ...e, recurrence: { ...e.recurrence, count: (e.recurrence.count || 2) + 1 }, exceptions: [] };
          const all = expandOccurrences(e2).map(o => o.date).sort();
          const after = all.filter(d => d > lastOcc);
          if (after.length) nextStart = after[0];
        } catch (err) { /* fall back to the +7/+14 estimate */ }
        const xid = 'extend:' + e.id + ':' + lastOcc;
        if (!done.has(xid)) {
          standing.push({
            id: xid, kind: 'extend', day: forDate, assignees: assigneesFor(e.id),
            label: 'ALERT: "' + e.title + '" has only ' + upcoming.length + ' occurrence' + (upcoming.length === 1 ? '' : 's') + ' left (last: ' + human(lastOcc) + ') - review & extend the series',
            links: {
              duplicate: BASE + '/booking.html?dupEvent=' + encodeURIComponent(e.id) + '&start=' + nextStart,
              details: eventUrl(e, nextOcc)
            },
            event: { id: e.id, title: e.title, occDate: nextOcc, lastOcc: lastOcc, nextStart: nextStart },
            done: false
          });
        }
      }
    }
  });

  // Distinct assignee list for the console's Guru filter.
  const gurus = [];
  [].concat(today, overdue, standing).forEach(t => (t.assignees || []).forEach(g => { if (gurus.indexOf(g) < 0) gurus.push(g); }));
  gurus.sort();

  return { date: forDate, today, overdue, standing, gurus };
}

/* ---------- plain-text digest body (daily email) ---------- */
export function digestBody(result) {
  const L = [];
  const line = t => '  • ' + t.label + ((t.assignees && t.assignees.length) ? ('  [' + t.assignees.join(' + ') + ']') : '') + (t.done ? '  ✅' : '');
  if (result.overdue.length) {
    L.push('⚠️ OVERDUE (last 7 days, not yet done):');
    result.overdue.forEach(t => L.push(line(t)));
    L.push('');
  }
  L.push('📣 TODAY (' + human(result.date) + '):');
  if (result.today.length) result.today.forEach(t => L.push(line(t)));
  else L.push('  • No scheduled promotion tasks today.');
  L.push('');
  if (result.standing.length) {
    L.push('📰 VOLUME ONE LISTINGS STILL NEEDED:');
    result.standing.forEach(t => L.push(line(t)));
    L.push('');
  }
  L.push('Open the task list to knock these out — each task has a one-click share:');
  L.push(BASE + '/guru-promo.html');
  return L.join('\n');
}
