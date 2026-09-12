// NGH-BUILD 2026-09-12l
// tests/karaoke-nametune.test.mjs — Name That Tune, the Battle Karaoke minigame.
//
// Run:  node --import ./tests/_register-karaoke.mjs --test tests/karaoke-nametune.test.mjs
//
// The real karaoke.mjs runs against the in-memory Neon stand-in, so the buzz
// race, the anti-cheat clamps, the steal chain and the room scoring are all
// exercised for real.
//
// Two things get the most attention here, because they are the two ways this
// game can go wrong in front of a room:
//   1. THE ANSWER LEAKING. The whole game is not knowing the song. A title
//      visible in the state JSON before the reveal loses the round for
//      everybody with devtools open.
//   2. THE RACE BEING UNFAIR. Reaction time is measured from the phone's
//      clock-corrected press, not from when the request happened to arrive, so
//      bad wifi must not cost you the buzz — and a doctored timestamp must not
//      win it.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const fn = (await import('../netlify/functions/karaoke.mjs')).default;
const D = globalThis.__kdb;

const BASE = 'https://gamehaven.guru/.netlify/functions/karaoke';
const ADMIN = { authorization: 'Bearer admin-ok' };

async function call(method, path, { body, headers } = {}) {
  const res = await fn(new Request(BASE + path, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
  let json = null;
  try { json = await res.clone().json(); } catch { }
  return { status: res.status, body: json };
}
const guru = (method, path, body) => call(method, path, { body, headers: ADMIN });
const control = (code, body) => guru('POST', '/sessions/' + code + '/control', body);
const state = async (code) => (await call('GET', '/sessions/' + code + '/state')).body;

function seedSongs() {
  D.songs.clear();
  const mk = (id, title, artist, audio) => D.songs.set(id, {
    id, provider: 'local', title, artist, duration_ms: 30000,
    data: audio ? { media: { audio } } : {}, updated_at: new Date().toISOString()
  });
  mk('s1', 'Otter Slide', 'The Stash Band', 'http://192.168.1.50:8766/a.mp3');
  mk('s2', 'Meeple Moon', 'Chippewa Choir', null);
  mk('s3', 'Twenty-Sided Heart', 'Dungeon Dwellers', null);
}

async function newSession() {
  const r = await guru('POST', '/sessions', { mode: 'battle', rooms: ['holt', 'depths'], teams: {} });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.code;
}
async function join(code, name, room) {
  const r = await call('POST', '/sessions/' + code + '/join', { body: { name, room, deviceId: 'd-' + name } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const buzz = (code, token, mgId, t) =>
  call('POST', '/sessions/' + code + '/mgbuzz', { body: { token, mgId, t } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Arm the round and let real time pass, so a press timestamped "300ms after GO"
// is genuinely in the past by the time the request lands. Claiming a press from
// the future is what the anti-cheat clamp exists to stop — the first draft of
// these tests tripped it, which was the clamp doing its job.
async function armAndWait(code, waitMs) {
  const goAt = (await control(code, { action: 'mgArm', leadMs: 0 })).body.result.goAt;
  await sleep(waitMs == null ? 400 : waitMs);
  return goAt;
}

beforeEach(() => {
  D.sessions.clear(); D.votes.clear(); D.players.clear(); D.media.clear(); D.calls.length = 0;
  seedSongs();
});

// ---- the answer must not leak ----------------------------------------------
describe('the song stays secret until the reveal', () => {
  test('no title, artist or songId anywhere in the public state before the reveal', async () => {
    const code = await newSession();
    await control(code, { action: 'mgStart' });
    await control(code, { action: 'mgArm' });
    const s = await state(code);
    const blob = JSON.stringify(s);
    assert.ok(s.mg, 'the minigame should be published');
    assert.equal(s.mg.title, undefined);
    assert.equal(s.mg.artist, undefined);
    assert.equal(s.mg.songId, undefined);
    for (const leak of ['Otter Slide', 'Meeple Moon', 'Twenty-Sided Heart', 'The Stash Band', 'Chippewa Choir', 'Dungeon Dwellers']) {
      assert.equal(blob.includes(leak), false, 'the answer leaked into public state: ' + leak);
    }
  });

  test('the LAN audio path is never published to browsers', async () => {
    const code = await newSession();
    await control(code, { action: 'mgStart', songId: 's1' });
    await control(code, { action: 'mgArm' });
    const blob = JSON.stringify(await state(code));
    assert.equal(blob.includes('192.168'), false, 'a LAN media URL reached the public state');
    assert.equal(blob.includes('8766'), false);
  });

  test('the reveal is where the answer appears', async () => {
    const code = await newSession();
    await control(code, { action: 'mgStart', songId: 's2' });
    await control(code, { action: 'mgArm' });
    assert.equal((await state(code)).mg.title, undefined);
    await control(code, { action: 'mgReveal' });
    const mg = (await state(code)).mg;
    assert.equal(mg.phase, 'reveal');
    assert.equal(mg.title, 'Meeple Moon');
    assert.equal(mg.artist, 'Chippewa Choir');
  });
});

// ---- the race ---------------------------------------------------------------
describe('the buzz race', () => {
  test('reaction time is measured from GO, not from when the request arrived', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    // Ann pressed 300ms after GO but her request lands much later — slow wifi
    // must not cost her the race.
    const goAt = await armAndWait(code, 600);
    const r = await buzz(code, ann.token, null, goAt + 300);
    assert.equal(r.status, 200);
    assert.equal(r.body.rt, 300, 'reaction time should come from the press, not the arrival');
    assert.equal(r.body.jumped, false);
  });

  test('order is by reaction time, and the fastest clean buzz takes the floor', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    const bo = await join(code, 'Bo', 'depths');
    const cy = await join(code, 'Cy', 'holt');
    await control(code, { action: 'mgStart' });
    // Wait past the slowest press we are about to claim, or the clamp will
    // (rightly) treat it as a press from the future.
    const goAt = await armAndWait(code, 1000);
    // Bo presses last in wall-clock order but fastest by reaction.
    await buzz(code, ann.token, null, goAt + 800);
    await buzz(code, cy.token, null, goAt + 500);
    await buzz(code, bo.token, null, goAt + 120);
    const mg = (await state(code)).mg;
    assert.deepEqual(mg.buzzes.slice().sort((a, b) => a.rt - b.rt).map(b => b.name), ['Bo', 'Cy', 'Ann']);
    assert.equal(mg.answering, bo.memberId, 'the fastest should be on the clock');
    assert.equal(mg.phase, 'answering');
  });

  test('the floor goes to the fastest REACTION, not to whoever\'s packet arrived first', async () => {
    // Bo pressed at +120ms but his request lands second; Ann pressed at +800ms
    // and lands first. On a room full of phones sharing one access point this
    // is routine, and handing Ann the buzz would mean the better wifi wins.
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    const bo = await join(code, 'Bo', 'depths');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code, 1000);
    await buzz(code, ann.token, null, goAt + 800);
    assert.equal((await state(code)).mg.answering, ann.memberId, 'Ann holds it until someone faster lands');
    await buzz(code, bo.token, null, goAt + 120);
    const mg = (await state(code)).mg;
    assert.equal(mg.answering, bo.memberId, 'the faster press should take the floor back');
    assert.equal(mg.phase, 'answering');
  });

  test('once the settling window closes, a late press queues for a steal instead of stealing the floor', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    const bo = await join(code, 'Bo', 'depths');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code, 600);
    await buzz(code, ann.token, null, goAt + 500);
    await sleep(1400);                                  // past the settle window
    await buzz(code, bo.token, null, goAt + 100);       // faster, but far too late
    const mg = (await state(code)).mg;
    assert.equal(mg.answering, ann.memberId, 'the floor must stop moving once someone is answering');
    assert.equal(mg.buzzes.length, 2, 'the late buzz is still queued for a steal');
  });

  test('a jumper gets no steal either — jumping is out for the round', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    const bo = await join(code, 'Bo', 'depths');
    await control(code, { action: 'mgStart' });
    const armed = (await control(code, { action: 'mgArm', leadMs: 300 })).body.result;
    await buzz(code, ann.token, null, armed.goAt - 200);   // Ann jumps
    await sleep(600);
    await buzz(code, bo.token, null, armed.goAt + 150);    // Bo buzzes clean
    await control(code, { action: 'mgJudge', ok: false }); // Bo misses
    const mg = (await state(code)).mg;
    assert.equal(mg.answering, null, 'the jumper must not inherit the floor');
    assert.equal(mg.phase, 'armed');
  });

  test('pressing before GO is a jump: recorded, ordered last, and never takes the floor', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    const bo = await join(code, 'Bo', 'depths');
    await control(code, { action: 'mgStart' });
    const armed = (await control(code, { action: 'mgArm', leadMs: 300 })).body.result;
    const jump = await buzz(code, ann.token, null, armed.goAt - 200);   // gun jumped
    assert.equal(jump.status, 200);
    assert.equal(jump.body.jumped, true);
    let mg = (await state(code)).mg;
    assert.equal(mg.answering, null, 'a jump must not win the floor');
    assert.equal(mg.phase, 'armed');
    // Bo buzzes properly after GO and takes it, even though Ann pressed earlier.
    await sleep(600);
    await buzz(code, bo.token, null, armed.goAt + 150);
    mg = (await state(code)).mg;
    assert.equal(mg.answering, bo.memberId);
    const order = mg.buzzes.slice().sort((a, b) => (a.jumped - b.jumped) || (a.rt - b.rt)).map(b => b.name);
    assert.deepEqual(order, ['Bo', 'Ann'], 'jumpers sort behind everyone clean');
  });

  test('arming with NO explicit lead — the way the host UI actually calls it', async () => {
    // Every other test in this file passes leadMs explicitly, which is exactly
    // how a real bug hid here: the default branch produced goAt = NaN, JSON
    // turned it into null, and reaction times came back as Unix timestamps.
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    const armed = (await control(code, { action: 'mgArm' })).body.result;   // no leadMs
    assert.ok(isFinite(armed.goAt) && armed.goAt > Date.now() - 1000, 'goAt must be a real time, got ' + armed.goAt);
    const mg = (await state(code)).mg;
    assert.ok(isFinite(mg.goAt) && mg.goAt > 0, 'published goAt must be a real time, got ' + mg.goAt);
    assert.ok(mg.goAt - mg.armAt >= 1000 && mg.goAt - mg.armAt <= 5000, 'the default lead should be a couple of seconds, got ' + (mg.goAt - mg.armAt));
    await sleep(mg.goAt - Date.now() + 150);
    const r = await buzz(code, ann.token, null, mg.goAt + 100);
    assert.equal(r.status, 200);
    assert.ok(r.body.rt >= 0 && r.body.rt < 5000, 'reaction time should be in milliseconds, got ' + r.body.rt);
  });

  test('a round armed with a broken clock is refused rather than scored as nonsense', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    await control(code, { action: 'mgArm', leadMs: 0 });
    // Corrupt goAt the way a bad arm used to
    const row = D.sessions.get(code);
    row.data.mg.goAt = null;
    const r = await buzz(code, ann.token, null, Date.now());
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not armed properly/);
  });

  test('a press claimed from the future is clamped to arrival', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    const r = await buzz(code, ann.token, null, goAt + 60_000_000);   // "I pressed it in an hour"
    assert.equal(r.status, 200);
    assert.ok(r.body.rt < 5000, 'a fabricated future press should be clamped, got rt=' + r.body.rt);
  });

  test('a press claimed from long before the round is rejected outright', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    const armed = (await control(code, { action: 'mgArm', leadMs: 0 })).body.result;
    const r = await buzz(code, ann.token, null, armed.goAt - 600_000);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /too early/);
  });

  test('a phone that never synced its clock still gets a fair buzz', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    await control(code, { action: 'mgArm', leadMs: 0 });
    const r = await buzz(code, ann.token, null, undefined);   // no `t` at all
    assert.equal(r.status, 200);
    assert.equal(r.body.jumped, false);
    assert.ok(typeof r.body.rt === 'number');
  });

  test('double-tapping is not an error and does not queue you twice', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    const a = await buzz(code, ann.token, null, goAt + 200);
    const b = await buzz(code, ann.token, null, goAt + 260);
    assert.equal(b.status, 200);
    assert.equal(b.body.already, true);
    assert.equal(b.body.rt, a.body.rt, 'the first press is the one that counts');
    assert.equal((await state(code)).mg.buzzes.length, 1);
  });

  test('buzzing needs a check-in, and only while a round is armed', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    assert.equal((await buzz(code, ann.token, null, Date.now())).status, 409);   // nothing armed
    await control(code, { action: 'mgStart' });
    assert.equal((await buzz(code, ann.token, null, Date.now())).status, 409);   // started, not armed
    await control(code, { action: 'mgArm', leadMs: 0 });
    assert.equal((await buzz(code, 'not-a-token', null, Date.now())).status, 403);
    assert.equal((await buzz(code, ann.token, null, Date.now())).status, 200);
  });

  test('a buzz for a previous round is refused', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    const stale = (await state(code)).mg.id;
    await control(code, { action: 'mgStart' });          // new round, new id
    await control(code, { action: 'mgArm', leadMs: 0 });
    const r = await buzz(code, ann.token, stale, Date.now());
    assert.equal(r.status, 409);
    assert.match(r.body.error, /stale/);
  });
});

