// netlify/functions/schedule.mjs — NGH-BUILD 2026-09-12q
//
// One read for the whole schedule.
//
//   GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD   (admin Bearer)
//   GET /api/schedule?date=YYYY-MM-DD                 single day
//   GET /api/schedule?week=YYYY-MM-DD                 the Mon–Sun week containing that date
//
// Returns the fully merged, normalized payload from _shared/schedule-core.mjs:
// every event, booking (approved AND pending), birthday request, blackout,
// store shift, unavailability and committed off-site event in the window,
// plus per-day guru lanes, room lanes, floor-coverage gaps and conflicts.
//
// WHY THE MERGE HAPPENS HERE AND NOT IN THE PAGE
//
// The guru-* pages are deliberately plain ES5 with no build step and no module
// loader, so they cannot import a shared module. Every previous attempt to
// share scheduling logic with them ended in a copy-paste — the repo already
// carried five separate reimplementations of recurrence expansion, which is
// exactly how the Guru Schedule and the booking console drifted into
// disagreeing about what was on the calendar. Doing the merge server-side
// means one implementation, one set of tests, and a page that only draws.
//
// Read-only. Every mutation still goes to its own endpoint: /bookings,
// /events, /gurus, /birthday, /interest-events.
import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { buildSchedule, addDays, dowOf, DEFAULT_STORE_HOURS } from './_shared/schedule-core.mjs';

export const DEFAULT_ROSTER = ['Dustin', 'Mike', 'Chad', 'Jen', 'Sarah', 'Kyle', 'Zach'];
export const STORE_HOURS_ID = 'STORE-HOURS';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// Monday-anchored week containing `date`. The shop thinks in Mon–Sun weeks;
// Date#getDay is Sunday-anchored, hence the shuffle.
export function weekBounds(date) {
  const dow = dowOf(date);
  const back = dow === 0 ? 6 : dow - 1;
  const from = addDays(date, -back);
  return { from, to: addDays(from, 6) };
}

// Never let a caller ask for a decade. 92 days is a full quarter, which is the
// widest anyone plans over, and it keeps one response inside a sane size.
export function resolveRange(params) {
  const get = (k) => (params.get(k) || '').trim();
  if (YMD.test(get('week'))) return weekBounds(get('week'));
  if (YMD.test(get('date'))) return { from: get('date'), to: get('date') };
  const from = get('from'), to = get('to');
  if (!YMD.test(from)) return { error: 'from must be YYYY-MM-DD (or pass week= / date=)' };
  if (!YMD.test(to)) return { from, to: addDays(from, 6) };
  if (to < from) return { error: 'to is before from' };
  if (addDays(from, 92) < to) return { error: 'range too wide — 92 days maximum' };
  return { from, to };
}

export async function loadSources(sqlFn) {
  // birthday_requests and interest_events may not exist until the first record
  // is created, and guru_data may not exist on a fresh install. A missing
  // optional table must degrade to an empty list, never a 500 — a schedule
  // that half-loads is far more useful than one that refuses to.
  const soft = async (fn, label) => {
    try { return await fn(); }
    catch (e) { console.warn('[schedule] optional source unavailable: ' + label, e && e.message); return []; }
  };
  const [bk, ev, bo, gd, bd, ie] = await Promise.all([
    soft(() => sqlFn`SELECT data FROM bookings WHERE status <> 'rejected'`, 'bookings'),
    soft(() => sqlFn`SELECT data FROM events`, 'events'),
    soft(() => sqlFn`SELECT data FROM blackouts WHERE id = 1`, 'blackouts'),
    soft(() => sqlFn`SELECT kind, data FROM guru_data`, 'guru_data'),
    soft(() => sqlFn`SELECT data FROM birthday_requests`, 'birthday_requests'),
    soft(() => sqlFn`SELECT data FROM interest_events`, 'interest_events')
  ]);

  const assignments = [], shifts = [], unavail = [];
  let hours = null;
  for (const r of gd) {
    if (!r || !r.data) continue;
    if (r.kind === 'assignment') assignments.push(r.data);
    else if (r.kind === 'shift') shifts.push(r.data);
    else if (r.kind === 'unavail') unavail.push(r.data);
    else if (r.kind === 'hours') hours = r.data;
  }
  return {
    bookings: bk.map(r => r.data).filter(Boolean),
    events: ev.map(r => r.data).filter(Boolean),
    blackouts: (bo[0] && bo[0].data) || [],
    birthdays: bd.map(r => r.data).filter(Boolean),
    interest: ie.map(r => r.data).filter(Boolean),
    assignments, shifts, unavail,
    hours: hours || DEFAULT_STORE_HOURS
  };
}

// Everyone the calendar should show a lane for, whether or not they are busy.
export function rosterFrom(src, extra) {
  const seen = [];
  const push = (n) => { const s = String(n || '').trim(); if (s && seen.indexOf(s) < 0) seen.push(s); };
  (extra && extra.length ? extra : DEFAULT_ROSTER).forEach(push);
  (src.shifts || []).forEach(s => push(s && s.guru));
  (src.unavail || []).forEach(u => push(u && u.guru));
  (src.assignments || []).forEach(a => (a && a.gurus || []).forEach(push));
  return seen;
}

export default async (req) => {
  try { return await handler(req); }
  catch (e) {
    console.error('[schedule] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'GET') return bad('Method not allowed', 405);
  if (!requireAdmin(req)) return bad('unauthorized', 401);

  const url = new URL(req.url);
  const range = resolveRange(url.searchParams);
  if (range.error) return bad(range.error, 400);

  await ensureSchema();
  const src = await loadSources(sql);

  const rosterParam = (url.searchParams.get('roster') || '').split(',').map(s => s.trim()).filter(Boolean);
  const out = buildSchedule({
    from: range.from, to: range.to,
    roster: rosterFrom(src, rosterParam),
    hours: src.hours,
    events: src.events,
    bookings: src.bookings,
    birthdays: src.birthdays,
    blackouts: src.blackouts,
    shifts: src.shifts,
    unavail: src.unavail,
    interest: src.interest,
    assignments: src.assignments
  });
  out.generatedAt = new Date().toISOString();
  return json(out);
};
