// NGH-BUILD 2026-09-12l
// tests/speedgaming-api.test.mjs — the Speed Gaming session engine, end to end.
//
// The real handler runs against a real in-memory table (see _speedgaming-hooks),
// so optimistic concurrency, the draft/publish lifecycle and the derived history
// are all exercised rather than mocked. The engine itself is covered by
// speedgaming.test.mjs; this is about the night going right around it: people
// joining late, a Guru pulling a round back, two tablets saving at once.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./_speedgaming-hooks.mjs', import.meta.url);
const fn = (await import('../netlify/functions/speedgaming.mjs')).default;
const S = globalThis.__sg;

const BASE = 'https://gamehaven.guru/.netlify/functions/speedgaming';
const ADMIN = { authorization: 'Bearer admin-ok' };

async function call(method, path, { body, headers } = {}) {
  const res = await fn(new Request(BASE + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
  let json = null;
  try { json = await res.clone().json(); } catch { /* 204 / png */ }
  return { status: res.status, body: json, res };
}
const asGuru = (method, path, body) => call(method, path, { body, headers: ADMIN });
const control = (code, body) => asGuru('POST', '/sessions/' + code + '/control', body);

async function newSession(over = {}) {
  const r = await asGuru('POST', '/sessions', Object.assign({ date: '2026-09-17', eventId: 'EVT-PITPB5-103' }, over));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.code;
}
async function joinMany(code, names) {
  const out = [];
  for (const n of names) {
    const r = await call('POST', '/sessions/' + code + '/join', { body: { name: n, deviceId: 'dev-' + n } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    out.push(r.body);
  }
  return out;
}
const state = async (code, q = '') => (await call('GET', '/sessions/' + code + '/state' + q)).body;
async function playRound(code) {
  await control(code, { action: 'pairRound' });
  await control(code, { action: 'publishRound' });
}

beforeEach(() => { S.rows.clear(); S.calls.length = 0; S.clock.t = 0; S.beforeUpdate = null; });

// ---- session lifecycle ------------------------------------------------------
describe('creating a meet-up', () => {
  test('needs a Guru', async () => {
    assert.equal((await call('POST', '/sessions', { body: {} })).status, 401);
    assert.equal((await call('GET', '/sessions')).status, 401);
  });

  test('returns a 4-letter code and a join URL', async () => {
    const r = await asGuru('POST', '/sessions', { date: '2026-09-17' });
    assert.equal(r.status, 201);
    assert.match(r.body.code, /^[A-HJ-NP-Z]{4}$/);
    assert.equal(r.body.joinUrl, 'https://gamehaven.guru/speedgaming?c=' + r.body.code);
  });

  test('defaults to the published format — 3 rounds of 10 teach / 40 play / 10 break', async () => {
    const s = await state(await newSession());
    assert.equal(s.settings.rounds, 3);
    assert.deepEqual(s.settings.phases.map(p => [p.id, p.minutes]), [['teach', 10], ['play', 40], ['break', 10]]);
    assert.equal(s.settings.roundLengthMs, 3_600_000);
  });

  test('a code collision retries instead of failing the Guru', async () => {
    // Force the first attempt to hit an existing row.
    const taken = await newSession();
    const realRandom = Math.random;
    const r = await asGuru('POST', '/sessions', {});
    Math.random = realRandom;
    assert.equal(r.status, 201);
    assert.notEqual(r.body.code, taken);
  });

  test('/active surfaces the running meet-up for the TV to pick up', async () => {
    assert.equal((await call('GET', '/active')).body.active, null);
    const code = await newSession({ title: 'Speed Gaming Meet-up' });
    await joinMany(code, ['Ann']);
    const a = (await call('GET', '/active')).body.active;
    assert.equal(a.code, code);
    assert.equal(a.playing, 1);
  });
});

// ---- check-in ---------------------------------------------------------------
describe('checking people in', () => {
  test('a name is required and a token comes back', async () => {
    const code = await newSession();
    assert.equal((await call('POST', '/sessions/' + code + '/join', { body: { name: '  ' } })).status, 400);
    const r = await call('POST', '/sessions/' + code + '/join', { body: { name: 'Ann' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.token && r.body.playerId);
  });

  test('the same phone re-joining is the same person, not a duplicate', async () => {
    const code = await newSession();
    const a = await call('POST', '/sessions/' + code + '/join', { body: { name: 'Ann', deviceId: 'iphone-1' } });
    const b = await call('POST', '/sessions/' + code + '/join', { body: { name: 'Annie', deviceId: 'iphone-1' } });
    assert.equal(b.body.playerId, a.body.playerId);
    assert.equal(b.body.rejoined, true);
    const s = await state(code);
    assert.equal(s.players.length, 1);
    assert.equal(s.players[0].name, 'Annie', 'a rejoin should update the name they typed');
  });

  test("one player's token never appears in anyone else's state", async () => {
    const code = await newSession();
    const [ann, bo] = await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    for (const q of ['', '?token=' + bo.token]) {
      const s = await state(code, q);
      assert.equal(JSON.stringify(s).includes(ann.token), false, "Ann's token leaked into state " + (q || '(anonymous)'));
      for (const p of s.players) assert.equal(p.token, undefined);
    }
    const admin = (await control(code, { action: 'renamePlayer', playerId: ann.playerId, name: 'Ann B' })).body;
    assert.equal(JSON.stringify(admin).includes(ann.token), false);
  });

  test('the Guru can close self-join and check people in at the desk', async () => {
    const code = await newSession();
    await control(code, { action: 'setSettings', settings: { allowSelfJoin: false } });
    const r = await call('POST', '/sessions/' + code + '/join', { body: { name: 'Ann' } });
    assert.equal(r.status, 403);
    assert.equal((await control(code, { action: 'addPlayer', name: 'Ann' })).status, 200);
    assert.equal((await state(code)).players.length, 1);
  });

  test('leaving marks you inactive rather than deleting you', async () => {
    const code = await newSession();
    const [ann] = await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    await call('POST', '/sessions/' + code + '/leave', { body: { token: ann.token } });
    const s = await state(code);
    assert.equal(s.players.length, 4, 'they stay on the roster');
    assert.equal(s.players.find(p => p.id === ann.playerId).active, false);
    assert.equal(s.playing, 3);
    assert.ok(s.rounds[0].tables[0].teamA.concat(s.rounds[0].tables[0].teamB).some(p => p.id === ann.playerId),
      'and stay in the round they actually played');
  });
});

// ---- draft / publish --------------------------------------------------------
describe('pairing a round', () => {
  test('needs four players for a 2v2 table', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy']);
    const r = await control(code, { action: 'pairRound' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /at least 4/);
  });

  test('a paired round is a DRAFT — the room does not see it until it is published', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await control(code, { action: 'pairRound' });
    let s = await state(code);
    assert.ok(s.draft, 'the Guru can see the draft');
    assert.equal(s.round, null, 'but there is no live round yet');
    assert.equal(s.current, 0);
    assert.equal(s.status, 'lobby');

    await control(code, { action: 'publishRound' });
    s = await state(code);
    assert.equal(s.draft, null);
    assert.equal(s.current, 1);
    assert.equal(s.status, 'live');
    assert.equal(s.round.tables.length, 1);
  });

  test('reshuffle gives a different draw; pairing twice without publishing does not', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Fi', 'Gus', 'Hal']);
    await control(code, { action: 'pairRound' });
    const first = JSON.stringify((await state(code)).draft.tables);
    await control(code, { action: 'pairRound' });
    assert.equal(JSON.stringify((await state(code)).draft.tables), first, 'the engine must be deterministic');
    let changed = false;
    for (let i = 0; i < 6 && !changed; i++) {
      await control(code, { action: 'reshuffle' });
      if (JSON.stringify((await state(code)).draft.tables) !== first) changed = true;
    }
    assert.ok(changed, 'reshuffle never produced a different seating');
  });

  test('the Guru can hand-swap two people in the draft', async () => {
    const code = await newSession();
    const p = await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Fi', 'Gus', 'Hal']);
    await control(code, { action: 'pairRound' });
    const before = (await state(code)).draft;
    const a = before.tables[0].teamA[0].id, b = before.tables[1].teamB[0].id;
    const r = await control(code, { action: 'swapDraft', a, b });
    assert.equal(r.status, 200);
    const after = (await state(code)).draft;
    assert.equal(after.tables[0].teamA[0].id, b);
    assert.equal(after.tables[1].teamB[0].id, a);
    assert.ok(after.warnings.some(w => /hand-adjusted/.test(w)));
    // everyone still seated exactly once
    const ids = after.tables.flatMap(t => t.teamA.concat(t.teamB)).map(x => x.id).concat(after.byes.map(x => x.id));
    assert.equal(new Set(ids).size, p.length);
  });

  test('swapping a seated player with someone on the bye list works both ways', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di', 'Ed']);      // 5 -> one bye
    await control(code, { action: 'pairRound' });
    const d = (await state(code)).draft;
    assert.equal(d.byes.length, 1);
    const benched = d.byes[0].id, seated = d.tables[0].teamA[0].id;
    await control(code, { action: 'swapDraft', a: benched, b: seated });
    const after = (await state(code)).draft;
    assert.equal(after.byes[0].id, seated);
    assert.ok(after.tables[0].teamA.some(x => x.id === benched));
  });

  test('publishing twice is refused rather than duplicating the round', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    const r = await control(code, { action: 'publishRound' });
    assert.equal(r.status, 409);
  });

  test('a fifth round is refused when the night is set to three', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    for (let i = 0; i < 3; i++) await playRound(code);
    const r = await control(code, { action: 'pairRound' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /all 3 rounds/);
  });
});

// ---- the property that matters most across the night ------------------------
describe('history is derived from published rounds, never stored', () => {
  test('three published rounds never repeat a partnership', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Fi', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kit', 'Lou']);
    for (let i = 0; i < 3; i++) await playRound(code);
    const s = await state(code);
    const seen = new Set();
    for (const r of s.rounds) for (const t of r.tables) for (const team of [t.teamA, t.teamB]) {
      const k = team.map(x => x.id).sort().join('|');
      assert.ok(!seen.has(k), 'repeated partnership across rounds');
      seen.add(k);
    }
  });

  test('pulling a round back un-does its history, so the re-pair is not poisoned', async () => {
    // This is the whole reason history is recomputed. With a stored running
    // tally, an unpublished round would leave its partnerships banned forever
    // and the engine would start reporting "had to repeat a partner" on a room
    // with plenty of fresh combinations left.
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    const r1 = JSON.stringify((await state(code)).rounds[0].tables);

    await control(code, { action: 'unpublishRound' });
    let s = await state(code);
    assert.equal(s.rounds.length, 0);
    assert.equal(s.current, 0);
    assert.ok(s.draft, 'the pulled round comes back as an editable draft');

    await control(code, { action: 'pairRound' });
    await control(code, { action: 'publishRound' });
    s = await state(code);
    assert.equal(JSON.stringify(s.rounds[0].tables), r1,
      'the same four people with a clean history must pair the same way again');
    assert.equal((s.rounds[0].warnings || []).some(w => /repeat/i.test(w)), false,
      'no phantom "had to repeat a partner" from a round that was pulled');
  });

  test('a started round is not pulled back by accident', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    await control(code, { action: 'startRound' });
    const r = await control(code, { action: 'unpublishRound' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already started/);
    assert.equal((await control(code, { action: 'unpublishRound', force: true })).status, 200);
  });
});

