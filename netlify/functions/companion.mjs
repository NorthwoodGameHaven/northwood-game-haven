// netlify/functions/companion.mjs
// NGH-BUILD 2026-09-11a — Game Companion shared tables (Turn Tracker)
// ---------------------------------------------------------------------
// Tiny shared-state rooms for phones sitting at the same table. Same
// polling model as trivia/tv/karaoke: GET state?v=N -> {unchanged:true}.
// Tables are short-lived (12 h after the last change) and hold no PII
// beyond display names.
//
// Routes (via /api/companion/* alias):
//   GET  /companion/time                                PUBLIC {serverNow}
//   POST /companion/tables                              PUBLIC {kind:'turns', settings, host:{name,color,deviceId}} -> {code, hostToken, playerId, token}
//   GET  /companion/tables/:code/state?v=N              PUBLIC poll
//   POST /companion/tables/:code/join                   PUBLIC {name, color, deviceId} -> {playerId, token}
//   POST /companion/tables/:code/action                 PUBLIC {token, action, ...}
//        player: endTurn | leave | setMe{name,color}
//        host (hostToken): start | pause | resume | next | prev | reverse | setOrder{order:[ids]} | addLocal{name,color} | remove{playerId} | setSettings{settings} | reset | end
// ---------------------------------------------------------------------
import { sql, json, bad, preflight } from './_shared/db.mjs';
import crypto from 'node:crypto';

