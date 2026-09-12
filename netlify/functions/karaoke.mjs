// netlify/functions/karaoke.mjs
// NGH-BUILD 2026-09-11a — Karaoke Battle engine
// ---------------------------------------------------------------------
// Same synchronization model as trivia.mjs / tv.mjs: no WebSockets on
// Netlify Functions. Every client polls GET state with the last version it
// saw; the server answers {unchanged:true, serverNow} (tiny) until a
// mutation bumps `version`. Anything timed (song start, scoring window)
// is scheduled in SERVER epoch ms so TVs, phones and the rack player start
// together. The session document is one JSON blob (karaoke_sessions.data),
// mutated with optimistic concurrency (UPDATE … WHERE version = expected).
//
// Routes (via /api/karaoke/* alias in netlify.toml):
//   GET  /karaoke/time                               PUBLIC {serverNow}
//   GET  /karaoke/active                             PUBLIC most recent lobby/live session {code, mode, status}
//   GET  /karaoke/songs?q=&limit=                    PUBLIC catalog search
//   GET  /karaoke/songs/:id                          PUBLIC song meta (no lyrics)
//   GET  /karaoke/songs/:id/lyrics                   PUBLIC {lyrics: TimedLyrics|null, cdg: url|null}
//   PUT  /karaoke/catalog                            admin  bulk upsert songs [{id,title,artist,durationMs,provider,media:{audio,cdg},lyrics}]
//   DELETE /karaoke/catalog/:id                      admin
//   GET  /karaoke/catalog/stats                      admin  {songs, withLyrics, withCdg, providers}
//   GET  /karaoke/sessions                           admin  recent sessions
//   POST /karaoke/sessions                           admin  {mode:'battle'|'openmic', rooms:[ids], settings} -> {code}
//   GET  /karaoke/sessions/:code/state?v=N           PUBLIC poll
//   POST /karaoke/sessions/:code/join                PUBLIC {name, room, deviceId} -> {memberId, token}
//   POST /karaoke/sessions/:code/leave               PUBLIC {token}
//   POST /karaoke/sessions/:code/queue               PUBLIC {token, songId | custom:{title,artist}, singers:[]}  (admin may pass room)
//   DELETE /karaoke/sessions/:code/queue/:entryId    PUBLIC own entry (token) | admin
//   POST /karaoke/sessions/:code/vote                PUBLIC {token, entryId, choice:1-5, delivery:1-5}
//   POST /karaoke/sessions/:code/tally               PUBLIC idempotent: closes scoring if closesAt passed (admin: force)
//   POST /karaoke/sessions/:code/autoend             PUBLIC idempotent: ends the song if startAt+duration passed (no rack player)
//   POST /karaoke/sessions/:code/control             admin  {action, ...} — see ACTIONS
//   POST /karaoke/sessions/:code/player              player heartbeat {key, name, status, position, entryId} (KARAOKE_PLAYER_KEY or admin)
//   GET  /karaoke/sessions/:code/player              admin  last heartbeat
//   GET  /karaoke/sessions/:code/wifi-qr.png         PUBLIC WiFi QR (session wifi or KARAOKE_WIFI_SSID/PASS env)
//   GET  /karaoke/media/needed?session=CODE          player — songs queued/playing whose CD+G isn't hosted yet
//   PUT  /karaoke/media/:songId/cdg                  player|admin {b64} — host a CD+G file (≤4 MB) for browsers
//   GET  /karaoke/media/:songId/cdg                  PUBLIC binary CD+G (HTTPS copy of the rack PC's LAN file)
//
// Why hosted CD+G: TVs and phones load gamehaven.guru over HTTPS, so they cannot
// fetch http://<rack-pc>:8766 LAN URLs (mixed content). The rack player uploads
// the .cdg for each song as it enters the queue; rows older than 7 days are purged.
// Browsers are never handed LAN URLs — only the rack player uses media.audio.
//
// Scoring (from the brief): after each song every member NOT in the singing
// room rates 1–5 stars for song choice and 1–5 for delivery. Points:
//   delivery = round1(avgDelivery * 2)  (max 10)
//   choice   = round1(avgChoice)        (max 5)
// voteWeighting 'participant' (default) averages every vote equally;
// 'room' averages within each room first, then across rooms.
// ---------------------------------------------------------------------

