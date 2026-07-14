// netlify/functions/_shared/conflicts.mjs
// Room-conflict detection shared by bookings.mjs (booking requests) and
// events.mjs (admin event creation/edit).
//
//   RED    = hard overlap: the same room is claimed by two things at once.
//   TIGHT  = back-to-back: a room's reservations have < MIN_GAP_MINS of
//            changeover margin between them (yellow warning; can proceed
//            with an explicit allowTight flag).
//
// Semantics mirror the front-end (booking.html):
//   • bookings hold their listed rooms; rejected/canceled don't block
//   • events hold their listed rooms; offsite events hold NOTHING;
//     an event with no rooms listed (and not offsite) holds ALL rooms
//   • all-day items hold 00:00–24:00
//   • overnight events (end <= start) spill their tail into the next day
//   • recurrence is expanded (weekly / biweekly / monthly), honoring
//     the `exceptions` date list

export const ROOM_IDS = ['holt', 'den', 'depths'];
export const MIN_GAP_MINS = 15;

export function toMins(t) { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); }
export function fmtT(mins) {
  let h = Math.floor(mins / 60), m = mins % 60;
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12; if (h === 0) h = 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
export function roomLabel(id) { return ({ holt: 'The Holt', den: "Stash's Den", depths: 'The Depths' })[id] || id; }

function overlap(a1, a2, b1, b2) { return a1 < b2 && b1 < a2; }
function addDays(d, n) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }
function addMonths(d, n) { const x = new Date(d + 'T12:00:00'); x.setMonth(x.getMonth() + n); return x.toISOString().slice(0, 10); }
function prevYMD(d) { return addDays(d, -1); }

export function eventRoomsOf(e) {
  if (e && e.offsite) return [];                                   // offsite holds nothing
  return (e && e.rooms && e.rooms.length) ? e.rooms : ROOM_IDS;    // unset = whole venue
}

// Expand a recurring event/blackout into per-date copies (honors exceptions).
export function expandOccurrences(e) {
  if (!e) return [];
  if (!e.recurrence) return [e];
  const out = [];
  const freq = e.recurrence.freq, count = Math.min(60, parseInt(e.recurrence.count, 10) || 1);
  let cur = e.date;
  for (let i = 0; i < count; i++) {
    out.push({ ...e, date: cur });
    cur = freq === 'weekly' ? addDays(cur, 7)
        : freq === 'biweekly' ? addDays(cur, 14)
        : addMonths(e.date, i + 1);
  }
  const exc = e.exceptions || [];
  return exc.length ? out.filter(o => exc.indexOf(o.date) < 0) : out;
}

// Busy intervals for ONE calendar date, keyed by room id.
// blockers: { bookings:[...], events:[...], blackouts:[...] } raw rows.
// opts: { ignoreBookingId, ignoreEventId, includeBlackouts (default true) }
export function busyByRoom(date, blockers, opts = {}) {
  const byRoom = {}; ROOM_IDS.forEach(id => { byRoom[id] = []; });
  const add = (room, s, e, kind, label, id) => { if (byRoom[room]) byRoom[room].push({ s, e, kind, label, id }); };

  for (const r of (blockers.bookings || [])) {
    if (!r || r.status === 'rejected' || r.status === 'canceled') continue;
    if (r.date !== date) continue;
    if (opts.ignoreBookingId && r.id === opts.ignoreBookingId) continue;
    const rs = toMins(r.start), re = Math.min(rs + (Number(r.hours) || 1) * 60, 1440);
    for (const room of (r.rooms && r.rooms.length ? r.rooms : ROOM_IDS)) {
      add(room, rs, re, 'booking', ((r.status === 'pending' || r.status === 'hold') ? 'Pending booking' : 'Booking') + (r.name ? ' · ' + r.name : ''), r.id);
    }
  }

  for (const raw of (blockers.events || [])) {
    if (opts.ignoreEventId && raw.id === opts.ignoreEventId) continue;
    const rooms = eventRoomsOf(raw);
    if (!rooms.length) continue;                                   // offsite
    for (const e of expandOccurrences(raw)) {
      const label = (e.private ? 'Private event' : ('NGH event: ' + (e.title || 'Scheduled event')));
      if (e.allDay) {
        if (e.date !== date) continue;
        rooms.forEach(room => add(room, 0, 1440, 'event', label + ' (all day)', e.id));
        continue;
      }
      if (!e.start || !e.end) continue;
      const es = toMins(e.start), ee = toMins(e.end), overnight = ee <= es;
      if (e.date === date) rooms.forEach(room => add(room, es, overnight ? 1440 : ee, 'event', label, e.id));
      if (overnight && e.date === prevYMD(date)) rooms.forEach(room => add(room, 0, ee, 'event', label + ' (overnight)', e.id));
    }
  }

  if (opts.includeBlackouts !== false) {
    for (const raw of (blockers.blackouts || [])) {
      for (const b of expandOccurrences(raw)) {
        if (b.date !== date) continue;
        const bs = b.allDay ? 0 : toMins(b.start), be = b.allDay ? 1440 : toMins(b.end);
        const rooms = (b.rooms && b.rooms.length) ? b.rooms : ROOM_IDS;
        rooms.forEach(room => add(room, bs, be, 'blackout', 'Blackout' + (b.reason ? ' · ' + b.reason : '') + (b.label ? ' · ' + b.label : ''), null));
      }
    }
  }
  return byRoom;
}

// Check ONE window (date, startM–endM, rooms) against blockers.
// Returns { red:[{room,label,win}], tight:[{room,label,gap,win}] }.
export function checkWindow({ date, startM, endM, rooms }, blockers, opts = {}) {
  const gapMin = opts.minGapMins != null ? opts.minGapMins : MIN_GAP_MINS;
  const byRoom = busyByRoom(date, blockers, opts);
  const endCk = Math.min(endM, 1440);
  const red = [], tight = [];
  for (const room of (rooms && rooms.length ? rooms : ROOM_IDS)) {
    for (const iv of (byRoom[room] || [])) {
      if (overlap(startM, endCk, iv.s, iv.e)) {
        red.push({ room, label: iv.label, kind: iv.kind, win: fmtT(iv.s) + '–' + fmtT(iv.e) });
        continue;
      }
      if (iv.kind === 'blackout') continue;                        // no margin needed vs closures
      const gapAfter = iv.s - endCk;                               // they start after we end
      const gapBefore = startM - iv.e;                             // they end before we start
      const gap = (gapAfter >= 0 && gapAfter < gapMin) ? gapAfter
                : (gapBefore >= 0 && gapBefore < gapMin) ? gapBefore : null;
      if (gap !== null) tight.push({ room, label: iv.label, kind: iv.kind, gap, win: fmtT(iv.s) + '–' + fmtT(iv.e) });
    }
  }
  return { red, tight };
}

export function describe(list) {
  return list.map(c => roomLabel(c.room) + ': ' + c.label + ' (' + c.win + ')').join('; ');
}

// Load all blockers from the database in one shot.
export async function loadBlockers(sql) {
  const [bk, ev, bo] = await Promise.all([
    sql`SELECT data FROM bookings WHERE status <> 'rejected'`,
    sql`SELECT data FROM events`,
    sql`SELECT data FROM blackouts WHERE id = 1`
  ]);
  return {
    bookings: bk.map(r => r.data),
    events: ev.map(r => r.data),
    blackouts: (bo[0] && bo[0].data) || []
  };
}
