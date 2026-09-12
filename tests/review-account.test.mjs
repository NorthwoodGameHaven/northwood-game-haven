// tests/review-account.test.mjs — NGH-BUILD 2026-09-12z
// Run:  node --test tests/review-account.test.mjs
//
// The Play review account. Sign-in is a code emailed to the customer, so
// without a fixed-code account Google's reviewer cannot reach the Rewards
// screen at all — and "App access" is a required section of the listing.
//
// Four properties, all of which are quiet failures if they break:
//   1. It is OFF unless BOTH env vars are set. A deploy that forgets them must
//      behave exactly as it did before, not half-enable a backdoor.
//   2. It never touches Lightspeed. The id is not a customer there, so any
//      path that reaches the POS either 404s (reviewer sees a broken app) or,
//      worse, WRITES (signup creating a real customer record).
//   3. Wrong codes are counted against the same ceiling as a real sign-in, so
//      the fixed code is not an unrated six-digit oracle.
//   4. The dashboard it returns is fully populated — a reviewer looking at an
//      empty Rewards screen learns nothing and may reject for it.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SITE_URL = 'https://gamehaven.guru';
process.env.LIGHTSPEED_CLIENT_ID = 'cid';
process.env.LIGHTSPEED_CLIENT_SECRET = 'csecret';
process.env.LIGHTSPEED_DOMAIN = 'teststore';
process.env.PLAY_REVIEW_EMAIL = 'play-review@gamehaven.guru';
process.env.PLAY_REVIEW_CODE = '480126';

const core = await import('../netlify/functions/_shared/lightspeed-core.mjs');
register('./_mock-hooks.mjs', import.meta.url);
const accountFn = (await import('../netlify/functions/account.mjs')).default;

