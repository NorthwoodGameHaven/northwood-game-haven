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
export const DISCORD_URL = process.env.NGH_DISCORD_URL || 'https://discord.gg/EP2f6npF';
// Poster tasks apply to NEW events only - those created on/after this date.
export const POSTER_SINCE = process.env.PROMO_POSTER_SINCE || '2026-08-06';
export const PROMO_PRINT_GURU = process.env.PROMO_PRINT_GURU || 'Chad';         // weekly printed schedule
export const PRINT_SINCE = '2026-08-22';                                        // first Saturday
export const TT_GURU = process.env.PROMO_TT_GURU || 'Dustin';                   // Team Trivia teasers

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
// Courtesy rule: the Eau Claire Board Game Group runs its own main event every
// Friday — NGH posts about FRIDAY-OCCURRING events must never be shared there.
// Posting ON a Friday about other days is fine; it's the event's day that matters.
const EC_FLAG = '🚫 Do NOT share to the Eau Claire Board Game Group — this covers a FRIDAY event (their main event night).';
const EC_FLAG_WEEK = '⚠️ This week includes Friday events — don\'t share the calendar to the Eau Claire Board Game Group (their main event night).';
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

/* ---------- per-event promotion plan (set in Draft Review) ----------
 * e.promoPlan: { facebook, discord, dayBefore, volumeone, poster: bool (default true),
 *                countdownWeeks: [4,3,2,1] subset } — absent plan = all defaults. */