// ---- the clock --------------------------------------------------------------
describe('the round clock', () => {
  test('starting a round sets a server-epoch plan every screen counts down from', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    const t0 = Date.now();
    await control(code, { action: 'startRound' });
    const s = await state(code);
    assert.ok(s.round.startAt >= t0);
    assert.equal(s.round.phases.length, 3);
    assert.equal(s.round.phases[2].endsAt - s.round.startAt, 3_600_000);
    assert.equal(s.clock.state, 'running');
    assert.equal(s.clock.phase.id, 'teach');
    assert.ok(s.clock.msLeft > 0 && s.clock.msLeft <= 600_000);
  });

  test('a lead-in delays the start so the room can be told to sit down', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    await control(code, { action: 'startRound', leadInMs: 60_000 });
    const s = await state(code);
    assert.equal(s.clock.state, 'pending');
    assert.ok(s.clock.msToStart > 50_000);
  });

  test('"give them five more minutes" moves every boundary still ahead, and nothing behind', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    await control(code, { action: 'startRound' });
    const before = (await state(code)).round.phases.map(p => p.endsAt);
    await control(code, { action: 'adjustClock', minutes: 5 });
    const after = (await state(code)).round.phases.map(p => p.endsAt);
    assert.deepEqual(after.map((x, i) => x - before[i]), [300_000, 300_000, 300_000]);
    // and the phases stay contiguous — no gap or overlap opened up
    const ph = (await state(code)).round.phases;
    assert.equal(ph[1].startsAt, ph[0].endsAt);
    assert.equal(ph[2].startsAt, ph[1].endsAt);
  });

  test('ending a round early unblocks the next one — the normal case, not an exception', async () => {
    // A 40-minute play phase is a ceiling, not a target. Tables finish early
    // constantly, and before this the Guru who stopped the clock was offered
    // "Start the clock" again with no way forward.
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    await control(code, { action: 'startRound' });
    assert.equal((await control(code, { action: 'endRoundEarly' })).status, 200);
    let s = await state(code);
    assert.equal(s.round.endedEarly, true);
    assert.equal(s.round.startAt, null);
    assert.equal(s.clock, null);
    // and the next round pairs straight away
    assert.equal((await control(code, { action: 'pairRound' })).status, 200);
    assert.equal((await state(code)).draft.n, 2);
  });

  test('restarting a round clears the finished flag', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    await control(code, { action: 'startRound' });
    await control(code, { action: 'endRoundEarly' });
    await control(code, { action: 'startRound' });
    const s = await state(code);
    assert.equal(s.round.endedEarly, false);
    assert.equal(s.clock.state, 'running');
  });

  test('adjusting a clock that is not running is refused, not silently ignored', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    assert.equal((await control(code, { action: 'adjustClock', minutes: 5 })).status, 409);
  });
});

