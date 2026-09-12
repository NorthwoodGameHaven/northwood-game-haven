// netlify/functions/venue.mjs
// NGH-BUILD 2026-09-12m — Venue mode: one source of truth for what the room is doing
// ---------------------------------------------------------------------
// THE WHOLE IDEA, IN ONE LINE: Magic night, Trivia, Karaoke Battle and the
// Speed Gaming Meet-up never run at the same time, so the venue has exactly
// ONE mode, and every screen, speaker and phone FOLLOWS it.
//
// That is not a simplification for tidiness — it is what makes "synchronized"
// achievable. The alternative, where a Guru sets the TVs, then the mixer, then
// the app, is a system that drifts the first time someone gets distracted
// mid-changeover, and it always drifts in front of a full room.
//
//   Stream Deck button  ──▶  GET /api/venue/mode/karaoke?key=…      (sets it)
//                                        │
//                            venue mode (this file)
//                                        │
//         ┌──────────────────────────────┼──────────────────────────────┐
//         ▼                              ▼                              ▼
//   /tv-auto  (Google TV          Bitfocus Companion            the NGH app
//    Streamer 4K points here      polls /api/venue/state         + players'
//    ONCE, forever)               and fires the X32 scene         phones
//
// WHY GET, NOT POST, FOR THE CONTROL SURFACE
// Bitfocus Companion's generic HTTP action is happiest with a bare URL. Mode
// setting is idempotent by nature — pressing "Karaoke" twice means karaoke
// both times — so a GET is honest here rather than a shortcut, and a Guru can
// also just bookmark it. Each button is one URL with no body and no token
// dance, which is the difference between something that works at 7pm on a
// Friday and something that needs debugging at 7pm on a Friday.
//
// AUTH: a shared VENUE_KEY, same pattern as KARAOKE_PLAYER_KEY. Admin tokens
// expire and Stream Deck cannot re-auth itself. The key only sets modes; it
// cannot read customer data or touch money.
//
// WHY THE SERVER DOES NOT TALK TO THE X32
// The mixer is on the shop LAN and this runs on Netlify. Even if it were
// reachable, making the mixer depend on the internet would mean a dropped
// upstream link silences the PA. So the server publishes intent, and Companion
// — which is already on the LAN, already drives the rack, and keeps working if
// the internet dies — is the thing that acts on it.
//
// Routes (via /api/venue/* alias in netlify.toml):
//   GET  /venue/state?v=N            PUBLIC  the current mode (version-gated poll)
//   GET  /venue/mode/:mode?key=…     KEY     set the mode — the Stream Deck surface
//   POST /venue/mode                 KEY|admin  {mode, note}
//   GET  /venue/modes                PUBLIC  the mode table (labels, screens, av cues)
//   POST /venue/note                 KEY|admin  {note} — a line for the screens
//   GET  /venue/time                 PUBLIC  {serverNow}
// ---------------------------------------------------------------------

import crypto from 'node:crypto';
import { sql, json, bad, preflight, requireAdmin } from './_shared/db.mjs';

// The mode table is the contract every consumer reads. `screen` is what
// /tv-auto shows; `av` is advisory — Companion owns the actual X32 scene
// numbers, and they live in Companion so the rack still works when the
// internet does not. We publish an intent name, not a scene number.
export const MODES = {
  idle: {
    label: 'Open play',
    screen: '/tv-idle',
    av: { cue: 'house', mics: 'off', music: 'house-playlist' },
    blurb: 'Board games, retro cabinets and craft soda'
  },
  trivia: {
    label: 'Team Trivia',
    screen: '/trivia-display.html',
    av: { cue: 'trivia', mics: 'host', music: 'beds-low' },
    blurb: 'Team Trivia is live'
  },
  karaoke: {
    label: 'Karaoke Battle',
    screen: '/app/karaoke/tv.html',
    av: { cue: 'karaoke', mics: 'wireless-pair', music: 'backing-track' },
    blurb: 'Karaoke Battle is live'
  },
  mtg: {
    label: 'Magic night',
    screen: '/mtg-tv',
    av: { cue: 'mtg', mics: 'host', music: 'house-playlist' },
    blurb: 'Magic: The Gathering'
  },
  speedgaming: {
    label: 'Speed Gaming Meet-up',
    screen: '/speedgaming-tv',
    av: { cue: 'speedgaming', mics: 'host', music: 'house-playlist' },
    blurb: '2v2, new partner every round'
  }
};
const MODE_IDS = Object.keys(MODES);

let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
async function mk(stmt) { try { await stmt; } catch (e) { if (!isAlreadyExists(e)) throw e; } }
async function ensureSchema() {
  if (_ready) return;
  await mk(sql`CREATE TABLE IF NOT EXISTS venue_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT now())`);
  await mk(sql`INSERT INTO venue_state (id, data, version) VALUES (1, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`);
  _ready = true;
}

