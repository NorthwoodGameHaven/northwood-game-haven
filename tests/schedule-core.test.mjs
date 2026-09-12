// NGH-BUILD 2026-09-12q
// tests/schedule-core.test.mjs — the Master Guru Calendar merge engine.
//
// Seven tables, four recurrence models, five rooms and a store-hours template
// all have to land on one grid. The failure modes here are quiet ones: a
// pending booking that doesn't render looks exactly like a free room, and a
// guru marked unavailable who still gets assigned looks exactly like a guru
// who turned up. So these tests are mostly about things that must APPEAR and
// things that must be CAUGHT, not about pixel output.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchedule, storeHoursFor, coverageFor, assignmentFor,
  normalizeEvents, normalizeBookings, normalizeBirthdays, normalizeBlackouts,
  normalizeShifts, normalizeUnavail, normalizeExternal,
  roomLanes, guruLanes, conflictsFor, eachDate, addDays, shiftDates,
  ALL_ROOM_IDS, DEFAULT_STORE_HOURS
} from '../netlify/functions/_shared/schedule-core.mjs';

const WEEK = { from: '2026-09-14', to: '2026-09-20' };   // Mon 14 → Sun 20
const HOURS = {
  configured: true,
  weekly: [
    { closed: false, open: '10:00', close: '18:00' },  // Sun
    { closed: true, open: '', close: '' },             // Mon
    { closed: false, open: '12:00', close: '20:00' },  // Tue
    { closed: false, open: '12:00', close: '20:00' },  // Wed
    { closed: false, open: '12:00', close: '20:00' },  // Thu
    { closed: false, open: '12:00', close: '23:00' },  // Fri
    { closed: false, open: '10:00', close: '23:00' }   // Sat
  ],
  overrides: []
};

const booking = (o = {}) => ({
  id: 'BK-1', name: 'Rausch', status: 'approved', date: '2026-09-16',
  start: '17:00', hours: 4, rooms: ['den'], ...o
});
const event = (o = {}) => ({
  id: 'EVT-1', title: 'FNM', date: '2026-09-18', start: '18:00', end: '22:00',
  rooms: ['holt'], status: 'live', ...o
});
const build = (o = {}) => buildSchedule({ ...WEEK, hours: HOURS, roster: ['Dustin', 'Mike', 'Jen'], ...o });
const day = (out, d) => out.days.find(x => x.date === d);
const kinds = (items) => items.map(i => i.kind);

// ---------------------------------------------------------------------------
describe('pending bookings are real and must show up', () => {
  // The Guru Schedule never loaded /bookings at all. A room could be spoken
  // for by an unapproved request and the schedule would show it empty.
  for (const status of ['approved', 'pending', 'hold']) {
    test(`a ${status} booking appears`, () => {
      const out = build({ bookings: [booking({ status })] });
      const items = day(out, '2026-09-16').items.filter(i => i.kind === 'booking');
      assert.equal(items.length, 1, status + ' bookings belong on the calendar');
      assert.equal(items[0].title, 'Rausch');
      assert.equal(items[0].status, status);
    });
  }

  test('a pending booking is marked tentative, an approved one confirmed', () => {
    const out = build({ bookings: [booking({ id: 'BK-A', status: 'approved' }), booking({ id: 'BK-P', status: 'pending', rooms: ['holt'] })] });
    const items = day(out, '2026-09-16').items.filter(i => i.kind === 'booking');
    assert.equal(items.find(i => i.id === 'BK-A').tone, 'confirmed');
    assert.equal(items.find(i => i.id === 'BK-P').tone, 'tentative');
  });

  for (const status of ['rejected', 'canceled']) {
    test(`a ${status} booking stays off`, () => {
      const out = build({ bookings: [booking({ status })] });
      assert.equal(day(out, '2026-09-16').items.filter(i => i.kind === 'booking').length, 0);
    });
  }

  test('payment state never hides a booking', () => {
    // Whether the fee or the day-of deposit is settled is a money question,
    // not a scheduling one. The room is held either way.
    const variants = [{}, { feePaid: true }, { depositPaid: true }, { payment: 'paid' }, { payment: 'onaccount' }];
    variants.forEach((v, i) => {
      const out = build({ bookings: [booking({ id: 'BK-' + i, ...v })] });
      assert.equal(day(out, '2026-09-16').items.filter(i => i.kind === 'booking').length, 1, JSON.stringify(v));
    });
  });

  test('a booking carries what a Guru needs to act on it', () => {
    const out = build({ bookings: [booking({ guests: 12, phone: '715-555-0100', depositPaid: true, addons: [{ id: 'guru', qty: 2 }] })] });
    const b = day(out, '2026-09-16').items.find(i => i.kind === 'booking');
    assert.equal(b.meta.guests, 12);
    assert.equal(b.meta.phone, '715-555-0100');
    assert.equal(b.meta.depositPaid, true);
    assert.equal(b.meta.feePaid, false);
    assert.equal(b.guruNeed, 2, 'the Guru add-on quantity is how many people are owed');
    assert.equal(b.sub, "Stash's Den");
  });

  test('duration comes from hours, not a stored end time', () => {
    const out = build({ bookings: [booking({ start: '17:00', hours: 3.5 })] });
    const b = day(out, '2026-09-16').items.find(i => i.kind === 'booking');
    assert.equal(b.sMin, 17 * 60);
    assert.equal(b.eMin, 20 * 60 + 30);
  });
});