// ---- results and standings --------------------------------------------------
describe('results and the night leaderboard', () => {
  test('a win is 2 points each, a draw 1, and byes are shown so nobody looks bad', async () => {
    const code = await newSession();
    const p = await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di', 'Ed']);
    await playRound(code);
    const s0 = await state(code);
    const t = s0.round.tables[0];
    await control(code, { action: 'setResult', table: t.table, result: 'A' });
    const s = await state(code);
    const by = id => s.standings.find(x => x.id === id);
    for (const x of t.teamA) { assert.equal(by(x.id).points, 2); assert.equal(by(x.id).wins, 1); }
    for (const x of t.teamB) { assert.equal(by(x.id).points, 0); assert.equal(by(x.id).played, 1); }
    const benched = s.round.byes[0];
    assert.equal(by(benched.id).byes, 1);
    assert.equal(by(benched.id).played, 0);
    assert.equal(s.standings[0].points, 2, 'leaderboard is sorted by points');
    assert.equal(s.standings.length, p.length);
  });

  test('a result can be corrected or cleared', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    const tbl = (await state(code)).round.tables[0].table;
    await control(code, { action: 'setResult', table: tbl, result: 'A' });
    await control(code, { action: 'setResult', table: tbl, result: 'draw' });
    let s = await state(code);
    assert.ok(s.standings.every(x => x.points === 1 && x.draws === 1));
    await control(code, { action: 'setResult', table: tbl, result: '' });
    s = await state(code);
    assert.ok(s.standings.every(x => x.points === 0));
    assert.equal((await control(code, { action: 'setResult', table: tbl, result: 'nope' })).status, 400);
  });
});

