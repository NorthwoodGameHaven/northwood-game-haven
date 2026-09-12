// NGH-BUILD 2026-09-12t
// tests/db-responses.test.mjs — the REAL netlify/functions/_shared/db.mjs.
//
// Every other suite loads db.mjs through tests/_mock-hooks.mjs, which swaps the
// whole module out for an in-memory copy. That is the right call for testing
// the functions built on top of it — but it means the real file was executed by
// nothing, ever, and a bug in it could not be caught.
//
// One was. noContent() returned:
//
//     new Response('', { status: 204, headers: CORS })
//
// 204 is a null-body status in the fetch spec, so the Response constructor
// throws a TypeError on any body at all, empty string included. Result: EVERY
// delete endpoint in the codebase — bookings, events, gurus, interest-events,
// karaoke, mtg, registrations, specials, speedgaming — returned
// "Server error: Response constructor: Invalid response status code 204",
// and every CORS preflight failed the same way. It hid for months because each
// function's top-level catch turns the throw into a generic 500, and because
// same-origin fetches never send a preflight.
//
// This file loads db.mjs for real, stubbing only the Neon driver.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.NETLIFY_DATABASE_URL = 'postgres://stub/stub';
process.env.ADMIN_SECRET = 'test-admin-secret';

register('./_neon-stub.mjs', import.meta.url);
const db = await import('../netlify/functions/_shared/db.mjs');

describe('null-body responses', () => {
  // The spec rule this file is guarding. If Node ever stops enforcing it the
  // tests below stop meaning anything, so assert the rule itself.
  test('the platform really does reject a body on a 204', () => {
    assert.throws(() => new Response('', { status: 204 }), /Invalid response status code 204/);
  });

  test('noContent() does not throw', () => {
    assert.doesNotThrow(() => db.noContent());
  });

  test('noContent() is a 204 with no body', async () => {
    const r = db.noContent();
    assert.equal(r.status, 204);
    assert.equal(r.body, null);
    assert.equal(await r.text(), '');
  });

  test('preflight() does not throw', () => {
    assert.doesNotThrow(() => db.preflight());
  });

  test('preflight() is a 204 that answers CORS', () => {
    const r = db.preflight();
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  });
});

describe('the other response helpers', () => {
  test('json() carries the body and the CORS header', async () => {
    const r = db.json({ hello: 'there' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await r.json(), { hello: 'there' });
  });

  test('json() takes a status', async () => {
    assert.equal(db.json({ error: 'nope' }, 409).status, 409);
  });

  test('json(null) sends an empty body on a 200, which is legal', async () => {
    const r = db.json(null);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '');
  });

  test('bad() defaults to 400 and shapes the error', async () => {
    const r = db.bad('no good');
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'no good' });
  });

  test('bad() takes a status', () => {
    assert.equal(db.bad('unauthorized', 401).status, 401);
    assert.equal(db.bad('boom', 500).status, 500);
  });
});

describe('admin tokens', () => {
  test('a fresh token verifies', () => {
    assert.equal(db.verifyToken(db.issueToken()), true);
  });

  test('an expired one does not', () => {
    const past = Date.now() - 1000;
    // Rebuild the shape the issuer produces, but dated in the past.
    const stale = db.issueToken(-1);
    assert.equal(db.verifyToken(stale), false, 'a token that expired must be refused');
    assert.ok(past);
  });

  test('a tampered token does not', () => {
    const t = db.issueToken();
    const [exp, mac] = t.split('.');
    assert.equal(db.verifyToken((+exp + 3600000) + '.' + mac), false,
      'extending your own expiry must not verify');
    assert.equal(db.verifyToken(exp + '.' + '0'.repeat(mac.length)), false);
  });

  test('junk does not verify and does not throw', () => {
    for (const junk of ['', 'nope', '.', 'abc.def', null, undefined]) {
      assert.doesNotThrow(() => db.verifyToken(junk), String(junk));
      assert.equal(db.verifyToken(junk), false, String(junk));
    }
  });

  test('requireAdmin reads the Bearer header', () => {
    const t = db.issueToken();
    const req = (h) => new Request('https://gamehaven.guru/x', { headers: h });
    assert.equal(db.requireAdmin(req({ Authorization: 'Bearer ' + t })), true);
    assert.equal(db.requireAdmin(req({ Authorization: 'bearer ' + t })), true, 'case-insensitive scheme');
    assert.equal(db.requireAdmin(req({ Authorization: t })), true, 'bare token still accepted');
    assert.equal(db.requireAdmin(req({})), false);
    assert.equal(db.requireAdmin(req({ Authorization: 'Bearer nonsense' })), false);
  });
});