const M = globalThis.__mock;
const REVIEW = 'play-review@gamehaven.guru';
const CODE = '480126';
const api = (path, body, headers = {}) => new Request('https://gamehaven.guru/api/account/' + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const get = (path, headers) => new Request('https://gamehaven.guru/api/account/' + path, { method: 'GET', headers });

let attempts = 0;
function reset(startingAttempts = 0) {
  M.db.handlers.length = 0; M.db.calls.length = 0; M.mail.length = 0;
  attempts = startingAttempts;
  M.db.handlers.push((t) => {
    if (t.startsWith('SELECT attempts FROM login_codes')) return [{ attempts }];
    if (t.startsWith('INSERT INTO login_codes')) { attempts++; return []; }
    if (t.startsWith('UPDATE login_codes')) { attempts = 0; return []; }
    return undefined;
  });
}
// Anything that would reach the POS goes through globalThis.fetch. If the
// review paths are clean, nothing here is ever called.
let lsCalls = [];
globalThis.fetch = async (url, init = {}) => {
  lsCalls.push(String(url) + ' ' + (init.method || 'GET'));
  return new Response(JSON.stringify({ error: 'the review account must never reach Lightspeed' }), { status: 599 });
};

async function signIn() {
  const r = await accountFn(api('verify', { email: REVIEW, code: CODE }));
  assert.equal(r.status, 200, 'review sign-in should succeed');
  return (await r.json()).session;
}

describe('Play review account', () => {
  beforeEach(() => { reset(); lsCalls = []; });

  test('"send code" succeeds without sending anything', async () => {
    const r = await accountFn(api('start', { email: REVIEW }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.equal(M.mail.length, 0, 'there is no inbox to send to — mailing it would just bounce around');
    // Schema bootstrap also mentions login_codes, so match the write itself.
    assert.equal(M.db.calls.filter((c) => /^(INSERT INTO|UPDATE) login_codes/.test(c.text)).length, 0,
      'and no code row is written');
  });

  test('the fixed code signs in and returns a customer', async () => {
    const r = await accountFn(api('verify', { email: REVIEW, code: CODE }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.session, 'a session is issued');
    assert.ok(j.customer, 'a customer comes back, so the app shows the dashboard and not the sign-up form');
    assert.equal(j.customer.email, REVIEW);
    assert.equal(lsCalls.length, 0, 'and Lightspeed was never asked');
  });

  test('a wrong code is refused and counted', async () => {
    const r = await accountFn(api('verify', { email: REVIEW, code: '000000' }));
    assert.equal(r.status, 400);
    assert.equal(attempts, 1, 'the attempt is recorded against the same ceiling as a real sign-in');
  });

  test('five wrong codes locks it, like any other account', async () => {
    reset(5);
    const r = await accountFn(api('verify', { email: REVIEW, code: '000000' }));
    assert.equal(r.status, 429);
  });

  test('a correct code clears the attempt count', async () => {
    reset(3);
    await accountFn(api('verify', { email: REVIEW, code: CODE }));
    assert.equal(attempts, 0);
  });

  test('the dashboard is populated — an empty Rewards screen tells a reviewer nothing', async () => {
    const session = await signIn();
    const r = await accountFn(get('me', { [core.SESSION_HEADER]: session }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.customer.customer_code, 'NGH-0000');
    assert.ok(j.customer.loyalty_balance > 0, 'a balance to look at');
    assert.ok(j.loyalty && j.loyalty.ratio > 0, 'so the earn rule renders');
    assert.ok(j.purchases.length >= 2, 'purchase history');
    assert.ok(j.bookings.length >= 1, 'an upcoming booking');
    assert.ok(j.registrations.length >= 1, 'an event registration');
    assert.equal(lsCalls.length, 0, 'all of it invented here, none of it from the POS');
  });

  test('the upcoming booking and registration are in the future', async () => {
    const session = await signIn();
    const j = await (await accountFn(get('me', { [core.SESSION_HEADER]: session }))).json();
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(j.bookings[0].date > today, 'a past booking would not render under "upcoming"');
    assert.ok(j.registrations[0].occDate > today);
  });

  test('saving the profile succeeds and writes nothing', async () => {
    const session = await signIn();
    const r = await accountFn(new Request('https://gamehaven.guru/api/account/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', [core.SESSION_HEADER]: session },
      body: JSON.stringify({ first_name: 'Someone', phone: '(715) 555-9999' })
    }));
    assert.equal(r.status, 200, 'an error here reads to a reviewer as a broken app');
    assert.equal((await r.json()).customer.first_name, 'Play', 'and the change is not kept');
    assert.equal(lsCalls.length, 0);
  });

  test('signup cannot create a real Lightspeed customer', async () => {
    const session = await signIn();
    const r = await accountFn(api('signup', { first_name: 'Real', last_name: 'Person' }, { [core.SESSION_HEADER]: session }));
    assert.equal(r.status, 200);
    assert.equal(lsCalls.length, 0, 'a stray signup must not write a customer into the POS');
  });

  test('deleting the review account still just queues a request', async () => {
    reset();
    M.db.handlers.push((t) => {
      if (t.startsWith('SELECT count') && t.includes('deletion_requests')) return [{ n: 0 }];
      if (t.startsWith('INSERT INTO deletion_requests')) return [];
      return undefined;
    });
    const r = await accountFn(api('delete-request', { email: REVIEW }));
    assert.equal(r.status, 200);
    assert.equal(lsCalls.length, 0);
  });
});

// The env is read per call rather than at import, so switching the account off
// takes effect on the next invocation — no cold start, no redeploy. That also
// means these can exercise the SAME module instance rather than re-importing a
// second copy, which is a stronger test: it is the real running code.
describe('Play review account — switched off', () => {
  beforeEach(() => {
    reset(); lsCalls = [];
    delete process.env.PLAY_REVIEW_EMAIL;
    delete process.env.PLAY_REVIEW_CODE;
  });
  const restore = () => { process.env.PLAY_REVIEW_EMAIL = REVIEW; process.env.PLAY_REVIEW_CODE = CODE; };

  test('the review address becomes an ordinary address again', async () => {
    try {
      const r = await accountFn(api('start', { email: REVIEW }));
      assert.equal(r.status, 200);
      assert.equal(M.mail.length, 1, 'with no fixed code configured it must fall back to emailing one');
    } finally { restore(); }
  });

  test('the fixed code no longer opens anything', async () => {
    try {
      const r = await accountFn(api('verify', { email: REVIEW, code: CODE }));
      assert.equal(r.status, 400, 'no code has been sent, so verify must refuse');
      assert.match((await r.json()).error, /no code has been sent/);
    } finally { restore(); }
  });

  test('a session minted while it was on stops working', async () => {
    // Switching the account off has to actually close the door, not just stop
    // new sign-ins — otherwise a leaked session outlives the decision.
    restore();
    const session = await signIn();
    delete process.env.PLAY_REVIEW_EMAIL;
    delete process.env.PLAY_REVIEW_CODE;
    try {
      const r = await accountFn(get('me', { [core.SESSION_HEADER]: session }));
      assert.notEqual(r.status, 200, 'the review bundle must not be served once the account is off');
    } finally { restore(); }
  });
});

describe('Play review account — half-configured', () => {
  // An address with no code, or a code the app's six-digit input could never
  // accept, is a typo rather than a configuration. Half-on is the dangerous
  // state, so it has to resolve to off.
  const restore = () => { process.env.PLAY_REVIEW_EMAIL = REVIEW; process.env.PLAY_REVIEW_CODE = CODE; };

  test('an address with no code leaves it off', async () => {
    reset();
    process.env.PLAY_REVIEW_EMAIL = REVIEW;
    delete process.env.PLAY_REVIEW_CODE;
    try {
      const r = await accountFn(api('start', { email: REVIEW }));
      assert.equal(r.status, 200);
      assert.equal(M.mail.length, 1, 'falls back to the normal emailed code');
    } finally { restore(); }
  });

  test('a code that is not six digits leaves it off', async () => {
    reset();
    process.env.PLAY_REVIEW_EMAIL = REVIEW;
    process.env.PLAY_REVIEW_CODE = '1234';
    try {
      await accountFn(api('start', { email: REVIEW }));
      assert.equal(M.mail.length, 1, 'the app only accepts six digits, so a short code could never be typed in');
    } finally { restore(); }
  });
});