// ---- the player's phone -----------------------------------------------------
describe('what a player sees on their phone', () => {
  test('their token resolves table, partner and opponents server-side', async () => {
    const code = await newSession();
    const [ann] = await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    const s = await state(code, '?token=' + ann.token);
    assert.equal(s.you.id, ann.playerId);
    assert.ok(s.you.table >= 1);
    assert.ok(s.you.partner && s.you.partner.id !== ann.playerId);
    assert.equal(s.you.opponents.length, 2);
    assert.equal(s.you.bye, false);
    const all = [s.you.partner.id, ...s.you.opponents.map(o => o.id), ann.playerId];
    assert.equal(new Set(all).size, 4, 'partner and opponents must be four distinct people');
  });

  test('a benched player is told they are first back in, not just left blank', async () => {
    const code = await newSession();
    const joined = await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di', 'Ed']);
    await playRound(code);
    const s0 = await state(code);
    const benchedId = s0.round.byes[0].id;
    const tok = joined.find(j => j.playerId === benchedId).token;
    const s = await state(code, '?token=' + tok);
    assert.equal(s.you.bye, true);
    assert.match(s.you.nextUp, /sitting out/);
  });

  test('someone who joins mid-round is told they are in for the next one', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    const late = (await call('POST', '/sessions/' + code + '/join', { body: { name: 'Zed', deviceId: 'z' } })).body;
    const s = await state(code, '?token=' + late.token);
    assert.equal(s.you.table, null);
    assert.match(s.you.nextUp, /next one/);
  });

  test('a late arrival is seated in the following round', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    const late = (await call('POST', '/sessions/' + code + '/join', { body: { name: 'Zed', deviceId: 'z' } })).body;
    await playRound(code);
    const s = await state(code, '?token=' + late.token);
    const seated = s.rounds[1].tables.flatMap(t => t.teamA.concat(t.teamB)).map(x => x.id)
      .concat(s.rounds[1].byes.map(x => x.id));
    assert.ok(seated.includes(late.playerId), 'the late arrival was never placed');
  });

  test('no token means no `you` block, and no leak of anyone else', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    await playRound(code);
    const s = await state(code);
    assert.equal(s.you, undefined);
  });
});

