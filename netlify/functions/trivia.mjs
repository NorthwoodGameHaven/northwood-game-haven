// netlify/functions/trivia.mjs
// NGH-BUILD 07f — Event Stream engine: + publish round themes to event pages, registrant notify.
//
// Routes (via /api/trivia/* alias in netlify.toml):
//   GET  /trivia/time                          public  — server clock for client offset sync
//   GET  /trivia/games                         admin   — list games
//   POST /trivia/games                         admin   — create game
//   GET  /trivia/games/:id                     admin   — full game (def + state)
//   PUT  /trivia/games/:id                     admin   — update game definition
//   DELETE /trivia/games/:id                   admin   — delete game (+teams/answers/displays)
//   POST /trivia/games/:id/state               admin   — drive the state machine
//   POST /trivia/games/:id/command             admin   — per-display command (refresh)
//   GET  /trivia/games/:id/displays            admin   — display heartbeat health
//   GET  /trivia/games/:id/teams               admin   — team list + scores
//   GET  /trivia/games/:id/answers?qKey=       admin   — answers for a question
//   GET  /trivia/games/:id/state?v=N           PUBLIC  — poll; {unchanged:true} when v matches
//   POST /trivia/games/:id/join                PUBLIC  — {teamName, pin?} -> {teamId, token}
//   POST /trivia/games/:id/answer              PUBLIC  — {token, qKey, answer, wager?}
//   POST /trivia/games/:id/heartbeat           PUBLIC  — display heartbeat; returns pending cmd
//   GET/POST /trivia/questions, PUT/DELETE /trivia/questions/:id   admin — question bank
//   GET/POST /trivia/themes,    PUT/DELETE /trivia/themes/:id      admin — theme library
//   GET /trivia/suggestions, PUT /trivia/suggestions/:id           admin — suggestion inbox
//   POST /trivia/suggest                       PUBLIC  — customer theme suggestion (rate-limited)
//
// Design notes:
// - No WebSockets on Netlify Functions. Clients poll GET state with their last
//   version number; the server answers {unchanged:true} (tiny) until the host
//   mutates state, which bumps `version`.
// - Synchronized playback: the host schedules phases a few seconds in the
//   future; state carries `startAt`/`deadline` in server epoch ms and every
//   response echoes `serverNow` so clients can maintain a clock offset.
// - Answers are never exposed in public state until phase === 'reveal'.
//   During 'preload' only the media URL is exposed (TVs must fetch it early);
//   the prompt itself stays hidden until 'live'.