import QRCode from 'qrcode';
import { sql, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import crypto from 'node:crypto';

const ROOMS = {
  commons: { name: 'The Commons', color: '#c9973a' },
  holt:    { name: 'The Holt',    color: '#1488a6' },
  depths:  { name: 'The Depths',  color: '#7a2431' },
  den:     { name: "Stash's Den", color: '#3d7a54' }
};
const ROOM_ORDER = ['commons', 'holt', 'depths', 'den'];
const DEFAULT_SETTINGS = { maxSingers: 2, onDeck: 5, voteSeconds: 45, voteWeighting: 'participant', rotateRooms: true, leadInMs: 3000 };

let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
async function mk(stmt) { try { await stmt; } catch (e) { if (!isAlreadyExists(e)) throw e; } }
async function ensureSchema() {
  if (_ready) return;
  await mk(sql`CREATE TABLE IF NOT EXISTS karaoke_sessions (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'lobby', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
  await mk(sql`CREATE TABLE IF NOT EXISTS karaoke_songs (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'local', title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER, data JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ DEFAULT now())`);
  await mk(sql`CREATE INDEX IF NOT EXISTS karaoke_songs_title_idx ON karaoke_songs (lower(title))`);
  await mk(sql`CREATE INDEX IF NOT EXISTS karaoke_songs_artist_idx ON karaoke_songs (lower(artist))`);
  await mk(sql`CREATE TABLE IF NOT EXISTS karaoke_votes (
    session_id TEXT NOT NULL, entry_id TEXT NOT NULL, member_id TEXT NOT NULL, room TEXT NOT NULL,
    choice INTEGER NOT NULL, delivery INTEGER NOT NULL, at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (session_id, entry_id, member_id))`);
  await mk(sql`CREATE TABLE IF NOT EXISTS karaoke_media (
    song_id TEXT NOT NULL, kind TEXT NOT NULL, b64 TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (song_id, kind))`);
  await mk(sql`CREATE TABLE IF NOT EXISTS karaoke_players (
    session_id TEXT NOT NULL, name TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (session_id, name))`);
  _ready = true;
}

// ---- helpers ----
const now = () => Date.now();
const rid = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const token = () => crypto.randomBytes(12).toString('hex');
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += A[crypto.randomInt(A.length)]; return s; }
const round1 = (x) => Math.round(x * 10) / 10;
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 80);
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
async function readBody(req) { try { return await req.json(); } catch { return {}; } }
function playerKeyOk(req, body) {
  const k = process.env.KARAOKE_PLAYER_KEY || '';
  const given = (body && body.key) || (req.headers.get('x-karaoke-key') || '');
  return (k && given && crypto.timingSafeEqual(Buffer.from(String(given).padEnd(64).slice(0, 64)), Buffer.from(String(k).padEnd(64).slice(0, 64)))) || requireAdmin(req);
}

// ---- session load / mutate (optimistic concurrency) ----
async function loadSession(code) {
  const rows = await sql`SELECT data, version, status FROM karaoke_sessions WHERE id = ${code}`;
  if (!rows.length) return null;
  const s = rows[0].data; s.version = rows[0].version; return s;
}
// fn(s) mutates in place and returns a result (or throws {status,error}); retried on version conflict.
async function mutate(code, fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const s = await loadSession(code);
    if (!s) return { error: 'no such session', status: 404 };
    const expected = s.version;
    let result;
    try { result = await fn(s); } catch (e) { if (e && e.status) return { error: e.error || e.message, status: e.status }; throw e; }
    if (result && result.noChange) return { ok: true, state: s, result };
    s.version = expected + 1;
    s.status = s.status || 'lobby';
    const r = await sql`UPDATE karaoke_sessions SET data = ${JSON.stringify(s)}::jsonb, version = ${expected + 1}, status = ${s.status}, updated_at = now()
                        WHERE id = ${code} AND version = ${expected} RETURNING version`;
    if (r.length) return { ok: true, state: s, result };
  }
  return { error: 'busy, try again', status: 409 };
}

// ---- state shaping ----
function publicState(s, serverNow) {
  const out = Object.assign({}, s);
  out.members = (s.members || []).map(m => ({ id: m.id, name: m.name, room: m.room, joinedAt: m.joinedAt }));
  out.settings = Object.assign({}, s.settings || {});
  if (out.settings.wifi) out.settings.wifi = { ssid: out.settings.wifi.ssid || '', hasQr: !!(out.settings.wifi.ssid) };
  else if (process.env.KARAOKE_WIFI_SSID) out.settings.wifi = { ssid: process.env.KARAOKE_WIFI_SSID, hasQr: true };
  out.onDeck = onDeck(s, (s.settings && s.settings.onDeck) || 5).map(e => e.id);
  out.mg = mgPublic(s.mg, serverNow);   /* NGH-BUILD 2026-09-12l */
  out.serverNow = serverNow;
  return out;
}
function findMember(s, tok) { return tok ? (s.members || []).find(m => m.token === tok) : null; }
function roomList(s) { return (s.roomOrder && s.roomOrder.length) ? s.roomOrder : ROOM_ORDER.filter(r => s.rooms && s.rooms[r]); }
function byOrder(a, b) { return (a.order - b.order) || (a.addedAt - b.addedAt); }

// On-deck order: round-robin between rooms (battle + rotateRooms) starting
// after the room that sang last; otherwise plain queue order.
function onDeck(s, n) {
  const queued = (s.queue || []).filter(q => q.status === 'queued').slice().sort(byOrder);
  if (!(s.mode === 'battle' && s.settings && s.settings.rotateRooms)) return queued.slice(0, n);
  const rooms = roomList(s); const out = []; let last = s.lastRoom || null; const pool = queued.slice();
  while (out.length < n && pool.length) {
    let picked = null;
    const start = rooms.indexOf(last);
    for (let i = 1; i <= rooms.length && !picked; i++) {
      const r = rooms[(start + i) % rooms.length];
      picked = pool.find(q => q.room === r) || null;
    }
    if (!picked) picked = pool[0];
    out.push(picked); last = picked.room; pool.splice(pool.indexOf(picked), 1);
  }
  return out;
}
function nextEntry(s) { return onDeck(s, 1)[0] || null; }

// Browser-safe CD+G URL: hosted copy if uploaded, an https:// provider URL as-is, never a LAN http:// URL.
function hostedCdg(id, d) {
  const m = (d && d.media) || {};
  if (m.cdgHosted) return '/api/karaoke/media/' + encodeURIComponent(id) + '/cdg';
  if (m.cdg && /^https:\/\//i.test(m.cdg)) return m.cdg;
  return null;
}
async function songMedia(songId) {
  if (!songId) return null;
  const rows = await sql`SELECT id, title, artist, duration_ms, provider, data FROM karaoke_songs WHERE id = ${songId}`;
  if (!rows.length) return null;
  const r = rows[0]; const d = r.data || {};
  return { id: r.id, title: r.title, artist: r.artist, durationMs: r.duration_ms || d.durationMs || null, provider: r.provider,
           media: { audio: d.media && d.media.audio || null, cdg: hostedCdg(r.id, d), video: d.media && d.media.video || null },
           hasLyrics: !!(d.lyrics && d.lyrics.lines && d.lyrics.lines.length) };
}

// ---- Name That Tune (Battle Karaoke minigame) — NGH-BUILD 2026-09-12l ----------
// Between performances the next singer is setting up and the room goes flat.
// This fills it: a few seconds of a song intro, first phone to buzz gets to
// name it, points go to their ROOM's battle score.
//
// The buzz model is lifted from arcade.mjs because it is already right:
//   * The host ARMS the round. goAt = armAt + a short lead, and every phone
//     flips to "GO" on its OWN clock-synced timer — no server round trip in
//     the hot path, so the race is fair regardless of who has better wifi.
//   * A press posts the phone's offset-corrected server time. Reaction is
//     t - goAt. Pressing before goAt is a JUMP: recorded, ordered last, and
//     the Guru can see who jumped the gun.
//   * Anti-cheat: t is clamped to the server's arrival time (nobody presses
//     from the future) and anything wildly early is rejected outright.
//
// Deliberately NOT automated end to end: the Guru arms it at the moment they
// start the clip, whatever the audio is coming from. Only the rack player can
// reach the LAN audio files (browsers get HTTPS-only URLs), so tying the game
// to rack-player automation would make it unusable on any night the rack PC is
// off. `mg.media` is published for the rack player to pick up when it can, and
// the game works perfectly without it.
const MG_LEAD_MS = 2500;          // between arming and GO
const MG_ANSWER_MS = 15000;       // how long the first buzzer has to answer
const MG_SETTLE_MS = 1200;        // window in which a faster press can still take the floor
const MG_POINTS = 10;
const MG_STEAL_POINTS = 5;        // a steal after someone else missed

function mgPublic(mg, serverNow) {
  if (!mg) return null;
  const out = {
    id: mg.id, kind: mg.kind, round: mg.round, phase: mg.phase,
    armAt: mg.armAt || 0, goAt: mg.goAt || 0, clipMs: mg.clipMs || 0,
    points: mg.points, answerBy: mg.answerBy || 0,
    buzzes: (mg.buzzes || []).map(b => ({ memberId: b.memberId, name: b.name, room: b.room, rt: b.rt, jumped: !!b.jumped })),
    answering: mg.answering || null, settleUntil: mg.settleUntil || 0,
    result: mg.result || null,
    missed: mg.missed || []
  };
  // The whole game is not knowing what the song is. Title, artist and songId
  // stay server-side until the reveal — a curious player reading the JSON in
  // devtools would otherwise win every round.
  if (mg.phase === 'reveal') { out.title = mg.title; out.artist = mg.artist; out.songId = mg.songId; }
  return out;
}
function mgRoomOf(s, memberId) {
  const m = (s.members || []).find(x => x.id === memberId);
  return m ? m.room : null;
}
function mgAward(s, memberId, pts) {
  const room = mgRoomOf(s, memberId);
  if (!room || !s.rooms || !s.rooms[room]) return null;
  s.rooms[room].score = round1((Number(s.rooms[room].score) || 0) + pts);
  return room;
}
// Buzz order: everyone who went early is sorted behind everyone who didn't,
// then by reaction time.
function mgSortBuzzes(list) {
  return list.slice().sort((a, b) => (a.jumped - b.jumped) || (a.rt - b.rt) || (a.at - b.at));
}
// Who has the floor: the fastest clean buzz that has not already had a turn.
// Jumping the gun puts you out for the round — you do not get a steal either,
// which is the only thing that makes the penalty mean anything.
function mgNextUp(mg) {
  const done = mg.missed || [];
  return mgSortBuzzes(mg.buzzes || []).find(b => !b.jumped && done.indexOf(b.memberId) < 0) || null;
}

// ---- transport ----
async function startEntry(s, entry) {
  const song = entry.songId ? await songMedia(entry.songId) : null;
  const t = now();
  s.playSeq = (s.playSeq || 0) + 1;
  entry.status = 'playing'; entry.startedAt = t;
  s.nowPlaying = {
    entryId: entry.id, songId: entry.songId || null, title: entry.title, artist: entry.artist, singers: entry.singers, room: entry.room,
    startAt: t + ((s.settings && s.settings.leadInMs) || 3000), pausedAt: null,
    durationMs: (song && song.durationMs) || entry.durationMs || null,
    media: song ? song.media : null, hasLyrics: !!(song && song.hasLyrics),
    lyricsUrl: song && song.hasLyrics ? ('/api/karaoke/songs/' + encodeURIComponent(song.id) + '/lyrics') : null,
    seq: s.playSeq, custom: !entry.songId
  };
  s.status = 'live'; s.scoring = null; s.lastResult = null;
}
function endCurrent(s, how) {
  const np = s.nowPlaying; if (!np) return null;
  const entry = (s.queue || []).find(q => q.id === np.entryId);
  s.nowPlaying = null;
  if (!entry) return null;
  s.lastRoom = entry.room;
  entry.endedAt = now();
  if (how === 'skip') { entry.status = 'skipped'; return entry; }
  if (s.mode === 'battle' && s.rooms && Object.keys(s.rooms).length > 1) {
    entry.status = 'scoring';
    const secs = (s.settings && s.settings.voteSeconds) || 45;
    s.scoring = { entryId: entry.id, room: entry.room, title: entry.title, singers: entry.singers, opensAt: now(), closesAt: now() + secs * 1000, tally: { count: 0, choiceAvg: 0, deliveryAvg: 0 } };
  } else {
    entry.status = 'done';
    pushHistory(s, entry);
  }
  return entry;
}
function pushHistory(s, entry) {
  s.history = s.history || [];
  s.history.unshift({ id: entry.id, title: entry.title, artist: entry.artist, singers: entry.singers, room: entry.room, endedAt: entry.endedAt, points: entry.points || null });
  s.history = s.history.slice(0, 20);
}
async function tallyVotes(code, s, force) {
  const sc = s.scoring; if (!sc) return { noChange: true };
  if (!force && now() < sc.closesAt) return { noChange: true };
  const rows = await sql`SELECT room, choice, delivery FROM karaoke_votes WHERE session_id = ${code} AND entry_id = ${sc.entryId}`;
  const entry = (s.queue || []).find(q => q.id === sc.entryId);
  let choiceAvg = 0, deliveryAvg = 0;
  if (rows.length) {
    if ((s.settings && s.settings.voteWeighting) === 'room') {
      const byRoom = {};
      rows.forEach(r => { (byRoom[r.room] = byRoom[r.room] || []).push(r); });
      const roomsAvg = Object.values(byRoom).map(list => ({ c: list.reduce((a, r) => a + r.choice, 0) / list.length, d: list.reduce((a, r) => a + r.delivery, 0) / list.length }));
      choiceAvg = roomsAvg.reduce((a, r) => a + r.c, 0) / roomsAvg.length;
      deliveryAvg = roomsAvg.reduce((a, r) => a + r.d, 0) / roomsAvg.length;
    } else {
      choiceAvg = rows.reduce((a, r) => a + r.choice, 0) / rows.length;
      deliveryAvg = rows.reduce((a, r) => a + r.delivery, 0) / rows.length;
    }
  }
  const pDelivery = round1(deliveryAvg * 2), pChoice = round1(choiceAvg), points = round1(pDelivery + pChoice);
  const result = { entryId: sc.entryId, room: sc.room, title: sc.title, singers: sc.singers, votes: rows.length,
                   choiceAvg: round1(choiceAvg), deliveryAvg: round1(deliveryAvg), pointsChoice: pChoice, pointsDelivery: pDelivery, points, unscored: !rows.length, at: now() };
  s.results = s.results || [];
  // Re-opened scoring for a song that was already tallied: replace the old result instead of double counting.
  const prevIdx = s.results.findIndex(x => x.entryId === sc.entryId);
  if (prevIdx >= 0) {
    const prev = s.results[prevIdx];
    if (s.rooms && s.rooms[prev.room]) { s.rooms[prev.room].score = round1((s.rooms[prev.room].score || 0) - (prev.points || 0)); s.rooms[prev.room].songs = Math.max(0, (s.rooms[prev.room].songs || 0) - 1); }
    s.results.splice(prevIdx, 1);
    if (s.history) s.history = s.history.filter(h => h.id !== sc.entryId);
  }
  s.results.push(result);
  if (s.rooms && s.rooms[sc.room]) { s.rooms[sc.room].score = round1((s.rooms[sc.room].score || 0) + points); s.rooms[sc.room].songs = (s.rooms[sc.room].songs || 0) + 1; }
  if (entry) { entry.status = 'done'; entry.points = points; pushHistory(s, entry); }
  s.lastResult = result; s.scoring = null;
  return result;
}

// ---- catalog search ----
async function searchSongs(q, limit) {
  const lim = Math.min(60, Math.max(1, limit || 30));
  q = clean(q, 80);
  if (!q) {
    return sql`SELECT id, title, artist, duration_ms, provider, (data->'lyrics') IS NOT NULL AS has_lyrics, data->'media'->>'cdg' IS NOT NULL AS has_cdg
               FROM karaoke_songs ORDER BY updated_at DESC LIMIT ${lim}`;
  }
  const like = '%' + q.toLowerCase().replace(/[%_]/g, '') + '%';
  const prefix = q.toLowerCase().replace(/[%_]/g, '') + '%';
  return sql`SELECT id, title, artist, duration_ms, provider, (data->'lyrics') IS NOT NULL AS has_lyrics, data->'media'->>'cdg' IS NOT NULL AS has_cdg
             FROM karaoke_songs
             WHERE lower(title) LIKE ${like} OR lower(artist) LIKE ${like}
             ORDER BY (lower(title) LIKE ${prefix}) DESC, (lower(artist) LIKE ${prefix}) DESC, title ASC
             LIMIT ${lim}`;
}
function songRow(r) { return { id: r.id, title: r.title, artist: r.artist, durationMs: r.duration_ms, provider: r.provider, hasLyrics: !!r.has_lyrics, hasCdg: !!r.has_cdg }; }

// =====================================================================
export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^.*\/karaoke\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const head = parts[0] || '';

    if (head === 'time') return json({ serverNow: now() });

    if (head === 'active' && req.method === 'GET') {
      const rows = await sql`SELECT id, status, data->>'mode' AS mode, version FROM karaoke_sessions WHERE status IN ('lobby','live') ORDER BY updated_at DESC LIMIT 1`;
      if (!rows.length) return json({ code: null, serverNow: now() });
      return json({ code: rows[0].id, status: rows[0].status, mode: rows[0].mode, v: rows[0].version, serverNow: now() });
    }

    // ---------------- catalog ----------------
    if (head === 'songs') {
      const id = parts[1];
      if (!id && req.method === 'GET') {
        const rows = await searchSongs(url.searchParams.get('q') || '', Number(url.searchParams.get('limit')) || 30);
        return json({ songs: rows.map(songRow) });
      }
      if (id && parts[2] === 'lyrics' && req.method === 'GET') {
        const rows = await sql`SELECT data FROM karaoke_songs WHERE id = ${id}`;
        if (!rows.length) return bad('not found', 404);
        const d = rows[0].data || {};
        const cdgUrl = hostedCdg(id, d);
        return new Response(JSON.stringify({ lyrics: d.lyrics || null, cdg: cdgUrl, cdgPending: !cdgUrl && !!(d.media && d.media.cdg), offsetMs: d.offsetMs || 0 }),
          { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': cdgUrl || !(d.media && d.media.cdg) ? 'public, max-age=300' : 'no-store' } });
      }
      if (id && req.method === 'GET') {
        const m = await songMedia(id); if (!m) return bad('not found', 404);
        return json(m);
      }
      return bad('not found', 404);
    }

    if (head === 'catalog') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      if (parts[1] === 'stats' && req.method === 'GET') {
        const r = await sql`SELECT count(*)::int AS songs, count(*) FILTER (WHERE data ? 'lyrics')::int AS with_lyrics,
                                   count(*) FILTER (WHERE data->'media'->>'cdg' IS NOT NULL)::int AS with_cdg FROM karaoke_songs`;
        const p = await sql`SELECT provider, count(*)::int AS n FROM karaoke_songs GROUP BY provider`;
        return json({ songs: r[0].songs, withLyrics: r[0].with_lyrics, withCdg: r[0].with_cdg, providers: p });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const list = Array.isArray(body) ? body : (body.songs || []);
        let n = 0;
        // keep the hosted-CD+G flag across re-imports (one lookup per batch)
        const batchIds = list.slice(0, 500).map(x => clean(x && x.id, 120)).filter(Boolean);
        const hostedRows = batchIds.length ? await sql`SELECT song_id FROM karaoke_media WHERE kind = 'cdg' AND song_id = ANY(${batchIds})` : [];
        const hosted = new Set(hostedRows.map(r => r.song_id));
        for (const s of list.slice(0, 500)) {
          const id = clean(s.id, 120); const title = clean(s.title, 160); if (!id || !title) continue;
          const data = { media: Object.assign({}, s.media || {}, hosted.has(id) ? { cdgHosted: true } : {}), lyrics: (s.lyrics && s.lyrics.lines) ? s.lyrics : undefined, offsetMs: Number(s.offsetMs) || 0, meta: s.meta || undefined, durationMs: Number(s.durationMs) || null };
          await sql`INSERT INTO karaoke_songs (id, provider, title, artist, duration_ms, data, updated_at)
                    VALUES (${id}, ${clean(s.provider, 20) || 'local'}, ${title}, ${clean(s.artist, 160)}, ${Number(s.durationMs) || null}, ${JSON.stringify(data)}::jsonb, now())
                    ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, title = EXCLUDED.title, artist = EXCLUDED.artist,
                      duration_ms = COALESCE(EXCLUDED.duration_ms, karaoke_songs.duration_ms), data = EXCLUDED.data, updated_at = now()`;
          n++;
        }
        return json({ upserted: n });
      }
      if (parts[1] && req.method === 'DELETE') { await sql`DELETE FROM karaoke_songs WHERE id = ${parts[1]}`; return noContent(); }
      return bad('not found', 404);
    }

    // ---------------- hosted CD+G media ----------------
    if (head === 'media') {
      if (parts[1] === 'needed' && req.method === 'GET') {
        if (!playerKeyOk(req, {})) return bad('unauthorized', 401);
        const s = await loadSession(cleanCode(url.searchParams.get('session')));
        if (!s) return json({ songs: [] });
        const ids = [...new Set((s.queue || []).filter(q => q.songId && (q.status === 'queued' || q.status === 'playing')).map(q => q.songId))].slice(0, 40);
        const out = [];
        for (const sid of ids) {
          const r = await sql`SELECT data FROM karaoke_songs WHERE id = ${sid}`;
          const d = r.length ? (r[0].data || {}) : {};
          if (d.media && d.media.cdg && !d.media.cdgHosted) out.push({ id: sid, cdg: d.media.cdg });
        }
        return json({ songs: out });
      }
      const sid = parts[1], kind = parts[2];
      if (!sid || kind !== 'cdg') return bad('not found', 404);
      if (req.method === 'GET') {
        const r = await sql`SELECT b64 FROM karaoke_media WHERE song_id = ${sid} AND kind = 'cdg'`;
        if (!r.length) return bad('not hosted yet', 404);
        return new Response(Buffer.from(r[0].b64, 'base64'), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!playerKeyOk(req, body)) return bad('unauthorized', 401);
        const b64 = String(body.b64 || '');
        const bytes = Math.floor(b64.length * 3 / 4);
        if (!bytes || bytes > 4.2 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return bad('b64 CD+G payload required (max 4 MB)');
        const r = await sql`SELECT data FROM karaoke_songs WHERE id = ${sid}`;
        if (!r.length) return bad('song not found', 404);
        await sql`DELETE FROM karaoke_media WHERE updated_at < now() - interval '7 days'`;
        await sql`INSERT INTO karaoke_media (song_id, kind, b64, bytes, updated_at) VALUES (${sid}, 'cdg', ${b64}, ${bytes}, now())
                  ON CONFLICT (song_id, kind) DO UPDATE SET b64 = EXCLUDED.b64, bytes = EXCLUDED.bytes, updated_at = now()`;
        const d = r[0].data || {}; d.media = Object.assign({}, d.media || {}, { cdgHosted: true });
        await sql`UPDATE karaoke_songs SET data = ${JSON.stringify(d)}::jsonb, updated_at = now() WHERE id = ${sid}`;
        return json({ ok: true, bytes, url: '/api/karaoke/media/' + encodeURIComponent(sid) + '/cdg' });
      }
      return bad('not found', 404);
    }

    // ---------------- sessions ----------------
    if (head !== 'sessions') return bad('not found', 404);
    const code = cleanCode(parts[1]);
    const sub = parts[2] || '';

    if (!code && req.method === 'GET') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const rows = await sql`SELECT id, status, version, created_at, updated_at, data->>'mode' AS mode, jsonb_array_length(COALESCE(data->'members','[]'::jsonb)) AS members
                             FROM karaoke_sessions ORDER BY updated_at DESC LIMIT 20`;
      return json({ sessions: rows });
    }
    if (!code && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const body = await readBody(req);
      const mode = body.mode === 'openmic' ? 'openmic' : 'battle';
      const roomIds = (Array.isArray(body.rooms) && body.rooms.length ? body.rooms : ROOM_ORDER).filter(r => ROOMS[r]);
      const rooms = {}; roomIds.forEach(r => { rooms[r] = { name: ROOMS[r].name, color: ROOMS[r].color, team: clean((body.teams || {})[r], 40) || ROOMS[r].name, score: 0, songs: 0 }; });
      const settings = Object.assign({}, DEFAULT_SETTINGS, sanitizeSettings(body.settings || {}));
      let newC = newCode();
      for (let i = 0; i < 5; i++) { const ex = await sql`SELECT 1 FROM karaoke_sessions WHERE id = ${newC}`; if (!ex.length) break; newC = newCode(); }
      const s = { code: newC, mode, status: 'lobby', settings, rooms, roomOrder: roomIds, members: [], queue: [], nowPlaying: null, scoring: null, results: [], history: [], lastRoom: null, playSeq: 0, createdAt: now() };
      await sql`INSERT INTO karaoke_sessions (id, data, version, status) VALUES (${newC}, ${JSON.stringify(s)}::jsonb, 1, 'lobby')`;
      return json({ code: newC, state: publicState(Object.assign(s, { version: 1 }), now()) }, 201);
    }
    if (!code) return bad('session code required');

    // ---- public poll ----
    if (sub === 'state' && req.method === 'GET') {
      const s = await loadSession(code); if (!s) return bad('no such session', 404);
      const v = Number(url.searchParams.get('v')) || 0;
      if (v && v === s.version) return json({ unchanged: true, serverNow: now(), version: s.version });
      return json(publicState(s, now()));
    }

    // ---- wifi QR ----
    if (sub === 'wifi-qr.png' && req.method === 'GET') {
      const s = await loadSession(code); if (!s) return bad('no such session', 404);
      const w = (s.settings && s.settings.wifi && s.settings.wifi.ssid) ? s.settings.wifi : { ssid: process.env.KARAOKE_WIFI_SSID || '', pass: process.env.KARAOKE_WIFI_PASS || '', auth: process.env.KARAOKE_WIFI_AUTH || 'WPA' };
      if (!w.ssid) return bad('no wifi configured', 404);
      const escW = (t) => String(t).replace(/([\\;,:"])/g, '\\$1');
      const payload = 'WIFI:T:' + (w.pass ? (w.auth || 'WPA') : 'nopass') + ';S:' + escW(w.ssid) + ';' + (w.pass ? 'P:' + escW(w.pass) + ';' : '') + ';';
      const size = Math.min(800, Math.max(120, Number(url.searchParams.get('s')) || 360));
      const png = await QRCode.toBuffer(payload, { type: 'png', width: size, margin: 1, color: { dark: '#132a1d', light: '#f6efdd' } });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
    }

    // ---- join / leave ----
    if (sub === 'join' && req.method === 'POST') {
      const body = await readBody(req);
      const name = clean(body.name, 30); const room = String(body.room || '').toLowerCase();
      if (!name) return bad('name required');
      const r = await mutate(code, (s) => {
        if (s.status === 'ended') throw { status: 410, error: 'session ended' };
        if (!s.rooms[room]) throw { status: 400, error: 'pick a room' };
        // same device re-joining → reuse
        const dev = clean(body.deviceId, 40);
        let m = dev ? s.members.find(x => x.deviceId === dev) : null;
        if (m) { m.name = name; m.room = room; m.token = m.token || token(); m.lastSeen = now(); return { member: m }; }
        if (s.members.length >= 200) throw { status: 429, error: 'session full' };
        m = { id: rid('m'), name, room, deviceId: dev || null, token: token(), joinedAt: now(), lastSeen: now() };
        s.members.push(m);
        return { member: m };
      });
      if (r.error) return bad(r.error, r.status);
      const m = r.result.member;
      return json({ memberId: m.id, token: m.token, name: m.name, room: m.room, state: publicState(r.state, now()) });
    }
    if (sub === 'leave' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await mutate(code, (s) => { const i = s.members.findIndex(m => m.token === body.token); if (i < 0) return { noChange: true }; s.members.splice(i, 1); return {}; });
      if (r.error) return bad(r.error, r.status);
      return noContent();
    }

    // ---- queue ----
    if (sub === 'queue' && req.method === 'POST') {
      const body = await readBody(req);
      const isAdmin = requireAdmin(req);
      let song = null;
      if (body.songId) { song = await songMedia(String(body.songId)); if (!song) return bad('song not found', 404); }
      const r = await mutate(code, (s) => {
        if (s.status === 'ended') throw { status: 410, error: 'session ended' };
        const m = findMember(s, body.token);
        if (!m && !isAdmin) throw { status: 401, error: 'join first' };
        const room = (isAdmin && body.room && s.rooms[body.room]) ? body.room : (m ? m.room : roomList(s)[0]);
        const maxS = (s.settings && s.settings.maxSingers) || 2;
        let singers = (Array.isArray(body.singers) ? body.singers : []).map(x => clean(x, 30)).filter(Boolean).slice(0, maxS);
        if (!singers.length && m) singers = [m.name];
        if (!singers.length) throw { status: 400, error: 'who is singing?' };
        const custom = body.custom && !song ? { title: clean(body.custom.title, 120), artist: clean(body.custom.artist, 120) } : null;
        if (!song && !(custom && custom.title)) throw { status: 400, error: 'song required' };
        const mine = s.queue.filter(q => q.status === 'queued' && m && q.requestedBy === m.id).length;
        if (!isAdmin && mine >= 3) throw { status: 429, error: 'you already have 3 songs queued' };
        const e = { id: rid('q'), songId: song ? song.id : null, title: song ? song.title : custom.title, artist: song ? song.artist : custom.artist,
                    durationMs: song ? song.durationMs : null, room, singers, requestedBy: m ? m.id : 'host', status: 'queued', addedAt: now(),
                    order: (s.queue.reduce((mx, q) => Math.max(mx, q.order || 0), 0) + 1) };
        s.queue.push(e);
        return { entry: e };
      });
      if (r.error) return bad(r.error, r.status);
      return json({ entry: r.result.entry, state: publicState(r.state, now()) }, 201);
    }
    if (sub === 'queue' && parts[3] && req.method === 'DELETE') {
      const isAdmin = requireAdmin(req);
      const tok = url.searchParams.get('token') || req.headers.get('x-karaoke-token') || '';
      const r = await mutate(code, (s) => {
        const e = s.queue.find(q => q.id === parts[3]); if (!e) throw { status: 404, error: 'not in queue' };
        const m = findMember(s, tok);
        if (!isAdmin && !(m && e.requestedBy === m.id)) throw { status: 403, error: 'not your song' };
        if (e.status !== 'queued') throw { status: 409, error: 'already ' + e.status };
        s.queue.splice(s.queue.indexOf(e), 1); return {};
      });
      if (r.error) return bad(r.error, r.status);
      return json({ state: publicState(r.state, now()) });
    }

    // ---- vote ----
    if (sub === 'vote' && req.method === 'POST') {
      const body = await readBody(req);
      const s = await loadSession(code); if (!s) return bad('no such session', 404);
      const m = findMember(s, body.token); if (!m) return bad('join first', 401);
      const sc = s.scoring; if (!sc || sc.entryId !== body.entryId) return bad('scoring is not open for that song', 409);
      if (now() > sc.closesAt + 3000) return bad('scoring closed', 409);
      if (m.room === sc.room) return bad('you cannot score your own room', 403);
      const choice = Math.round(Number(body.choice)), delivery = Math.round(Number(body.delivery));
      if (!(choice >= 1 && choice <= 5 && delivery >= 1 && delivery <= 5)) return bad('stars must be 1-5');
      await sql`INSERT INTO karaoke_votes (session_id, entry_id, member_id, room, choice, delivery) VALUES (${code}, ${sc.entryId}, ${m.id}, ${m.room}, ${choice}, ${delivery})
                ON CONFLICT (session_id, entry_id, member_id) DO UPDATE SET choice = EXCLUDED.choice, delivery = EXCLUDED.delivery, room = EXCLUDED.room, at = now()`;
      // live tally (cheap): bump version so TVs can show the count
      const agg = await sql`SELECT count(*)::int AS n, avg(choice)::float AS c, avg(delivery)::float AS d FROM karaoke_votes WHERE session_id = ${code} AND entry_id = ${sc.entryId}`;
      const r = await mutate(code, (st) => { if (!st.scoring || st.scoring.entryId !== sc.entryId) return { noChange: true }; st.scoring.tally = { count: agg[0].n, choiceAvg: round1(agg[0].c || 0), deliveryAvg: round1(agg[0].d || 0) }; return {}; });
      return json({ ok: true, tally: r.state && r.state.scoring ? r.state.scoring.tally : null });
    }

    // ---- idempotent timers (any client may call; server verifies) ----
    if (sub === 'tally' && req.method === 'POST') {
      const force = requireAdmin(req);
      const r = await mutate(code, (s) => tallyVotes(code, s, force));
      if (r.error) return bad(r.error, r.status);
      return json({ result: r.result && r.result.noChange ? null : r.result, state: publicState(r.state, now()) });
    }
    if (sub === 'autoend' && req.method === 'POST') {
      const r = await mutate(code, (s) => {
        const np = s.nowPlaying;
        if (!np || !np.durationMs || np.pausedAt) return { noChange: true };
        if (now() < np.startAt + np.durationMs + 1500) return { noChange: true };
        endCurrent(s, 'end'); return {};
      });
      if (r.error) return bad(r.error, r.status);
      return json({ state: publicState(r.state, now()) });
    }

    // ---- rack player heartbeat ----
    if (sub === 'player') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (req.method === 'GET') {
        if (!requireAdmin(req)) return bad('unauthorized', 401);
        const rows = await sql`SELECT name, data, last_seen FROM karaoke_players WHERE session_id = ${code} ORDER BY last_seen DESC`;
        return json({ players: rows.map(r => ({ name: r.name, seenAt: new Date(r.last_seen).getTime(), online: (now() - new Date(r.last_seen).getTime()) < 12000, ...r.data })) });
      }
      if (!playerKeyOk(req, body)) return bad('unauthorized', 401);
      const name = clean(body.name, 30) || 'rack';
      const data = { status: clean(body.status, 20), position: Number(body.position) || 0, entryId: body.entryId || null, device: clean(body.device, 80), error: clean(body.error, 200) || null };
      await sql`INSERT INTO karaoke_players (session_id, name, data, last_seen) VALUES (${code}, ${name}, ${JSON.stringify(data)}::jsonb, now())
                ON CONFLICT (session_id, name) DO UPDATE SET data = EXCLUDED.data, last_seen = now()`;
      let state = null;
      if (data.status === 'ended' && data.entryId) {
        const r = await mutate(code, (s) => { if (!s.nowPlaying || s.nowPlaying.entryId !== data.entryId) return { noChange: true }; endCurrent(s, 'end'); return {}; });
        state = r.state;
      }
      if (!state) state = await loadSession(code);
      return json({ ok: true, serverNow: now(), version: state ? state.version : 0, nowPlaying: state ? state.nowPlaying : null, status: state ? state.status : null });
    }

    // ---- PUBLIC: Name That Tune buzz (NGH-BUILD 2026-09-12l) ----
    if (sub === 'mgbuzz' && req.method === 'POST') {
      const b = await readBody(req);
      const arrival = now();
      const r = await mutate(code, (s) => {
        const mg = s.mg;
        // Buzzes keep landing while someone is answering — that queue IS the
        // steal chain. Ordering is by reaction time, so anyone who only buzzes
        // after hearing the first player's guess sorts to the back on their own
        // and gains nothing by waiting.
        if (!mg || (mg.phase !== 'armed' && mg.phase !== 'answering')) throw { status: 409, error: 'no round is live' };
        if (b.mgId && b.mgId !== mg.id) throw { status: 409, error: 'stale round' };
        const m = findMember(s, b.token);
        if (!m) throw { status: 403, error: 'not checked in' };
        // One buzz per person per round. Answering "you already buzzed" is not
        // an error — a double-tap on a phone is the most ordinary thing there is.
        const prior = (mg.buzzes || []).find(x => x.memberId === m.id);
        if (prior) return { noChange: true, already: true, rt: prior.rt, jumped: prior.jumped, position: mgSortBuzzes(mg.buzzes).findIndex(x => x.memberId === m.id) + 1 };
        // A non-finite goAt means the round was armed wrong. Scoring against
        // `goAt || 0` would hand back reaction times in the billions and look
        // like a client bug, so refuse instead of guessing.
        const goAt = Number(mg.goAt);
        if (!isFinite(goAt) || goAt <= 0) throw { status: 409, error: 'this round was not armed properly — re-arm it' };
        let t = Number(b.t);
        if (!isFinite(t)) t = arrival;                  // phone never synced its clock
        if (t > arrival + 250) t = arrival;             // no presses from the future
        if (t < Number(mg.armAt || 0) - 2000) throw { status: 409, error: 'too early' };
        const jumped = t < goAt;
        const rt = Math.round(t - goAt);
        mg.buzzes = mg.buzzes || [];
        mg.buzzes.push({ memberId: m.id, name: m.name, room: m.room, at: t, rt, jumped });
        // The floor goes to the FASTEST reaction, not to whichever packet
        // reached us first — those are not the same thing on a room full of
        // phones sharing one access point, and handing the buzz to whoever had
        // the better wifi is precisely the unfairness the clock-synced press
        // time exists to remove. So for a short settling window after the first
        // buzz, a faster press still takes the floor; after that it is locked
        // and late arrivals queue for a steal.
        if (!mg.settleUntil) mg.settleUntil = now() + MG_SETTLE_MS;
        if (!mg.answering || now() < mg.settleUntil) {
          const lead = mgNextUp(mg);
          if (lead && lead.memberId !== mg.answering) {
            mg.answering = lead.memberId;
            mg.answerBy = now() + MG_ANSWER_MS;
            mg.phase = 'answering';
          }
        }
        return { rt, jumped, position: mgSortBuzzes(mg.buzzes).findIndex(x => x.memberId === m.id) + 1 };
      });
      if (r.error) return bad(r.error, r.status);
      return json(Object.assign({ ok: true, serverNow: now() }, r.result));
    }

    // ---- host control ----
    if (sub === 'control' && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const body = await readBody(req);
      const action = String(body.action || '');
      const r = await mutate(code, async (s) => {
        if (s.status === 'ended' && action !== 'reopen') throw { status: 410, error: 'session ended' };
        switch (action) {
          case 'start': s.status = 'live'; return {};
          case 'play': {
            if (s.nowPlaying) endCurrent(s, body.endAs === 'skip' ? 'skip' : 'end');
            if (s.scoring && !body.keepScoring) await tallyVotes(code, s, true);
            const e = body.entryId ? s.queue.find(q => q.id === body.entryId && q.status === 'queued') : nextEntry(s);
            if (!e) throw { status: 409, error: 'nothing queued' };
            await startEntry(s, e); return { started: e.id };
          }
          case 'pause': if (!s.nowPlaying || s.nowPlaying.pausedAt) return { noChange: true }; s.nowPlaying.pausedAt = now(); return {};
          case 'resume': {
            const np = s.nowPlaying; if (!np || !np.pausedAt) return { noChange: true };
            const pos = np.pausedAt - np.startAt; np.startAt = now() + 1500 - pos; np.pausedAt = null; np.seq = (s.playSeq = (s.playSeq || 0) + 1); return {};
          }
          case 'seek': { const np = s.nowPlaying; if (!np) return { noChange: true }; const pos = Math.max(0, Number(body.positionMs) || 0); np.startAt = now() + 1500 - pos; np.pausedAt = null; np.seq = (s.playSeq = (s.playSeq || 0) + 1); return {}; }
          case 'restart': { const np = s.nowPlaying; if (!np) return { noChange: true }; np.startAt = now() + 3000; np.pausedAt = null; np.seq = (s.playSeq = (s.playSeq || 0) + 1); return {}; }
          case 'end': if (!s.nowPlaying) return { noChange: true }; endCurrent(s, 'end'); return {};
          case 'skip': if (!s.nowPlaying) return { noChange: true }; endCurrent(s, 'skip'); return {};
          case 'openScoring': {
            const e = s.queue.find(q => q.id === body.entryId); if (!e) throw { status: 404, error: 'no such entry' };
            if (s.nowPlaying && s.nowPlaying.entryId === e.id) s.nowPlaying = null;
            const secs = (s.settings && s.settings.voteSeconds) || 45;
            e.status = 'scoring'; s.lastRoom = e.room;
            s.scoring = { entryId: e.id, room: e.room, title: e.title, singers: e.singers, opensAt: now(), closesAt: now() + secs * 1000, tally: { count: 0, choiceAvg: 0, deliveryAvg: 0 } };
            return {};
          }
          case 'extendScoring': if (!s.scoring) return { noChange: true }; s.scoring.closesAt = Math.max(s.scoring.closesAt, now()) + ((Number(body.seconds) || 20) * 1000); return {};
          case 'closeScoring': return tallyVotes(code, s, true);
          case 'reorder': {
            const ids = Array.isArray(body.order) ? body.order : [];
            let i = 1; ids.forEach(id => { const e = s.queue.find(q => q.id === id && q.status === 'queued'); if (e) e.order = i++; });
            s.queue.filter(q => q.status === 'queued' && ids.indexOf(q.id) < 0).sort(byOrder).forEach(e => { e.order = i++; });
            if (body.disableRotation !== false) s.settings.rotateRooms = false;
            return {};
          }
          case 'moveToTop': { const e = s.queue.find(q => q.id === body.entryId && q.status === 'queued'); if (!e) throw { status: 404, error: 'no such entry' }; e.order = Math.min(0, ...s.queue.map(q => q.order || 0)) - 1; e.pinned = true; return {}; }
          case 'removeEntry': { const i = s.queue.findIndex(q => q.id === body.entryId); if (i < 0) throw { status: 404, error: 'no such entry' }; if (s.nowPlaying && s.nowPlaying.entryId === body.entryId) endCurrent(s, 'skip'); else s.queue.splice(i, 1); return {}; }
          case 'setSingers': { const e = s.queue.find(q => q.id === body.entryId); if (!e) throw { status: 404, error: 'no such entry' }; e.singers = (body.singers || []).map(x => clean(x, 30)).filter(Boolean).slice(0, Math.max(1, s.settings.maxSingers || 2)); if (!e.singers.length) throw { status: 400, error: 'singer required' }; if (body.room && s.rooms[body.room]) e.room = body.room; return {}; }
          case 'setTeam': { const rm = s.rooms[body.room]; if (!rm) throw { status: 404, error: 'no such room' }; if (body.team != null) rm.team = clean(body.team, 40) || rm.name; if (body.score != null) rm.score = round1(Number(body.score) || 0); return {}; }
          /* ===== NGH-BUILD 2026-09-12l: Name That Tune ===================== */
          case 'mgStart': {
            // Pick a song the room has a chance at: prefer the catalog, and
            // never one that has already been used tonight.
            const used = (s.mgUsed || []);
            let song = null;
            if (body.songId) {
              const rows = await sql`SELECT id, title, artist, data FROM karaoke_songs WHERE id = ${String(body.songId)}`;
              if (!rows.length) throw { status: 404, error: 'no such song' };
              song = rows[0];
            } else {
              const rows = await sql`SELECT id, title, artist, data FROM karaoke_songs ORDER BY random() LIMIT 40`;
              song = rows.find(r => used.indexOf(r.id) < 0) || rows[0] || null;
              if (!song) throw { status: 409, error: 'the song catalog is empty — add songs first' };
            }
            const d = song.data || {};
            s.mg = {
              id: rid('mg'), kind: 'nametune', round: ((s.mg && s.mg.round) || 0) + 1,
              phase: 'idle', songId: song.id, title: song.title, artist: song.artist,
              armAt: 0, goAt: 0, clipMs: Math.min(30000, Math.max(2000, Math.round(Number(body.clipMs) || 7000))),
              points: MG_POINTS, buzzes: [], answering: null, answerBy: 0, result: null, missed: [],
              // Only the rack player can use a LAN audio path; browsers never see it.
              media: d.media && d.media.audio ? { audio: d.media.audio } : null
            };
            return { mgId: s.mg.id, title: song.title, artist: song.artist, hasAudio: !!s.mg.media };
          }
          case 'mgArm': {
            if (!s.mg) throw { status: 409, error: 'start a round first' };
            if (s.mg.phase === 'armed' || s.mg.phase === 'answering') throw { status: 409, error: 'this round is already live' };
            s.mg.armAt = now();
            // `Number(undefined) != null` is TRUE (NaN != null), so the obvious
            // one-liner here silently produced goAt = NaN whenever the caller
            // omitted leadMs — which the host UI always does. JSON turns that
            // into null, `mg.goAt || 0` then reads as 0, and every reaction
            // time comes back as a Unix timestamp. Check for the value being
            // absent, not for the coerced number.
            const lead = body.leadMs == null ? MG_LEAD_MS : Math.min(10000, Math.max(0, Math.round(Number(body.leadMs) || 0)));
            s.mg.goAt = s.mg.armAt + lead;
            s.mg.phase = 'armed';
            s.mg.buzzes = []; s.mg.answering = null; s.mg.answerBy = 0; s.mg.result = null; s.mg.missed = []; s.mg.settleUntil = 0;
            return { goAt: s.mg.goAt };
          }
          // Correct: points to the answerer's room, and the answer is revealed.
          // Wrong: they are struck off and the floor opens to the next buzzer
          // for a steal, which is the bit that makes the game fun.
          case 'mgJudge': {
            const mg = s.mg;
            if (!mg || !mg.answering) throw { status: 409, error: 'nobody is answering' };
            const who = mg.answering;
            if (body.ok) {
              const steal = (mg.missed || []).length > 0;
              const pts = steal ? MG_STEAL_POINTS : mg.points;
              const room = mgAward(s, who, pts);
              mg.result = 'correct'; mg.phase = 'reveal'; mg.wonBy = who; mg.wonPoints = pts; mg.wonRoom = room;
              s.mgUsed = (s.mgUsed || []).concat([mg.songId]).slice(-200);
              return { correct: true, points: pts, room };
            }
            mg.missed = (mg.missed || []).concat([who]);
            const next = mgNextUp(mg);
            if (next) { mg.answering = next.memberId; mg.answerBy = now() + MG_ANSWER_MS; mg.phase = 'answering'; return { steal: next.name }; }
            mg.answering = null; mg.answerBy = 0; mg.phase = 'armed';
            return { reopened: true };
          }
          // The answer clock ran out. Same shape as a wrong answer so the game
          // never stalls waiting for a Guru who is dealing with something else.
          case 'mgTimeout': {
            const mg = s.mg;
            if (!mg || !mg.answering) return { noChange: true };
            if (mg.answerBy && now() < mg.answerBy && !body.force) return { noChange: true };
            mg.missed = (mg.missed || []).concat([mg.answering]);
            const next = mgNextUp(mg);
            if (next) { mg.answering = next.memberId; mg.answerBy = now() + MG_ANSWER_MS; mg.phase = 'answering'; return { steal: next.name }; }
            mg.answering = null; mg.answerBy = 0; mg.phase = 'armed';
            return { reopened: true };
          }
          case 'mgReveal': {
            if (!s.mg) throw { status: 409, error: 'no round' };
            s.mg.phase = 'reveal';
            if (!s.mg.result) s.mg.result = 'nobody';
            s.mgUsed = (s.mgUsed || []).concat([s.mg.songId]).slice(-200);
            return {};
          }
          case 'mgEnd': { s.mg = null; return {}; }
          /* ===================================================== end NGH-BUILD 2026-09-12l */
          case 'setSettings': Object.assign(s.settings, sanitizeSettings(body.settings || {})); return {};
          case 'setMode': s.mode = body.mode === 'openmic' ? 'openmic' : 'battle'; return {};
          case 'resetScores': Object.values(s.rooms).forEach(r => { r.score = 0; r.songs = 0; }); s.results = []; s.history = []; s.lastResult = null; return {};
          case 'kick': { const i = s.members.findIndex(m => m.id === body.memberId); if (i < 0) throw { status: 404, error: 'no such member' }; s.members.splice(i, 1); return {}; }
          case 'endSession': s.mg = null; /* NGH-BUILD 2026-09-12l */ if (s.nowPlaying) endCurrent(s, 'skip'); if (s.scoring) await tallyVotes(code, s, true); s.status = 'ended'; s.endedAt = now(); return {};
          case 'reopen': s.status = 'live'; delete s.endedAt; return {};
          default: throw { status: 400, error: 'unknown action ' + action };
        }
      });
      if (r.error) return bad(r.error, r.status);
      return json({ ok: true, result: r.result, state: publicState(r.state, now()) });
    }

    return bad('not found', 404);
  } catch (e) {
    console.error('[karaoke]', e);
    return bad('server error: ' + (e && e.message || e), 500);
  }
};

function sanitizeSettings(x) {
  const o = {};
  if (x.maxSingers != null) o.maxSingers = Math.min(6, Math.max(1, Math.round(Number(x.maxSingers) || 2)));
  if (x.onDeck != null) o.onDeck = Math.min(10, Math.max(1, Math.round(Number(x.onDeck) || 5)));
  if (x.voteSeconds != null) o.voteSeconds = Math.min(300, Math.max(10, Math.round(Number(x.voteSeconds) || 45)));
  if (x.voteWeighting != null) o.voteWeighting = x.voteWeighting === 'room' ? 'room' : 'participant';
  if (x.rotateRooms != null) o.rotateRooms = !!x.rotateRooms;
  if (x.leadInMs != null) o.leadInMs = Math.min(15000, Math.max(500, Math.round(Number(x.leadInMs) || 3000)));
  if (x.wifi !== undefined) o.wifi = x.wifi && x.wifi.ssid ? { ssid: clean(x.wifi.ssid, 32), pass: String(x.wifi.pass || '').slice(0, 63), auth: x.wifi.auth === 'WEP' ? 'WEP' : 'WPA' } : null;
  if (x.tvAudio != null) o.tvAudio = !!x.tvAudio;
  if (x.vocalsToPA != null) o.vocalsToPA = !!x.vocalsToPA;
  return o;
}
