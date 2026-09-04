// netlify/functions/arcade.mjs
// NGH-BUILD 2026-08-24c — NGH Arcade engine (speed buzzer + audience Q&A)
// ---------------------------------------------------------------------
// Phone-vs-phone minigames for events, run from guru-tv.html and shown on
// the TV Network. Same sync architecture as trivia/tv: version-gated 1 s
// polls, server-epoch timestamps, offset-corrected client clocks.
//
// KINDS
//   buzzer — host ARMs a round; state carries armAt/goAt (goAt = armAt +
//     2–4.5 s random). Displays & phones flip to "GO" at goAt using their
//     own synced clocks (no server round-trip at the flash). A press posts
//     the player's offset-corrected server-time; reaction = t - goAt.
//     Pressing before goAt = "jumped" (disqualified for the round).
//     Anti-cheat: t is clamped to server arrival time (can't claim a
//     press from the future) and rejected if wildly early.
//   qa — audience submits questions; host approves/pins; players upvote;
//     the TV shows the approved wall sorted pinned → votes → newest.
//
// API (after /api/arcade):
//   GET  /time                                PUBLIC — {serverNow}
//   GET  /sessions/:id/state?v=N              PUBLIC — poll; {unchanged:true}
//   POST /sessions/:id/join                   PUBLIC — {name} -> {playerId, token}
//   POST /sessions/:id/buzz                   PUBLIC — {token, round, t?}
//   POST /sessions/:id/ask                    PUBLIC — {token, text}
//   POST /sessions/:id/vote                   PUBLIC — {token, itemId}
//   POST /sessions                            admin  — {kind, name?} -> session
//   GET  /sessions                            admin  — recent sessions
//   POST /sessions/:id/state                  admin  — {op: arm|results|award|
//                                                       lobby|reset} (+args)
//   GET  /sessions/:id/items?status=S         admin  — QA moderation list
//   POST /sessions/:id/items/:iid             admin  — {status: approved|
//                                                       dismissed|pinned|done}
// ---------------------------------------------------------------------

import crypto from 'node:crypto';
import { sql, json, bad, preflight, requireAdmin } from './_shared/db.mjs';

