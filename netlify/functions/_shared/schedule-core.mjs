// netlify/functions/_shared/schedule-core.mjs — NGH-BUILD 2026-09-12q
//
// The merge engine behind the Master Guru Calendar.
//
// Every scheduling fact at NGH lives in a different table with a different
// shape, a different idea of time, and — until now — a different calendar page
// that could see it. This module turns all of them into ONE normalized item
// type so a single view can answer the questions that actually matter on a
// Tuesday: who is in the building, what room is that party in, is anybody
// covering the register at four, and is Chad double-booked.
//
// Sources folded in here:
//   events            NGH events, incl. offsite ones          (recurring)
//   bookings          private room bookings, incl. PENDING    (one-off)
//   birthday_requests party requests not yet turned into a booking
//   blackouts         closures                                 (recurring)
//   guru_data shift   a guru on the retail floor               (recurring)
//   guru_data unavail a guru who cannot work                   (date span)
//   guru_data hours   the store-hours template                 (weekly + overrides)
//   interest-events   third-party events off-site (card shows, the Plus)
//
// DESIGN NOTES
//
// 1. THIS FILE IS PURE. No database, no fetch, no Date.now() except where a
//    caller passes the clock in. That is what makes the whole calendar
//    testable — see tests/schedule-core.test.mjs.
//
// 2. RECURRENCE IS NOT REIMPLEMENTED. expandOccurrences() from conflicts.mjs
//    is the one true rule for events and blackouts, monthly modes and all.
//    There were already five divergent copies of that logic in the repo; this
//    module deliberately does not add a sixth.
//
// 3. AN OCCURRENCE IS NOT ADDRESSABLE in the underlying data — a recurring
//    event is one row with one id. Everything downstream therefore keys on
//    `kind:id|date`, which is the convention the rest of the codebase already
//    uses for assignment overrides, run-sheets and cancelled occurrences.
//
// 4. MINUTES, NOT STRINGS. Times arrive as "HH:MM" and leave as integer
//    minutes from midnight (sMin/eMin) so the renderer never parses. All-day
//    items are 0..1440. Overnight items (end <= start) are clamped at midnight
//    and re-emitted on the following day as a tail, the same way the conflict
//    engine handles them.
import { toMins, fmtT, roomLabel, ROOM_IDS, eventRoomsOf, expandOccurrences } from './conflicts.mjs';

export { toMins, fmtT, roomLabel };

// The front end knows five rooms; the server conflict engine only ever knew
// three, so a booking in the Lodge or the Rest was invisible to it. The master
// calendar shows all five — a room that can be reserved is a room that belongs
// on the schedule.
export const ALL_ROOMS = [
  { id: 'holt', label: 'The Holt' },
  { id: 'den', label: "Stash's Den" },
  { id: 'depths', label: 'The Depths' },
  { id: 'lodge', label: 'The Lodge', vrbo: true },
  { id: 'rest', label: "The Adventurer's Rest", vrbo: true }
];
export const ALL_ROOM_IDS = ALL_ROOMS.map(r => r.id);
export function anyRoomLabel(id) {
  const m = ALL_ROOMS.find(r => r.id === id);
  return m ? m.label : roomLabel(id);
}

export const DEFAULT_STORE_HOURS = {
  // Index 0 = Sunday, matching Date#getDay. Empty until somebody fills it in;
  // a closed day and an unconfigured day are NOT the same thing and the UI
  // must be able to tell them apart, hence the explicit `closed` flag.
  weekly: [
    { closed: true, open: '', close: '' },
    { closed: true, open: '', close: '' },
    { closed: true, open: '', close: '' },
    { closed: true, open: '', close: '' },
    { closed: true, open: '', close: '' },
    { closed: true, open: '', close: '' },
    { closed: true, open: '', close: '' }
  ],
  overrides: [],          // [{date, closed, open, close, label}]
  configured: false
};

const pad = (n) => (n < 10 ? '0' : '') + n;
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
export function dowOf(dateStr) { return new Date(dateStr + 'T12:00:00').getDay(); }
export function eachDate(from, to) {
  const out = [];
  if (!from || !to || to < from) return out;
  for (let d = from, guard = 0; d <= to && guard < 400; d = addDays(d, 1), guard++) out.push(d);
  return out;
}
function inWin(d, from, to) { return !!d && d >= from && d <= to; }
function clampMin(n) { return Math.max(0, Math.min(1440, n | 0)); }
function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }
function uniq(list) { return list.filter((v, i) => list.indexOf(v) === i); }

