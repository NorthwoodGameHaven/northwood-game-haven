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
    // The real table is (id, kind, data) and the merge logic reads r.id, so the
    // mock has to hand back an id or it tests a shape that does not exist.
    if (/FROM guru_data/.test(text)) return (tables.guru || []).map(d => ({ id: (d.data && d.data.id) || d.id, kind: d.kind, data: d.data }));
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

describe('deleting things actually works', () => {
  // This whole suite exists because of one line. noContent() returned
  //     new Response('', { status: 204 })
  // and 204 is a null-body status, so the Response constructor threw a
  // TypeError on every call. EVERY delete endpoint in the codebase was broken
  // — bookings, events, gurus, interest-events, karaoke, mtg, registrations,
  // specials, speedgaming — and it stayed hidden because each function's
  // top-level catch turned the throw into a generic "Server error", and
  // because tests/_mock-hooks.mjs carried a byte-identical copy of the bug.
  test('a 204 can be constructed at all', () => {
    assert.doesNotThrow(() => new Response(null, { status: 204 }));
    assert.throws(() => new Response('', { status: 204 }), /Invalid response status code 204/,
      'if this ever stops throwing, the guard below is no longer needed');
  });

  test('deleting a shift returns 204, not a server error', async () => {
    db({ guru: [{ kind: 'shift', data: { id: 'GS-1', guru: 'Chad', date: '2026-09-16', open: '12:00', close: '20:00' } }] });
    const r = await gurusFn(POST({ action: 'delete-shift', item: { id: 'GS-1' } }));
    assert.equal(r.status, 204, await r.text().catch(() => ''));
    assert.ok(M().db.calls.some(c => /^DELETE FROM guru_data/.test(c.text)), 'and it really deletes');
  });

  for (const action of ['delete-assignment', 'delete-unavail']) {
    test(action + ' returns 204 too', async () => {
      db({});
      assert.equal((await gurusFn(POST({ action, item: { id: 'X-1' } }))).status, 204);
    });
  }

  test('an OPTIONS preflight does not throw', async () => {
    db({});
    const r = await gurusFn(new Request('https://gamehaven.guru/api/gurus', { method: 'OPTIONS' }));
    assert.equal(r.status, 204);
  });
});

