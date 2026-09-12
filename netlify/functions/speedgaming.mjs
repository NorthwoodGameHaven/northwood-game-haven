// netlify/functions/speedgaming.mjs
// NGH-BUILD 2026-09-12l — Speed Gaming Meet-up engine
// ---------------------------------------------------------------------
// The event (EVT-PITPB5-103, first run 2026-09-17): players arrive alone or in
// pairs, get matched into 2v2 teams, and swap PARTNERS every round. 3 rounds of
// 10 min teach + 40 min play + 10 min break. Prizes each round.
//
// Same synchronization model as trivia.mjs / karaoke.mjs / tv.mjs: no
// WebSockets on Netlify Functions, so every client polls GET state with the
// last version it saw and the server answers {unchanged:true, serverNow} until
// a mutation bumps `version`. The round clock is scheduled in SERVER epoch ms
// so the TV, the Guru's tablet and every phone in the room count down together.
//
// TWO DELIBERATE DESIGN CHOICES, both about not embarrassing anyone in a full room:
//
// 1. PAIRING IS A DRAFT UNTIL IT IS PUBLISHED. `pairRound` computes a seating
//    and parks it in `draft`; the Guru eyeballs it, reshuffles if they don't
//    like it, and only `publishRound` makes it real. Once published the seating
//    is FROZEN in the document — never recomputed — so a phone refresh or a
//    cold start can never re-shuffle a room that has already sat down.
//
// 2. HISTORY IS DERIVED, NEVER STORED. Who has partnered whom is recomputed
//    from the published rounds on every read (`historyFrom`). Keeping a running
//    tally would drift the moment a Guru edits or unpublishes a round, and a
//    drifted history silently re-pairs people who already played together —
//    the exact failure the pairing engine exists to prevent. Recomputing is
//    three rounds of array pushes; correctness is worth vastly more.
//
// Routes (via /api/speedgaming/* alias in netlify.toml):
//   GET  /speedgaming/time                              PUBLIC {serverNow}
//   GET  /speedgaming/active                            PUBLIC most recent lobby/live session
//   GET  /speedgaming/sessions                          admin  recent sessions
//   POST /speedgaming/sessions                          admin  {eventId,date,rounds,phases,games} -> {code}
//   GET  /speedgaming/sessions/:code/state?v=N&token=   PUBLIC poll (token adds a `you` block)
//   POST /speedgaming/sessions/:code/join               PUBLIC {name, deviceId, arrivedWith} -> {playerId, token}
//   POST /speedgaming/sessions/:code/leave              PUBLIC {token}
//   GET  /speedgaming/sessions/:code/join-qr.png        PUBLIC QR to the join page
//   POST /speedgaming/sessions/:code/control            admin  {action, ...} — see ACTIONS
// ---------------------------------------------------------------------