// ---- scoring and the steal --------------------------------------------------
describe('scoring feeds the room battle', () => {
  test('a correct answer scores the answerer\'s ROOM, not the person', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await join(code, 'Bo', 'depths');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    await buzz(code, ann.token, null, goAt + 100);
    const j = await control(code, { action: 'mgJudge', ok: true });
    assert.equal(j.body.result.correct, true);
    assert.equal(j.body.result.room, 'holt');
    const s = await state(code);
    assert.equal(s.rooms.holt.score, 10);
    assert.equal(s.rooms.depths.score, 0);
    assert.equal(s.mg.phase, 'reveal', 'a correct answer reveals the song');
  });

  test('a wrong answer opens a steal for the next fastest, worth less', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    const bo = await join(code, 'Bo', 'depths');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    await buzz(code, ann.token, null, goAt + 100);
    await buzz(code, bo.token, null, goAt + 400);
    const miss = await control(code, { action: 'mgJudge', ok: false });
    assert.equal(miss.body.result.steal, 'Bo');
    let s = await state(code);
    assert.equal(s.mg.answering, bo.memberId);
    assert.deepEqual(s.mg.missed, [ann.memberId]);
    const win = await control(code, { action: 'mgJudge', ok: true });
    assert.equal(win.body.result.points, 5, 'a steal is worth less than getting it first');
    s = await state(code);
    assert.equal(s.rooms.depths.score, 5);
    assert.equal(s.rooms.holt.score, 0);
  });

  test('when everyone who buzzed has missed, the floor reopens rather than dead-ending', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    await buzz(code, ann.token, null, goAt + 100);
    const r = await control(code, { action: 'mgJudge', ok: false });
    assert.equal(r.body.result.reopened, true);
    const mg = (await state(code)).mg;
    assert.equal(mg.phase, 'armed', 'the round goes back to live so someone else can still buzz');
    assert.equal(mg.answering, null);
  });

  test('someone who already missed cannot take the floor again', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    const bo = await join(code, 'Bo', 'depths');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    await buzz(code, ann.token, null, goAt + 100);
    await buzz(code, bo.token, null, goAt + 200);
    await control(code, { action: 'mgJudge', ok: false });   // Ann misses -> Bo
    await control(code, { action: 'mgJudge', ok: false });   // Bo misses  -> reopen
    const mg = (await state(code)).mg;
    assert.equal(mg.answering, null);
    assert.deepEqual(mg.missed.slice().sort(), [ann.memberId, bo.memberId].sort());
  });

  test('judging with nobody on the clock is refused', async () => {
    const code = await newSession();
    await control(code, { action: 'mgStart' });
    await control(code, { action: 'mgArm', leadMs: 0 });
    assert.equal((await control(code, { action: 'mgJudge', ok: true })).status, 409);
  });
});