const now = () => Date.now();
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 160);
async function readBody(req) { try { return await req.json(); } catch { return {}; } }

// Compare SHA-256 digests rather than padded strings.
//
// The obvious version — pad both to 64 chars and timingSafeEqual — has a hole
// that a mutation test found: padding makes a 64-space key equal an EMPTY
// configured key, so if VENUE_KEY were ever unset or blank, sending spaces
// would authenticate. Hashing removes the whole class of problem: digests are
// always 32 bytes, so no padding is needed, and an unset key still cannot be
// matched because we refuse before we get there.
function keyOk(req, url, body) {
  const want = String(process.env.VENUE_KEY || '').trim();
  if (!want) return false;                                   // not configured = closed
  const raw = (body && body.key) || url.searchParams.get('key') || req.headers.get('x-venue-key') || '';
  const given = String(raw).trim();
  if (!given) return false;
  const h = (v) => crypto.createHash('sha256').update(v, 'utf8').digest();
  try { return crypto.timingSafeEqual(h(given), h(want)); } catch { return false; }
}
const authed = (req, url, body) => keyOk(req, url, body) || requireAdmin(req);

async function load() {
  const rows = await sql`SELECT data, version FROM venue_state WHERE id = 1`;
  if (!rows.length) return { data: {}, version: 1 };
  return { data: rows[0].data || {}, version: rows[0].version };
}

function publicState(d, version) {
  const mode = MODES[d.mode] ? d.mode : 'idle';
  const m = MODES[mode];
  return {
    mode,
    label: m.label,
    screen: m.screen,
    av: m.av,
    blurb: m.blurb,
    note: d.note || null,
    since: d.since || null,
    setBy: d.setBy || null,
    version,
    serverNow: now()
  };
}

async function setMode(mode, opts) {
  const { data: prev, version } = await load();
  const d = Object.assign({}, prev);
  const changed = d.mode !== mode;
  d.mode = mode;
  if (changed) { d.since = now(); d.note = null; }     // a new mode starts with a clean slate
  if (opts && opts.note !== undefined) d.note = clean(opts.note, 160) || null;
  d.setBy = (opts && opts.setBy) || null;
  const next = version + 1;
  await sql`UPDATE venue_state SET data = ${JSON.stringify(d)}::jsonb, version = ${next}, updated_at = now() WHERE id = 1`;
  return { state: publicState(d, next), changed };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^.*\/venue\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const head = parts[0] || '';

    if (head === 'time' && req.method === 'GET') return json({ serverNow: now() });

    if (head === 'modes' && req.method === 'GET') {
      return json({ modes: MODE_IDS.map(id => Object.assign({ id }, MODES[id])), serverNow: now() });
    }

    if (head === 'state' && req.method === 'GET') {
      const { data, version } = await load();
      const v = Number(url.searchParams.get('v') || 0);
      if (v && v === version) return json({ unchanged: true, version, serverNow: now() });
      return json(publicState(data, version));
    }

    // ---- the Stream Deck surface: one bare URL per button -------------------
    if (head === 'mode' && parts[1] && req.method === 'GET') {
      const mode = String(parts[1]).toLowerCase();
      if (!MODES[mode]) return bad('unknown mode "' + mode + '" — one of: ' + MODE_IDS.join(', '), 404);
      if (!authed(req, url, null)) return bad('unauthorized', 401);
      const r = await setMode(mode, { setBy: 'streamdeck' });
      // Companion shows the response body on the button when asked to, so keep
      // the first thing in it human-readable.
      return json(Object.assign({ ok: true, set: r.state.label }, r.state));
    }

    if (head === 'mode' && !parts[1] && req.method === 'POST') {
      const body = await readBody(req);
      if (!authed(req, url, body)) return bad('unauthorized', 401);
      const mode = String(body.mode || '').toLowerCase();
      if (!MODES[mode]) return bad('unknown mode "' + mode + '" — one of: ' + MODE_IDS.join(', '), 400);
      const r = await setMode(mode, { note: body.note, setBy: clean(body.setBy, 30) || 'api' });
      return json(Object.assign({ ok: true }, r.state));
    }

    // A one-line override for the screens ("Round 3 starts in 5") without
    // changing mode — the thing a Guru actually wants mid-event.
    if (head === 'note' && req.method === 'POST') {
      const body = await readBody(req);
      if (!authed(req, url, body)) return bad('unauthorized', 401);
      const { data: prev, version } = await load();
      const d = Object.assign({}, prev, { note: clean(body.note, 160) || null });
      const next = version + 1;
      await sql`UPDATE venue_state SET data = ${JSON.stringify(d)}::jsonb, version = ${next}, updated_at = now() WHERE id = 1`;
      return json(Object.assign({ ok: true }, publicState(d, next)));
    }

    return bad('not found', 404);
  } catch (e) {
    console.error('[venue]', e);
    return bad('server error: ' + (e && e.message || e), 500);
  }
};