let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
async function mk(stmt) { try { await stmt; } catch (e) { if (!isAlreadyExists(e)) throw e; } }
async function ensureSchema() {
  if (_ready) return;
  await mk(sql`CREATE TABLE IF NOT EXISTS companion_tables (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
  _ready = true;
}
const now = () => Date.now();
const rid = (p) => p + '_' + crypto.randomBytes(4).toString('hex');
const tok = () => crypto.randomBytes(12).toString('hex');
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 30);
const cleanColor = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? String(c).toLowerCase() : '#c9973a';
function newCode() { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 5; i++) s += A[crypto.randomInt(A.length)]; return s; }
async function readBody(req) { try { return await req.json(); } catch { return {}; } }

async function load(code) { const r = await sql`SELECT data, version FROM companion_tables WHERE id = ${code}`; if (!r.length) return null; const s = r[0].data; s.version = r[0].version; return s; }
async function mutate(code, fn) {
  for (let i = 0; i < 4; i++) {
    const s = await load(code); if (!s) return { error: 'no such table', status: 404 };
    const expected = s.version; let result;
    try { result = fn(s); } catch (e) { if (e && e.status) return { error: e.error, status: e.status }; throw e; }
    if (result && result.noChange) return { ok: true, state: s, result };
    const r = await sql`UPDATE companion_tables SET data = ${JSON.stringify(s)}::jsonb, version = ${expected + 1}, updated_at = now() WHERE id = ${code} AND version = ${expected} RETURNING version`;
    if (r.length) { s.version = expected + 1; return { ok: true, state: s, result }; }
  }
  return { error: 'busy', status: 409 };
}
function pub(s) {
  const o = Object.assign({}, s);
  o.players = (s.players || []).map(p => ({ id: p.id, name: p.name, color: p.color, order: p.order, local: !!p.local, joinedAt: p.joinedAt }));
  delete o.hostToken; o.serverNow = now(); return o;
}
function ordered(s) { return (s.players || []).slice().sort((a, b) => a.order - b.order); }
function setTurn(s, idx, dir) {
  const ps = ordered(s); if (!ps.length) { s.turn = null; return; }
  let i = ((idx % ps.length) + ps.length) % ps.length;
  const prev = s.turn ? s.turn.index : -1;
  if (s.turn && ((dir > 0 && i <= prev && ps.length > 1) || (dir < 0 && i >= prev && ps.length > 1))) { /* wrapped */ }
  const p = ps[i];
  const round = s.turn ? s.turn.round + ((dir > 0 && i === 0 && ps.length > 1) ? 1 : (dir < 0 && i === ps.length - 1 && ps.length > 1) ? -1 : 0) : 1;
  s.turn = { playerId: p.id, index: i, round: Math.max(1, round), startedAt: now(), seq: (s.seq = (s.seq || 0) + 1) };
  s.history = (s.history || []).concat([{ playerId: p.id, at: now() }]).slice(-50);
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^.*\/companion\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const head = parts[0] || '';
    if (head === 'time') return json({ serverNow: now() });
    if (head !== 'tables') return bad('not found', 404);
    const code = String(parts[1] || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const sub = parts[2] || '';

    if (!code && req.method === 'POST') {
      const b = await readBody(req);
      await sql`DELETE FROM companion_tables WHERE updated_at < now() - interval '12 hours'`;
      let c = newCode(); for (let i = 0; i < 5; i++) { const ex = await sql`SELECT 1 FROM companion_tables WHERE id = ${c}`; if (!ex.length) break; c = newCode(); }
      const host = b.host || {};
      const hostToken = tok();
      const s = { code: c, kind: 'turns', status: 'lobby', hostToken, players: [], turn: null, direction: 1, seq: 0, round: 0,
                  settings: { timerSec: Math.min(3600, Math.max(0, Number((b.settings || {}).timerSec) || 0)), showNames: true }, createdAt: now(), history: [] };
      let me = null;
      if (host.name) { me = { id: rid('p'), name: clean(host.name), color: cleanColor(host.color), token: tok(), deviceId: clean(host.deviceId, 40) || null, order: 1, joinedAt: now(), isHost: true }; s.players.push(me); }
      await sql`INSERT INTO companion_tables (id, data, version) VALUES (${c}, ${JSON.stringify(s)}::jsonb, 1)`;
      s.version = 1;
      return json({ code: c, hostToken, playerId: me ? me.id : null, token: me ? me.token : null, state: pub(s) }, 201);
    }
    if (!code) return bad('table code required');

    if (sub === 'state' && req.method === 'GET') {
      const s = await load(code); if (!s) return bad('no such table', 404);
      const v = Number(url.searchParams.get('v')) || 0;
      if (v && v === s.version) return json({ unchanged: true, serverNow: now(), version: s.version });
      return json(pub(s));
    }
    if (sub === 'join' && req.method === 'POST') {
      const b = await readBody(req); const name = clean(b.name); if (!name) return bad('name required');
      const r = await mutate(code, (s) => {
        if (s.status === 'ended') throw { status: 410, error: 'table closed' };
        const dev = clean(b.deviceId, 40); let p = dev ? s.players.find(x => x.deviceId === dev) : null;
        if (p) { p.name = name; p.color = cleanColor(b.color); return { player: p }; }
        if (s.players.length >= 16) throw { status: 429, error: 'table full (16)' };
        if (s.players.some(x => x.color === cleanColor(b.color))) throw { status: 409, error: 'that color is taken' };
        p = { id: rid('p'), name, color: cleanColor(b.color), token: tok(), deviceId: dev || null, order: s.players.reduce((m, x) => Math.max(m, x.order), 0) + 1, joinedAt: now() };
        s.players.push(p); return { player: p };
      });
      if (r.error) return bad(r.error, r.status);
      const p = r.result.player; return json({ playerId: p.id, token: p.token, state: pub(r.state) });
    }
    if (sub === 'action' && req.method === 'POST') {
      const b = await readBody(req); const action = String(b.action || '');
      const r = await mutate(code, (s) => {
        const isHost = b.token && b.token === s.hostToken;
        const me = s.players.find(p => p.token === b.token) || null;
        if (!isHost && !me) throw { status: 401, error: 'not at this table' };
        const cur = s.turn ? s.players.find(p => p.id === s.turn.playerId) : null;
        switch (action) {
          case 'endTurn': {
            if (s.status !== 'live') throw { status: 409, error: 'game not running' };
            const allowed = isHost || (me && cur && cur.id === me.id) || (cur && cur.local && me);
            if (!allowed) throw { status: 403, error: 'not your turn' };
            setTurn(s, s.turn.index + s.direction, s.direction); return {};
          }
          case 'leave': { if (!me) return { noChange: true }; s.players = s.players.filter(p => p.id !== me.id); if (s.turn && s.turn.playerId === me.id) setTurn(s, s.turn.index, s.direction); return {}; }
          case 'setMe': { if (!me) throw { status: 403, error: 'no player' }; if (b.name) me.name = clean(b.name); if (b.color) { const c = cleanColor(b.color); if (s.players.some(p => p.id !== me.id && p.color === c)) throw { status: 409, error: 'color taken' }; me.color = c; } return {}; }
        }
        if (!isHost) throw { status: 403, error: 'host only' };
        switch (action) {
          case 'start': { if (!s.players.length) throw { status: 409, error: 'no players' }; s.status = 'live'; s.turn = null; setTurn(s, Number(b.startIndex) || 0, 1); s.turn.round = 1; return {}; }
          case 'pause': s.status = 'paused'; if (s.turn) s.turn.pausedAt = now(); return {};
          case 'resume': s.status = 'live'; if (s.turn && s.turn.pausedAt) { s.turn.startedAt += now() - s.turn.pausedAt; delete s.turn.pausedAt; } return {};
          case 'next': if (!s.turn) throw { status: 409, error: 'not started' }; setTurn(s, s.turn.index + s.direction, s.direction); return {};
          case 'prev': if (!s.turn) throw { status: 409, error: 'not started' }; setTurn(s, s.turn.index - s.direction, -s.direction); return {};
          case 'reverse': s.direction = -s.direction; return {};
          case 'setOrder': { const ids = Array.isArray(b.order) ? b.order : []; let i = 1; ids.forEach(id => { const p = s.players.find(x => x.id === id); if (p) p.order = i++; }); s.players.filter(p => ids.indexOf(p.id) < 0).sort((a, c) => a.order - c.order).forEach(p => { p.order = i++; }); if (s.turn) { const ps = ordered(s); s.turn.index = Math.max(0, ps.findIndex(p => p.id === s.turn.playerId)); } return {}; }
          case 'addLocal': { const name = clean(b.name); if (!name) throw { status: 400, error: 'name required' }; if (s.players.length >= 16) throw { status: 429, error: 'table full' }; const c = cleanColor(b.color); if (s.players.some(p => p.color === c)) throw { status: 409, error: 'color taken' }; s.players.push({ id: rid('p'), name, color: c, token: null, local: true, order: s.players.reduce((m, x) => Math.max(m, x.order), 0) + 1, joinedAt: now() }); return {}; }
          case 'remove': { const p = s.players.find(x => x.id === b.playerId); if (!p) throw { status: 404, error: 'no such player' }; s.players = s.players.filter(x => x.id !== p.id); if (s.turn && s.turn.playerId === p.id) setTurn(s, s.turn.index, s.direction); else if (s.turn) { const ps = ordered(s); s.turn.index = Math.max(0, ps.findIndex(x => x.id === s.turn.playerId)); } return {}; }
          case 'setSettings': { const st = b.settings || {}; if (st.timerSec != null) s.settings.timerSec = Math.min(3600, Math.max(0, Number(st.timerSec) || 0)); if (st.showNames != null) s.settings.showNames = !!st.showNames; return {}; }
          case 'reset': s.status = 'lobby'; s.turn = null; s.history = []; s.direction = 1; return {};
          case 'end': s.status = 'ended'; s.endedAt = now(); return {};
          default: throw { status: 400, error: 'unknown action' };
        }
      });
      if (r.error) return bad(r.error, r.status);
      return json({ ok: true, state: pub(r.state) });
    }
    return bad('not found', 404);
  } catch (e) { console.error('[companion]', e); return bad('server error: ' + (e && e.message || e), 500); }
};