// ---- the answer clock -------------------------------------------------------
describe('the answer clock', () => {
  test('the clock is published so the phone can count it down', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    const t0 = Date.now();
    await buzz(code, ann.token, null, goAt + 100);
    const mg = (await state(code)).mg;
    assert.ok(mg.answerBy > t0, 'an answer deadline should be set');
    assert.ok(mg.answerBy - t0 <= 20000);
  });

  test('a timeout before the deadline does nothing; forcing it passes the floor on', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    const bo = await join(code, 'Bo', 'depths');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    await buzz(code, ann.token, null, goAt + 100);
    await buzz(code, bo.token, null, goAt + 300);
    await control(code, { action: 'mgTimeout' });
    assert.equal((await state(code)).mg.answering, ann.memberId, 'not past the deadline yet');
    const forced = await control(code, { action: 'mgTimeout', force: true });
    assert.equal(forced.body.result.steal, 'Bo');
  });
});

// ---- housekeeping -----------------------------------------------------------
describe('rounds and housekeeping', () => {
  test('a song already used tonight is not picked again', async () => {
    const code = await newSession();
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      await control(code, { action: 'mgStart' });
      await control(code, { action: 'mgReveal' });          // reveal marks it used
      const t = (await state(code)).mg.title;
      assert.ok(!seen.has(t), 'repeated the song "' + t + '"');
      seen.add(t);
    }
    assert.equal(seen.size, 3);
  });

  test('round numbers climb', async () => {
    const code = await newSession();
    await control(code, { action: 'mgStart' });
    assert.equal((await state(code)).mg.round, 1);
    await control(code, { action: 'mgStart' });
    assert.equal((await state(code)).mg.round, 2);
  });

  test('arming clears the previous round\'s buzzes', async () => {
    const code = await newSession();
    const ann = await join(code, 'Ann', 'holt');
    await control(code, { action: 'mgStart' });
    const goAt = await armAndWait(code);
    await buzz(code, ann.token, null, goAt + 100);
    assert.equal((await state(code)).mg.buzzes.length, 1);
    await control(code, { action: 'mgStart' });
    await control(code, { action: 'mgArm', leadMs: 0 });
    assert.equal((await state(code)).mg.buzzes.length, 0);
  });

  test('an empty catalog is refused with a message a Guru can act on', async () => {
    D.songs.clear();
    const code = await newSession();
    const r = await control(code, { action: 'mgStart' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /catalog is empty/);
  });

  test('mgEnd clears it, and so does ending the session', async () => {
    const code = await newSession();
    await control(code, { action: 'mgStart' });
    await control(code, { action: 'mgEnd' });
    assert.equal((await state(code)).mg, null);
    await control(code, { action: 'mgStart' });
    await control(code, { action: 'endSession' });
    assert.equal((await state(code)).mg, null, 'a finished session must not leave a game on the TV');
  });

  test('every minigame control needs the Guru', async () => {
    const code = await newSession();
    for (const action of ['mgStart', 'mgArm', 'mgJudge', 'mgReveal', 'mgEnd']) {
      const r = await call('POST', '/sessions/' + code + '/control', { body: { action } });
      assert.equal(r.status, 401, action + ' should be admin-only');
    }
  });

  test('the minigame does not disturb the singing transport', async () => {
    const code = await newSession();
    await control(code, { action: 'mgStart' });
    await control(code, { action: 'mgArm', leadMs: 0 });
    const s = await state(code);
    assert.equal(s.nowPlaying, null);
    assert.ok(Array.isArray(s.queue));
  });
});