describe('one Guru cannot be on the floor twice at once', () => {
  // Clicking "Roster Chad on the floor" twice produced two identical shifts
  // and a week tally of 52 hours. A UI guard is not enough — any caller can
  // post twice — so the merge is server-side.
  const existing = (o = {}) => ({ kind: 'shift', data: { id: 'GS-1', guru: 'Chad', date: '2026-09-26', open: '10:00', close: '22:00', ...o } });
  // POST() builds the Request; gurusFn is what turns it into a Response.
  const add = (o = {}) => gurusFn(POST({ action: 'save-shift', item: { guru: 'Chad', date: '2026-09-26', open: '10:00', close: '22:00', ...o } }));
  const deletes = () => M().db.calls.filter(c => /^DELETE FROM guru_data/.test(c.text));

  test('posting the same shift twice keeps one record', async () => {
    db({ guru: [existing()] });
    const rec = await (await add()).json();
    assert.equal(rec.id, 'GS-1', 'it must reuse the existing record, not mint a second');
    assert.equal(rec.open, '10:00');
    assert.equal(rec.close, '22:00');
    assert.equal(rec.merged, 1);
  });

  test('an overlapping shift widens the existing one', async () => {
    db({ guru: [existing({ open: '10:00', close: '18:00' })] });
    const rec = await (await add({ open: '16:00', close: '22:00' })).json();
    assert.equal(rec.id, 'GS-1');
    assert.equal(rec.open, '10:00');
    assert.equal(rec.close, '22:00', 'the union, not the newer one');
  });

  test('an abutting shift merges rather than sitting beside it', async () => {
    db({ guru: [existing({ open: '10:00', close: '14:00' })] });
    const rec = await (await add({ open: '14:00', close: '18:00' })).json();
    assert.equal(rec.close, '18:00');
    assert.equal(rec.open, '10:00');
  });

  test('three overlapping shifts collapse to one and the extras are deleted', async () => {
    db({
      guru: [existing({ id: 'GS-1', open: '10:00', close: '14:00' }),
        existing({ id: 'GS-2', open: '13:00', close: '18:00' })]
    });
    const rec = await (await add({ open: '17:00', close: '22:00' })).json();
    assert.equal(rec.id, 'GS-1');
    assert.equal(rec.open, '10:00');
    assert.equal(rec.close, '22:00');
    assert.equal(deletes().length, 1, 'GS-2 gets absorbed');
  });

  test('a separate shift later the same day is left alone', async () => {
    db({ guru: [existing({ open: '09:00', close: '12:00' })] });
    const rec = await (await add({ open: '17:00', close: '20:00' })).json();
    assert.notEqual(rec.id, 'GS-1', 'a genuine second shift is not a duplicate');
    assert.equal(rec.merged, undefined);
    assert.equal(deletes().length, 0);
  });

  test('another Guru on the same hours is not a duplicate', async () => {
    db({ guru: [existing()] });
    const rec = await (await gurusFn(POST({ action: 'save-shift', item: { guru: 'Mike', date: '2026-09-26', open: '10:00', close: '22:00' } }))).json();
    assert.notEqual(rec.id, 'GS-1');
    assert.equal(rec.merged, undefined);
  });

  test('the same hours on a different day is not a duplicate', async () => {
    db({ guru: [existing()] });
    const rec = await (await add({ date: '2026-09-27' })).json();
    assert.notEqual(rec.id, 'GS-1');
  });

  test('editing a shift is honoured exactly, never merged', async () => {
    // An id means somebody deliberately changed this record. Widening it to
    // swallow a neighbour would silently undo the edit they just made.
    db({ guru: [existing({ id: 'GS-1', open: '10:00', close: '22:00' }), existing({ id: 'GS-2', open: '10:00', close: '14:00' })] });
    const rec = await (await add({ id: 'GS-2', open: '11:00', close: '13:00' })).json();
    assert.equal(rec.id, 'GS-2');
    assert.equal(rec.open, '11:00');
    assert.equal(rec.close, '13:00');
    assert.equal(deletes().length, 0);
  });

  test('a one-off a weekly series already covers is not created at all', async () => {
    // This is how the doubled Fridays appeared: rostering a gap by hand on a
    // day a recurring shift already spoke for.
    db({ guru: [{ kind: 'shift', data: { id: 'R1', guru: 'Chad', date: '2026-09-19', open: '10:00', close: '22:00', recurrence: { freq: 'weekly', count: 8 } } }] });
    const r = await add({ date: '2026-09-26', open: '10:00', close: '22:00' });
    const rec = await r.json();
    assert.equal(rec.alreadyCovered, true);
    assert.equal(rec.id, 'R1', 'it hands back the series rather than minting a twin');
    assert.equal(writes().length, 0, 'and writes nothing');
  });

  test('but a one-off outside the series window still gets created', async () => {
    db({ guru: [{ kind: 'shift', data: { id: 'R1', guru: 'Chad', date: '2026-09-19', open: '16:00', close: '20:00', recurrence: { freq: 'weekly', count: 8 } } }] });
    const rec = await (await add({ date: '2026-09-26', open: '20:00', close: '22:00' })).json();
    assert.notEqual(rec.id, 'R1');
    assert.equal(rec.alreadyCovered, undefined);
  });

  test('a recurring shift is never merged into a one-off', async () => {
    db({ guru: [existing()] });
    const rec = await (await add({ recurrence: { freq: 'weekly', count: 8 } })).json();
    assert.notEqual(rec.id, 'GS-1', 'it spans dates the day-level merge knows nothing about');
    assert.equal(rec.recurrence.count, 8);
  });
});