let _ready = false;
function isAlreadyExists(e) {
  const c = e && e.code;
  return c === '23505' || c === '42P07' || c === '42710';
}
async function createIfMissing(stmt) {
  try { await stmt; } catch (e) { if (!isAlreadyExists(e)) throw e; }
}
async function ensureArcadeSchema() {
  if (_ready) return;
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS arcade_sessions (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    version    INTEGER NOT NULL DEFAULT 1,
    state      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS arcade_players (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name       TEXT NOT NULL,
    token      TEXT NOT NULL,
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS arcade_items (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    player_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new',
    votes      INTEGER NOT NULL DEFAULT 0,
    data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE INDEX IF NOT EXISTS arcade_items_sess
    ON arcade_items (session_id, kind, status)`);
  _ready = true;
}

const KINDS = new Set(['buzzer', 'qa']);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
function shortCode(n = 4) {
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function rid(p) { return p + '_' + crypto.randomBytes(8).toString('hex'); }
function clean(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }

async function getSession(id) {
  const rows = await sql`SELECT id, kind, version, state FROM arcade_sessions WHERE id = ${id}`;
  return rows.length ? rows[0] : null;
}
async function saveState(id, st) {
  const rows = await sql`UPDATE arcade_sessions
    SET state = ${JSON.stringify(st)}::jsonb, version = version + 1, updated_at = now()
    WHERE id = ${id} RETURNING version`;
  return rows.length ? Number(rows[0].version) : 0;
}
async function bump(id) {
  await sql`UPDATE arcade_sessions SET version = version + 1, updated_at = now() WHERE id = ${id}`;
}
async function playerByToken(sessionId, token) {
  if (!token) return null;
  const rows = await sql`SELECT id, name FROM arcade_players
    WHERE session_id = ${sessionId} AND token = ${token}`;
  return rows.length ? rows[0] : null;
}

// ---- public state assembly ----
async function publicState(sess) {
  const st = sess.state || {};
  const out = { kind: sess.kind, version: Number(sess.version), serverNow: Date.now() };
  const pc = await sql`SELECT count(*)::int AS n FROM arcade_players WHERE session_id = ${sess.id}`;
  out.players = pc.length ? pc[0].n : 0;

  if (sess.kind === 'buzzer') {
    out.phase = st.phase || 'lobby';
    out.round = st.round || 0;
    out.armAt = st.armAt || 0;
    out.goAt = st.goAt || 0;
    out.question = st.question || '';
    out.scores = st.scores || {};
    if (out.round > 0) {
      const buzz = await sql`SELECT player_id, data FROM arcade_items
        WHERE session_id = ${sess.id} AND kind = 'buzz'
          AND (data->>'round')::int = ${out.round}`;
      out.buzzes = buzz.map(b => ({
        playerId: b.player_id,
        name: (b.data && b.data.name) || '?',
        rt: Number(b.data && b.data.rt),
        jumped: !!(b.data && b.data.jumped)
      })).sort((a, b) => (a.jumped - b.jumped) || (a.rt - b.rt));
    } else out.buzzes = [];
    // recent joiners for the lobby ticker
    const names = await sql`SELECT name FROM arcade_players
      WHERE session_id = ${sess.id} ORDER BY last_seen DESC LIMIT 12`;
    out.roster = names.map(r => r.name);
  }

  if (sess.kind === 'qa') {
    const items = await sql`SELECT id, player_id, status, votes, data, created_at FROM arcade_items
      WHERE session_id = ${sess.id} AND kind = 'q'
        AND status IN ('approved','pinned','done')
      ORDER BY (status = 'pinned') DESC, votes DESC, created_at DESC LIMIT 40`;
    out.items = items.map(i => ({
      id: i.id, name: (i.data && i.data.name) || 'Guest',
      text: (i.data && i.data.text) || '',
      votes: Number(i.votes), status: i.status
    }));
    out.title = st.title || '';
  }
  return out;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureArcadeSchema();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/arcade/, '').split('/').filter(Boolean);
  const head = parts[0] || '';

  if (head === 'time' && req.method === 'GET') return json({ serverNow: Date.now() });

  // ---------------- /sessions ----------------
  if (head === 'sessions') {
    const id = clean(parts[1], 12).toUpperCase();
    const sub = parts[2] || '';

    // admin: create
    if (!id && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const kind = String((body && body.kind) || '');
      if (!KINDS.has(kind)) return bad('kind must be buzzer or qa');
      const st = kind === 'buzzer'
        ? { phase: 'lobby', round: 0, scores: {} }
        : { title: clean(body.title, 80) };
      for (let tries = 0; tries < 5; tries++) {
        const code = shortCode(4);
        try {
          await sql`INSERT INTO arcade_sessions (id, kind, state)
            VALUES (${code}, ${kind}, ${JSON.stringify(st)}::jsonb)`;
          return json({ id: code, kind, version: 1, state: st });
        } catch (e) { if (!isAlreadyExists(e)) throw e; }
      }
      return bad('could not allocate a session code', 500);
    }

    // admin: list
    if (!id && req.method === 'GET') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const rows = await sql`SELECT s.id, s.kind, s.version, s.state, s.created_at,
          (SELECT count(*)::int FROM arcade_players p WHERE p.session_id = s.id) AS players
        FROM arcade_sessions s ORDER BY s.created_at DESC LIMIT 20`;
      return json({ sessions: rows });
    }

    if (!id) return bad('not found', 404);
    const sess = await getSession(id);
    if (!sess) return bad('session not found', 404);
    const st = sess.state || {};

    // ---- PUBLIC: poll state ----
    if (sub === 'state' && req.method === 'GET') {
      const v = Number(url.searchParams.get('v') || 0);
      if (v && v === Number(sess.version)) return json({ unchanged: true, serverNow: Date.now() });
      return json(await publicState(sess));
    }

    // ---- PUBLIC: join ----
    if (sub === 'join' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const name = clean(body && body.name, 24);
      if (!name) return bad('name required');
      const playerId = rid('p'), token = rid('t');
      await sql`INSERT INTO arcade_players (id, session_id, name, token)
        VALUES (${playerId}, ${sess.id}, ${name}, ${token})`;
      await bump(sess.id); // lobby counters update on displays
      return json({ playerId, token, kind: sess.kind });
    }

    // ---- PUBLIC: buzz ----
    if (sub === 'buzz' && req.method === 'POST') {
      if (sess.kind !== 'buzzer') return bad('not a buzzer session');
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const player = await playerByToken(sess.id, body && body.token);
      if (!player) return bad('unknown player', 403);
      const round = Number(body && body.round);
      if (!round || round !== Number(st.round)) return bad('stale round', 409);
      if (st.phase !== 'armed') return bad('round is not live', 409);
      const arrival = Date.now();
      let t = Number(body && body.t);
      if (!isFinite(t)) t = arrival;                 // unsynced phone: arrival time
      if (t > arrival + 250) t = arrival;            // no presses from the future
      if (t < Number(st.armAt || 0) - 2000) return bad('too early', 409);
      const jumped = t < Number(st.goAt || 0);
      const rt = Math.round(t - Number(st.goAt || 0));
      const iid = rid('b');
      // one buzz per player per round
      const dup = await sql`SELECT 1 FROM arcade_items
        WHERE session_id = ${sess.id} AND kind = 'buzz' AND player_id = ${player.id}
          AND (data->>'round')::int = ${round}`;
      if (dup.length) return json({ ok: true, dup: true, rt, jumped });
      await sql`INSERT INTO arcade_items (id, session_id, player_id, kind, status, data)
        VALUES (${iid}, ${sess.id}, ${player.id}, 'buzz', 'ok',
          ${JSON.stringify({ round, rt, jumped, name: player.name })}::jsonb)`;
      await sql`UPDATE arcade_players SET last_seen = now() WHERE id = ${player.id}`;
      await bump(sess.id); // displays see the buzz land within a poll
      return json({ ok: true, rt, jumped });
    }

    // ---- PUBLIC: ask (QA) ----
    if (sub === 'ask' && req.method === 'POST') {
      if (sess.kind !== 'qa') return bad('not a Q&A session');
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const player = await playerByToken(sess.id, body && body.token);
      if (!player) return bad('unknown player', 403);
      const text = clean(body && body.text, 200);
      if (text.length < 3) return bad('question is too short');
      const pending = await sql`SELECT count(*)::int AS n FROM arcade_items
        WHERE session_id = ${sess.id} AND kind = 'q' AND player_id = ${player.id}
          AND status = 'new'`;
      if (pending.length && pending[0].n >= 5) return bad('too many pending questions', 429);
      const iid = rid('q');
      await sql`INSERT INTO arcade_items (id, session_id, player_id, kind, status, data)
        VALUES (${iid}, ${sess.id}, ${player.id}, 'q', 'new',
          ${JSON.stringify({ text, name: player.name })}::jsonb)`;
      await sql`UPDATE arcade_players SET last_seen = now() WHERE id = ${player.id}`;
      await bump(sess.id); // host's moderation queue refreshes on next poll
      return json({ ok: true, id: iid, status: 'new' });
    }

    // ---- PUBLIC: vote (QA) ----
    if (sub === 'vote' && req.method === 'POST') {
      if (sess.kind !== 'qa') return bad('not a Q&A session');
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const player = await playerByToken(sess.id, body && body.token);
      if (!player) return bad('unknown player', 403);
      const iid = clean(body && body.itemId, 40);
      const rows = await sql`SELECT id, data, status FROM arcade_items
        WHERE id = ${iid} AND session_id = ${sess.id} AND kind = 'q'`;
      if (!rows.length) return bad('not found', 404);
      if (rows[0].status !== 'approved' && rows[0].status !== 'pinned') return bad('not votable', 409);
      const data = rows[0].data || {};
      const voters = Array.isArray(data.voters) ? data.voters : [];
      if (voters.indexOf(player.id) >= 0) return json({ ok: true, dup: true });
      voters.push(player.id);
      data.voters = voters.slice(0, 500);
      await sql`UPDATE arcade_items
        SET votes = votes + 1, data = ${JSON.stringify(data)}::jsonb WHERE id = ${iid}`;
      await bump(sess.id);
      return json({ ok: true });
    }

    // ---- ADMIN: drive buzzer state ----
    if (sub === 'state' && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const op = String((body && body.op) || '');

      if (sess.kind === 'buzzer') {
        if (op === 'arm') {
          st.round = (Number(st.round) || 0) + 1;
          st.phase = 'armed';
          st.armAt = Date.now();
          st.goAt = st.armAt + 2000 + Math.floor(Math.random() * 2500);
          st.question = clean(body.question, 120);
          delete st.lastResults;
        } else if (op === 'results') {
          st.phase = 'results';
        } else if (op === 'award') {
          const pid = clean(body.playerId, 40);
          const pts = Math.max(-5, Math.min(5, Number(body.pts) || 1));
          const p = await sql`SELECT name FROM arcade_players WHERE id = ${pid} AND session_id = ${sess.id}`;
          if (!p.length) return bad('unknown player', 404);
          st.scores = st.scores || {};
          const cur = st.scores[pid] || { name: p[0].name, pts: 0 };
          cur.pts += pts; cur.name = p[0].name;
          st.scores[pid] = cur;
        } else if (op === 'lobby') {
          st.phase = 'lobby';
        } else if (op === 'reset') {
          st.phase = 'lobby'; st.round = 0; st.scores = {};
          await sql`DELETE FROM arcade_items WHERE session_id = ${sess.id} AND kind = 'buzz'`;
        } else return bad('bad op');
        const version = await saveState(sess.id, st);
        return json({ ok: true, version, state: st });
      }

      if (sess.kind === 'qa') {
        if (op === 'title') {
          st.title = clean(body.title, 80);
          const version = await saveState(sess.id, st);
          return json({ ok: true, version, state: st });
        }
        return bad('bad op');
      }
      return bad('bad kind');
    }

    // ---- ADMIN: QA moderation ----
    if (sub === 'items' && req.method === 'GET') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const status = clean(url.searchParams.get('status'), 12);
      const rows = status
        ? await sql`SELECT id, player_id, status, votes, data, created_at FROM arcade_items
            WHERE session_id = ${sess.id} AND kind = 'q' AND status = ${status}
            ORDER BY created_at ASC LIMIT 100`
        : await sql`SELECT id, player_id, status, votes, data, created_at FROM arcade_items
            WHERE session_id = ${sess.id} AND kind = 'q'
            ORDER BY created_at DESC LIMIT 100`;
      return json({ items: rows });
    }

    if (sub === 'items' && parts[3] && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const status = String((body && body.status) || '');
      if (['approved', 'dismissed', 'pinned', 'done', 'new'].indexOf(status) < 0) return bad('bad status');
      const iid = clean(parts[3], 40);
      const rows = await sql`UPDATE arcade_items SET status = ${status}
        WHERE id = ${iid} AND session_id = ${sess.id} AND kind = 'q' RETURNING id`;
      if (!rows.length) return bad('not found', 404);
      await bump(sess.id);
      return json({ ok: true });
    }

    return bad('not found', 404);
  }

  return bad('not found', 404);
};