describe('rooms', () => {
  test('the Lodge and the Rest are visible', () => {
    // The server conflict engine only ever knew three rooms, so a VRBO-space
    // booking was invisible to it. On the calendar it must not be.
    const out = build({ bookings: [booking({ rooms: ['lodge'] }), booking({ id: 'BK-2', rooms: ['rest'] })] });
    const lanes = day(out, '2026-09-16').roomLanes;
    assert.equal(lanes.lodge.length, 1);
    assert.equal(lanes.rest.length, 1);
  });

  test('an event with no rooms holds the whole venue', () => {
    const out = build({ events: [event({ rooms: [] })] });
    const e = day(out, '2026-09-18').items.find(i => i.kind === 'event');
    assert.deepEqual(e.rooms.slice().sort(), ['den', 'depths', 'holt']);
    assert.equal(e.meta.wholeVenue, true);
    assert.equal(e.sub, 'Whole venue');
  });

  test('an offsite event holds nothing and lands in the offsite lane', () => {
    const out = build({ events: [event({ offsite: true, offsiteLocation: 'The Plus, Eau Claire', rooms: [] })] });
    const d = day(out, '2026-09-18');
    const e = d.items.find(i => i.kind === 'event');
    assert.deepEqual(e.rooms, []);
    assert.equal(e.offsite, true);
    assert.equal(e.sub, 'The Plus, Eau Claire');
    assert.equal(d.roomLanes.offsite.length, 1);
    ALL_ROOM_IDS.forEach(r => assert.equal(d.roomLanes[r].length, 0, r + ' must be free'));
  });
});

describe('time', () => {
  test('an overnight booking spills a tail onto the next day', () => {
    const out = build({ bookings: [booking({ date: '2026-09-16', start: '22:00', hours: 5 })] });
    const first = day(out, '2026-09-16').items.find(i => i.kind === 'booking');
    const tail = day(out, '2026-09-17').items.find(i => i.kind === 'booking');
    assert.equal(first.eMin, 1440, 'the first night is clamped at midnight');
    assert.ok(tail, 'the tail must appear on the following day');
    assert.equal(tail.tail, true);
    assert.equal(tail.sMin, 0);
    assert.equal(tail.eMin, 180);
    assert.notEqual(first.key, tail.key, 'the two halves need distinct keys');
  });

  test('an event that wraps past midnight also spills a tail', () => {
    // Events express overnight differently from bookings: an end time BELOW
    // the start, rather than a duration that runs past 1440. Both must work.
    const out = build({ events: [event({ date: '2026-09-18', start: '21:00', end: '02:00' })] });
    assert.equal(day(out, '2026-09-18').items.find(i => i.kind === 'event').eMin, 1440);
    const tail = day(out, '2026-09-19').items.find(i => i.kind === 'event');
    assert.ok(tail && tail.tail, 'the small hours belong to the next day');
    assert.equal(tail.eMin, 120);
  });

  test('a tail outside the window is simply not emitted', () => {
    const out = build({ bookings: [booking({ date: '2026-09-20', start: '22:00', hours: 5 })] });
    assert.equal(out.days.length, 7);
    assert.equal(day(out, '2026-09-20').items.filter(i => i.kind === 'booking').length, 1);
  });

  test('an all-day item covers the whole day', () => {
    const out = build({ events: [event({ allDay: true, start: '', end: '' })] });
    const e = day(out, '2026-09-18').items.find(i => i.kind === 'event');
    assert.equal(e.sMin, 0); assert.equal(e.eMin, 1440); assert.equal(e.allDay, true);
  });

  test('all-day items sort ahead of timed ones', () => {
    const out = build({
      events: [event({ id: 'EVT-AD', allDay: true, start: '', end: '' })],
      bookings: [booking({ date: '2026-09-18', rooms: ['den'] })]
    });
    assert.equal(day(out, '2026-09-18').items[0].allDay, true);
  });

  test('the grid never squeezes an item off the edge', () => {
    const out = build({ bookings: [booking({ start: '06:00', hours: 1 })] });
    assert.ok(out.grid.loMin <= 6 * 60, 'a 6am booking must be inside the grid');
    const late = build({ events: [event({ start: '20:00', end: '23:30' })] });
    assert.ok(late.grid.hiMin >= 23 * 60 + 30);
  });

  test('open hours widen the grid even on an empty day', () => {
    const out = buildSchedule({
      from: '2026-09-19', to: '2026-09-19', hours: HOURS, roster: [],
      events: [], bookings: []
    });
    assert.ok(out.grid.hiMin >= 23 * 60, 'Friday closes at 11pm');
  });
});

