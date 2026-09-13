// tests/mock-companion.test.mjs — NGH-BUILD 2026-09-13a
// Run:  node --test tests/mock-companion.test.mjs
//
// tests/mock-companion.mjs stands in for netlify/functions/companion.mjs so the
// Turn Tracker can be walked in a browser (tests/app-nav.e2e.mjs). A mock that
// drifts from the thing it stands in for is worse than no mock: the e2e goes on
// passing while the app breaks on real hardware. mock-live.mjs learned that the
// expensive way — six screens were being tested, and photographed, empty.
//
// So two things are checked here. First that the mock behaves: a real table,
// hosted, joined, started, played, left. Second that it has not drifted — the
// action list and the public field list are read out of the REAL function's
// source and compared, so adding an action there and forgetting it here fails.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { companionApi, resetTables } from './mock-companion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = fs.readFileSync(path.join(ROOT, 'netlify/functions/companion.mjs'), 'utf8');
const MOCK = fs.readFileSync(path.join(ROOT, 'tests/mock-companion.mjs'), 'utf8');

const call = (method, p, body, qs) =>
  companionApi(p, method, new URL('http://x' + p + (qs || '')), body);

beforeEach(() => resetTables());

function hostTable(name = 'Dustin', color = '#2e9e4f', deviceId = 'devA') {
  const r = call('POST', '/api/companion/tables', { kind: 'turns', settings: { timerSec: 0 }, host: { name, color, deviceId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

describe('the mock serves a real table', () => {
  test('hosting returns a code, a host token and a seated host', () => {
    const t = hostTable();
    assert.match(t.code, /^[A-Z0-9]{5}$/);
    assert.ok(t.hostToken && t.token && t.playerId);
    assert.equal(t.state.status, 'lobby');
    assert.equal(t.state.players.length, 1);
    assert.equal(t.state.players[0].name, 'Dustin');
  });

  test('the public state never leaks a token', () => {
    const t = hostTable();
    const s = JSON.stringify(call('GET', `/api/companion/tables/${t.code}/state`).body);
    assert.ok(!s.includes(t.hostToken), 'hostToken is in the public state');
    assert.ok(!s.includes(t.token), "a player's token is in the public state");
    assert.ok(!s.includes('devA'), 'a device id is in the public state');
  });

  test('a second phone joins and takes a seat', () => {
    const t = hostTable();
    const g = call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sam', color: '#d7263d', deviceId: 'devB' });
    assert.equal(g.status, 200);
    assert.equal(g.body.state.players.length, 2);
    assert.equal(g.body.state.players[1].order, 2);
  });

  test('the same phone joining twice keeps one seat', () => {
    // This is why the e2e needs two browser contexts: the join matches on
    // deviceId and renames the existing player instead of adding one.
    const t = hostTable();
    call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sam', color: '#d7263d', deviceId: 'devB' });
    const again = call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sammy', color: '#d7263d', deviceId: 'devB' });
    assert.equal(again.body.state.players.length, 2);
    assert.equal(again.body.state.players[1].name, 'Sammy');
  });

  test('two players cannot take the same colour', () => {
    const t = hostTable();
    const clash = call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sam', color: '#2e9e4f', deviceId: 'devB' });
    assert.equal(clash.status, 409);
  });

  test('the rotation goes round, and the round counter with it', () => {
    const t = hostTable();
    const g = call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sam', color: '#d7263d', deviceId: 'devB' }).body;
    const started = call('POST', `/api/companion/tables/${t.code}/action`, { token: t.hostToken, action: 'start' }).body.state;
    assert.equal(started.status, 'live');
    assert.equal(started.turn.round, 1);
    assert.equal(started.turn.playerId, t.playerId);

    const second = call('POST', `/api/companion/tables/${t.code}/action`, { token: t.token, action: 'endTurn' }).body.state;
    assert.equal(second.turn.playerId, g.playerId, "the host's turn should pass to the guest");
    assert.equal(second.turn.round, 1);

    const wrapped = call('POST', `/api/companion/tables/${t.code}/action`, { token: g.token, action: 'endTurn' }).body.state;
    assert.equal(wrapped.turn.playerId, t.playerId);
    assert.equal(wrapped.turn.round, 2, 'coming back to the top of the order is a new round');
  });

  test('you cannot end a turn that is not yours', () => {
    const t = hostTable();
    const g = call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sam', color: '#d7263d', deviceId: 'devB' }).body;
    call('POST', `/api/companion/tables/${t.code}/action`, { token: t.hostToken, action: 'start' });
    assert.equal(call('POST', `/api/companion/tables/${t.code}/action`, { token: g.token, action: 'endTurn' }).status, 403);
  });

  test('a stranger is turned away', () => {
    const t = hostTable();
    assert.equal(call('POST', `/api/companion/tables/${t.code}/action`, { token: 'nope', action: 'endTurn' }).status, 401);
  });

  test('only the host can start or end the game', () => {
    const t = hostTable();
    const g = call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sam', color: '#d7263d', deviceId: 'devB' }).body;
    assert.equal(call('POST', `/api/companion/tables/${t.code}/action`, { token: g.token, action: 'start' }).status, 403);
    assert.equal(call('POST', `/api/companion/tables/${t.code}/action`, { token: g.token, action: 'end' }).status, 403);
  });

  test('leaving gives up the seat — which backing out deliberately does not', () => {
    const t = hostTable();
    const g = call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sam', color: '#d7263d', deviceId: 'devB' }).body;
    const after = call('POST', `/api/companion/tables/${t.code}/action`, { token: g.token, action: 'leave' }).body.state;
    assert.equal(after.players.length, 1);
    assert.ok(!after.players.some((p) => p.name === 'Sam'));
  });

  test('the version bumps on every change, so the poller short-circuits', () => {
    const t = hostTable();
    const v1 = call('GET', `/api/companion/tables/${t.code}/state`).body.version;
    assert.equal(call('GET', `/api/companion/tables/${t.code}/state`, null, '?v=' + v1).body.unchanged, true);
    call('POST', `/api/companion/tables/${t.code}/join`, { name: 'Sam', color: '#d7263d', deviceId: 'devB' });
    const again = call('GET', `/api/companion/tables/${t.code}/state`, null, '?v=' + v1).body;
    assert.ok(!again.unchanged, 'a join must break the poller out of unchanged');
    assert.ok(again.version > v1);

    // …and so must every action. A version that stops moving wedges NGH.poll()
    // on {unchanged:true} for good: every phone at the table freezes on the
    // lobby while the game runs on without them.
    let v = again.version;
    for (const action of ['start', 'next', 'reverse', 'pause', 'resume', 'end']) {
      const r = call('POST', `/api/companion/tables/${t.code}/action`, { token: t.hostToken, action });
      assert.equal(r.status, 200, action + ': ' + JSON.stringify(r.body));
      assert.ok(r.body.state.version > v, action + ' did not bump the version (' + r.body.state.version + ' after ' + v + ')');
      assert.ok(!call('GET', `/api/companion/tables/${t.code}/state`, null, '?v=' + v).body.unchanged, action + ' left the poller stuck');
      v = r.body.state.version;
    }
  });

  test('an unknown table is a 404, not an empty lobby', () => {
    assert.equal(call('GET', '/api/companion/tables/ZZZZZ/state').status, 404);
    assert.equal(call('POST', '/api/companion/tables/ZZZZZ/join', { name: 'Sam' }).status, 404);
  });

  test('it keeps its hands off every other route', () => {
    assert.equal(companionApi('/api/specials', 'GET', new URL('http://x/api/specials')), null);
    assert.equal(companionApi('/api/karaoke/active', 'GET', new URL('http://x/api/karaoke/active')), null);
  });

  test('table codes never repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(hostTable('H' + i, '#2e9e4f', 'd' + i).code);
    assert.equal(seen.size, 40);
  });
});

describe('and has not drifted from the real function', () => {
  const actions = (src) => [...src.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]).sort();

  test('it answers every action companion.mjs implements', () => {
    const real = new Set(actions(REAL));
    const mock = new Set(actions(MOCK));
    const missing = [...real].filter((a) => !mock.has(a));
    assert.deepEqual(missing, [], 'actions in companion.mjs with no mock: ' + missing.join(', '));
  });

  test('and invents none of its own', () => {
    const real = new Set(actions(REAL));
    const extra = [...new Set(actions(MOCK))].filter((a) => !real.has(a));
    assert.deepEqual(extra, [], 'actions the mock made up: ' + extra.join(', '));
  });

  test('pub() strips and keeps the same fields', () => {
    const fields = (src) => {
      const m = /o\.players = \(s\.players \|\| \[\]\)\.map\(\(?p\)? => \(\{([^}]*)\}\)\)/.exec(src);
      assert.ok(m, 'pub() has changed shape in ' + (src === REAL ? 'companion.mjs' : 'the mock'));
      return m[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean).sort();
    };
    assert.deepEqual(fields(MOCK), fields(REAL));
    for (const src of [REAL, MOCK]) assert.match(src, /delete o\.hostToken/);
  });

  test('the same limits apply', () => {
    for (const src of [REAL, MOCK]) {
      assert.ok(/players\.length >= 16/.test(src), 'the 16-player cap');
      assert.ok(/Math\.min\(3600, Math\.max\(0/.test(src), 'the timer clamp');
      assert.ok(/slice\(-50\)/.test(src), 'the 50-entry history window');
    }
  });
});