// ---------------------------------------------------------------------------
// Assignments. A record with date:null covers every occurrence; a record with
// a date overrides it for that one date. Four separate copies of this rule
// existed in the repo; this is the one the calendar uses.
export function assignmentFor(assignments, field, refId, date) {
  if (!refId) return null;
  const mine = (assignments || []).filter(a => a && a[field] === refId);
  const exact = mine.find(a => a.date === date);
  if (exact) return exact;
  return mine.find(a => a.date == null) || null;
}
function gurusFrom(a) { return a && !a.none && Array.isArray(a.gurus) ? a.gurus.slice() : []; }

// ---------------------------------------------------------------------------
// Store hours for one date. An override wins outright; otherwise the weekly
// template applies. Returns `configured:false` when nobody has set hours up,
// so the UI can say "hours not set" rather than silently implying "closed".
export function storeHoursFor(date, hours) {
  const H = hours || DEFAULT_STORE_HOURS;
  const ov = (H.overrides || []).find(o => o && o.date === date);
  if (ov) {
    if (ov.closed || !ov.open || !ov.close) {
      return { date, closed: true, sMin: null, eMin: null, label: ov.label || 'Closed', source: 'override', configured: true };
    }
    return { date, closed: false, sMin: toMins(ov.open), eMin: toMins(ov.close), label: ov.label || '', source: 'override', configured: true };
  }
  const w = (H.weekly || [])[dowOf(date)];
  if (!H.configured || !w) return { date, closed: false, sMin: null, eMin: null, label: '', source: 'unset', configured: false };
  if (w.closed || !w.open || !w.close) {
    return { date, closed: true, sMin: null, eMin: null, label: w.label || 'Closed', source: 'weekly', configured: true };
  }
  return { date, closed: false, sMin: toMins(w.open), eMin: toMins(w.close), label: w.label || '', source: 'weekly', configured: true };
}

// ---------------------------------------------------------------------------
// Normalizers. Each returns a flat array of items; each item is self-contained
// so the renderer never has to look anything up.

function item(o) {
  const allDay = !!o.allDay;
  const sMin = allDay ? 0 : clampMin(o.sMin);
  let eMin = allDay ? 1440 : clampMin(o.eMin);
  if (!allDay && eMin <= sMin) eMin = 1440;      // overnight: clamp, tail emitted separately
  return {
    key: o.kind + ':' + o.id + '|' + o.date + (o.tail ? '#tail' : ''),
    kind: o.kind,
    id: o.id,
    date: o.date,
    allDay,
    sMin, eMin,
    start: allDay ? null : fmtT(sMin),
    end: allDay ? null : fmtT(eMin),
    tail: !!o.tail,
    title: o.title || '',
    sub: o.sub || '',
    rooms: o.rooms || [],
    offsite: !!o.offsite,
    location: o.location || '',
    gurus: o.gurus || [],
    guruNeed: o.guruNeed == null ? null : o.guruNeed,
    status: o.status || '',
    tone: o.tone || 'confirmed',
    recurring: !!o.recurring,
    holdsRooms: o.holdsRooms !== false && (o.rooms || []).length > 0,
    meta: o.meta || {}
  };
}

// Emit the item for `date`, plus its overnight tail on the following day when
// the window is long enough to include it.
//
// The two source shapes disagree about what "overnight" looks like, so both
// are handled here rather than at every call site:
//   bookings  start + hours, which can run PAST 1440 (22:00 + 5h = 1620)
//   events    an explicit end that WRAPS below the start (22:00 → 03:00)
function withTail(base, from, to, out) {
  const raw = base;
  if (inWin(raw.date, from, to)) out.push(item(raw));
  if (raw.allDay) return;
  const s = raw.sMin | 0, e = raw.eMin | 0;
  const tailEnd = e > 1440 ? e - 1440 : (e <= s ? e : 0);
  if (tailEnd <= 0) return;                           // not overnight
  const next = addDays(raw.date, 1);
  if (!inWin(next, from, to)) return;
  out.push(item({ ...raw, date: next, sMin: 0, eMin: tailEnd, tail: true }));
}

