// NGH-BUILD 2026-09-12p
// tests/auto-cancel.test.mjs — the nightly sweep, run for real against an
// in-memory database.
//
// This file exists because of one booking. Robyn paid her booking fee for the
// Depths, owed only the refundable deposit that is payable on the day, and the
// software cancelled her party and emailed her about it. More than once.
//
// So these tests are not "does auto-cancel work". They are two promises:
//
//   1. THE DEPOSIT NEVER CANCELS ANYBODY. Not as a trigger, not as half of a
//      condition, not ever. It appears only as something that can save a
//      booking.
//   2. NOTHING IS CANCELLED BEFORE IT IS OVER. Not the night before, not at
//      the start time, not while the guests are in the room.
//
// The pure date/payment predicates are tested directly. The handler is then
// run end to end through _mock-hooks.mjs, so the SQL it emits and the mail it
// sends are the real ones.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.ADMIN_EMAIL = 'ops@example.com';
process.env.SITE_URL = 'https://gamehaven.guru';
process.env.RESEND_API_KEY = 'test-key';

register('./_mock-hooks.mjs', import.meta.url);
const mod = await import('../netlify/functions/auto-cancel.mjs');
const { bookingEndsAt, nothingPaid } = mod;

// ---------------------------------------------------------------------------
// Store-local wall clock. Chicago is UTC-5 in September (CDT).
const CDT = 5 * 3600000;
const chi = (dateStr, hh, mm = 0) => Date.UTC(
  +dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), hh, mm) + CDT;

const bk = (over = {}) => ({
  id: 'BK-1', name: 'Robyn', email: 'robyn@example.com',
  date: '2026-09-10', start: '18:00', hours: 3, rooms: ['depths'], ...over
});

describe('the deposit can never cancel anybody', () => {
  // nothingPaid is the ONLY gate between a booking and a cancellation. If it
  // returns false the booking is untouchable, whatever the dates say.
  const sparing = [
    ['fee paid, deposit still due — this is Robyn', { feePaid: true }],
    ['deposit paid, fee still due', { depositPaid: true }],
    ['both paid', { feePaid: true, depositPaid: true }],
    ['payment marked paid', { payment: 'paid' }],
    ['on account in Lightspeed', { payment: 'onaccount' }],
    ['fee on account', { feeOnAccount: true }],
    ['deposit on account', { depositOnAccount: true }]
  ];
  for (const [label, over] of sparing) {
    test(`spared: ${label}`, () => {
      assert.equal(nothingPaid(bk(over)), false, 'anything paid must make the booking untouchable');
    });
  }

  test('only a booking with nothing at all against it is even a candidate', () => {
    assert.equal(nothingPaid(bk()), true);
    assert.equal(nothingPaid(bk({ feePaid: false, depositPaid: false })), true);
    // Guard against a truthy-but-not-true value being read as payment.
    assert.equal(nothingPaid(bk({ feePaid: 'no' })), true);
  });

  test('an unpaid deposit is not part of the question at all', () => {
    // The two records differ ONLY in the deposit. If the deposit had any say,
    // these would disagree.
    assert.equal(nothingPaid(bk({ depositPaid: false })), nothingPaid(bk({})));
  });
});

