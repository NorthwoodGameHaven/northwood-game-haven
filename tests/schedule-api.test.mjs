// NGH-BUILD 2026-09-12q
// tests/schedule-api.test.mjs — /api/schedule and the extended /gurus actions,
// run for real against the in-memory database from _mock-hooks.mjs.
//
// The merge itself is covered in schedule-core.test.mjs. What is tested here
// is the plumbing around it, which is where this kind of endpoint usually
// fails in production rather than in review:
//
//   * a missing optional table must not take the whole calendar down
//   * a guru assigned to a BOOKING must be blocked when they are unavailable,
//     the same way an event assignment always has been
//   * the store-hours template must refuse a closing time before its opening
//     time, because a negative open window silently means "never covered"
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.ADMIN_SECRET = 'test-admin-secret';

register('./_mock-hooks.mjs', import.meta.url);
const schedule = await import('../netlify/functions/schedule.mjs');
const gurusFn = (await import('../netlify/functions/gurus.mjs')).default;
const scheduleFn = schedule.default;

const M = () => globalThis.__mock;
const AUTH = { Authorization: 'Bearer admin-ok', 'Content-Type': 'application/json' };

function db(tables) {
  // The mocks each initialise their own slice of __mock when first imported,
  // and only db.mjs is pulled in on this path — so `mail` may not exist yet.
  // Reset in place; replacing the object orphans the mock's captured handle.
  const m = (globalThis.__mock = globalThis.__mock || {});
  m.db = m.db || { handlers: [], calls: [] };
  m.mail = m.mail || [];
  m.db.handlers.length = 0; m.db.calls.length = 0; m.mail.length = 0;
  m.db.handlers.push((text) => {
    if (/FROM bookings/.test(text)) return (tables.bookings || []).map(d => ({ data: d }));
    if (/FROM events/.test(text)) return (tables.events || []).map(d => ({ data: d }));
    if (/FROM blackouts/.test(text)) return tables.blackouts ? [{ data: tables.blackouts }] : [];
    if (/FROM guru_data/.test(text)) return (tables.guru || []).map(d => ({ kind: d.kind, data: d.data }));
    if (/FROM birthday_requests/.test(text)) {
      if (tables.noBirthdayTable) throw new Error('relation "birthday_requests" does not exist');
      return (tables.birthdays || []).map(d => ({ data: d }));
    }
    if (/FROM interest_events/.test(text)) {
      if (tables.noInterestTable) throw new Error('relation "interest_events" does not exist');
      return (tables.interest || []).map(d => ({ data: d }));
    }
    return [];
  });
}
const GET = (qs) => new Request('https://gamehaven.guru/api/schedule?' + qs, { headers: AUTH });
const POST = (body) => new Request('https://gamehaven.guru/api/gurus', { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
const writes = () => M().db.calls.filter(c => /^INSERT INTO guru_data/.test(c.text));

// ---------------------------------------------------------------------------
describe('picking a date range', () => {
  const P = (s) => new URLSearchParams(s);

  test('a Monday-anchored week from any day inside it', () => {
    // 2026-09-16 is a Wednesday.
    assert.deepEqual(schedule.weekBounds('2026-09-16'), { from: '2026-09-14', to: '2026-09-20' });
  });

  test('Sunday belongs to the week that just ended, not the one starting', () => {
    // Getting this wrong shows Sunday's events on the wrong week — the classic
    // getDay()-is-Sunday-anchored bug.
    assert.deepEqual(schedule.weekBounds('2026-09-20'), { from: '2026-09-14', to: '2026-09-20' });
    assert.deepEqual(schedule.weekBounds('2026-09-21'), { from: '2026-09-21', to: '2026-09-27' });
  });

  test('a single date resolves to itself', () => {
    assert.deepEqual(schedule.resolveRange(P('date=2026-09-16')), { from: '2026-09-16', to: '2026-09-16' });
  });

  test('from with no to gives a week', () => {
    assert.deepEqual(schedule.resolveRange(P('from=2026-09-14')), { from: '2026-09-14', to: '2026-09-20' });
  });

  test('nonsense is rejected rather than guessed at', () => {
    assert.match(schedule.resolveRange(P('')).error, /from must be/);
    assert.match(schedule.resolveRange(P('from=nope')).error, /from must be/);
    assert.match(schedule.resolveRange(P('from=2026-09-20&to=2026-09-14')).error, /before/);
    assert.match(schedule.resolveRange(P('from=2026-01-01&to=2027-01-01')).error, /too wide/);
  });

  test('a full quarter is allowed', () => {
    assert.equal(schedule.resolveRange(P('from=2026-09-01&to=2026-11-30')).error, undefined);
  });
});

describe('GET /api/schedule', () => {
  beforeEach(() => db({}));

  test('unauthenticated gets nothing', async () => {
    const r = await scheduleFn(new Request('https://gamehaven.guru/api/schedule?week=2026-09-16'));
    assert.equal(r.status, 401);
  });

  test('a week comes back with all seven days', async () => {
    const r = await scheduleFn(GET('week=2026-09-16'));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.days.length, 7);
    assert.equal(body.from, '2026-09-14');
    assert.ok(body.generatedAt);
  });

  test('pending bookings are in the payload', async () => {
    db({
      bookings: [
        { id: 'BK-1', name: 'Rausch', status: 'pending', date: '2026-09-16', start: '17:00', hours: 4, rooms: ['den'] },
        { id: 'BK-2', name: 'Olson', status: 'approved', date: '2026-09-16', start: '10:00', hours: 2, rooms: ['holt'] }
      ]
    });
    const body = await (await scheduleFn(GET('week=2026-09-16'))).json();
    assert.equal(body.counts.bookings, 2);
    assert.equal(body.counts.pendingBookings, 1);
  });

  test('a missing optional table degrades to empty, not a 500', async () => {
    // birthday_requests and interest_events only exist after the first record.
    // A brand-new install must still get a calendar.
    db({ noBirthdayTable: true, noInterestTable: true, bookings: [{ id: 'BK-1', status: 'approved', date: '2026-09-16', start: '17:00', hours: 2, rooms: ['den'] }] });
    const r = await scheduleFn(GET('week=2026-09-16'));
    assert.equal(r.status, 200, 'a half-loaded schedule beats no schedule');
    const body = await r.json();
    assert.equal(body.counts.bookings, 1);
  });

  test('the store-hours row is picked out of guru_data', async () => {
    db({
      guru: [{ kind: 'hours', data: { configured: true, weekly: Array.from({ length: 7 }, () => ({ closed: false, open: '12:00', close: '20:00' })), overrides: [] } }]
    });
    const body = await (await scheduleFn(GET('date=2026-09-16'))).json();
    assert.equal(body.days[0].hours.configured, true);
    assert.equal(body.days[0].hours.closed, false);
  });

  test('with no hours configured, no coverage alarm is raised', async () => {
    db({ guru: [{ kind: 'shift', data: { id: 'GS-1', guru: 'Mike', date: '2026-09-16', open: '12:00', close: '14:00' } }] });
    const body = await (await scheduleFn(GET('date=2026-09-16'))).json();
    assert.equal(body.days[0].conflicts.filter(c => c.type === 'store-uncovered').length, 0);
  });

  test('the roster shows everyone, including people with nothing on', async () => {
    const body = await (await scheduleFn(GET('week=2026-09-16'))).json();
    assert.ok(body.gurus.includes('Dustin'));
    assert.ok(body.gurus.includes('Sarah'));
    assert.ok(body.days[0].guruLanes.Sarah, 'an empty lane is how you see somebody is free');
  });

  test('rejected bookings never even leave the database', async () => {
    const body = await (await scheduleFn(GET('week=2026-09-16'))).json();
    const q = M().db.calls.find(c => /FROM bookings/.test(c.text));
    assert.match(q.text, /status <> 'rejected'/);
    assert.ok(body);
  });
});

describe('assigning a guru to something other than an event', () => {
  const bk = { id: 'BK-1', name: 'Rausch', status: 'approved', date: '2026-09-16', start: '17:00', hours: 4, rooms: ['den'] };
  const bd = { id: 'BDAY-1', date: '2026-09-19', time: '13:00', heroName: 'Ava', status: 'confirmed' };

  test('a booking assignment saves and records the bookingId', async () => {
    db({ bookings: [bk] });
    const r = await gurusFn(POST({ action: 'save-assignment', item: { bookingId: 'BK-1', gurus: ['Mike'] } }));
    assert.equal(r.status, 201);
    const rec = await r.json();
    assert.equal(rec.bookingId, 'BK-1');
    assert.equal(rec.eventId, undefined, 'it must not masquerade as an event assignment');
    assert.deepEqual(rec.gurus, ['Mike']);
    assert.equal(writes().length, 1);
  });

  test('a birthday assignment saves', async () => {
    db({ birthdays: [bd] });
    const rec = await (await gurusFn(POST({ action: 'save-assignment', item: { birthdayId: 'BDAY-1', gurus: ['Jen'] } }))).json();
    assert.equal(rec.birthdayId, 'BDAY-1');
  });

  test('an off-site assignment saves against the date', async () => {
    db({ interest: [{ id: 'IE-1', title: 'Card show', date: '2026-09-19', allDay: true, status: 'committed' }] });
    const rec = await (await gurusFn(POST({ action: 'save-assignment', item: { externalId: 'IE-1', date: '2026-09-19', gurus: ['Chad'] } }))).json();
    assert.equal(rec.externalId, 'IE-1');
    assert.equal(rec.date, '2026-09-19');
  });

  test('exactly one target is required', async () => {
    db({ bookings: [bk] });
    assert.equal((await gurusFn(POST({ action: 'save-assignment', item: { gurus: ['Mike'] } }))).status, 400);
    const both = await gurusFn(POST({ action: 'save-assignment', item: { bookingId: 'BK-1', eventId: 'EVT-1', gurus: ['Mike'] } }));
    assert.equal(both.status, 400, 'an assignment that staffs two different things is meaningless');
  });

  test('assigning to a booking that does not exist is a 404', async () => {
    db({ bookings: [] });
    assert.equal((await gurusFn(POST({ action: 'save-assignment', item: { bookingId: 'BK-NOPE', gurus: ['Mike'] } }))).status, 404);
  });

  test('an unavailable guru cannot be put on a booking', async () => {
    // The server has always enforced this for events. A booking could not be
    // assigned at all before, so this rule has never applied to one until now.
    db({
      bookings: [bk],
      guru: [{ kind: 'unavail', data: { id: 'GU-1', guru: 'Jen', date: '2026-09-16', allDay: true, notes: 'Out of town' } }]
    });
    const r = await gurusFn(POST({ action: 'save-assignment', item: { bookingId: 'BK-1', gurus: ['Jen'] } }));
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error, 'guru-unavailable');
    assert.equal(body.conflicts[0].guru, 'Jen');
    assert.equal(writes().length, 0, 'and nothing may be written');
  });

  test('unavailable in the morning does not block an evening booking', async () => {
    db({
      bookings: [bk],
      guru: [{ kind: 'unavail', data: { id: 'GU-1', guru: 'Jen', date: '2026-09-16', allDay: false, start: '08:00', end: '12:00' } }]
    });
    assert.equal((await gurusFn(POST({ action: 'save-assignment', item: { bookingId: 'BK-1', gurus: ['Jen'] } }))).status, 201);
  });

  test('an unavailable guru cannot be put on a birthday party either', async () => {
    db({
      birthdays: [bd],
      guru: [{ kind: 'unavail', data: { id: 'GU-1', guru: 'Jen', date: '2026-09-19', allDay: true } }]
    });
    assert.equal((await gurusFn(POST({ action: 'save-assignment', item: { birthdayId: 'BDAY-1', gurus: ['Jen'] } }))).status, 409);
  });

  test('"none" is still allowed while unavailable — it assigns nobody', async () => {
    db({ bookings: [bk], guru: [{ kind: 'unavail', data: { id: 'GU-1', guru: 'Jen', date: '2026-09-16', allDay: true } }] });
    const r = await gurusFn(POST({ action: 'save-assignment', item: { bookingId: 'BK-1', none: true } }));
    assert.equal(r.status, 201);
    assert.deepEqual((await r.json()).gurus, []);
  });

  test('event assignments still work exactly as they did', async () => {
    db({ events: [{ id: 'EVT-1', title: 'FNM', date: '2026-09-18', start: '18:00', end: '22:00' }] });
    const rec = await (await gurusFn(POST({ action: 'save-assignment', item: { eventId: 'EVT-1', gurus: ['Dustin'] } }))).json();
    assert.equal(rec.eventId, 'EVT-1');
    assert.equal(rec.date, null, 'no date still means the whole series');
  });
});