export function normalizeEvents(events, assignments, from, to) {
  const out = [];
  for (const raw of (events || [])) {
    if (!raw || !raw.id) continue;
    for (const e of expandOccurrences(raw)) {
      if (!inWin(e.date, from, addDays(to, 1))) continue;   // +1 so a tail can land in-window
      const a = assignmentFor(assignments, 'eventId', e.id, e.date);
      const rooms = raw.offsite ? [] : eventRoomsOf(raw);
      const wholeVenue = !raw.offsite && !(raw.rooms && raw.rooms.length);
      withTail({
        kind: 'event', id: e.id, date: e.date,
        allDay: !!e.allDay, sMin: toMins(e.start), eMin: toMins(e.end || e.start),
        title: e.title || 'Untitled event',
        sub: raw.offsite ? (e.offsiteLocation || 'Offsite') : (wholeVenue ? 'Whole venue' : rooms.map(anyRoomLabel).join(', ')),
        rooms, offsite: !!raw.offsite, location: e.offsiteLocation || '',
        gurus: gurusFrom(a),
        status: e.status || 'live',
        tone: e.status === 'draft' ? 'tentative' : 'confirmed',
        recurring: !!raw.recurrence,
        meta: {
          private: !!e.private, draft: e.status === 'draft', wholeVenue,
          assignedNone: !!(a && a.none), assignmentId: a ? a.id : null,
          assignmentScope: a ? (a.date ? 'occurrence' : 'series') : null,
          registration: e.registration && e.registration.enabled
            ? { min: e.registration.min || 0, max: e.registration.max || 0 } : null
        }
      }, from, to, out);
    }
  }
  return out;
}

// Bookings. THE POINT OF THIS WHOLE EXERCISE: pending bookings are real. A
// request that has not been approved yet still tells you the room may be
// spoken for, and it has never appeared on the Guru Schedule at all.
export function normalizeBookings(bookings, assignments, from, to, opts = {}) {
  const keep = opts.statuses || ['approved', 'pending', 'hold'];
  const out = [];
  for (const b of (bookings || [])) {
    if (!b || !b.id || !b.date) continue;
    if (keep.indexOf(b.status) < 0) continue;
    if (!inWin(b.date, from, addDays(to, 1))) continue;
    const a = assignmentFor(assignments, 'bookingId', b.id, b.date);
    const sMin = toMins(b.start);
    const eMin = sMin + Math.round((Number(b.hours) || 1) * 60);
    const guruAddon = (b.addons || []).find(x => x && x.id === 'guru');
    const need = guruAddon ? Math.max(1, parseInt(guruAddon.qty, 10) || 1) : null;
    withTail({
      kind: 'booking', id: b.id, date: b.date,
      allDay: false, sMin, eMin,
      title: b.name || 'Private booking',
      sub: (b.rooms || []).map(anyRoomLabel).join(', ') || 'Room TBD',
      rooms: (b.rooms || []).slice(),
      gurus: gurusFrom(a),
      guruNeed: need,
      status: b.status,
      tone: b.status === 'approved' ? 'confirmed' : 'tentative',
      meta: {
        guests: b.guests || null, phone: b.phone || '', email: b.email || '',
        feePaid: b.feePaid === true || b.payment === 'paid',
        depositPaid: b.depositPaid === true || b.payment === 'paid',
        onAccount: b.payment === 'onaccount',
        birthday: !!b.birthdayParty,
        guruReach: !!b.guruReach,
        guruNotGuaranteed: !!b.guruNotGuaranteed,
        groupId: b.groupId || null, recIndex: b.recIndex || null, recTotal: b.recTotal || null,
        assignedNone: !!(a && a.none), assignmentId: a ? a.id : null,
        comments: b.comments || ''
      }
    }, from, to, out);
  }
  return out;
}