describe('a booking is over before anything happens to it', () => {
  test('the end is start + hours in store time', () => {
    // 6 PM + 3h on 10 Sep 2026 = 9 PM Central.
    assert.equal(bookingEndsAt(bk()).getTime(), chi('2026-09-10', 21, 0));
  });

  test('an hour before the end is still too early', () => {
    const end = bookingEndsAt(bk()).getTime();
    assert.ok(end > chi('2026-09-10', 20, 0), 'must not be cancellable at 8 PM');
  });

  test('7 PM Central — when this cron actually runs — is inside a 6 PM booking', () => {
    // @daily fires at midnight UTC = 7 PM CDT. Using the START time would have
    // released this room with the guests in it. This is the regression.
    const cronFires = chi('2026-09-10', 19, 0);
    assert.ok(bookingEndsAt(bk()).getTime() > cronFires,
      'the 7 PM cron must not be able to cancel a 6 PM booking that is still running');
  });

  test('no start time means the end of the day, never earlier', () => {
    assert.equal(bookingEndsAt(bk({ start: '', hours: 0 })).getTime(), chi('2026-09-10', 23, 59) + 59000);
    assert.equal(bookingEndsAt(bk({ start: '10:00', allDay: true })).getTime(), chi('2026-09-10', 23, 59) + 59000);
  });

  test('a session running past midnight is capped at its own day', () => {
    assert.equal(bookingEndsAt(bk({ start: '22:00', hours: 5 })).getTime(), chi('2026-09-10', 23, 59) + 59000);
  });

  test('a missing or malformed date is never cancellable', () => {
    assert.equal(bookingEndsAt(bk({ date: '' })), null);
    assert.equal(bookingEndsAt(bk({ date: 'soon' })), null);
    assert.equal(bookingEndsAt(null), null);
  });

  test('winter bookings use CST, not a hardcoded offset', () => {
    // 10 Jan 2026, 6 PM Central = UTC-6.
    const end = bookingEndsAt(bk({ date: '2026-01-10', start: '18:00', hours: 1 }));
    assert.equal(end.toISOString(), '2026-01-11T01:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// End to end: run the real handler against the mock database.
const M = () => globalThis.__mock;

function setup(bookings, { enabled } = {}) {
  // The mocks captured globalThis.__mock at module load, so reset it IN PLACE.
  // Replacing the object leaves the mock writing to an orphan and every
  // assertion quietly passing against an empty log.
  const m = globalThis.__mock;
  m.db.handlers.length = 0; m.db.calls.length = 0; m.mail.length = 0;
  const guestMail = [];
  globalThis.fetch = async (url, opts) => {
    guestMail.push(JSON.parse(opts.body));
    return new Response('{}', { status: 200 });
  };
  M().db.handlers.push((text) => {
    if (/SELECT data, created_at FROM bookings/.test(text)) return bookings.map(d => ({ data: d, created_at: '2026-08-01T00:00:00Z' }));
    if (/FROM events/.test(text) || /FROM registrations/.test(text) || /FROM bookings/.test(text) || /birthday_requests/.test(text)) return [];
    return [];
  });
  if (enabled === false) process.env.AUTO_CANCEL_ENABLED = '0';
  else delete process.env.AUTO_CANCEL_ENABLED;
  return { guestMail, updates: () => M().db.calls.filter(c => /^UPDATE bookings/.test(c.text)) };
}

async function runAt(isoNow, bookings, opts = {}) {
  const ctx = setup(bookings, opts);
  // AUTO_CANCEL_ENABLED is read once, at module load — which on Netlify means
  // once per deploy, hence "change it and trigger a deploy" in the runbook.
  // A test that only sets process.env would silently exercise the wrong branch,
  // so load a fresh instance of the module instead.
  const fn = opts.enabled === false
    ? (await import('../netlify/functions/auto-cancel.mjs?killswitch=1')).default
    : mod.default;
  const RealDate = Date;
  const fixed = new RealDate(isoNow).getTime();
  // eslint-disable-next-line no-global-assign
  globalThis.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
    static now() { return fixed; }
  };
  try { await fn(); }
  finally { globalThis.Date = RealDate; }
  return ctx;
}

describe('the nightly run, end to end', () => {
  // A 6-9 PM booking on 10 Sep 2026 with nothing paid.
  const unpaid = bk();

  test('the cron firing at 7 PM does not touch a booking still in progress', async () => {
    const { updates, guestMail } = await runAt('2026-09-11T00:00:00Z', [unpaid]);  // 7 PM CDT, 10 Sep
    assert.equal(updates().length, 0, 'the guests are in the room');
    assert.equal(guestMail.length, 0);
  });

  test('nor the night before, which is when Robyn lost hers', async () => {
    const { updates, guestMail } = await runAt('2026-09-10T00:00:00Z', [unpaid]);  // 7 PM CDT, 9 Sep
    assert.equal(updates().length, 0);
    assert.equal(guestMail.length, 0);
  });

  test('once it is over and the fee was never paid, it is closed out', async () => {
    const { updates, guestMail } = await runAt('2026-09-12T00:00:00Z', [unpaid]);  // 7 PM CDT, 11 Sep
    assert.equal(updates().length, 1);
    assert.match(updates()[0].values.map(v => String(v)).join(' '), /"status":"rejected"/);
    assert.equal(guestMail.length, 1, 'and the guest hears about it while it is still recent');
  });

  test('the guest is never told the deposit was the reason', async () => {
    const { guestMail } = await runAt('2026-09-12T00:00:00Z', [unpaid]);
    const body = guestMail[0].subject + ' ' + guestMail[0].text;
    assert.match(body, /booking fee/i, 'the fee is the reason and should be named');
    assert.ok(!/deposit hold/i.test(body), 'the old copy blamed the deposit hold');
    assert.match(guestMail[0].text, /deposit is payable on the day and had nothing to do with this/i);
    assert.match(guestMail[0].text, /reply to this email/i, 'a wrongly-cancelled guest needs a way back');
  });

  test('Robyn — fee paid, deposit due — survives every run', async () => {
    for (const iso of ['2026-09-10T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-12T00:00:00Z', '2026-12-01T00:00:00Z']) {
      const { updates, guestMail } = await runAt(iso, [bk({ feePaid: true })]);
      assert.equal(updates().length, 0, 'no write on ' + iso);
      assert.equal(guestMail.length, 0, 'no email on ' + iso);
    }
  });

  test('a deposit-paid, fee-unpaid booking also survives', async () => {
    const { updates } = await runAt('2026-12-01T00:00:00Z', [bk({ depositPaid: true })]);
    assert.equal(updates().length, 0);
  });

  test('a long-past no-show is closed out without emailing them', async () => {
    const { updates, guestMail } = await runAt('2026-10-01T00:00:00Z', [unpaid]);
    assert.equal(updates().length, 1, 'the record should not sit approved forever');
    assert.equal(guestMail.length, 0, 'nobody needs a cancellation notice three weeks later');
  });

  test('AUTO_CANCEL_ENABLED=0 stops all of it', async () => {
    const { updates, guestMail } = await runAt('2026-09-12T00:00:00Z', [unpaid], { enabled: false });
    assert.equal(updates().length, 0);
    assert.equal(guestMail.length, 0);
    const digest = M().mail.map(m => m.bodyText || '').join('\n');
    assert.match(digest, /NOTHING WAS CANCELED/, 'staff still need to see it');
    assert.match(digest, /BK-1/);
  });

  test('staff always get told, whichever way it went', async () => {
    await runAt('2026-09-12T00:00:00Z', [unpaid]);
    const digest = M().mail.map(m => m.bodyText || '').join('\n');
    assert.match(digest, /CLOSED OUT/);
    assert.match(digest, /BK-1/);
    assert.match(digest, /deposit was never part of it/i);
  });

  test('a mixed night: only the finished, wholly unpaid one moves', async () => {
    const list = [
      bk({ id: 'BK-PAID', feePaid: true }),
      bk({ id: 'BK-DEP', depositPaid: true }),
      bk({ id: 'BK-ACCT', payment: 'onaccount' }),
      bk({ id: 'BK-FUTURE', date: '2099-01-01' }),
      bk({ id: 'BK-NODATE', date: '' }),
      bk({ id: 'BK-GONE' })
    ];
    const { updates } = await runAt('2026-09-12T00:00:00Z', list);
    assert.equal(updates().length, 1);
    assert.ok(updates()[0].values.some(v => v === 'BK-GONE'), 'only the one that is over and wholly unpaid');
  });
});