import QRCode from 'qrcode';
import { sql, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import crypto from 'node:crypto';
import {
  DEFAULT_PHASES, DEFAULT_ROUNDS, PLAYERS_PER_TABLE,
  emptyHistory, buildRound, applyRound, phasePlan, phaseAt, roundLengthMs
} from './_shared/speedgaming-core.mjs';

const SITE = process.env.PUBLIC_SITE_URL || 'https://gamehaven.guru';
const MAX_PLAYERS = 80;
const DEFAULT_GAMES = [];

let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
async function mk(stmt) { try { await stmt; } catch (e) { if (!isAlreadyExists(e)) throw e; } }
async function ensureSchema() {
  if (_ready) return;
  await mk(sql`CREATE TABLE IF NOT EXISTS speedgaming_sessions (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'lobby', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
  _ready = true;
}

// ---- helpers ----
const now = () => Date.now();
const rid = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const mkToken = () => crypto.randomBytes(12).toString('hex');
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += A[crypto.randomInt(A.length)]; return s; }
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 80);
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
async function readBody(req) { try { return await req.json(); } catch { return {}; } }

// ---- session load / mutate (optimistic concurrency) ----
async function loadSession(code) {
  const rows = await sql`SELECT data, version, status FROM speedgaming_sessions WHERE id = ${code}`;
  if (!rows.length) return null;
  const s = rows[0].data; s.version = rows[0].version; return s;
}
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
    const r = await sql`UPDATE speedgaming_sessions SET data = ${JSON.stringify(s)}::jsonb, version = ${expected + 1},
                          status = ${s.status}, updated_at = now()
                        WHERE id = ${code} AND version = ${expected} RETURNING version`;
    if (r.length) return { ok: true, state: s, result };
  }
  return { error: 'busy, try again', status: 409 };
}

// ---- players ----
const activePlayers = (s) => (s.players || []).filter(p => p.active !== false);
const playerById = (s, id) => (s.players || []).find(p => p.id === id) || null;
const playerByToken = (s, t) => t ? (s.players || []).find(p => p.token === t) || null : null;
// The engine only needs these three fields, and passing trimmed objects keeps
// tokens out of anything the pairing code could accidentally echo back.
const forPairing = (s) => activePlayers(s).map(p => ({ id: p.id, name: p.name, arrivedWith: p.arrivedWith || null }));

// A published round stores IDs. Rehydrate for display; a player who has since
// been removed shows as "(left)" rather than blowing up the TV.
function nameOf(s, id) { const p = playerById(s, id); return p ? p.name : '(left)'; }
function hydrate(s, round) {
  if (!round) return null;
  const ppl = ids => (ids || []).map(id => ({ id, name: nameOf(s, id) }));
  return {
    n: round.n, seed: round.seed, publishedAt: round.publishedAt || null,
    startAt: round.startAt || null, phases: round.phases || null,
    endedEarly: !!round.endedEarly,
    warnings: round.warnings || [],
    byes: ppl(round.byes),
    tables: (round.tables || []).map(t => ({
      table: t.table, game: t.game || null, result: t.result || null,
      teamA: ppl(t.teamA), teamB: ppl(t.teamB)
    }))
  };
}

// ---- history: DERIVED from published rounds, never stored (see header) ------
function historyFrom(s) {
  let h = emptyHistory();
  for (const r of (s.rounds || [])) {
    h = applyRound(h, {
      tables: (r.tables || []).map(t => ({
        teamA: t.teamA.map(id => ({ id })), teamB: t.teamB.map(id => ({ id }))
      })),
      byes: (r.byes || []).map(id => ({ id }))
    });
  }
  return h;
}

// ---- standings --------------------------------------------------------------
// Prizes each round, so the night leaderboard is wins first. `played` and
// `byes` are shown alongside so nobody thinks the person who sat out twice is
// simply bad at board games.
function standings(s) {
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { id, name: nameOf(s, id), wins: 0, draws: 0, played: 0, byes: 0, points: 0 });
    return rows.get(id);
  };
  for (const p of (s.players || [])) row(p.id);
  for (const r of (s.rounds || [])) {
    for (const t of (r.tables || [])) {
      const all = t.teamA.concat(t.teamB);
      for (const id of all) row(id).played++;
      if (!t.result) continue;
      if (t.result === 'draw') for (const id of all) { row(id).draws++; row(id).points += 1; }
      else {
        const winners = t.result === 'A' ? t.teamA : t.teamB;
        for (const id of winners) { row(id).wins++; row(id).points += 2; }
      }
    }
    for (const id of (r.byes || [])) row(id).byes++;
  }
  return Array.from(rows.values()).sort((a, b) =>
    b.points - a.points || b.wins - a.wins || a.byes - b.byes || a.name.localeCompare(b.name));
}

// ---- state shaping ----------------------------------------------------------
function publicState(s, token) {
  const t = now();
  const cur = (s.rounds || []).find(r => r.n === s.current) || null;
  const out = {
    code: s.code, status: s.status, version: s.version,
    eventId: s.eventId || null, date: s.date || null, title: s.title || 'Speed Gaming Meet-up',
    settings: {
      rounds: s.settings.rounds, phases: s.settings.phases,
      games: s.settings.games || [], allowSelfJoin: s.settings.allowSelfJoin !== false,
      roundLengthMs: roundLengthMs(s.settings.phases)
    },
    players: (s.players || []).map(p => ({ id: p.id, name: p.name, active: p.active !== false, arrivedWith: p.arrivedWith || null })),
    playing: activePlayers(s).length,
    current: s.current || 0,
    round: hydrate(s, cur),
    rounds: (s.rounds || []).map(r => hydrate(s, r)),
    draft: s.draft ? hydrate(s, s.draft) : null,
    standings: standings(s),
    clock: cur && cur.startAt ? phaseAt(cur.phases, t) : null,
    serverNow: t
  };
  const me = playerByToken(s, token);
  if (me) out.you = youBlock(s, me, cur);
  return out;
}

// What one player's phone needs, resolved server-side so the app screen is a
// dumb renderer: where to sit, who with, who against, and what happens next.
function youBlock(s, me, cur) {
  const y = { id: me.id, name: me.name, active: me.active !== false, table: null, partner: null, opponents: [], bye: false, nextUp: null };
  if (!cur) { y.nextUp = 'waiting for the first round'; return y; }
  if ((cur.byes || []).includes(me.id)) {
    y.bye = true;
    y.nextUp = 'sitting out this round — you are first back in next round';
    return y;
  }
  for (const t of (cur.tables || [])) {
    const mine = t.teamA.includes(me.id) ? t.teamA : (t.teamB.includes(me.id) ? t.teamB : null);
    if (!mine) continue;
    const theirs = mine === t.teamA ? t.teamB : t.teamA;
    y.table = t.table;
    y.game = t.game || null;
    y.partner = { id: mine.find(x => x !== me.id), name: nameOf(s, mine.find(x => x !== me.id)) };
    y.opponents = theirs.map(id => ({ id, name: nameOf(s, id) }));
    y.result = t.result || null;
    return y;
  }
  y.nextUp = 'you joined mid-round — you are in for the next one';
  return y;
}

// ---- round building ---------------------------------------------------------
function buildDraft(s, seedSuffix) {
  const n = (s.current || 0) + 1;
  const seed = (s.settings.seedBase || s.code) + ':' + n + (seedSuffix ? ':' + seedSuffix : '');
  const r = buildRound(forPairing(s), historyFrom(s), {
    round: n, seed, games: s.settings.games || [], firstTable: 1
  });
  return {
    n, seed, publishedAt: null, startAt: null, phases: null,
    warnings: r.warnings,
    byes: r.byes.map(p => p.id),
    tables: r.tables.map(t => ({
      table: t.table, game: t.game || null, result: null,
      teamA: t.teamA.map(p => p.id), teamB: t.teamB.map(p => p.id)
    }))
  };
}

function sanitizePhases(x) {
  if (!Array.isArray(x) || !x.length) return DEFAULT_PHASES.slice();
  return x.slice(0, 6).map((p, i) => ({
    id: clean(p.id, 16) || ('phase' + (i + 1)),
    label: clean(p.label, 40) || ('Phase ' + (i + 1)),
    minutes: Math.min(240, Math.max(0, Math.round(Number(p.minutes) || 0)))
  }));
}

// ---- handler ----------------------------------------------------------------
export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^.*\/speedgaming\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const head = parts[0] || '';

    if (head === 'time' && req.method === 'GET') return json({ serverNow: now() });

    if (head === 'active' && req.method === 'GET') {
      const rows = await sql`SELECT id, data, version, status FROM speedgaming_sessions
                             WHERE status IN ('lobby','live') ORDER BY updated_at DESC LIMIT 1`;
      if (!rows.length) return json({ active: null, serverNow: now() });
      const s = rows[0].data;
      return json({ active: { code: rows[0].id, status: rows[0].status, title: s.title || 'Speed Gaming Meet-up', date: s.date || null, playing: activePlayers(s).length }, serverNow: now() });
    }

    if (head !== 'sessions') return bad('not found', 404);

    // ---- session collection ----
    if (!parts[1] && req.method === 'GET') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const rows = await sql`SELECT id, data, status, created_at, updated_at FROM speedgaming_sessions
                             ORDER BY created_at DESC LIMIT 25`;
      return json(rows.map(r => ({
        code: r.id, status: r.status, date: r.data.date || null, title: r.data.title || null,
        players: (r.data.players || []).length, rounds: (r.data.rounds || []).length,
        createdAt: r.created_at, updatedAt: r.updated_at
      })));
    }

    if (!parts[1] && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const b = await readBody(req);
      const phases = sanitizePhases(b.phases);
      const s = {
        code: '', eventId: clean(b.eventId, 40) || null, date: clean(b.date, 10) || null,
        title: clean(b.title, 60) || 'Speed Gaming Meet-up',
        status: 'lobby', createdAt: now(),
        settings: {
          rounds: Math.min(8, Math.max(1, Math.round(Number(b.rounds) || DEFAULT_ROUNDS))),
          phases,
          games: Array.isArray(b.games) ? b.games.map(g => clean(g, 40)).filter(Boolean).slice(0, 20) : DEFAULT_GAMES,
          allowSelfJoin: b.allowSelfJoin !== false,
          seedBase: crypto.randomBytes(4).toString('hex')
        },
        players: [], rounds: [], draft: null, current: 0
      };
      // Collide-and-retry rather than trusting 4 random letters to be unique.
      for (let i = 0; i < 8; i++) {
        const code = newCode();
        s.code = code;
        try {
          await sql`INSERT INTO speedgaming_sessions (id, data, version, status)
                    VALUES (${code}, ${JSON.stringify(s)}::jsonb, 1, 'lobby')`;
          return json({ code, joinUrl: SITE + '/speedgaming?c=' + code, state: publicState(Object.assign({ version: 1 }, s)) }, 201);
        } catch (e) { if (!isAlreadyExists(e)) throw e; }
      }
      return bad('could not allocate a session code', 500);
    }

    const code = cleanCode(parts[1]);
    const sub = parts[2] || '';

    // ---- poll ----
    if (sub === 'state' && req.method === 'GET') {
      const s = await loadSession(code);
      if (!s) return bad('no such session', 404);
      const v = Number(url.searchParams.get('v') || 0);
      const tok = url.searchParams.get('token') || '';
      // A token holder still needs the small answer, but `you` can change
      // without the version moving (it cannot — every seating change is a
      // mutation), so the cheap path is safe for everyone.
      if (v && v === s.version) return json({ unchanged: true, serverNow: now(), version: s.version });
      return json(publicState(s, tok));
    }

    if (sub === 'join-qr.png' && req.method === 'GET') {
      const png = await QRCode.toBuffer(SITE + '/speedgaming?c=' + code, { width: 480, margin: 1 });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } });
    }

    // ---- join / leave ----
    if (sub === 'join' && req.method === 'POST') {
      const b = await readBody(req);
      const name = clean(b.name, 30);
      if (!name) return bad('name required');
      const r = await mutate(code, (s) => {
        if (s.status === 'ended') throw { status: 409, error: 'this meet-up has finished' };
        if (s.settings.allowSelfJoin === false && !requireAdmin(req)) throw { status: 403, error: 'the Guru is checking people in tonight — see the desk' };
        // Re-joining from the same device returns the same identity rather than
        // creating a duplicate person, which is what happens when a phone
        // reloads or a browser tab is restored.
        const dev = clean(b.deviceId, 64);
        const existing = dev ? (s.players || []).find(p => p.deviceId === dev) : null;
        if (existing) { existing.name = name; existing.active = true; return { playerId: existing.id, token: existing.token, rejoined: true }; }
        if ((s.players || []).length >= MAX_PLAYERS) throw { status: 409, error: 'this meet-up is full' };
        const p = {
          id: rid('sg'), name, token: mkToken(), deviceId: dev || null,
          arrivedWith: clean(b.arrivedWith, 40) || null, active: true, joinedAt: now()
        };
        s.players.push(p);
        return { playerId: p.id, token: p.token };
      });
      if (r.error) return bad(r.error, r.status);
      return json({ ok: true, ...r.result, state: publicState(r.state, r.result.token) });
    }

    if (sub === 'leave' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await mutate(code, (s) => {
        const p = playerByToken(s, b.token);
        if (!p) throw { status: 404, error: 'not checked in' };
        p.active = false;
        return {};
      });
      if (r.error) return bad(r.error, r.status);
      return json({ ok: true });
    }

    // ---- Guru controls ----
    if (sub === 'control' && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const body = await readBody(req);
      const action = String(body.action || '');
      const r = await mutate(code, async (s) => {
        switch (action) {

          // -- roster --
          case 'addPlayer': {
            const name = clean(body.name, 30);
            if (!name) throw { status: 400, error: 'name required' };
            if ((s.players || []).length >= MAX_PLAYERS) throw { status: 409, error: 'too many players' };
            const p = { id: rid('sg'), name, token: mkToken(), deviceId: null, arrivedWith: clean(body.arrivedWith, 40) || null, active: true, joinedAt: now() };
            s.players.push(p);
            return { playerId: p.id };
          }
          case 'renamePlayer': {
            const p = playerById(s, body.playerId);
            if (!p) throw { status: 404, error: 'no such player' };
            const name = clean(body.name, 30);
            if (!name) throw { status: 400, error: 'name required' };
            p.name = name; return {};
          }
          // Someone leaving mid-night is set inactive, not deleted: they stay in
          // the published rounds they actually played, and in the standings.
          case 'setActive': {
            const p = playerById(s, body.playerId);
            if (!p) throw { status: 404, error: 'no such player' };
            p.active = !!body.active; return {};
          }
          case 'pairWith': {
            const p = playerById(s, body.playerId);
            if (!p) throw { status: 404, error: 'no such player' };
            p.arrivedWith = clean(body.arrivedWith, 40) || null; return {};
          }

          // -- pairing --
          // Reshuffle just changes the seed; the engine is deterministic, so
          // "give me a different draw" has to perturb the input to mean anything.
          case 'pairRound':
          case 'reshuffle': {
            if ((s.current || 0) >= s.settings.rounds && action === 'pairRound') {
              throw { status: 409, error: 'all ' + s.settings.rounds + ' rounds have been played — add a round first' };
            }
            if (activePlayers(s).length < PLAYERS_PER_TABLE) {
              throw { status: 409, error: 'need at least ' + PLAYERS_PER_TABLE + ' checked-in players for a 2v2 table' };
            }
            s.draft = buildDraft(s, action === 'reshuffle' ? crypto.randomBytes(3).toString('hex') : '');
            return { draft: true };
          }
          case 'discardDraft': { s.draft = null; return {}; }

          // Swapping two players in the DRAFT lets a Guru fix the one thing the
          // engine could not know ("those two are married", "he needs to leave
          // at 8"). Published rounds are never edited this way — reprinting a
          // seating people are already sitting in causes more confusion than it
          // solves; unpublish first if it really has to change.
          case 'swapDraft': {
            if (!s.draft) throw { status: 409, error: 'no draft to edit — pair the round first' };
            const a = String(body.a || ''), b = String(body.b || '');
            const find = (id) => {
              for (const t of s.draft.tables) {
                for (const side of ['teamA', 'teamB']) {
                  const i = t[side].indexOf(id);
                  if (i >= 0) return { where: 'table', t, side, i };
                }
              }
              const bi = s.draft.byes.indexOf(id);
              if (bi >= 0) return { where: 'bye', i: bi };
              return null;
            };
            const A = find(a), B = find(b);
            if (!A || !B) throw { status: 404, error: 'both players must be in this round' };
            if (A.where === 'table' && B.where === 'table') { A.t[A.side][A.i] = b; B.t[B.side][B.i] = a; }
            else if (A.where === 'table') { A.t[A.side][A.i] = b; s.draft.byes[B.i] = a; }
            else if (B.where === 'table') { B.t[B.side][B.i] = a; s.draft.byes[A.i] = b; }
            else { s.draft.byes[A.i] = b; s.draft.byes[B.i] = a; }
            s.draft.warnings = (s.draft.warnings || []).concat(['seating hand-adjusted by the Guru']);
            return {};
          }

          case 'publishRound': {
            if (!s.draft) throw { status: 409, error: 'nothing to publish — pair the round first' };
            if ((s.rounds || []).some(r => r.n === s.draft.n)) throw { status: 409, error: 'round ' + s.draft.n + ' is already published' };
            s.draft.publishedAt = now();
            s.rounds.push(s.draft);
            s.current = s.draft.n;
            s.draft = null;
            s.status = 'live';
            return { round: s.current };
          }
          // Undo. Only the LAST round, only before the clock starts — once
          // people are playing, the seating is what is on the tables.
          case 'unpublishRound': {
            const last = (s.rounds || [])[s.rounds.length - 1];
            if (!last) throw { status: 409, error: 'nothing published yet' };
            if (last.startAt && !body.force) throw { status: 409, error: 'round ' + last.n + ' has already started — pass force to pull it back anyway' };
            s.rounds.pop();
            s.draft = Object.assign({}, last, { publishedAt: null, startAt: null, phases: null });
            s.current = s.rounds.length ? s.rounds[s.rounds.length - 1].n : 0;
            return { pulled: last.n };
          }

          // -- clock --
          case 'startRound': {
            const cur = (s.rounds || []).find(r => r.n === s.current);
            if (!cur) throw { status: 409, error: 'publish a round first' };
            const lead = Math.min(300000, Math.max(0, Math.round(Number(body.leadInMs) || 0)));
            cur.startAt = now() + lead;
            cur.phases = phasePlan(s.settings.phases, cur.startAt);
            delete cur.endedEarly;
            s.status = 'live';
            return { startAt: cur.startAt };
          }
          // Shift every remaining boundary by the same delta, so "give them 5
          // more minutes" doesn't require re-deriving the whole plan and the
          // phases stay contiguous.
          case 'adjustClock': {
            const cur = (s.rounds || []).find(r => r.n === s.current);
            if (!cur || !cur.phases) throw { status: 409, error: 'the round clock is not running' };
            const delta = Math.round(Number(body.minutes) || 0) * 60000;
            if (!delta) return { noChange: true };
            const t = now();
            for (const p of cur.phases) {
              if (p.endsAt <= t) continue;              // a finished phase is history
              if (p.startsAt > t) p.startsAt += delta;  // future phase moves whole
              p.endsAt += delta;
            }
            return { adjustedMinutes: delta / 60000 };
          }
          // Tables finishing early is the NORMAL case, not an exception — a
          // 40-minute slot is a ceiling, not a target. So this means "this
          // round is over", which is what the Guru actually intends, and it
          // unblocks pairing the next round. (Before this it only cleared the
          // clock, leaving the console offering "Start the clock" again and no
          // way forward without waiting out a timer nobody was watching.)
          case 'endRoundEarly':
          case 'stopClock': {
            const cur = (s.rounds || []).find(r => r.n === s.current);
            if (!cur) throw { status: 409, error: 'no round' };
            cur.startAt = null; cur.phases = null; cur.endedEarly = true;
            return {};
          }

          // -- results --
          case 'setResult': {
            const cur = (s.rounds || []).find(r => r.n === (body.round != null ? Number(body.round) : s.current));
            if (!cur) throw { status: 404, error: 'no such round' };
            const t = (cur.tables || []).find(x => x.table === Number(body.table));
            if (!t) throw { status: 404, error: 'no such table' };
            const v = String(body.result || '');
            if (!['A', 'B', 'draw', ''].includes(v)) throw { status: 400, error: "result must be 'A', 'B', 'draw' or '' to clear" };
            t.result = v || null;
            return {};
          }
          case 'setGame': {
            const cur = (s.rounds || []).find(r => r.n === (body.round != null ? Number(body.round) : s.current));
            if (!cur) throw { status: 404, error: 'no such round' };
            const t = (cur.tables || []).find(x => x.table === Number(body.table));
            if (!t) throw { status: 404, error: 'no such table' };
            t.game = clean(body.game, 40) || null;
            return {};
          }

          // -- settings / lifecycle --
          case 'setSettings': {
            const x = body.settings || {};
            if (x.rounds != null) s.settings.rounds = Math.min(8, Math.max(s.rounds.length || 1, Math.round(Number(x.rounds) || DEFAULT_ROUNDS)));
            if (x.phases != null) s.settings.phases = sanitizePhases(x.phases);
            if (x.games != null) s.settings.games = (Array.isArray(x.games) ? x.games : []).map(g => clean(g, 40)).filter(Boolean).slice(0, 20);
            if (x.allowSelfJoin != null) s.settings.allowSelfJoin = !!x.allowSelfJoin;
            if (x.title != null) s.title = clean(x.title, 60) || s.title;
            return {};
          }
          case 'endSession': { s.status = 'ended'; s.endedAt = now(); s.draft = null; return {}; }
          case 'reopen': { s.status = s.rounds.length ? 'live' : 'lobby'; delete s.endedAt; return {}; }

          default: throw { status: 400, error: 'unknown action ' + action };
        }
      });
      if (r.error) return bad(r.error, r.status);
      return json({ ok: true, result: r.result, state: publicState(r.state) });
    }

    if (sub === '' && req.method === 'DELETE') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      await sql`DELETE FROM speedgaming_sessions WHERE id = ${code}`;
      return noContent();
    }

    return bad('not found', 404);
  } catch (e) {
    console.error('[speedgaming]', e);
    return bad('server error: ' + (e && e.message || e), 500);
  }
};
