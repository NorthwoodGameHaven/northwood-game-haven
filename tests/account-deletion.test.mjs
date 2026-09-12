// tests/account-deletion.test.mjs — NGH-BUILD 2026-09-12y
// Run:  node --test tests/account-deletion.test.mjs
//
// POST /api/account/delete-request exists because Google Play will not accept
// the listing without an account-deletion path, and it has three properties
// that are easy to break and expensive to get wrong:
//
//   1. It is PUBLIC. site/account-delete.html has to work for somebody who
//      already uninstalled the app, so the route must sit above the session
//      gate in account.mjs. Move it below and every web request 401s.
//   2. It DELETES NOTHING. A Guru actions it by hand, because completed sales
//      have to be kept for tax. A test here should fail loudly if this ever
//      starts issuing DELETEs.
//   3. It must not leak whether an address has an account — the same posture
//      as /start. The reply is identical either way.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.SITE_URL = 'https://gamehaven.guru';
process.env.ADMIN_EMAIL = 'desk@northwoodgamehaven.com';
process.env.LIGHTSPEED_CLIENT_ID = 'cid';
process.env.LIGHTSPEED_CLIENT_SECRET = 'csecret';
process.env.LIGHTSPEED_DOMAIN = 'teststore';

const core = await import('../netlify/functions/_shared/lightspeed-core.mjs');
register('./_mock-hooks.mjs', import.meta.url);
const accountFn = (await import('../netlify/functions/account.mjs')).default;