// Birthday requests that have NOT yet been turned into a booking. Once
// `linkedBookingId` is set the booking carries the party, and showing both
// would double-book the room on screen.
export function normalizeBirthdays(bdays, assignments, from, to) {
  const dead = ['declined', 'archived', 'canceled', 'cancelled'];
  const out = [];
  for (const r of (bdays || [])) {
    if (!r || !r.id || !r.date) continue;
    if (r.linkedBookingId) continue;
    if (dead.indexOf(String(r.status || '').toLowerCase()) >= 0) continue;
    if (!inWin(r.date, from, to)) continue;
    const a = assignmentFor(assignments, 'birthdayId', r.id, r.date);
    const sMin = r.time ? toMins(r.time) : 0;
    out.push(item({
      kind: 'birthday', id: r.id, date: r.date,
      allDay: !r.time, sMin, eMin: r.time ? sMin + 180 : 1440,   // parties are booked as 3h
      title: (r.heroName ? r.heroName + "'s party" : 'Birthday party'),
      sub: (r.package || 'Party') + (r.audience ? ' · ' + r.audience : ''),
      rooms: [],
      gurus: gurusFrom(a),
      status: r.status || 'new',
      tone: r.status === 'confirmed' ? 'confirmed' : 'tentative',
      meta: {
        requestOnly: true, guests: r.guests || null, heroAge: r.heroAge || null,
        contact: r.name || '', email: r.email || '', phone: r.phone || '',
        assignmentId: a ? a.id : null, notes: r.notes || ''
      }
    }));
  }
  return out;
}

export function normalizeBlackouts(blackouts, from, to) {
  const out = [];
  for (const raw of (blackouts || [])) {
    if (!raw) continue;
    for (const b of expandOccurrences(raw)) {
      if (!inWin(b.date, from, to)) continue;
      const rooms = (b.rooms && b.rooms.length) ? b.rooms : ROOM_IDS;
      out.push(item({
        kind: 'blackout', id: b.id || ('BO-' + b.date), date: b.date,
        allDay: !!b.allDay, sMin: toMins(b.start), eMin: toMins(b.end),
        title: b.label || b.reason || 'Closed',
        sub: rooms.length === ROOM_IDS.length ? 'All rooms' : rooms.map(anyRoomLabel).join(', '),
        rooms, tone: 'blocked', recurring: !!raw.recurrence,
        meta: {}
      }));
    }
  }
  return out;
}

// Shifts use their own weaker recurrence (no monthly mode, no exceptions) —
// that is how they are stored, so that is how they expand. Reproduced here
// rather than routed through expandOccurrences because the shapes differ.
export function shiftDates(s, from, to) {
  if (!s || !s.date) return [];
  const out = [];
  const freq = s.recurrence && s.recurrence.freq;
  const count = s.recurrence ? Math.max(1, Math.min(60, parseInt(s.recurrence.count, 10) || 1)) : 1;
  let cur = s.date;
  for (let i = 0; i < count; i++) {
    if (cur > to) break;
    if (cur >= from) out.push(cur);
    cur = freq === 'weekly' ? addDays(cur, 7)
      : freq === 'biweekly' ? addDays(cur, 14)
        : freq === 'monthly' ? addDays(cur, 28)
          : null;
    if (!cur) break;
  }
  return out;
}

export function normalizeShifts(shifts, from, to) {
  const out = [];
  for (const s of (shifts || [])) {
    if (!s || !s.guru) continue;
    for (const d of shiftDates(s, from, to)) {
      out.push(item({
        kind: 'shift', id: s.id + '@' + d, date: d,
        allDay: false, sMin: toMins(s.open), eMin: toMins(s.close),
        title: s.guru, sub: 'Retail store',
        gurus: [s.guru], rooms: [],
        tone: 'info', recurring: !!(s.recurrence && s.recurrence.freq),
        meta: { shiftId: s.id, notes: s.notes || '' }
      }));
    }
  }
  return out;
}

// Unavailability is a date SPAN, not a recurrence — one record can cover a
// week off. There is deliberately no recurring unavailability in the data
// model, so "every Tuesday off" cannot be expressed; that is worth knowing
// before anyone tries to read a gap here as availability.
export function normalizeUnavail(unavail, from, to) {
  const out = [];
  for (const u of (unavail || [])) {
    if (!u || !u.guru || !u.date) continue;
    const last = u.endDate || u.date;
    for (const d of eachDate(u.date > from ? u.date : from, last < to ? last : to)) {
      if (d < u.date || d > last) continue;
      out.push(item({
        kind: 'unavail', id: u.id + '@' + d, date: d,
        allDay: !!u.allDay, sMin: toMins(u.start), eMin: toMins(u.end),
        title: u.guru, sub: u.notes || 'Unavailable',
        gurus: [u.guru], rooms: [],
        tone: 'blocked',
        meta: { unavailId: u.id, notes: u.notes || '', spanStart: u.date, spanEnd: last }
      }));
    }
  }
  return out;
}