describe('recurrence', () => {
  test('a weekly event repeats across the window', () => {
    const out = build({
      events: [event({ date: '2026-09-14', recurrence: { freq: 'weekly', count: 4 } })]
    });
    const hits = out.days.filter(d => d.items.some(i => i.kind === 'event'));
    assert.deepEqual(hits.map(d => d.date), ['2026-09-14'], 'only one occurrence falls inside this week');
    const wide = buildSchedule({
      from: '2026-09-14', to: '2026-10-12', hours: HOURS, roster: [],
      events: [event({ date: '2026-09-14', recurrence: { freq: 'weekly', count: 4 } })]
    });
    assert.deepEqual(
      wide.days.filter(d => d.items.length).map(d => d.date),
      ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
  });

  test('exceptions remove an occurrence', () => {
    const wide = buildSchedule({
      from: '2026-09-14', to: '2026-10-12', hours: HOURS, roster: [],
      events: [event({ date: '2026-09-14', recurrence: { freq: 'weekly', count: 4 }, exceptions: ['2026-09-21'] })]
    });
    assert.deepEqual(wide.days.filter(d => d.items.length).map(d => d.date),
      ['2026-09-14', '2026-09-28', '2026-10-05']);
  });

  test('every occurrence of a recurring event is flagged as recurring', () => {
    const out = build({ events: [event({ date: '2026-09-14', recurrence: { freq: 'weekly', count: 2 } })] });
    assert.equal(day(out, '2026-09-14').items[0].recurring, true);
  });

  test('shift recurrence expands weekly and stops at the window edge', () => {
    assert.deepEqual(
      shiftDates({ date: '2026-09-14', recurrence: { freq: 'weekly', count: 6 } }, '2026-09-14', '2026-10-05'),
      ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
  });

  test('a one-off shift yields exactly one date', () => {
    assert.deepEqual(shiftDates({ date: '2026-09-16' }, '2026-09-14', '2026-09-20'), ['2026-09-16']);
  });

  test('unavailability expands across its whole span', () => {
    const items = normalizeUnavail(
      [{ id: 'GU-1', guru: 'Jen', date: '2026-09-15', endDate: '2026-09-18', allDay: true }],
      WEEK.from, WEEK.to);
    assert.deepEqual(items.map(i => i.date), ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
    items.forEach(i => assert.deepEqual(i.gurus, ['Jen']));
  });

  test('a span reaching past the window is clipped, not dropped', () => {
    const items = normalizeUnavail(
      [{ id: 'GU-2', guru: 'Jen', date: '2026-09-01', endDate: '2026-12-01', allDay: true }],
      WEEK.from, WEEK.to);
    assert.equal(items.length, 7);
    assert.equal(items[0].date, '2026-09-14');
    assert.equal(items[6].date, '2026-09-20');
  });
});

describe('guru assignments', () => {
  const asg = [
    { id: 'GA-S', eventId: 'EVT-1', date: null, gurus: ['Dustin'] },
    { id: 'GA-O', eventId: 'EVT-1', date: '2026-09-21', gurus: ['Mike', 'Jen'] }
  ];

  test('a date-specific assignment overrides the series', () => {
    assert.equal(assignmentFor(asg, 'eventId', 'EVT-1', '2026-09-21').id, 'GA-O');
    assert.equal(assignmentFor(asg, 'eventId', 'EVT-1', '2026-09-14').id, 'GA-S');
  });

  test('the override actually changes who is shown that day', () => {
    const wide = buildSchedule({
      from: '2026-09-14', to: '2026-09-28', hours: HOURS, roster: ['Dustin', 'Mike', 'Jen'],
      assignments: asg,
      events: [event({ date: '2026-09-14', recurrence: { freq: 'weekly', count: 3 } })]
    });
    assert.deepEqual(day(wide, '2026-09-14').items[0].gurus, ['Dustin']);
    assert.deepEqual(day(wide, '2026-09-21').items[0].gurus, ['Mike', 'Jen']);
    assert.deepEqual(day(wide, '2026-09-28').items[0].gurus, ['Dustin'], 'later dates fall back to the series');
  });

  test('"none" means nobody, not unassigned', () => {
    const out = build({ events: [event()], assignments: [{ id: 'GA-N', eventId: 'EVT-1', date: null, none: true, gurus: [] }] });
    const e = day(out, '2026-09-18').items[0];
    assert.deepEqual(e.gurus, []);
    assert.equal(e.meta.assignedNone, true, 'deliberately unstaffed must be distinguishable from forgotten');
  });

  test('a booking can be assigned a guru — the thing that never existed before', () => {
    const out = build({
      bookings: [booking({ addons: [{ id: 'guru', qty: 1 }] })],
      assignments: [{ id: 'GA-B', bookingId: 'BK-1', date: null, gurus: ['Mike'] }]
    });
    const b = day(out, '2026-09-16').items.find(i => i.kind === 'booking');
    assert.deepEqual(b.gurus, ['Mike']);
    assert.deepEqual(day(out, '2026-09-16').guruLanes.Mike.map(x => x.kind), ['booking']);
  });

  test('a birthday party can be assigned a guru', () => {
    const out = build({
      birthdays: [{ id: 'BDAY-1', date: '2026-09-19', time: '13:00', heroName: 'Ava', package: 'Kids Party', status: 'confirmed' }],
      assignments: [{ id: 'GA-D', birthdayId: 'BDAY-1', date: null, gurus: ['Jen'] }]
    });
    assert.deepEqual(day(out, '2026-09-19').guruLanes.Jen.map(x => x.title), ["Ava's party"]);
  });

  test('assignments never leak between record types', () => {
    // eventId 'X' and bookingId 'X' must not find each other's assignment.
    const a = [{ id: 'GA-1', eventId: 'X', date: null, gurus: ['Dustin'] }];
    assert.equal(assignmentFor(a, 'bookingId', 'X', '2026-09-16'), null);
  });
});

describe('birthday requests', () => {
  test('an unlinked request shows as a tentative hold', () => {
    const out = build({ birthdays: [{ id: 'BDAY-1', date: '2026-09-19', time: '13:00', heroName: 'Ava', package: 'Kids Party', audience: 'Kids', status: 'new', guests: 14 }] });
    const b = day(out, '2026-09-19').items.find(i => i.kind === 'birthday');
    assert.equal(b.title, "Ava's party");
    assert.equal(b.sub, 'Kids Party · Kids');
    assert.equal(b.tone, 'tentative');
    assert.equal(b.meta.requestOnly, true);
    assert.equal(b.eMin - b.sMin, 180);
  });

  test('once it becomes a booking the request stops drawing', () => {
    // Otherwise the same party occupies the room twice on screen.
    const out = build({
      birthdays: [{ id: 'BDAY-1', date: '2026-09-19', time: '13:00', heroName: 'Ava', status: 'confirmed', linkedBookingId: 'BK-9' }],
      bookings: [booking({ id: 'BK-9', date: '2026-09-19', start: '13:00', hours: 3, birthdayParty: true, name: 'Ava party' })]
    });
    const items = day(out, '2026-09-19').items;
    assert.equal(items.filter(i => i.kind === 'birthday').length, 0);
    assert.equal(items.filter(i => i.kind === 'booking').length, 1);
    assert.equal(items[0].meta.birthday, true);
  });

  for (const status of ['declined', 'archived', 'canceled']) {
    test(`a ${status} request is not on the calendar`, () => {
      const out = build({ birthdays: [{ id: 'BDAY-X', date: '2026-09-19', time: '13:00', status }] });
      assert.equal(day(out, '2026-09-19').items.length, 0);
    });
  }
});

describe('external / off-site events', () => {
  const ext = (o = {}) => ({
    id: 'IE-1', title: 'Chippewa Card Show', date: '2026-09-19', allDay: true,
    location: 'Eagles Club', status: 'committed', supportTypes: ['vendor'], ...o
  });

  test('a committed external event appears in the offsite lane with its guru', () => {
    const out = build({
      interest: [ext()],
      assignments: [{ id: 'GA-E', externalId: 'IE-1', date: null, gurus: ['Chad'] }]
    });
    const d = day(out, '2026-09-19');
    const e = d.items.find(i => i.kind === 'external');
    assert.equal(e.title, 'Chippewa Card Show');
    assert.equal(e.offsite, true);
    assert.equal(e.sub, 'Eagles Club');
    assert.deepEqual(e.gurus, ['Chad']);
    assert.equal(d.roomLanes.offsite.length, 1);
    assert.deepEqual(d.guruLanes.Chad.map(x => x.kind), ['external']);
  });

  test('a multi-day external event covers every one of its days', () => {
    const out = build({ interest: [ext({ date: '2026-09-18', endDate: '2026-09-20' })] });
    assert.deepEqual(out.days.filter(d => d.items.length).map(d => d.date),
      ['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  test('a weekly repeat expands — this is the Sunday game night at the Plus', () => {
    const out = buildSchedule({
      from: '2026-09-13', to: '2026-10-11', hours: HOURS, roster: [],
      interest: [ext({ id: 'IE-P', title: 'Game night at the Plus', date: '2026-09-13', repeatWeeklyUntil: '2026-10-11' })]
    });
    assert.deepEqual(out.days.filter(d => d.items.length).map(d => d.date),
      ['2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04', '2026-10-11']);
  });

  test('once converted to a real NGH event the radar item steps aside', () => {
    const out = build({ interest: [ext({ linkedEventId: 'EVT-77' })] });
    assert.equal(day(out, '2026-09-19').items.filter(i => i.kind === 'external').length, 0);
  });

  test('things we are only watching stay off the working calendar', () => {
    for (const status of ['watching', 'passed', 'converted']) {
      const out = build({ interest: [ext({ status })] });
      assert.equal(day(out, '2026-09-19').items.length, 0, status + ' should not clutter the schedule');
    }
    assert.equal(build({ interest: [ext({ status: 'considering' })] }).days.filter(d => d.items.length).length, 1);
  });
});

describe('store hours', () => {
  test('the weekly template drives the day', () => {
    const h = storeHoursFor('2026-09-16', HOURS);        // Wednesday
    assert.equal(h.closed, false);
    assert.equal(h.sMin, 12 * 60);
    assert.equal(h.eMin, 20 * 60);
    assert.equal(h.source, 'weekly');
  });

  test('a closed weekday is closed', () => {
    const h = storeHoursFor('2026-09-14', HOURS);        // Monday
    assert.equal(h.closed, true);
    assert.equal(h.sMin, null);
  });

  test('an override beats the template in both directions', () => {
    const H = { ...HOURS, overrides: [{ date: '2026-09-14', closed: false, open: '09:00', close: '13:00', label: 'Special opening' }, { date: '2026-09-16', closed: true, label: 'Thanksgiving' }] };
    const open = storeHoursFor('2026-09-14', H);
    assert.equal(open.closed, false); assert.equal(open.sMin, 540); assert.equal(open.label, 'Special opening');
    const shut = storeHoursFor('2026-09-16', H);
    assert.equal(shut.closed, true); assert.equal(shut.label, 'Thanksgiving');
  });

  test('unset hours are NOT the same as closed', () => {
    // A day nobody has configured must not silently read as "we are shut",
    // or the coverage warnings become meaningless.
    const h = storeHoursFor('2026-09-16', DEFAULT_STORE_HOURS);
    assert.equal(h.configured, false);
    assert.equal(h.closed, false);
    assert.equal(h.source, 'unset');
  });

  test('no coverage warnings are raised until hours are configured', () => {
    const out = buildSchedule({ ...WEEK, hours: DEFAULT_STORE_HOURS, roster: ['Dustin'], bookings: [booking()] });
    assert.equal(out.days.some(d => d.conflicts.some(c => c.type === 'store-uncovered')), false);
  });
});

describe('floor coverage', () => {
  const openWin = { closed: false, sMin: 12 * 60, eMin: 20 * 60, configured: true };
  const shift = (guru, open, close) => normalizeShifts([{ id: 'GS-' + guru + open, guru, date: '2026-09-16', open, close }], '2026-09-16', '2026-09-16')[0];

  test('a shift covering the whole day leaves no gap', () => {
    const c = coverageFor(openWin, [shift('Mike', '12:00', '20:00')]);
    assert.deepEqual(c.gaps, []);
    assert.equal(c.covered.length, 1);
    assert.deepEqual(c.covered[0].gurus, ['Mike']);
  });

  test('a short shift leaves the rest uncovered', () => {
    const c = coverageFor(openWin, [shift('Mike', '12:00', '17:00')]);
    assert.equal(c.gaps.length, 1);
    assert.equal(c.gaps[0].from, '5:00 PM');
    assert.equal(c.gaps[0].to, '8:00 PM');
  });

  test('a gap in the middle is found', () => {
    const c = coverageFor(openWin, [shift('Mike', '12:00', '14:00'), shift('Jen', '17:00', '20:00')]);
    assert.equal(c.gaps.length, 1);
    assert.equal(c.gaps[0].from, '2:00 PM');
    assert.equal(c.gaps[0].to, '5:00 PM');
  });

  test('back-to-back shifts by different people leave no gap', () => {
    const c = coverageFor(openWin, [shift('Mike', '12:00', '16:00'), shift('Jen', '16:00', '20:00')]);
    assert.deepEqual(c.gaps, []);
    assert.equal(c.covered.length, 2, 'but they are shown as two stretches, since the person changes');
  });

  test('two people at once are both credited', () => {
    const c = coverageFor(openWin, [shift('Mike', '12:00', '20:00'), shift('Jen', '14:00', '16:00')]);
    assert.deepEqual(c.gaps, []);
    const both = c.covered.find(s => s.gurus.length === 2);
    assert.ok(both, 'the overlap should show both names');
    assert.deepEqual(both.gurus.slice().sort(), ['Jen', 'Mike']);
  });

  test('a shift running outside open hours is clipped, not counted', () => {
    const c = coverageFor(openWin, [shift('Mike', '08:00', '23:00')]);
    assert.deepEqual(c.gaps, []);
    assert.equal(c.covered[0].sMin, 12 * 60);
    assert.equal(c.covered[0].eMin, 20 * 60);
  });

  test('a shift entirely outside open hours covers nothing', () => {
    const c = coverageFor(openWin, [shift('Mike', '21:00', '23:00')]);
    assert.equal(c.gaps.length, 1);
    assert.equal(c.gaps[0].sMin, 12 * 60);
    assert.equal(c.gaps[0].eMin, 20 * 60);
  });

  test('a closed day has no coverage question to answer', () => {
    const c = coverageFor({ closed: true, configured: true, sMin: null, eMin: null }, []);
    assert.equal(c.open, false);
    assert.deepEqual(c.gaps, []);
  });
});

describe('conflicts a human needs to see', () => {
  test('a guru in two places at once', () => {
    const out = build({
      events: [event({ date: '2026-09-16', start: '17:00', end: '21:00' })],
      bookings: [booking({ start: '18:00', hours: 2 })],
      assignments: [
        { id: 'A1', eventId: 'EVT-1', date: null, gurus: ['Dustin'] },
        { id: 'A2', bookingId: 'BK-1', date: null, gurus: ['Dustin'] }
      ]
    });
    const c = day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-double-booked');
    assert.equal(c.length, 1);
    assert.equal(c[0].guru, 'Dustin');
    assert.match(c[0].detail, /at the same time/);
  });

  test('back-to-back is not a conflict', () => {
    const out = build({
      events: [event({ date: '2026-09-16', start: '13:00', end: '17:00' })],
      bookings: [booking({ start: '17:00', hours: 2 })],
      assignments: [
        { id: 'A1', eventId: 'EVT-1', date: null, gurus: ['Dustin'] },
        { id: 'A2', bookingId: 'BK-1', date: null, gurus: ['Dustin'] }
      ]
    });
    assert.equal(day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-double-booked').length, 0);
  });

  test('an unavailable guru who has been assigned anyway', () => {
    const out = build({
      bookings: [booking()],
      assignments: [{ id: 'A1', bookingId: 'BK-1', date: null, gurus: ['Jen'] }],
      unavail: [{ id: 'GU-1', guru: 'Jen', date: '2026-09-16', allDay: true }]
    });
    const c = day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-unavailable');
    assert.equal(c.length, 1);
    assert.equal(c[0].guru, 'Jen');
  });

  test("one person's day off does not flag somebody else's work", () => {
    // Found by mutation testing: removing the "is this guru actually on this
    // item" check left every conflict test still green, because each one had
    // the unavailable guru assigned to the thing being checked. Jen being out
    // must say nothing whatsoever about Mike's booking.
    const out = build({
      bookings: [booking()],
      assignments: [{ id: 'A1', bookingId: 'BK-1', date: null, gurus: ['Mike'] }],
      unavail: [{ id: 'GU-1', guru: 'Jen', date: '2026-09-16', allDay: true }]
    });
    assert.deepEqual(day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-unavailable'), []);
  });

  test('an unassigned item is never flagged against anybody being away', () => {
    const out = build({
      bookings: [booking()],
      unavail: [{ id: 'GU-1', guru: 'Jen', date: '2026-09-16', allDay: true }]
    });
    assert.deepEqual(day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-unavailable'), []);
  });

  test('unavailable in the morning does not block an evening booking', () => {
    const out = build({
      bookings: [booking({ start: '17:00', hours: 3 })],
      assignments: [{ id: 'A1', bookingId: 'BK-1', date: null, gurus: ['Jen'] }],
      unavail: [{ id: 'GU-1', guru: 'Jen', date: '2026-09-16', allDay: false, start: '08:00', end: '12:00' }]
    });
    assert.equal(day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-unavailable').length, 0);
  });

  test('two things in the same room at the same time', () => {
    const out = build({
      bookings: [booking({ id: 'BK-1', rooms: ['den'], start: '17:00', hours: 3 }),
        booking({ id: 'BK-2', rooms: ['den'], start: '18:00', hours: 2 })]
    });
    const c = day(out, '2026-09-16').conflicts.filter(x => x.type === 'room-double-booked');
    assert.equal(c.length, 1);
    assert.equal(c[0].room, 'den');
  });

  test('the same time in different rooms is fine', () => {
    const out = build({
      bookings: [booking({ id: 'BK-1', rooms: ['den'] }), booking({ id: 'BK-2', rooms: ['holt'] })]
    });
    assert.equal(day(out, '2026-09-16').conflicts.filter(x => x.type === 'room-double-booked').length, 0);
  });

  test('an offsite event never collides with a room', () => {
    const out = build({
      events: [event({ date: '2026-09-16', start: '17:00', end: '21:00', offsite: true, rooms: [] })],
      bookings: [booking({ rooms: ['den'] })]
    });
    assert.equal(day(out, '2026-09-16').conflicts.filter(x => x.type === 'room-double-booked').length, 0);
  });

  test('a booking that paid for Gurus and has none', () => {
    const out = build({ bookings: [booking({ addons: [{ id: 'guru', qty: 2 }] })] });
    const c = day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-understaffed');
    assert.equal(c.length, 1);
    assert.match(c[0].detail, /needs 2 Gurus and has none/);
  });

  test('half-staffed still counts as understaffed', () => {
    const out = build({
      bookings: [booking({ addons: [{ id: 'guru', qty: 2 }] })],
      assignments: [{ id: 'A1', bookingId: 'BK-1', date: null, gurus: ['Mike'] }]
    });
    assert.match(day(out, '2026-09-16').conflicts.find(x => x.type === 'guru-understaffed').detail, /has 1 assigned/);
  });

  test('fully staffed raises nothing', () => {
    const out = build({
      bookings: [booking({ addons: [{ id: 'guru', qty: 2 }] })],
      assignments: [{ id: 'A1', bookingId: 'BK-1', date: null, gurus: ['Mike', 'Jen'] }]
    });
    assert.equal(day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-understaffed').length, 0);
  });

  test('a booking with no Guru add-on is never called understaffed', () => {
    const out = build({ bookings: [booking()] });
    assert.equal(day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-understaffed').length, 0);
  });

  test('the store open with nobody on the floor', () => {
    const out = build({ shifts: [{ id: 'GS-1', guru: 'Mike', date: '2026-09-16', open: '12:00', close: '17:00' }] });
    const c = day(out, '2026-09-16').conflicts.filter(x => x.type === 'store-uncovered');
    assert.equal(c.length, 1);
    assert.match(c[0].detail, /5:00 PM–8:00 PM/);
  });

  test('a closed day raises no coverage warning', () => {
    assert.equal(day(build({}), '2026-09-14').conflicts.filter(x => x.type === 'store-uncovered').length, 0);
  });

  test('a shift is not itself a double-booking', () => {
    // Running the retail floor during an event is explicitly allowed.
    const out = build({
      events: [event({ date: '2026-09-16', start: '13:00', end: '17:00' })],
      assignments: [{ id: 'A1', eventId: 'EVT-1', date: null, gurus: ['Mike'] }],
      shifts: [{ id: 'GS-1', guru: 'Mike', date: '2026-09-16', open: '12:00', close: '20:00' }]
    });
    assert.equal(day(out, '2026-09-16').conflicts.filter(x => x.type === 'guru-double-booked').length, 0);
  });
});

describe('the assembled week', () => {
  test('every day in the range is present, even empty ones', () => {
    const out = build({});
    assert.equal(out.days.length, 7);
    assert.deepEqual(out.days.map(d => d.date), eachDate('2026-09-14', '2026-09-20'));
    assert.deepEqual(out.days.map(d => d.dow), [1, 2, 3, 4, 5, 6, 0]);
  });

  test('the roster leads, then anyone else who turns up in the data', () => {
    const out = build({
      roster: ['Dustin', 'Mike'],
      shifts: [{ id: 'GS-1', guru: 'Aaron', date: '2026-09-16', open: '12:00', close: '20:00' }]
    });
    assert.deepEqual(out.gurus, ['Dustin', 'Mike', 'Aaron']);
  });

  test('the counts tell you what you are looking at', () => {
    const out = build({
      bookings: [booking({ id: 'BK-1', status: 'approved' }), booking({ id: 'BK-2', status: 'pending', rooms: ['holt'] })],
      events: [event()],
      interest: [{ id: 'IE-1', title: 'Card show', date: '2026-09-19', allDay: true, status: 'committed' }]
    });
    assert.equal(out.counts.bookings, 2);
    assert.equal(out.counts.pendingBookings, 1);
    assert.equal(out.counts.events, 1);
    assert.equal(out.counts.external, 1);
  });

  test('a single day builds the same way a week does', () => {
    const out = buildSchedule({ from: '2026-09-16', to: '2026-09-16', hours: HOURS, roster: ['Mike'], bookings: [booking()] });
    assert.equal(out.days.length, 1);
    assert.equal(out.days[0].items.length, 1);
  });

  test('nothing at all still produces a usable week', () => {
    const out = buildSchedule({ from: '2026-09-14', to: '2026-09-20' });
    assert.equal(out.days.length, 7);
    assert.deepEqual(out.gurus, []);
    assert.equal(out.counts.items, 0);
    out.days.forEach(d => assert.deepEqual(d.conflicts, []));
  });

  test('malformed records are skipped, not fatal', () => {
    const out = build({
      bookings: [null, {}, { id: 'BK-X' }, booking()],
      events: [null, { id: 'EVT-X' }, event()],
      birthdays: [null, {}], interest: [null, {}], shifts: [null, {}], unavail: [null, {}],
      blackouts: [null]
    });
    assert.equal(day(out, '2026-09-16').items.filter(i => i.kind === 'booking').length, 1);
  });

  test('item keys are unique across a whole week', () => {
    const out = build({
      bookings: [booking({ id: 'BK-1' }), booking({ id: 'BK-2', rooms: ['holt'] })],
      events: [event({ date: '2026-09-14', recurrence: { freq: 'weekly', count: 2 } })],
      shifts: [{ id: 'GS-1', guru: 'Mike', date: '2026-09-14', open: '12:00', close: '20:00', recurrence: { freq: 'weekly', count: 2 } }]
    });
    const keys = out.days.reduce((a, d) => a.concat(d.items.map(i => i.key)), []);
    assert.equal(new Set(keys).size, keys.length, 'duplicate keys break every React-style reconcile and every dedupe');
  });
});

describe('blackouts', () => {
  test('a closure blocks its rooms and reads as blocked', () => {
    const out = build({ blackouts: [{ id: 'BO-1', date: '2026-09-16', allDay: true, rooms: [], label: 'Deep clean' }] });
    const b = day(out, '2026-09-16').items.find(i => i.kind === 'blackout');
    assert.equal(b.title, 'Deep clean');
    assert.equal(b.tone, 'blocked');
    assert.equal(b.sub, 'All rooms');
  });

  test('a blackout is not reported as a room conflict', () => {
    // It is a closure, not a competing reservation; the booking console already
    // warns at request time.
    const out = build({
      blackouts: [{ id: 'BO-1', date: '2026-09-16', allDay: true, rooms: ['den'] }],
      bookings: [booking({ rooms: ['den'] })]
    });
    assert.equal(day(out, '2026-09-16').conflicts.filter(x => x.type === 'room-double-booked').length, 0);
  });
});