const M = globalThis.__mock;
const URL_ = 'https://gamehaven.guru/api/account/delete-request';
const post = (body, headers = {}) => new Request(URL_, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

let inserted = [];
function reset(existingInLastHour = 0) {
  // The mock replaces neither object — the module captured this handle at
  // import time, so it has to be emptied in place, not reassigned.
  M.db.handlers.length = 0; M.db.calls.length = 0;
  M.mail.length = 0; inserted = [];
  M.db.handlers.push((t, v) => {
    if (t.startsWith('SELECT count') && t.includes('FROM deletion_requests')) return [{ n: existingInLastHour }];
    if (t.startsWith('INSERT INTO deletion_requests')) {
      inserted.push({ id: v[0], email: v[1], data: JSON.parse(v[2]) });
      return [];
    }
    return undefined;
  });
}
const admin = () => M.mail.find((m) => m.to === 'desk@northwoodgamehaven.com');
const toUser = (addr) => M.mail.find((m) => m.to === addr);

describe('POST /api/account/delete-request', () => {
  beforeEach(() => reset());

  test('works with no session at all — the web page has no account', async () => {
    const r = await accountFn(post({ email: 'pat@example.com' }));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.queued, true);
    assert.equal(inserted.length, 1);
  });

  test('rejects an address that is not one', async () => {
    for (const email of ['', 'nope', 'a@b', 'two words@example.com']) {
      reset();
      const r = await accountFn(post({ email }));
      assert.equal(r.status, 400, 'should reject ' + JSON.stringify(email));
      assert.equal(inserted.length, 0);
      assert.equal(M.mail.length, 0, 'a rejected address must not send mail');
    }
  });

  test('records who asked, what they said, and where from', async () => {
    await accountFn(post({ email: 'Pat@Example.com ', name: '  Pat   Okafor ', note: 'moving away' }));
    assert.equal(inserted.length, 1);
    const row = inserted[0];
    assert.equal(row.email, 'pat@example.com', 'email is normalised for the rate limit and the lookup');
    assert.equal(row.data.name, 'Pat Okafor');
    assert.equal(row.data.note, 'moving away');
    assert.equal(row.data.source, 'web');
    assert.equal(row.data.signedInAs, null);
    assert.match(row.id, /^del_/);
    assert.ok(Date.parse(row.data.requestedAt) > 0, 'requestedAt must be a real timestamp');
  });

  test('a signed-in request is marked as coming from the app, with the customer id', async () => {
    const session = core.issueSession('test-admin-secret', 'cust-9001');
    await accountFn(post({ email: 'pat@example.com' }, { [core.SESSION_HEADER]: session }));
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].data.source, 'app');
    assert.equal(inserted[0].data.signedInAs, 'cust-9001');
  });

  test('emails the shop with what it needs to action it', async () => {
    await accountFn(post({ email: 'pat@example.com', name: 'Pat', note: 'please remove me' }));
    const a = admin();
    assert.ok(a, 'the shop must be told, or nobody ever actions it');
    assert.match(a.subject, /pat@example\.com/);
    assert.match(a.bodyText, /pat@example\.com/);
    assert.match(a.bodyText, /please remove me/);
    assert.match(a.bodyText, /del_/, 'the request id is the handle for the audit trail');
    assert.equal(a.replyTo, 'pat@example.com', 'so a Guru can just hit reply');
  });

  test('confirms to the requester without revealing whether an account exists', async () => {
    await accountFn(post({ email: 'stranger@example.com' }));
    const c = toUser('stranger@example.com');
    assert.ok(c, 'the requester gets a confirmation');
    assert.match(c.bodyText, /30 days/);
    assert.match(c.bodyText, /del_/, 'a reference they can quote');
    // The reply must read the same whether or not they are a customer.
    assert.doesNotMatch(c.bodyText, /rewards balance is|we found your|your customer (code|id)/i);
  });

  test('an unknown address gets the same answer as a real one', async () => {
    const r1 = await accountFn(post({ email: 'real@example.com' }));
    const j1 = await r1.json();
    reset();
    const r2 = await accountFn(post({ email: 'ghost@example.com' }));
    const j2 = await r2.json();
    assert.equal(r1.status, r2.status);
    assert.deepEqual(Object.keys(j1).sort(), Object.keys(j2).sort());
    assert.equal(j1.ok, j2.ok);
    assert.equal(j1.queued, j2.queued);
  });

  test('three in an hour is enough — the fourth is swallowed, not bounced', async () => {
    reset(3);
    const r = await accountFn(post({ email: 'pat@example.com' }));
    assert.equal(r.status, 200, 'still 200 — a 429 would leak that the address is known to us');
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.queued, false);
    assert.equal(inserted.length, 0, 'no duplicate row');
    assert.equal(M.mail.length, 0, 'and the shop is not paged a fourth time');
  });

  test('two under the limit still goes through', async () => {
    reset(2);
    const r = await accountFn(post({ email: 'pat@example.com' }));
    assert.equal((await r.json()).queued, true);
    assert.equal(inserted.length, 1);
  });

  test('it deletes nothing — this endpoint only ever queues', async () => {
    await accountFn(post({ email: 'pat@example.com' }));
    const destructive = M.db.calls.filter((c) => /^\s*(DELETE|DROP|TRUNCATE|UPDATE)\b/i.test(c.text));
    assert.deepEqual(destructive, [],
      'a Guru actions deletion by hand; automatic purging would take out sales history that has to be kept');
  });

  test('a long note is truncated rather than stored whole', async () => {
    await accountFn(post({ email: 'pat@example.com', note: 'x'.repeat(5000) }));
    assert.equal(inserted[0].data.note.length, 1000);
  });

  test('the mail still sends when the note and name are missing', async () => {
    await accountFn(post({ email: 'pat@example.com' }));
    assert.ok(admin());
    assert.ok(toUser('pat@example.com'));
    assert.equal(inserted[0].data.name, '');
  });

  test('a mail failure does not lose the request', async () => {
    // The row is the thing that matters; the emails are a convenience. If
    // Resend is down the customer must still be in the queue.
    reset();
    const realPush = M.mail.push.bind(M.mail);
    M.mail.push = () => { throw new Error('resend is down'); };
    try {
      const r = await accountFn(post({ email: 'pat@example.com' }));
      assert.equal(r.status, 200);
      assert.equal(inserted.length, 1, 'the queue row survives a mail outage');
    } finally { M.mail.push = realPush; }
  });

  test('GET is not a way to do this', async () => {
    const r = await accountFn(new Request(URL_, { method: 'GET' }));
    assert.notEqual(r.status, 200);
  });
});