describe('the store-hours template', () => {
  const week = (o) => Array.from({ length: 7 }, () => ({ ...o }));

  test('a valid template saves and reads back configured', async () => {
    db({});
    const r = await gurusFn(POST({ action: 'save-hours', item: { weekly: week({ closed: false, open: '12:00', close: '20:00' }), overrides: [] } }));
    assert.equal(r.status, 201);
    const rec = await r.json();
    assert.equal(rec.configured, true);
    assert.equal(rec.weekly.length, 7);
    assert.equal(rec.weekly[0].open, '12:00');
    assert.match(writes()[0].text, /guru_data/);
  });

  test('a closing time before opening is refused', async () => {
    // An inverted window means every minute reads as uncovered, forever.
    db({});
    const bad = week({ closed: false, open: '12:00', close: '20:00' });
    bad[3] = { closed: false, open: '20:00', close: '12:00' };
    const r = await gurusFn(POST({ action: 'save-hours', item: { weekly: bad } }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /after opening/);
    assert.equal(writes().length, 0);
  });

  test('a day with no times is stored as closed, not as midnight to midnight', async () => {
    db({});
    const w = week({ closed: false, open: '12:00', close: '20:00' });
    w[1] = { open: '', close: '' };
    const rec = await (await gurusFn(POST({ action: 'save-hours', item: { weekly: w } }))).json();
    assert.equal(rec.weekly[1].closed, true);
  });

  test('a short template is padded to seven closed days rather than rejected', async () => {
    db({});
    const rec = await (await gurusFn(POST({ action: 'save-hours', item: { weekly: [{ closed: false, open: '10:00', close: '18:00' }] } }))).json();
    assert.equal(rec.weekly.length, 7);
    assert.equal(rec.weekly[6].closed, true);
  });

  test('overrides are validated, sorted and de-junked', async () => {
    db({});
    const rec = await (await gurusFn(POST({
      action: 'save-hours',
      item: {
        weekly: week({ closed: false, open: '12:00', close: '20:00' }),
        overrides: [
          { date: '2026-12-25', closed: true, label: 'Christmas' },
          { date: 'garbage', closed: true },
          { date: '2026-11-27', closed: true, label: 'Thanksgiving' },
          {}
        ]
      }
    }))).json();
    assert.deepEqual(rec.overrides.map(o => o.date), ['2026-11-27', '2026-12-25']);
    assert.equal(rec.overrides[0].label, 'Thanksgiving');
  });

  test('an inverted override is refused too', async () => {
    db({});
    const r = await gurusFn(POST({
      action: 'save-hours',
      item: { weekly: week({ closed: false, open: '12:00', close: '20:00' }), overrides: [{ date: '2026-12-24', open: '18:00', close: '09:00' }] }
    }));
    assert.equal(r.status, 400);
  });

  test('saved hours drive the coverage warnings end to end', async () => {
    db({
      guru: [
        { kind: 'hours', data: { configured: true, weekly: week({ closed: false, open: '12:00', close: '20:00' }), overrides: [] } },
        { kind: 'shift', data: { id: 'GS-1', guru: 'Mike', date: '2026-09-16', open: '12:00', close: '17:00' } }
      ]
    });
    const body = await (await scheduleFn(GET('date=2026-09-16'))).json();
    const gap = body.days[0].conflicts.find(c => c.type === 'store-uncovered');
    assert.ok(gap, 'three uncovered hours is exactly what this feature is for');
    assert.match(gap.detail, /5:00 PM–8:00 PM/);
  });

  test('an override closing the shop removes the warning entirely', async () => {
    db({
      guru: [{
        kind: 'hours',
        data: { configured: true, weekly: week({ closed: false, open: '12:00', close: '20:00' }), overrides: [{ date: '2026-09-16', closed: true, label: 'Staff day' }] }
      }]
    });
    const body = await (await scheduleFn(GET('date=2026-09-16'))).json();
    assert.equal(body.days[0].hours.closed, true);
    assert.equal(body.days[0].conflicts.filter(c => c.type === 'store-uncovered').length, 0);
  });
});