import { sql, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import crypto from 'node:crypto';

const newId = (p = 'TRV') => p + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// ---- schema ----
let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
async function mk(stmt) { try { await stmt; } catch (e) { if (!isAlreadyExists(e)) throw e; } }
async function ensureTriviaSchema() {
  if (_ready) return;
  await mk(sql`CREATE TABLE IF NOT EXISTS trivia_games (
    id         TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    state      JSONB NOT NULL DEFAULT '{}'::jsonb,
    version    INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await mk(sql`CREATE TABLE IF NOT EXISTS trivia_teams (
    id         TEXT PRIMARY KEY,
    game_id    TEXT NOT NULL,
    data       JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await mk(sql`CREATE TABLE IF NOT EXISTS trivia_answers (
    id         TEXT PRIMARY KEY,
    game_id    TEXT NOT NULL,
    team_id    TEXT NOT NULL,
    q_key      TEXT NOT NULL,
    data       JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await mk(sql`CREATE UNIQUE INDEX IF NOT EXISTS trivia_answers_uni ON trivia_answers (game_id, team_id, q_key)`);
  await mk(sql`CREATE TABLE IF NOT EXISTS trivia_displays (
    game_id    TEXT NOT NULL,
    display_id TEXT NOT NULL,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (game_id, display_id)
  )`);
  // Content Library (managed fully in build 07d; schema lands now so games
  // built later against the bank need no migration).
  await mk(sql`CREATE TABLE IF NOT EXISTS trivia_questions (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await mk(sql`CREATE TABLE IF NOT EXISTS trivia_themes (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await mk(sql`CREATE TABLE IF NOT EXISTS trivia_suggestions (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, status TEXT DEFAULT 'new', created_at TIMESTAMPTZ DEFAULT now()
  )`);
  _ready = true;
}

// ---- team tokens (stateless HMAC, same secret family as admin auth) ----
function secret() { return process.env.ADMIN_SECRET || process.env.ADMIN_CODE || 'change-me'; }
function teamToken(teamId) {
  const mac = crypto.createHmac('sha256', secret()).update('team:' + teamId).digest('hex');
  return teamId + '.' + mac;
}
function verifyTeamToken(token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const teamId = token.slice(0, i), mac = token.slice(i + 1);
  const good = crypto.createHmac('sha256', secret()).update('team:' + teamId).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good)) ? teamId : null; }
  catch { return null; }
}

// ---- answer normalization (fill-in auto-verdict) ----
function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip diacritics
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- game helpers ----
const PHASES = ['lobby', 'preload', 'live', 'answering', 'locked', 'reveal', 'intermission', 'scoreboard', 'ended', 'timer', 'timer-paused'];

// Damerau-lite Levenshtein for adjudication suggestions.
function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
// Suggested verdict for a pending fill-in: near-miss spelling => 'correct',
// clearly off => 'incorrect'. Host always has the final tap.
function suggestVerdict(answer, q) {
  const n = normalize(answer);
  if (!n) return 'incorrect';
  const pool = [q.answer].concat(Array.isArray(q.alternates) ? q.alternates : []).map(normalize).filter(Boolean);
  let best = Infinity;
  for (const p of pool) best = Math.min(best, levenshtein(n, p));
  const tol = Math.max(1, Math.round(Math.min(...pool.map(p => p.length), 99) / 5));
  return best <= tol ? 'correct' : 'incorrect';
}

function findQuestion(game, roundIdx, qIdx) {
  const r = (game.rounds || [])[roundIdx];
  if (!r) return { round: null, q: null };
  return { round: r, q: (r.questions || [])[qIdx] || null };
}

// Assign stable keys/ids to rounds & questions on save.
function stampGame(g) {
  g.rounds = Array.isArray(g.rounds) ? g.rounds : [];
  for (const r of g.rounds) {
    r.id = r.id || newId('RND');
    r.questions = Array.isArray(r.questions) ? r.questions : [];
    for (const q of r.questions) {
      q.id = q.id || newId('Q');
      q.key = r.id + ':' + q.id;
    }
  }
  return g;
}

function publicState(game, st, version) {
  const serverNow = Date.now();
  const phase = PHASES.includes(st.phase) ? st.phase : 'lobby';
  // ---- Tournament/round timer sessions (kind: 'timer') ----
  if ((game.kind || 'trivia') === 'timer') {
    return {
      v: version, serverNow, kind: 'timer', phase,
      title: game.title || 'Tournament',
      timerLabel: st.timerLabel || '',
      deadline: st.deadline || null,
      remainMs: st.remainMs || null,       // set while paused
      event: {
        id: game.eventId || null,
        title: game.eventTitle || game.title || '',
        date: game.occDate || null,
        start: game.eventStart || null,
        end: game.eventEnd || null,
        photo: game.eventPhoto || (game.eventId ? ('/event/' + encodeURIComponent(game.eventId) + '/photo') : null)
      },
      customImage: game.customImage || null
    };
  }
  const roundIdx = st.roundIdx | 0, qIdx = st.qIdx | 0;
  const { round, q } = findQuestion(game, roundIdx, qIdx);
  const out = {
    v: version, serverNow, phase, roundIdx, qIdx,
    startAt: st.startAt || null,
    deadline: st.deadline || null,
    title: game.title || 'Team Trivia',
    wagerLabel: game.wagerLabel || 'Stash or Splash',
    roundCount: (game.rounds || []).length,
    settings: {
      tvAudio: !!(game.settings && game.settings.tvAudio),
      showJoinQR: !!(game.settings && game.settings.showJoinQR)
    },
    round: round ? { title: round.title || '', isWager: !!round.isWager, qCount: (round.questions || []).length } : null
  };
  if (q) {
    if (phase === 'preload') {
      // TVs need the asset early; players must not see the prompt yet.
      out.q = { key: q.key, media: q.media && q.media.url ? { kind: q.media.kind || 'video', url: q.media.url } : null };
    } else if (['live', 'answering', 'locked', 'reveal'].includes(phase)) {
      out.q = {
        key: q.key, type: q.type || 'mc', prompt: q.prompt || '',
        choices: (q.type === 'mc' || q.type === 'media-mc') ? (q.choices || []) : null,
        points: Number(q.points) || 10,
        media: q.media && q.media.url ? { kind: q.media.kind || 'video', url: q.media.url } : null
      };
      if (phase === 'reveal') out.q.answer = q.answer == null ? '' : String(q.answer);
    }
  }
  if (phase === 'scoreboard' || phase === 'ended') out.scoreboard = st.scoreboard || [];
  if (phase === 'intermission') {
    out.scoreboard = st.scoreboard || [];
    out.next = st.next || null; // {roundIdx, title, isWager}
  }
  return out;
}

async function computeScoreboard(gameId) {
  const teams = await sql`SELECT id, data FROM trivia_teams WHERE game_id = ${gameId}`;
  const sums = await sql`SELECT team_id, SUM(COALESCE((data->>'points')::int, 0)) AS pts
                         FROM trivia_answers WHERE game_id = ${gameId} GROUP BY team_id`;
  const byId = {};
  for (const s of sums) byId[s.team_id] = Number(s.pts) || 0;
  return teams
    .map(t => ({ teamId: t.id, team: t.data.name || 'Team', score: byId[t.id] || 0 }))
    .sort((a, b) => b.score - a.score);
}

// A team's score across every OTHER question — the base for wager clamping.
async function teamScoreExcluding(gameId, teamId, qKey) {
  const rows = await sql`SELECT COALESCE(SUM((data->>'points')::int), 0) AS pts
    FROM trivia_answers
    WHERE game_id = ${gameId} AND team_id = ${teamId} AND q_key <> ${qKey}
      AND data->>'points' IS NOT NULL`;
  return rows.length ? (Number(rows[0].pts) || 0) : 0;
}

// Stash or Splash: correct = +wager, wrong = -wager. Wager is clamped to the
// team's current score, with a floor of WAGER_FLOOR so a trailing team can
// always stake something meaningful. No wager submitted => scored as a
// normal question (base points, no penalty).
const WAGER_FLOOR = 10;
function wagerPoints(correct, wager, teamScore, basePts) {
  if (wager == null) return correct ? basePts : 0;
  const cap = Math.max(teamScore, WAGER_FLOOR);
  const w = Math.min(Math.max(0, Math.round(Number(wager) || 0)), cap);
  return correct ? w : -w;
}

// Auto-score answers of one question at reveal time.
// MC: exact verdict. Fill-in: normalized exact match => correct; everything
// else stays pending for the host adjudication queue.
async function autoScoreQuestion(gameId, q, isWager) {
  if (!q) return;
  const rows = await sql`SELECT id, team_id, data FROM trivia_answers WHERE game_id = ${gameId} AND q_key = ${q.key}`;
  const pts = Number(q.points) || 10;
  for (const r of rows) {
    const d = r.data || {};
    if (d.verdict) continue; // host already ruled
    let verdict = null;
    if (q.type === 'mc' || q.type === 'media-mc') {
      verdict = normalize(d.answer) === normalize(q.answer) ? 'correct' : 'incorrect';
    } else {
      const n = normalize(d.answer);
      const pool = [q.answer].concat(Array.isArray(q.alternates) ? q.alternates : []);
      if (n && pool.some(a => normalize(a) === n)) verdict = 'correct';
      // else: leave pending — subjective spelling goes to the human.
    }
    if (verdict) {
      d.verdict = verdict;
      if (isWager) {
        const score = await teamScoreExcluding(gameId, r.team_id, q.key);
        d.points = wagerPoints(verdict === 'correct', d.wager, score, pts);
        d.wagerApplied = d.wager != null;
      } else {
        d.points = verdict === 'correct' ? pts : 0;
      }
      d.autoScored = true;
      await sql`UPDATE trivia_answers SET data = ${JSON.stringify(d)}::jsonb WHERE id = ${r.id}`;
    }
  }
}

// Mark bank-question usage the first time a question goes LIVE in this game.
// (Game-builder questions may carry bankId when pulled from the library.)
async function markUsage(game, q) {
  if (!q || !q.bankId) return;
  try {
    const rows = await sql`SELECT data FROM trivia_questions WHERE id = ${q.bankId}`;
    if (!rows.length) return;
    const d = rows[0].data || {};
    d.usage = Array.isArray(d.usage) ? d.usage : [];
    if (d.usage.some(u => u.gameId === game.id && u.qKey === q.key)) return;
    d.usage.push({
      gameId: game.id, qKey: q.key,
      eventId: game.eventId || null, occDate: game.occDate || null,
      at: new Date().toISOString()
    });
    await sql`UPDATE trivia_questions SET data = ${JSON.stringify(d)}::jsonb WHERE id = ${q.bankId}`;
  } catch { /* usage bookkeeping must never break the live game */ }
}

async function bumpState(gameId, st) {
  const rows = await sql`UPDATE trivia_games
    SET state = ${JSON.stringify(st)}::jsonb, version = version + 1
    WHERE id = ${gameId} RETURNING version`;
  return rows.length ? rows[0].version : null;
}

// ---- entry ----
export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/trivia/, '').split('/').filter(Boolean);
  const head = parts[0] || '';

  // Clock endpoint: no DB, no schema — must be fast and cheap.
  if (head === 'time' && req.method === 'GET') {
    return json({ now: Date.now() });
  }

  await ensureTriviaSchema();

  // ================= PUBLIC: theme suggestions =================
  if (head === 'suggest' && req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    if (b.website) return json({ ok: true }); // honeypot: pretend success
    const theme = String(b.theme || '').trim().slice(0, 120);
    if (!theme) return bad('theme required');
    const ip = req.headers.get('x-forwarded-for') || req.headers.get('x-nf-client-connection-ip') || '';
    const ipHash = crypto.createHash('sha256').update(ip.split(',')[0].trim()).digest('hex').slice(0, 16);
    const recent = await sql`SELECT COUNT(*)::int AS n FROM trivia_suggestions
      WHERE data->>'ipHash' = ${ipHash} AND created_at > now() - interval '1 hour'`;
    if (recent[0].n >= 5) return bad('Too many suggestions — try again later.', 429);
    const item = {
      id: newId('SUG'), theme,
      name: String(b.name || '').trim().slice(0, 80),
      note: String(b.note || '').trim().slice(0, 500),
      ipHash, createdAt: new Date().toISOString()
    };
    await sql`INSERT INTO trivia_suggestions (id, data, status) VALUES (${item.id}, ${JSON.stringify(item)}::jsonb, 'new')`;
    return json({ ok: true }, 201);
  }

  // ================= games =================
  if (head === 'games') {
    const gameId = parts[1] ? decodeURIComponent(parts[1]) : null;
    const action = parts[2] ? decodeURIComponent(parts[2]) : null;

    // ----- PUBLIC: poll state -----
    if (req.method === 'GET' && gameId && action === 'state') {
      const rows = await sql`SELECT data, state, version FROM trivia_games WHERE id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      const v = Number(url.searchParams.get('v') || 0);
      if (v && v === rows[0].version) return json({ unchanged: true, v, serverNow: Date.now() });
      return json(publicState(rows[0].data, rows[0].state || {}, rows[0].version));
    }

    // ----- PUBLIC: team join -----
    if (req.method === 'POST' && gameId && action === 'join') {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const rows = await sql`SELECT data FROM trivia_games WHERE id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      const game = rows[0].data;
      const pin = game.settings && game.settings.joinPin;
      if (pin && String(b.pin || '') !== String(pin)) return bad('Wrong PIN', 403);
      const name = String(b.teamName || '').trim().slice(0, 40);
      if (!name) return bad('teamName required');
      const dupe = await sql`SELECT id FROM trivia_teams WHERE game_id = ${gameId} AND lower(data->>'name') = ${name.toLowerCase()}`;
      if (dupe.length) return bad('Team name taken', 409);
      const team = { id: newId('TEAM'), name, joinedAt: new Date().toISOString() };
      await sql`INSERT INTO trivia_teams (id, game_id, data) VALUES (${team.id}, ${gameId}, ${JSON.stringify(team)}::jsonb)`;
      return json({ teamId: team.id, teamName: name, token: teamToken(team.id) }, 201);
    }

    // ----- PUBLIC: submit/replace answer -----
    if (req.method === 'POST' && gameId && action === 'answer') {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const teamId = verifyTeamToken(String(b.token || ''));
      if (!teamId) return bad('unauthorized', 401);
      const rows = await sql`SELECT data, state FROM trivia_games WHERE id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      const game = rows[0].data, st = rows[0].state || {};
      const { q } = findQuestion(game, st.roundIdx | 0, st.qIdx | 0);
      if (!q || q.key !== String(b.qKey || '')) return bad('Not the live question', 409);
      if (!['live', 'answering'].includes(st.phase)) return bad('Answers are locked', 409);
      if (st.deadline && Date.now() > Number(st.deadline) + 1500) return bad('Time is up', 409);
      const existing = await sql`SELECT id, data FROM trivia_answers
        WHERE game_id = ${gameId} AND team_id = ${teamId} AND q_key = ${q.key}`;
      if (existing.length && existing[0].data && existing[0].data.verdict) return bad('Already scored', 409);
      const d = {
        answer: String(b.answer == null ? '' : b.answer).slice(0, 300),
        wager: b.wager == null ? null : Math.max(0, Number(b.wager) || 0),
        submittedAt: Date.now(),
        verdict: null, points: null
      };
      if (existing.length) {
        await sql`UPDATE trivia_answers SET data = ${JSON.stringify(d)}::jsonb WHERE id = ${existing[0].id}`;
      } else {
        await sql`INSERT INTO trivia_answers (id, game_id, team_id, q_key, data)
          VALUES (${newId('ANS')}, ${gameId}, ${teamId}, ${q.key}, ${JSON.stringify(d)}::jsonb)`;
      }
      return json({ ok: true, qKey: q.key });
    }

    // ----- PUBLIC: display heartbeat -----
    if (req.method === 'POST' && gameId && action === 'heartbeat') {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const displayId = String(b.displayId || '').trim().slice(0, 40);
      if (!displayId) return bad('displayId required');
      const d = {
        name: String(b.name || displayId).slice(0, 60),
        ready: !!b.ready,
        qKeyReady: String(b.qKeyReady || '').slice(0, 80),
        lastCmdSeq: Number(b.lastCmdSeq) || 0
      };
      await sql`INSERT INTO trivia_displays (game_id, display_id, data, updated_at)
        VALUES (${gameId}, ${displayId}, ${JSON.stringify(d)}::jsonb, now())
        ON CONFLICT (game_id, display_id) DO UPDATE SET data = ${JSON.stringify(d)}::jsonb, updated_at = now()`;
      const rows = await sql`SELECT state FROM trivia_games WHERE id = ${gameId}`;
      const st = rows.length ? (rows[0].state || {}) : {};
      let cmd = null;
      if (st.cmd && Number(st.cmd.seq) > d.lastCmdSeq &&
          (st.cmd.target === 'all' || st.cmd.target === displayId)) {
        cmd = { seq: Number(st.cmd.seq), action: st.cmd.action || 'refresh' };
      }
      return json({ ok: true, cmd });
    }

    // ----- everything else on /games is admin -----
    if (!requireAdmin(req)) return bad('unauthorized', 401);

    if (req.method === 'GET' && !gameId) {
      const rows = await sql`SELECT id, data, state, version, created_at FROM trivia_games ORDER BY created_at DESC`;
      return json(rows.map(r => ({
        id: r.id, title: r.data.title || '', eventId: r.data.eventId || null,
        occDate: r.data.occDate || null, phase: (r.state && r.state.phase) || 'lobby',
        rounds: (r.data.rounds || []).length, v: r.version, createdAt: r.created_at
      })));
    }

    if (req.method === 'POST' && !gameId) {
      let g; try { g = await req.json(); } catch { return bad('Invalid JSON'); }
      if (!g.title) return bad('title required');
      g = stampGame(g);
      g.id = newId('GAME');
      g.createdAt = new Date().toISOString();
      await sql`INSERT INTO trivia_games (id, data, state) VALUES (${g.id}, ${JSON.stringify(g)}::jsonb, ${JSON.stringify({ phase: 'lobby', roundIdx: 0, qIdx: 0 })}::jsonb)`;
      return json(g, 201);
    }

    if (req.method === 'GET' && gameId && !action) {
      const rows = await sql`SELECT data, state, version FROM trivia_games WHERE id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      return json({ game: rows[0].data, state: rows[0].state || {}, v: rows[0].version });
    }

    if (req.method === 'PUT' && gameId && !action) {
      let g; try { g = await req.json(); } catch { return bad('Invalid JSON'); }
      const rows = await sql`SELECT data FROM trivia_games WHERE id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      if (!g.title) return bad('title required');
      g = stampGame(g);
      g.id = gameId;
      g.createdAt = rows[0].data.createdAt || null;
      g.updatedAt = new Date().toISOString();
      const upd = await sql`UPDATE trivia_games SET data = ${JSON.stringify(g)}::jsonb, version = version + 1
        WHERE id = ${gameId} RETURNING version`;
      return json({ game: g, v: upd[0].version });
    }

    if (req.method === 'DELETE' && gameId && !action) {
      await sql`DELETE FROM trivia_answers WHERE game_id = ${gameId}`;
      await sql`DELETE FROM trivia_teams WHERE game_id = ${gameId}`;
      await sql`DELETE FROM trivia_displays WHERE game_id = ${gameId}`;
      await sql`DELETE FROM trivia_games WHERE id = ${gameId}`;
      return noContent();
    }

    // ----- ADMIN: state machine -----
    if (req.method === 'POST' && gameId && action === 'state') {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const rows = await sql`SELECT data, state FROM trivia_games WHERE id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      const game = rows[0].data;
      const st = rows[0].state || {};
      const phase = String(b.phase || st.phase || 'lobby');
      if (!PHASES.includes(phase)) return bad('bad phase');
      if (b.roundIdx != null) st.roundIdx = Math.max(0, b.roundIdx | 0);
      if (b.qIdx != null) st.qIdx = Math.max(0, b.qIdx | 0);
      st.phase = phase;
      const now = Date.now();
      const { round, q } = findQuestion(game, st.roundIdx | 0, st.qIdx | 0);

      if (phase === 'preload') { st.startAt = null; st.deadline = null; }
      if (phase === 'live') {
        const lead = Math.min(30000, Math.max(1500, Number(b.leadMs) || 4000));
        st.startAt = now + lead;
        const secs = Number(b.answerSecs);
        st.deadline = (secs > 0) ? st.startAt + secs * 1000 : null;
        await markUsage(game, q);
      }
      if (phase === 'answering') {
        const secs = Math.min(600, Math.max(5, Number(b.answerSecs) || 45));
        st.deadline = now + secs * 1000;
      }
      if (phase === 'locked') { st.deadline = st.deadline && st.deadline < now ? st.deadline : now; }
      if (phase === 'reveal') { await autoScoreQuestion(gameId, q, !!(round && round.isWager)); }
      if (phase === 'scoreboard' || phase === 'ended') { st.scoreboard = await computeScoreboard(gameId); }
      if (phase === 'intermission') {
        const secs = Math.min(3600, Math.max(30, Number(b.breakSecs) || 300));
        st.deadline = now + secs * 1000;
        st.startAt = null;
        st.scoreboard = await computeScoreboard(gameId);
        const ni = (b.nextRoundIdx != null) ? Math.max(0, b.nextRoundIdx | 0) : (st.roundIdx | 0);
        const nr = (game.rounds || [])[ni];
        st.next = nr ? { roundIdx: ni, title: nr.title || '', isWager: !!nr.isWager } : null;
      }
      // ---- timer sessions ----
      if (phase === 'timer') {
        if (b.label != null) st.timerLabel = String(b.label).slice(0, 120);
        if (b.addSecs) {
          // extend a running (or just-expired) timer
          const base = Math.max(Number(st.deadline) || now, now);
          st.deadline = base + Math.min(3600, Math.max(1, Number(b.addSecs) | 0)) * 1000;
        } else if (b.resume && st.remainMs != null) {
          st.deadline = now + Number(st.remainMs);
        } else {
          const secs = Math.min(86400, Math.max(5, Number(b.secs) || 3000));
          st.deadline = now + secs * 1000;
        }
        st.remainMs = null;
        st.startAt = null;
      }
      if (phase === 'timer-paused') {
        st.remainMs = Math.max(0, (Number(st.deadline) || now) - now);
        st.deadline = null;
      }

      const v = await bumpState(gameId, st);
      return json({ ok: true, v, state: st, serverNow: Date.now() });
    }

    // ----- ADMIN: per-display command -----
    if (req.method === 'POST' && gameId && action === 'command') {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const rows = await sql`SELECT state FROM trivia_games WHERE id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      const st = rows[0].state || {};
      const prev = (st.cmd && Number(st.cmd.seq)) || 0;
      st.cmd = {
        seq: prev + 1,
        target: String(b.target || 'all').slice(0, 40),
        action: String(b.action || 'refresh').slice(0, 20)
      };
      // Commands ride heartbeats; don't bump version (no state re-render needed).
      await sql`UPDATE trivia_games SET state = ${JSON.stringify(st)}::jsonb WHERE id = ${gameId}`;
      return json({ ok: true, cmd: st.cmd });
    }

    if (req.method === 'GET' && gameId && action === 'displays') {
      const rows = await sql`SELECT display_id, data, updated_at FROM trivia_displays WHERE game_id = ${gameId} ORDER BY display_id`;
      const now = Date.now();
      return json(rows.map(r => ({
        displayId: r.display_id,
        name: (r.data && r.data.name) || r.display_id,
        ready: !!(r.data && r.data.ready),
        qKeyReady: (r.data && r.data.qKeyReady) || '',
        online: (now - new Date(r.updated_at).getTime()) < 15000,
        lastSeen: r.updated_at
      })));
    }

    if (req.method === 'GET' && gameId && action === 'teams') {
      const teams = await sql`SELECT id, data, created_at FROM trivia_teams WHERE game_id = ${gameId} ORDER BY created_at ASC`;
      const board = await computeScoreboard(gameId);
      const scores = {}; for (const s of board) scores[s.teamId] = s.score;
      return json(teams.map(t => ({ id: t.id, name: t.data.name, joinedAt: t.created_at, score: scores[t.id] || 0 })));
    }

    if (req.method === 'GET' && gameId && action === 'answers') {
      const qKey = url.searchParams.get('qKey') || '';
      if (!qKey) return bad('qKey required');
      const g = await sql`SELECT data FROM trivia_games WHERE id = ${gameId}`;
      let qDef = null;
      if (g.length) {
        for (const r of (g[0].data.rounds || [])) {
          for (const q of (r.questions || [])) if (q.key === qKey) qDef = q;
        }
      }
      const rows = await sql`
        SELECT a.id, a.team_id, a.data, t.data AS team
        FROM trivia_answers a LEFT JOIN trivia_teams t ON t.id = a.team_id
        WHERE a.game_id = ${gameId} AND a.q_key = ${qKey}
        ORDER BY (a.data->>'submittedAt')::bigint ASC NULLS LAST`;
      return json(rows.map(r => ({
        id: r.id, teamId: r.team_id, team: (r.team && r.team.name) || '?',
        answer: r.data.answer, wager: r.data.wager,
        verdict: r.data.verdict || null, points: r.data.points,
        autoScored: !!r.data.autoScored, submittedAt: r.data.submittedAt,
        suggest: (!r.data.verdict && qDef) ? suggestVerdict(r.data.answer, qDef) : null
      })));
    }

    // ----- ADMIN: adjudicate one answer (host taps ✓/✗ in the queue) -----
    if (req.method === 'POST' && gameId && action === 'adjudicate') {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const verdict = b.verdict === 'correct' ? 'correct' : b.verdict === 'incorrect' ? 'incorrect' : null;
      if (!b.answerId || !verdict) return bad('answerId and verdict required');
      const rows = await sql`SELECT id, team_id, q_key, data FROM trivia_answers WHERE id = ${b.answerId} AND game_id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      const g = await sql`SELECT data FROM trivia_games WHERE id = ${gameId}`;
      let pts = 10, isWager = false;
      if (g.length) {
        for (const r of (g[0].data.rounds || [])) {
          for (const q of (r.questions || [])) {
            if (q.key === rows[0].q_key) { pts = Number(q.points) || 10; isWager = !!r.isWager; }
          }
        }
      }
      const d = rows[0].data || {};
      d.verdict = verdict;
      if (isWager) {
        const score = await teamScoreExcluding(gameId, rows[0].team_id, rows[0].q_key);
        d.points = wagerPoints(verdict === 'correct', d.wager, score, pts);
        d.wagerApplied = d.wager != null;
      } else {
        d.points = verdict === 'correct' ? pts : 0;
      }
      d.autoScored = false;
      d.adjudicatedAt = new Date().toISOString();
      await sql`UPDATE trivia_answers SET data = ${JSON.stringify(d)}::jsonb WHERE id = ${rows[0].id}`;
      return json({ ok: true, id: rows[0].id, verdict, points: d.points });
    }

    // ----- ADMIN: publish round themes to the public event page (+ notify) -----
    if (req.method === 'POST' && gameId && action === 'publish-plan') {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const rows = await sql`SELECT data FROM trivia_games WHERE id = ${gameId}`;
      if (!rows.length) return bad('not found', 404);
      const game = rows[0].data;
      if (!game.eventId) return bad('Link this session to a public event first.');
      const evRows = await sql`SELECT data FROM events WHERE id = ${game.eventId}`;
      if (!evRows.length) return bad('Linked event not found on the calendar.', 404);
      const ev = evRows[0].data;

      const publish = !!b.publish;
      const wagerMode = ['show', 'tease', 'hide'].includes(b.wagerMode) ? b.wagerMode : 'show';

      if (!publish) {
        delete ev.triviaPlan;
        await sql`UPDATE events SET data = ${JSON.stringify(ev)}::jsonb WHERE id = ${game.eventId}`;
        return json({ ok: true, published: false, notified: 0 });
      }

      const planRounds = (game.rounds || []).map(r => {
        const minigame = (r.questions || []).some(q => String(q.type || '').indexOf('minigame') === 0);
        if (r.isWager && wagerMode === 'hide') return { title: r.title || '', isWager: false, minigame };
        if (r.isWager && wagerMode === 'tease') return { title: '??? Mystery Round ???', isWager: true, minigame };
        return { title: r.title || '', isWager: !!r.isWager, minigame };
      });
      if (!planRounds.length) return bad('Add rounds before publishing.');

      ev.triviaPlan = {
        publish: true,
        occDate: game.occDate || null,
        wagerLabel: game.wagerLabel || 'Stash or Splash',
        rounds: planRounds,
        gameId: game.id,
        updatedAt: new Date().toISOString()
      };
      await sql`UPDATE events SET data = ${JSON.stringify(ev)}::jsonb WHERE id = ${game.eventId}`;

      // ---- notify registrants of this occurrence ----
      let notified = 0;
      if (b.notify) {
        const base = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
        const regs = await sql`SELECT data, occ_date FROM registrations WHERE event_id = ${game.eventId}`;
        const occ = game.occDate || null;
        const lines = planRounds.map((r, i) =>
          (i + 1) + '. ' + (r.title || '???') +
          (r.isWager ? ' — 💰 ' + (game.wagerLabel || 'Stash or Splash') : '') +
          (r.minigame ? ' (minigame!)' : '')).join('\n');
        const bodyText =
          'The round themes for ' + (ev.title || 'our trivia night') +
          (occ ? (' on ' + occ) : '') + ' are locked in:\n\n' + lines +
          '\n\nStudy up, rally your team, and we\'ll see you at the Haven! ' +
          '(Themes can shuffle slightly on the night — Stash reserves showman\'s privilege.)';
        const link = base + '/event/' + encodeURIComponent(game.eventId) + (occ ? ('?date=' + encodeURIComponent(occ)) : '');
        for (const r of regs) {
          const reg = r.data || {};
          if (reg.canceled || reg.status === 'canceled') continue;
          if (occ && r.occ_date) {
            const rd = String(r.occ_date).slice(0, 10);
            if (rd !== occ) continue;
          }
          if (!reg.email) continue;
          try {
            await sendBrandedMail(reg.email,
              '🧠 Round themes revealed — ' + (ev.title || 'Trivia Night') + (occ ? (' · ' + occ) : ''),
              {
                heading: 'The themes are locked in! 🧠',
                bodyText,
                buttons: [{ label: 'View the event', url: link }]
              });
            notified++;
          } catch (e) { console.error('[trivia] notify failed', reg.email, e && e.message); }
        }
      }
      return json({ ok: true, published: true, rounds: planRounds.length, notified });
    }

    // ----- ADMIN: minigame placement scoring — host enters points per team -----
    if (req.method === 'POST' && gameId && action === 'minigame-score') {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const qKey = String(b.qKey || '');
      if (!qKey || !Array.isArray(b.scores)) return bad('qKey and scores[] required');
      let saved = 0;
      for (const s of b.scores) {
        if (!s || !s.teamId) continue;
        const pts = Math.round(Number(s.points) || 0);
        const existing = await sql`SELECT id, data FROM trivia_answers
          WHERE game_id = ${gameId} AND team_id = ${s.teamId} AND q_key = ${qKey}`;
        if (existing.length) {
          const d = existing[0].data || {};
          d.answer = d.answer || '(minigame result)';
          d.verdict = 'correct';
          d.points = pts;
          d.minigame = true;
          d.adjudicatedAt = new Date().toISOString();
          await sql`UPDATE trivia_answers SET data = ${JSON.stringify(d)}::jsonb WHERE id = ${existing[0].id}`;
        } else {
          const d = {
            answer: '(minigame result)', wager: null,
            submittedAt: Date.now(), verdict: 'correct', points: pts,
            minigame: true, adjudicatedAt: new Date().toISOString()
          };
          await sql`INSERT INTO trivia_answers (id, game_id, team_id, q_key, data)
            VALUES (${newId('ANS')}, ${gameId}, ${s.teamId}, ${qKey}, ${JSON.stringify(d)}::jsonb)`;
        }
        saved++;
      }
      return json({ ok: true, saved });
    }

    // ----- PUBLIC (team token): my answer + verdict for one question -----
    if (req.method === 'GET' && gameId && action === 'myanswer') {
      const teamId = verifyTeamToken(url.searchParams.get('token') || '');
      if (!teamId) return bad('unauthorized', 401);
      const qKey = url.searchParams.get('qKey') || '';
      if (!qKey) return bad('qKey required');
      const rows = await sql`SELECT data FROM trivia_answers
        WHERE game_id = ${gameId} AND team_id = ${teamId} AND q_key = ${qKey}`;
      if (!rows.length) return json({ answered: false });
      const d = rows[0].data || {};
      return json({ answered: true, answer: d.answer, wager: d.wager, verdict: d.verdict || null, points: d.points });
    }

    return bad('not found', 404);
  }

  // ================= content library (admin) =================
  const LIB = { questions: 'trivia_questions', themes: 'trivia_themes' };
  if (LIB[head]) {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    const table = LIB[head];
    const id = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (req.method === 'GET' && !id) {
      const rows = table === 'trivia_questions'
        ? await sql`SELECT data FROM trivia_questions ORDER BY created_at DESC`
        : await sql`SELECT data FROM trivia_themes ORDER BY created_at DESC`;
      return json(rows.map(r => r.data));
    }
    if (req.method === 'POST' && !id) {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      b.id = newId(head === 'questions' ? 'QB' : 'THM');
      b.createdAt = new Date().toISOString();
      if (table === 'trivia_questions') {
        await sql`INSERT INTO trivia_questions (id, data) VALUES (${b.id}, ${JSON.stringify(b)}::jsonb)`;
      } else {
        await sql`INSERT INTO trivia_themes (id, data) VALUES (${b.id}, ${JSON.stringify(b)}::jsonb)`;
      }
      return json(b, 201);
    }
    if (req.method === 'PUT' && id) {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      b.id = id;
      b.updatedAt = new Date().toISOString();
      if (table === 'trivia_questions') {
        await sql`UPDATE trivia_questions SET data = ${JSON.stringify(b)}::jsonb WHERE id = ${id}`;
      } else {
        await sql`UPDATE trivia_themes SET data = ${JSON.stringify(b)}::jsonb WHERE id = ${id}`;
      }
      return json(b);
    }
    if (req.method === 'DELETE' && id) {
      if (table === 'trivia_questions') {
        await sql`DELETE FROM trivia_questions WHERE id = ${id}`;
      } else {
        await sql`DELETE FROM trivia_themes WHERE id = ${id}`;
      }
      return noContent();
    }
    return bad('not found', 404);
  }

  // ================= suggestion inbox (admin) =================
  if (head === 'suggestions') {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    const id = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (req.method === 'GET' && !id) {
      const rows = await sql`SELECT data, status FROM trivia_suggestions ORDER BY created_at DESC`;
      return json(rows.map(r => Object.assign({}, r.data, { status: r.status })));
    }
    if (req.method === 'PUT' && id) {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const status = ['new', 'accepted', 'rejected'].includes(b.status) ? b.status : 'new';
      await sql`UPDATE trivia_suggestions SET status = ${status} WHERE id = ${id}`;
      return json({ ok: true, id, status });
    }
    return bad('not found', 404);
  }

  return bad('not found', 404);
};