describe('tidying up duplicates that already exist', () => {
  test('merge-shifts collapses overlapping runs and reports what it did', async () => {
    db({
      guru: [
        { kind: 'shift', data: { id: 'A1', guru: 'Chad', date: '2026-09-25', open: '16:00', close: '22:00' } },
        { kind: 'shift', data: { id: 'A2', guru: 'Chad', date: '2026-09-25', open: '16:00', close: '22:00' } },
        { kind: 'shift', data: { id: 'B1', guru: 'Chad', date: '2026-09-26', open: '10:00', close: '22:00' } },
        { kind: 'shift', data: { id: 'B2', guru: 'Chad', date: '2026-09-26', open: '10:00', close: '22:00' } },
        { kind: 'shift', data: { id: 'C1', guru: 'Mike', date: '2026-09-27', open: '12:00', close: '20:00' } }
      ]
    });
    const res = await (await gurusFn(POST({ action: 'merge-shifts' }))).json();
    assert.equal(res.removed, 2, 'one duplicate on each of the two days');
    // Exact duplicates are dropped outright in the first pass — there is
    // nothing to widen when both records already say the same thing.
    assert.equal(res.widened, 0);
  });

  test('overlapping-but-different one-offs are widened, not just dropped', async () => {
    db({
      guru: [
        { kind: 'shift', data: { id: 'A1', guru: 'Chad', date: '2026-09-25', open: '10:00', close: '15:00' } },
        { kind: 'shift', data: { id: 'A2', guru: 'Chad', date: '2026-09-25', open: '14:00', close: '20:00' } }
      ]
    });
    const res = await (await gurusFn(POST({ action: 'merge-shifts' }))).json();
    assert.equal(res.removed, 1);
    assert.equal(res.widened, 1);
    const upd = M().db.calls.find(c => /^UPDATE guru_data/.test(c.text));
    assert.match(upd.values.join(' '), /"open":"10:00"/);
    assert.match(upd.values.join(' '), /"close":"20:00"/);
  });

  // THE ONE THAT SHIPPED BROKEN. The first version skipped every recurring
  // shift, so Chad's doubled Friday — one of the pair a weekly series —
  // reported "no overlapping shifts" while sitting right there on screen.
  const weekly = (o = {}) => ({ kind: 'shift', data: { id: 'R1', guru: 'Chad', date: '2026-09-18', open: '16:00', close: '22:00', recurrence: { freq: 'weekly', count: 8 }, ...o } });

  test('two identical recurring shifts are deduped', async () => {
    db({ guru: [weekly({ id: 'R1' }), weekly({ id: 'R2' })] });
    const res = await (await gurusFn(POST({ action: 'merge-shifts' }))).json();
    assert.equal(res.removed, 1, 'a repeating shift can be a duplicate too');
  });

  test('a one-off the series already covers is removed', async () => {
    db({
      guru: [weekly({ id: 'R1' }),
        { kind: 'shift', data: { id: 'O1', guru: 'Chad', date: '2026-09-18', open: '16:00', close: '22:00' } }]
    });
    const res = await (await gurusFn(POST({ action: 'merge-shifts' }))).json();
    assert.equal(res.removed, 1);
    assert.equal(res.needsReview, 0);
  });

  test('and on a LATER occurrence of the series, not just the anchor date', async () => {
    // 2026-09-25 is the second Friday of the run — the duplicate the shop saw
    // was on a different week from where the series starts.
    db({
      guru: [weekly({ id: 'R1' }),
        { kind: 'shift', data: { id: 'O1', guru: 'Chad', date: '2026-09-25', open: '16:00', close: '22:00' } }]
    });
    assert.equal((await (await gurusFn(POST({ action: 'merge-shifts' }))).json()).removed, 1);
  });

  test('a one-off that sticks out past the series is left for a human', async () => {
    // Widening a weekly pattern to swallow one long evening would change every
    // other week too. Report it; do not silently reshape the series.
    db({
      guru: [weekly({ id: 'R1', open: '16:00', close: '20:00' }),
        { kind: 'shift', data: { id: 'O1', guru: 'Chad', date: '2026-09-18', open: '18:00', close: '23:00' } }]
    });
    const res = await (await gurusFn(POST({ action: 'merge-shifts' }))).json();
    assert.equal(res.removed, 0);
    assert.equal(res.needsReview, 1);
  });

  test('a one-off on a day the series does not fall on is untouched', async () => {
    db({
      guru: [weekly({ id: 'R1' }),
        { kind: 'shift', data: { id: 'O1', guru: 'Chad', date: '2026-09-19', open: '16:00', close: '22:00' } }]
    });
    const res = await (await gurusFn(POST({ action: 'merge-shifts' }))).json();
    assert.equal(res.removed, 0);
    assert.equal(res.needsReview, 0);
  });

  test('another Guru is never folded into somebody else\'s series', async () => {
    db({
      guru: [weekly({ id: 'R1' }),
        { kind: 'shift', data: { id: 'O1', guru: 'Mike', date: '2026-09-18', open: '16:00', close: '22:00' } }]
    });
    assert.equal((await (await gurusFn(POST({ action: 'merge-shifts' }))).json()).removed, 0);
  });

  test('it leaves a clean rota completely alone', async () => {
    db({
      guru: [
        { kind: 'shift', data: { id: 'A1', guru: 'Chad', date: '2026-09-25', open: '10:00', close: '14:00' } },
        { kind: 'shift', data: { id: 'A2', guru: 'Chad', date: '2026-09-25', open: '17:00', close: '20:00' } },
        { kind: 'shift', data: { id: 'A3', guru: 'Mike', date: '2026-09-25', open: '10:00', close: '14:00' } }
      ]
    });
    const res = await (await gurusFn(POST({ action: 'merge-shifts' }))).json();
    assert.equal(res.removed, 0);
    assert.equal(res.widened, 0);
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
