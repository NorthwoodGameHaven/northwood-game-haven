// NGH-BUILD 2026-09-12m
// tests/venue.test.mjs — the venue mode, the single source of truth for the room.
//
// This one carries more weight than its size suggests: the TVs, the PA and the
// app all follow it, so a wrong answer here is the whole room wrong at once.
// The Stream Deck surface gets the most attention, because it is the interface
// used while holding a microphone.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

process.env.VENUE_KEY = 'test-venue-key';
register('./_venue-hooks.mjs', import.meta.url);
const fn = (await import('../netlify/functions/venue.mjs')).default;
const { MODES } = await import('../netlify/functions/venue.mjs');
const V = globalThis.__venue;

const BASE = 'https://gamehaven.guru/.netlify/functions/venue';
const KEY = 'test-venue-key';

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
const state = async (q) => (await call('GET', '/state' + (q || ''))).body;
// key === undefined -> the real key; null -> no ?key= at all; '' -> an empty one.
// (`key || KEY` quietly turned the empty-key case into the valid-key case, so
// the "empty key is refused" assertion was testing nothing.)
const press = (mode, key) => call('GET', '/mode/' + mode +
  (key === null ? '' : '?key=' + encodeURIComponent(key === undefined ? KEY : key)));

beforeEach(() => { V.row = { data: {}, version: 1 }; V.calls.length = 0; });

describe('the room has exactly one mode', () => {
  test('it starts idle rather than undefined', async () => {
    const s = await state();
    assert.equal(s.mode, 'idle');
    assert.equal(s.label, 'Open play');
    assert.equal(s.screen, '/tv-idle');
  });

  test('every mode carries a screen and an AV cue for its followers', async () => {
    const { modes } = (await call('GET', '/modes')).body;
    assert.ok(modes.length >= 5);
    for (const m of modes) {
      assert.ok(m.id && m.label, 'mode needs an id and a label');
      assert.ok(m.screen && m.screen.startsWith('/'), m.id + ' needs a screen path');
      assert.ok(m.av && m.av.cue, m.id + ' needs an AV cue for Companion to key off');
    }
    assert.deepEqual(modes.map(m => m.id).sort(), ['idle', 'karaoke', 'mtg', 'speedgaming', 'trivia']);
  });

  test('setting one mode replaces the last — they are never both on', async () => {
    await press('karaoke');
    assert.equal((await state()).mode, 'karaoke');
    await press('mtg');
    const s = await state();
    assert.equal(s.mode, 'mtg');
    assert.equal(s.screen, '/mtg-tv');
    assert.equal(s.av.cue, 'mtg');
  });

  test('an unknown mode is refused with the list of real ones', async () => {
    const r = await press('discoteque');
    assert.equal(r.status, 404);
    assert.match(r.body.error, /unknown mode/);
    assert.match(r.body.error, /karaoke/);
    assert.equal((await state()).mode, 'idle', 'a bad press must not change the room');
  });
});

describe('the Stream Deck surface', () => {
  test('a bare GET with the key sets the mode — no body, no token dance', async () => {
    const r = await press('trivia');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'trivia');
    assert.equal(r.body.set, 'Team Trivia', 'the button should be able to show what it did');
  });

  test('pressing the same button twice is harmless', async () => {
    await press('karaoke');
    const first = await state();
    const r = await press('karaoke');
    assert.equal(r.status, 200);
    const second = await state();
    assert.equal(second.mode, 'karaoke');
    assert.equal(second.since, first.since, 're-pressing must not restart the clock');
  });

  test('no key, a wrong key, or an empty key is refused', async () => {
    for (const k of [null, 'nope', '']) {
      const r = await press('karaoke', k);
      assert.equal(r.status, 401, 'key ' + JSON.stringify(k) + ' should be refused');
    }
    assert.equal((await state()).mode, 'idle');
  });

  test('whitespace is never a valid key, configured or not', async () => {
    // Found by mutation testing: padding both sides to a fixed width made a
    // key of 64 spaces equal an EMPTY configured key. Hashing fixed it; this
    // is the test that would have caught it.
    const saved = process.env.VENUE_KEY;
    try {
      for (const junk of [' ', '   ', ' '.repeat(64), ' '.repeat(200), '\t\n']) {
        assert.equal((await press('karaoke', junk)).status, 401, JSON.stringify(junk) + ' should be refused');
      }
      process.env.VENUE_KEY = '';
      for (const junk of ['', ' ', ' '.repeat(64)]) {
        assert.equal((await press('karaoke', junk)).status, 401, 'with no key configured, ' + JSON.stringify(junk) + ' must not authenticate');
      }
      process.env.VENUE_KEY = '   ';
      assert.equal((await press('karaoke', '   ')).status, 401, 'a whitespace-only VENUE_KEY is not a key');
    } finally { process.env.VENUE_KEY = saved; }
    assert.equal((await state()).mode, 'idle');
  });

  test('a key with stray whitespace around it still works — Companion loves a trailing space', async () => {
    assert.equal((await press('karaoke', ' ' + KEY + ' ')).status, 200);
  });

  test('the key also works as a header, for a Companion instance that would rather not put it in a URL', async () => {
    const r = await call('GET', '/mode/karaoke', { headers: { 'x-venue-key': KEY } });
    assert.equal(r.status, 200);
    assert.equal((await state()).mode, 'karaoke');
  });

  test('a Guru admin token works too, so the app can drive it without the shared key', async () => {
    const r = await call('GET', '/mode/speedgaming', { headers: { authorization: 'Bearer admin-ok' } });
    assert.equal(r.status, 200);
    assert.equal((await state()).mode, 'speedgaming');
  });

  test('with no VENUE_KEY configured, the key path is closed rather than open', async () => {
    const saved = process.env.VENUE_KEY;
    delete process.env.VENUE_KEY;
    try {
      assert.equal((await press('karaoke', 'anything')).status, 401);
      assert.equal((await call('GET', '/mode/karaoke', { headers: { 'x-venue-key': '' } })).status, 401);
      // the Guru route must still work — losing the env var cannot lock staff out
      assert.equal((await call('GET', '/mode/karaoke', { headers: { authorization: 'Bearer admin-ok' } })).status, 200);
    } finally { process.env.VENUE_KEY = saved; }
  });
});