// Third-party events NGH is watching, vending at or attending. Their
// recurrence model is completely different from everything else — a date span
// plus an optional "repeat weekly until" — so it expands separately.
export function normalizeExternal(interest, assignments, from, to, opts = {}) {
  const show = opts.statuses || ['committed', 'considering'];
  const out = [];
  for (const r of (interest || [])) {
    if (!r || !r.id || !r.date) continue;
    if (show.indexOf(r.status) < 0) continue;
    if (r.linkedEventId) continue;              // it became a real NGH event; that record wins
    const spans = [];
    const runEnd = r.endDate && r.endDate > r.date ? r.endDate : r.date;
    let anchor = r.date, anchorEnd = runEnd, guard = 0;
    do {
      spans.push([anchor, anchorEnd]);
      if (!r.repeatWeeklyUntil) break;
      anchor = addDays(anchor, 7); anchorEnd = addDays(anchorEnd, 7);
    } while (anchor <= r.repeatWeeklyUntil && ++guard < 60);
    for (const [s0, e0] of spans) {
      for (const d of eachDate(s0 < from ? from : s0, e0 > to ? to : e0)) {
        if (d < s0 || d > e0) continue;
        const a = assignmentFor(assignments, 'externalId', r.id, d);
        out.push(item({
          kind: 'external', id: r.id + '@' + d, date: d,
          allDay: r.allDay !== false, sMin: toMins(r.start), eMin: toMins(r.end),
          title: r.title || 'External event',
          sub: r.location || 'Off-site',
          rooms: [], offsite: true, location: r.location || '',
          gurus: gurusFrom(a),
          status: r.status,
          tone: r.status === 'committed' ? 'confirmed' : 'tentative',
          meta: {
            externalId: r.id, category: r.category || 'other',
            supportTypes: r.supportTypes || [], contact: r.contact || '',
            sourceUrl: r.sourceUrl || '', assignmentId: a ? a.id : null
          }
        }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage. Given the store's open window and the shifts on that day, which
// stretches have somebody on the floor and which do not.
export function coverageFor(openWin, shiftItems) {
  if (!openWin || openWin.closed || openWin.sMin == null) {
    return { open: false, configured: !!(openWin && openWin.configured), covered: [], gaps: [], shifts: [] };
  }
  const spans = (shiftItems || [])
    .filter(s => s.eMin > openWin.sMin && s.sMin < openWin.eMin)
    .map(s => ({ s: Math.max(s.sMin, openWin.sMin), e: Math.min(s.eMin, openWin.eMin), guru: s.gurus[0] }))
    .sort((a, b) => a.s - b.s || a.e - b.e);

  // Sweep the open window, tracking who is on at each boundary.
  const edges = uniq([openWin.sMin, openWin.eMin].concat(
    spans.map(x => x.s), spans.map(x => x.e)
  )).filter(m => m >= openWin.sMin && m <= openWin.eMin).sort((a, b) => a - b);

  const covered = [], gaps = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1];
    if (b <= a) continue;
    const on = spans.filter(x => x.s <= a && x.e >= b).map(x => x.guru);
    const seg = { sMin: a, eMin: b, from: fmtT(a), to: fmtT(b), gurus: uniq(on) };
    (on.length ? covered : gaps).push(seg);
  }
  // Join touching segments with the same staffing so the UI shows one bar.
  const join = (list) => list.reduce((acc, seg) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.eMin === seg.sMin && prev.gurus.join('|') === seg.gurus.join('|')) {
      prev.eMin = seg.eMin; prev.to = seg.to; return acc;
    }
    acc.push(seg); return acc;
  }, []);
  return {
    open: true, configured: true,
    covered: join(covered), gaps: join(gaps),
    shifts: spans.map(x => ({ guru: x.guru, sMin: x.s, eMin: x.e }))
  };
}

// ---------------------------------------------------------------------------
// Per-guru lanes for one day: everything that occupies a named person.
export function guruLanes(dayItems, guruNames) {
  const lanes = {};
  const touch = (g) => { if (!lanes[g]) lanes[g] = []; return lanes[g]; };
  (guruNames || []).forEach(touch);
  for (const it of (dayItems || [])) {
    for (const g of it.gurus) {
      touch(g).push({
        key: it.key, kind: it.kind, title: it.title, sub: it.sub,
        allDay: it.allDay, sMin: it.sMin, eMin: it.eMin, start: it.start, end: it.end,
        tone: it.tone, offsite: it.offsite, rooms: it.rooms, status: it.status
      });
    }
  }
  Object.keys(lanes).forEach(g => lanes[g].sort((a, b) => a.sMin - b.sMin || a.eMin - b.eMin));
  return lanes;
}

// Per-room lanes for one day: what is physically happening in the building.
export function roomLanes(dayItems) {
  const lanes = {};
  ALL_ROOM_IDS.forEach(id => { lanes[id] = []; });
  lanes.offsite = [];
  for (const it of (dayItems || [])) {
    if (it.offsite) { lanes.offsite.push(it); continue; }
    for (const r of it.rooms) { if (lanes[r]) lanes[r].push(it); }
  }
  Object.keys(lanes).forEach(k => lanes[k].sort((a, b) => a.sMin - b.sMin || a.eMin - b.eMin));
  return lanes;
}

// ---------------------------------------------------------------------------
// Conflicts worth a human's attention on one day.
export function conflictsFor(date, dayItems, coverage) {
  const out = [];
  const real = (dayItems || []).filter(i => i.kind !== 'unavail' && i.kind !== 'shift' && i.kind !== 'blackout');

  // 1. A guru in two places at once.
  const byGuru = {};
  for (const it of real) for (const g of it.gurus) (byGuru[g] = byGuru[g] || []).push(it);
  for (const g of Object.keys(byGuru)) {
    const list = byGuru[g].sort((a, b) => a.sMin - b.sMin);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (overlaps(list[i].sMin, list[i].eMin, list[j].sMin, list[j].eMin)) {
        out.push({
          type: 'guru-double-booked', date, guru: g,
          a: list[i].key, b: list[j].key,
          detail: g + ' is on "' + list[i].title + '" and "' + list[j].title + '" at the same time'
        });
      }
    }
  }

  // 2. A guru assigned to something while marked unavailable. This is the one
  //    rule the server already enforces for events; here it also catches
  //    bookings, parties and offsite gigs.
  const un = (dayItems || []).filter(i => i.kind === 'unavail');
  for (const u of un) for (const it of real) {
    const g = u.gurus[0];
    if (it.gurus.indexOf(g) < 0) continue;
    if (!u.allDay && !it.allDay && !overlaps(u.sMin, u.eMin, it.sMin, it.eMin)) continue;
    out.push({
      type: 'guru-unavailable', date, guru: g, a: it.key, b: u.key,
      detail: g + ' is marked unavailable but is assigned to "' + it.title + '"'
    });
  }

  // 3. Two things claiming the same room.
  const lanes = roomLanes(real.filter(i => i.holdsRooms));
  for (const roomId of ALL_ROOM_IDS) {
    const list = lanes[roomId] || [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (overlaps(list[i].sMin, list[i].eMin, list[j].sMin, list[j].eMin)) {
        out.push({
          type: 'room-double-booked', date, room: roomId,
          a: list[i].key, b: list[j].key,
          detail: anyRoomLabel(roomId) + ': "' + list[i].title + '" overlaps "' + list[j].title + '"'
        });
      }
    }
  }

  // 4. A booking that bought Gurus and hasn't been given any.
  for (const it of real) {
    if (it.guruNeed && it.gurus.length < it.guruNeed) {
      out.push({
        type: 'guru-understaffed', date, a: it.key,
        detail: it.title + ' needs ' + it.guruNeed + ' Guru' + (it.guruNeed > 1 ? 's' : '') +
          ' and has ' + (it.gurus.length || 'none') + ' assigned'
      });
    }
  }

  // 5. The store is open with nobody rostered on the floor.
  //
  // "Nobody on the floor" and "nobody in the building" are different problems,
  // and conflating them buries the real one. A Tuesday where Chad is running
  // Gundam night in the Holt is not an empty shop — it is an unrostered shop,
  // which usually just means the shift was never written down. So each gap
  // carries who is actually on site during it, and the wording follows.
  for (const gap of ((coverage && coverage.gaps) || [])) {
    const inBuilding = uniq(real
      .filter(i => !i.offsite && i.gurus.length && (i.allDay || (i.sMin < gap.eMin && gap.sMin < i.eMin)))
      .reduce((acc, i) => acc.concat(i.gurus.map(g => ({ guru: g, what: i.title, key: i.key }))), [])
      .map(x => JSON.stringify(x))).map(s => JSON.parse(s));
    const names = uniq(inBuilding.map(x => x.guru));
    out.push({
      type: 'store-uncovered', date, sMin: gap.sMin, eMin: gap.eMin,
      from: gap.from, to: gap.to,
      inBuilding, unrostered: names.length > 0,
      detail: names.length
        ? 'Store open ' + gap.from + '–' + gap.to + ' with no Guru rostered on the floor — ' +
          names.join(' and ') + (names.length > 1 ? ' are' : ' is') + ' on site (' +
          uniq(inBuilding.map(x => x.what)).join(', ') + ')'
        : 'Store open ' + gap.from + '–' + gap.to + ' with nobody in the building'
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole thing. One call, one payload, one render.
export function buildSchedule(input) {
  const from = input.from, to = input.to;
  const assignments = input.assignments || [];
  const hours = input.hours || DEFAULT_STORE_HOURS;

  const all = []
    .concat(normalizeEvents(input.events, assignments, from, to))
    .concat(normalizeBookings(input.bookings, assignments, from, to, { statuses: input.bookingStatuses }))
    .concat(normalizeBirthdays(input.birthdays, assignments, from, to))
    .concat(normalizeBlackouts(input.blackouts, from, to))
    .concat(normalizeShifts(input.shifts, from, to))
    .concat(normalizeUnavail(input.unavail, from, to))
    .concat(normalizeExternal(input.interest, assignments, from, to, { statuses: input.externalStatuses }));

  const guruNames = uniq(
    (input.roster || []).concat(
      all.reduce((acc, i) => acc.concat(i.gurus), [])
    ).filter(Boolean)
  ).sort((a, b) => {
    const ra = (input.roster || []).indexOf(a), rb = (input.roster || []).indexOf(b);
    if (ra >= 0 && rb >= 0) return ra - rb;
    if (ra >= 0) return -1;
    if (rb >= 0) return 1;
    return a.localeCompare(b);
  });

  const byDate = {};
  all.forEach(i => { (byDate[i.date] = byDate[i.date] || []).push(i); });

  const days = eachDate(from, to).map(date => {
    const items = (byDate[date] || []).sort((a, b) =>
      (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || a.sMin - b.sMin || a.eMin - b.eMin);
    const openWin = storeHoursFor(date, hours);
    const cover = coverageFor(openWin, items.filter(i => i.kind === 'shift'));
    return {
      date, dow: dowOf(date),
      hours: openWin,
      coverage: cover,
      items,
      guruLanes: guruLanes(items, guruNames),
      roomLanes: roomLanes(items),
      conflicts: conflictsFor(date, items, cover)
    };
  });

  // Grid bounds: never tighter than 8am–11pm, always wide enough for the day.
  //
  // Overnight TAILS are deliberately excluded. A single lock-in running to 3am
  // would otherwise drag every day's grid back to midnight and add eight empty
  // rows to all seven columns — the view becomes unreadable to show three
  // hours of one night. Tails get their own band at the top instead.
  let lo = 8 * 60, hi = 23 * 60;
  for (const d of days) {
    for (const i of d.items) {
      if (i.allDay || i.tail || i.kind === 'unavail' || i.kind === 'shift') continue;
      if (i.sMin < lo) lo = i.sMin;
      if (i.eMin > hi) hi = i.eMin;
    }
    if (d.hours && !d.hours.closed && d.hours.sMin != null) {
      if (d.hours.sMin < lo) lo = d.hours.sMin;
      if (d.hours.eMin > hi) hi = d.hours.eMin;
    }
  }
  const grid = { loMin: Math.floor(lo / 60) * 60, hiMin: Math.min(1440, Math.ceil(hi / 60) * 60) };

  return {
    from, to,
    gurus: guruNames,
    rooms: ALL_ROOMS,
    hours,
    grid,
    days,
    counts: {
      items: all.length,
      bookings: all.filter(i => i.kind === 'booking').length,
      pendingBookings: all.filter(i => i.kind === 'booking' && i.status !== 'approved').length,
      events: all.filter(i => i.kind === 'event').length,
      external: all.filter(i => i.kind === 'external').length,
      conflicts: days.reduce((n, d) => n + d.conflicts.length, 0)
    }
  };
}