function plan(e) { return (e && e.promoPlan) || {}; }
function planOn(e, key) { return plan(e)[key] !== false; }
function planWeeks(e) {
  const w = plan(e).countdownWeeks;
  return (Array.isArray(w) && w.length) ? w : [1, 2, 3, 4];
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

function chanList(e) {
  const c = e.discordChannels || [];
  return c.map(x => x.charAt(0) === '#' ? x : ('#' + x)).join(', ');
}
export function discordPostText(e, occDate, weeks) {
  const when = weeks === 1 ? 'ONE WEEK out' : weeks + ' weeks out';
  const L = ['@here ' + e.title + ' — ' + when + ': ' + human(occDate) + ' @ the Haven!'];
  const ex = excerpt(e.notes, 0);
  if (ex) { L.push(''); L.push(ex); }
  L.push('');
  L.push((e.registration && e.registration.enabled ? 'Details & registration: ' : 'Details: ') + eventUrl(e, occDate));
  L.push('');
  L.push('Questions, requests, or want a warm-up session before the big day? Drop it below 👇');
  return L.join('\n');
}
export function discordDayBeforeText(e, occDate) {
  const L = ['@here TOMORROW: ' + e.title + ' — ' + human(occDate) + (timesOf(e) ? (', ' + timesOf(e)) : '') + ' @ the Haven!'];
  L.push('');
  L.push((e.registration && e.registration.enabled ? 'Last call to register: ' : 'Details: ') + eventUrl(e, occDate));
  L.push('');
  L.push('See you there — bring a friend 🦦');
  return L.join('\n');
}

export function triviaTeaserText(e, occDate, daysOut) {
  const when = daysOut === 0 ? 'TONIGHT' : daysOut === 1 ? 'TOMORROW' : daysOut + ' days out';
  const L = ['🧠 TEAM TRIVIA — ' + when + ': ' + human(occDate) + (timesOf(e) ? (', ' + timesOf(e)) : '') + ' @ the Haven!'];
  L.push('');
  L.push("THIS ROUND'S CATEGORIES — with a teaser question for each 👇");
  L.push('• [category 1] — teaser…');
  L.push('• [category 2] — teaser…');
  L.push('• [category 3] — teaser…');
  L.push('');
  L.push('😏 (optional: hint at a minigame or two)');
  L.push('');
  L.push((e.registration && e.registration.enabled ? 'Register your team: ' : 'Details: ') + eventUrl(e, occDate));
  L.push('');
  L.push('🦦 Think together. Win together.');
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
      const fri = addDays(day, 5);
      out.push({
        id: 'weekly:' + day, kind: 'weekly', day, assignees: [PROMO_WEEKLY_DAILY_GURU],
        label: 'Share this week\'s event calendar (' + day + ' – ' + addDays(day, 6) + ') to Facebook',
        flag: (byDate[fri] && byDate[fri].length) ? EC_FLAG_WEEK : undefined,
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
        flag: dow(tomorrow) === 5 ? EC_FLAG : undefined,
        text: dailyPostText(tomorrow, evs),
        links: { facebook: 'https://www.facebook.com/' }
      });
    }
    // 3) countdown posts — k weeks before each special occurrence
    for (const { e, date } of specialOccs) {
      if (!planOn(e, 'facebook')) continue;
      for (const k of planWeeks(e)) {
        if (addDays(date, -7 * k) === day) {
          out.push({
            id: 'cd:' + e.id + ':' + date + ':' + k + 'w', kind: 'cd', day, assignees: assigneesFor(e.id),
            flag: dow(date) === 5 ? EC_FLAG : undefined,
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
    // 3a-2) Saturday: print, laminate & display the physical weekly schedule
    if (dow(day) === 6 && day >= PRINT_SINCE) {
      out.push({
        id: 'print:' + day, kind: 'print', day, assignees: [PROMO_PRINT_GURU],
        label: 'Print, laminate & display this week\u2019s event schedule \u2014 hand-sanitizer frame near the checkout counter',
        links: { open: BASE + '/events.html?view=week&date=' + addDays(day, -6) + '&share=1' }
      });
    }

    // 3a-3) Sunday: review & update the TV display slideshows
    if (dow(day) === 0) {
      out.push({
        id: 'tv:' + day, kind: 'tv', day, assignees: [PROMO_WEEKLY_DAILY_GURU],
        label: 'Review & update the TV display slideshows \u2014 upcoming Special Events and current promotions',
        links: { details: BASE + '/events.html' }
      });
    }

    // 3a-4) Team Trivia teasers: 3 / 2 / 1 days before + day-of each instance —
    //       publish the categories with a teaser question each, link to
    //       registration, optionally hint at the minigames.
    for (const { e, date } of specialOccs) {
      if (!/team trivia/i.test(e.title || '')) continue;
      for (const n of [3, 2, 1, 0]) {
        if (addDays(date, -n) === day) {
          out.push({
            id: 'tt:' + e.id + ':' + date + ':' + n + 'd', kind: 'tt', day, assignees: [TT_GURU],
            label: 'Team Trivia teaser \u2014 ' + (n === 0 ? 'DAY OF' : n + ' day' + (n > 1 ? 's' : '') + ' before') + ' (' + human(date) + '): publish categories + a teaser question each, link to register' + (n >= 2 ? ', optionally hint the minigames' : ''),
            text: triviaTeaserText(e, date, n),
            flag: dow(date) === 5 ? EC_FLAG : undefined,
            links: { facebook: 'https://www.facebook.com/', details: eventUrl(e, date) },
            event: { id: e.id, title: e.title, occDate: date }
          });
        }
      }
    }

    // 3b) Discord countdown posts — same 4/3/2/1-week cadence, posted to the
    //     event's designated channel by the event's owner Guru. The task text
    //     doubles as a discussion starter (guest requests, questions, and any
    //     warm-up session — Teach & Play, practice night — the Guru deems fit).
    for (const { e, date } of specialOccs) {
      if (planOn(e, 'discord')) for (const k of planWeeks(e)) {
        if (addDays(date, -7 * k) === day) {
          out.push({
            id: 'dcd:' + e.id + ':' + date + ':' + k + 'w', kind: 'dcd', day, assignees: assigneesFor(e.id),
            label: e.title + ' — ' + k + '-week Discord post' + (chanList(e) ? (' in ' + chanList(e)) : '') + ' (event ' + human(date) + ') — promote + spin up discussion / warm-up session if applicable',
            text: discordPostText(e, date, k),
            links: { discord: DISCORD_URL, details: eventUrl(e, date) },
            event: { id: e.id, title: e.title, occDate: date }
          });
        }
      }
      // 3c) day-before Discord post in the same channel
      if (planOn(e, 'dayBefore') && addDays(date, -1) === day) {
        out.push({
          id: 'dpre:' + e.id + ':' + date, kind: 'dpre', day, assignees: assigneesFor(e.id),
          label: e.title + ' — day-before Discord post' + (chanList(e) ? (' in ' + chanList(e)) : '') + ' (event tomorrow, ' + human(date) + ')',
          text: discordDayBeforeText(e, date),
          links: { discord: DISCORD_URL, details: eventUrl(e, date) },
          event: { id: e.id, title: e.title, occDate: date }
        });
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

  // 3.5) Monthly standing tasks (until done):
  //  - smc:<YYYY-MM> — social-media giveaway campaign, activates the 3rd week
  //    of each month (from the 15th)
  //  - gbp:<YYYY-MM> — Google Business Profile refresh, activates from the 1st
  const _ym = forDate.slice(0, 7);
  const _monthDay = Number(forDate.slice(8, 10));
  const monthly = [];
  if (_monthDay >= 15 && !done.has('smc:' + _ym)) {
    monthly.push({
      id: 'smc:' + _ym, kind: 'smc', day: forDate, assignees: [PROMO_WEEKLY_DAILY_GURU],
      label: 'Social-Media campaign \u2014 giveaways for more followers (' + _ym + ' edition): pick the prize, set the follow/share/tag mechanics, schedule the posts',
      links: { facebook: 'https://www.facebook.com/' },
      done: false
    });
  }
  if (!done.has('gbp:' + _ym)) {
    monthly.push({
      id: 'gbp:' + _ym, kind: 'gbp', day: forDate, assignees: [PROMO_WEEKLY_DAILY_GURU],
      label: 'Google Business Profile refresh (' + _ym + '): post upcoming Special Events, update photos, reply to new reviews \u2014 this is what shows next to the map pin',
      links: { open: 'https://business.google.com/' },
      done: false
    });
  }

  // 4) Volume One listings — standing until done, regardless of event date.
  //    One task per special EVENT (not per occurrence); link opens its details.
  const standing = [];
  const seen = new Set();
  for (const { e, date } of specialOccs.sort((a, b) => a.date < b.date ? -1 : 1)) {
    if (date < forDate || seen.has(e.id)) continue;
    seen.add(e.id);
    if (!planOn(e, 'volumeone')) continue;
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

    // 1b) NEW special events (created on/after POSTER_SINCE, and not a copy —
    //     i.e. no earlier event shares its title, so extended series don't
    //     re-trigger): identify the Discord channels for discussion & promotion.
    if (isSpecial(e) && (createdAt[e.id] || '') >= POSTER_SINCE && !(e.discordChannels || []).length) {
      const isCopy = events.some(x => x.id !== e.id && x.title === e.title && (createdAt[x.id] || '') < (createdAt[e.id] || ''));
      if (!isCopy) {
        const did = 'dchan:' + e.id;
        if (!done.has(did)) {
          standing.push({
            id: did, kind: 'dchan', day: forDate, assignees: assigneesFor(e.id),
            label: 'Set the Discord channel(s) for "' + e.title + '" — check them off in the event editor; this task clears itself once set',
            links: { edit: BASE + '/booking.html?editEvent=' + encodeURIComponent(e.id), discord: DISCORD_URL, details: eventUrl(e, nextOcc) },
            event: { id: e.id, title: e.title, occDate: nextOcc },
            done: false
          });
        }
      }
    }

    // 2) NEW events (created on/after POSTER_SINCE): design, print & display a poster.
    if ((createdAt[e.id] || '') >= POSTER_SINCE && planOn(e, 'poster')) {
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

  return { date: forDate, today, overdue, standing: monthly.concat(standing), gurus };
}

/* Per-Guru digest filtering: a result narrowed to tasks assigned to any of
 * the given Gurus (used for the individual daily emails). */
export function filterForGurus(result, gurus) {
  const f = t => (t.assignees || []).some(g => gurus.indexOf(g) >= 0);
  return { ...result, today: result.today.filter(f), overdue: result.overdue.filter(f), standing: result.standing.filter(f) };
}

/* ---------- plain-text digest body (daily email) ---------- */
export function digestBody(result) {
  const L = [];
  const line = t => '  • ' + t.label + ((t.assignees && t.assignees.length) ? ('  [' + t.assignees.join(' + ') + ']') : '') + ((t.kind === 'weekly' || t.kind === 'daily' || t.kind === 'cd') ? '  · + share to applicable FB groups' : '') + (t.flag ? '  · 🚫 no EC Board Game Group' : '') + (t.done ? '  ✅' : '');
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