describe('followers can poll it cheaply', () => {
  test('an unchanged poll gets the tiny answer', async () => {
    const s = await state();
    const again = await state('?v=' + s.version);
    assert.equal(again.unchanged, true);
    assert.deepEqual(Object.keys(again).sort(), ['serverNow', 'unchanged', 'version']);
  });

  test('any change bumps the version so every screen and the mixer notice', async () => {
    const v0 = (await state()).version;
    await press('mtg');
    const v1 = (await state()).version;
    assert.ok(v1 > v0);
    await call('POST', '/note', { body: { key: KEY, note: 'Round 2 in five' } });
    assert.ok((await state()).version > v1);
  });

  test('a note rides along without changing the mode', async () => {
    await press('trivia');
    const before = await state();
    await call('POST', '/note', { body: { key: KEY, note: 'Halftime — grab a drink' } });
    const after = await state();
    assert.equal(after.mode, 'trivia');
    assert.equal(after.note, 'Halftime — grab a drink');
    assert.equal(after.since, before.since);
  });

  test('changing mode clears the previous mode\'s note', async () => {
    await press('trivia');
    await call('POST', '/note', { body: { key: KEY, note: 'Halftime' } });
    await press('karaoke');
    assert.equal((await state()).note, null, 'a stale note from the last event must not follow the room');
  });

  test('a note needs the key too', async () => {
    assert.equal((await call('POST', '/note', { body: { note: 'free advertising' } })).status, 401);
  });
});

describe('the POST form, for anything that would rather send a body', () => {
  test('sets the mode and a note together', async () => {
    const r = await call('POST', '/mode', { body: { key: KEY, mode: 'speedgaming', note: 'Round 1 pairing now', setBy: 'guru-tablet' } });
    assert.equal(r.status, 200);
    const s = await state();
    assert.equal(s.mode, 'speedgaming');
    assert.equal(s.note, 'Round 1 pairing now');
    assert.equal(s.setBy, 'guru-tablet');
  });

  test('rejects an unknown mode and a missing key', async () => {
    assert.equal((await call('POST', '/mode', { body: { key: KEY, mode: 'bingo' } })).status, 400);
    assert.equal((await call('POST', '/mode', { body: { mode: 'karaoke' } })).status, 401);
  });
});

describe('the mode table matches what the screens actually serve', () => {
  // /tv-auto trusts `screen` blindly, so a typo here is a black TV in a full
  // room. These are the real paths that exist in site/ or netlify.toml.
  const REAL = {
    idle: '/tv-idle',
    trivia: '/trivia-display.html',
    karaoke: '/app/karaoke/tv.html',
    mtg: '/mtg-tv',
    speedgaming: '/speedgaming-tv'
  };
  for (const id of Object.keys(REAL)) {
    test(id + ' points at the page that exists', () => {
      assert.equal(MODES[id].screen, REAL[id]);
    });
  }
  test('no two modes share a screen', () => {
    const seen = Object.values(MODES).map(m => m.screen);
    assert.equal(new Set(seen).size, seen.length);
  });
});

describe('bad input does not take the room down', () => {
  test('junk JSON, unknown routes and OPTIONS all answer cleanly', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
    assert.equal((await call('OPTIONS', '/state')).status, 204);
    const res = await fn(new Request(BASE + '/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oh dear' }));
    assert.equal(res.status, 401, 'unparseable body should fail auth, not throw');
  });

  test('an over-long note is trimmed rather than rejected mid-event', async () => {
    await press('karaoke');
    const long = 'x'.repeat(500);
    const r = await call('POST', '/note', { body: { key: KEY, note: long } });
    assert.equal(r.status, 200);
    assert.ok(r.body.note.length <= 160);
  });

  test('a state row from before this feature existed still reads as idle', async () => {
    V.row = { data: { somethingOld: true }, version: 7 };
    const s = await state();
    assert.equal(s.mode, 'idle');
    assert.equal(s.screen, '/tv-idle');
  });

  test('a mode that was valid once but is not any more falls back to idle', async () => {
    V.row = { data: { mode: 'laserquest', since: 1 }, version: 3 };
    const s = await state();
    assert.equal(s.mode, 'idle', 'an unknown stored mode must not blank the screens');
  });
});
