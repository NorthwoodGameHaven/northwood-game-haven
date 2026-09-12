// NGH-BUILD 2026-09-12h
// tests/pricing.test.mjs — the server-side booking pricing authority.
// These numbers are what a customer is actually charged, so they are asserted
// against the ladder published on booking.html rather than against the code.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../netlify/functions/_shared/pricing.mjs';

const base = (over = {}) => ({ rooms: ['depths'], hours: 4, addons: [], ...over });

describe('calcRoomCost — $10/hr first 4 hours, $5/hr after', () => {
  test('matches the published ladder', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(P.calcRoomCost), [10, 20, 30, 40, 45, 50, 55, 60]);
  });
  test('0 and junk are 0, never NaN', () => {
    assert.equal(P.calcRoomCost(0), 0);
    assert.equal(P.calcRoomCost(undefined), 0);
    assert.equal(P.calcRoomCost('nope'), 0);
  });
});

describe('computeBookingMoney', () => {
  test('one room, 4h: $40 + 5.5% tax + $40 deposit', () => {
    const m = P.computeBookingMoney(base());
    assert.deepEqual(
      { costBooking: m.costBooking, tax: m.tax, deposit: m.deposit, totalDue: m.totalDue },
      { costBooking: 40, tax: 2.2, deposit: 40, totalDue: 82.2 });
  });

  test('the room charge is PER ROOM — two rooms doubles the fee and lifts the deposit', () => {
    const m = P.computeBookingMoney(base({ rooms: ['holt', 'den'] }));
    assert.equal(m.costBooking, 80);
    assert.equal(m.deposit, 80);
    assert.equal(m.tax, 4.4);
  });

  test('karaoke adds $25 to the DEPOSIT only — never taxed, never a fee', () => {
    const plain = P.computeBookingMoney(base());
    const kara = P.computeBookingMoney(base({ addons: [{ id: 'karaoke' }] }));
    assert.equal(kara.deposit, plain.deposit + 25);
    assert.equal(kara.costBooking, plain.costBooking, 'karaoke must not change the fee');
    assert.equal(kara.tax, plain.tax, 'the deposit is never taxed');
  });

  test('paid add-ons: BYO food is flat $40, a Guru is $10/hr each', () => {
    const byo = P.computeBookingMoney(base({ addons: [{ id: 'byofood' }] }));
    assert.equal(byo.costBooking, 80);                       // 40 room + 40 byo
    const guru = P.computeBookingMoney(base({ hours: 4, addons: [{ id: 'guru', qty: 2 }] }));
    assert.equal(guru.costBooking, 40 + (10 * 4 * 2));       // 2 Gurus × 4h
    // and a Guru scales with hours, unlike BYO food
    const guru8 = P.computeBookingMoney(base({ hours: 8, addons: [{ id: 'guru', qty: 1 }] }));
    assert.equal(guru8.costBooking, 60 + 80);
  });

  test('military discount is 15% of the subtotal, applied before tax, never to the deposit', () => {
    const m = P.computeBookingMoney(base({ milRequested: true }));
    assert.equal(m.subtotal, 40);
    assert.equal(m.discount, 6);
    assert.equal(m.costBooking, 34);
    assert.equal(m.tax, 1.87);              // 34 × 5.5%
    assert.equal(m.deposit, 40, 'the deposit must not be discounted');
    assert.equal(m.totalDue, 75.87);
  });

  test('a staff deposit waiver survives a reprice; the base is refreshed', () => {
    // adjustDeposit waived the $40 deposit to $0 on a 4h one-room booking…
    const waived = { ...base(), deposit: 0, depositBase: 40 };
    const m = P.computeBookingMoney(waived);
    assert.equal(m.deposit, 0, 'the waiver must not be undone by a reprice');
    assert.equal(m.depositBase, 40);
    // …and adding karaoke updates the base while keeping the waiver
    const m2 = P.computeBookingMoney({ ...waived, addons: [{ id: 'karaoke' }] });
    assert.equal(m2.deposit, 0);
    assert.equal(m2.depositBase, 65);
  });

  test('no rooms means no charge and no deposit', () => {
    const m = P.computeBookingMoney(base({ rooms: [] }));
    assert.deepEqual({ c: m.costBooking, d: m.deposit, t: m.totalDue }, { c: 0, d: 0, t: 0 });
  });

  test('THE REGRESSION: repricing 4h → 1h actually changes the money', () => {
    // Live on 2026-09-12, editing NGH-Y3NOS3-349 to 1 hour left costBooking at
    // 40 and the pay-link at $42.20 instead of $10.55.
    const four = P.computeBookingMoney(base({ hours: 4 }));
    const one = P.computeBookingMoney(base({ hours: 1 }));
    assert.equal(four.costBooking, 40);
    assert.equal(one.costBooking, 10);
    assert.equal(one.tax, 0.55);
    assert.equal(one.totalDue, 50.55);      // 10 + 0.55 + 40 deposit
    assert.notEqual(one.costBooking, four.costBooking);
  });
});

describe('hoursError — the 4-hour customer minimum is a server rule, not a dropdown', () => {
  test('customers are held to 4 hours', () => {
    for (const h of [1, 2, 3]) assert.match(P.hoursError(h) || '', /4-hour minimum/);
    for (const h of [4, 5, 8]) assert.equal(P.hoursError(h), null);
  });
  test('staff may book 1-8 hours in person', () => {
    for (const h of [1, 2, 3, 4, 8]) assert.equal(P.hoursError(h, { isStaff: true }), null);
  });
  test('nobody exceeds the 8-hour ceiling, or books zero/garbage', () => {
    assert.match(P.hoursError(9, { isStaff: true }) || '', /maximum/);
    assert.match(P.hoursError(0, { isStaff: true }) || '', /whole number/);
    assert.match(P.hoursError('abc', { isStaff: true }) || '', /whole number/);
  });
});

describe('client money fields are never trusted', () => {
  test('every stored money field is on the strip list', () => {
    const produced = Object.keys(P.computeBookingMoney(base()));
    for (const k of produced) {
      if (k === 'deposit') continue;   // sanctioned staff override
      assert.ok(P.CLIENT_MONEY_FIELDS.includes(k), k + ' is computed but not stripped from client input');
    }
  });
  test('a shape change is detected for every input the price depends on', () => {
    assert.deepEqual(P.PRICE_SHAPE_FIELDS.slice().sort(), ['addons', 'hours', 'milRequested', 'rooms']);
  });
});