// ---- polling and concurrency ------------------------------------------------
describe('polling and two Gurus at once', () => {
  test('an unchanged poll gets the tiny answer', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann']);
    const s = await state(code);
    const again = await state(code, '?v=' + s.version);
    assert.deepEqual(Object.keys(again).sort(), ['serverNow', 'unchanged', 'version']);
    assert.equal(again.unchanged, true);
  });

  test('any mutation bumps the version so every screen refreshes', async () => {
    const code = await newSession();
    const v0 = (await state(code)).version;
    await joinMany(code, ['Ann']);
    const v1 = (await state(code)).version;
    assert.ok(v1 > v0);
    await control(code, { action: 'addPlayer', name: 'Bo' });
    assert.ok((await state(code)).version > v1);
  });

  test('a racing write is retried, not silently lost', async () => {
    const code = await newSession();
    await joinMany(code, ['Ann', 'Bo', 'Cy', 'Di']);
    // Simulate another tablet committing between this handler's read and write.
    S.beforeUpdate = (store) => {
      const row = store.rows.get(code);
      row.data.players.push({ id: 'sg_other', name: 'Racer', token: 'x', active: true, joinedAt: Date.now() });
      row.version += 1;
    };
    const r = await control(code, { action: 'addPlayer', name: 'Ed' });
    assert.equal(r.status, 200);
    const names = (await state(code)).players.map(p => p.name).sort();
    assert.deepEqual(names, ['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Racer'],
      'the retry must preserve the other writer\'s change AND land its own');
  });

  test('control is Guru-only; state and join are not', async () => {
    const code = await newSession();
    assert.equal((await call('POST', '/sessions/' + code + '/control', { body: { action: 'pairRound' } })).status, 401);
    assert.equal((await call('GET', '/sessions/' + code + '/state')).status, 200);
    assert.equal((await call('POST', '/sessions/' + code + '/join', { body: { name: 'Ann' } })).status, 200);
  });

  test('unknown session, unknown action and unknown route all answer cleanly', async () => {
    assert.equal((await call('GET', '/sessions/ZZZZ/state')).status, 404);
    const code = await newSession();
    assert.equal((await control(code, { action: 'launchTheMissiles' })).status, 400);
    assert.equal((await call('GET', '/nope')).status, 404);
    assert.equal((await call('OPTIONS', '/sessions')).status, 204);
  });
});
