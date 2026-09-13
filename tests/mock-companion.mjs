// NGH-BUILD 2026-09-13a
// =====================================================================
// tests/mock-companion.mjs — the Turn Tracker's shared tables, in memory.
//
// netlify/functions/companion.mjs is the only app feature with real shared
// state that the mock never implemented, so the turn tracker could only ever
// be tested — and screenshotted — on its landing screen. Everything past
// "Host a new table" was unreachable: the lobby, the live rotation, the host
// controls, and now the pass-it-down badge and the back guard.
//
// The pure logic below (ordered / setTurn / pub / the action switch) is ported
// straight across from companion.mjs rather than reimagined, because a mock
// that invents its own rules tests nothing. The only thing replaced is
// storage: a Map instead of the companion_tables row, with the same optimistic
// version bump so the poller's {unchanged:true} path is exercised for real.
//
// tests/companion-tables.test.mjs checks this file against the real one.
// =====================================================================

const TABLES = new Map();
const now = () => Date.now();
let seqN = 0;
const rid = (p) => p + '_' + (++seqN).toString(16).padStart(8, '0');
const tok = () => 't' + (++seqN).toString(16).padStart(12, '0');
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 30);
const cleanColor = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? String(c).toLowerCase() : '#c9973a';

// The real one uses crypto.randomInt over the same alphabet. Deterministic
// here so a screenshot or an assertion can name the code it expects.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let codeN = 0;
function newCode() {
  codeN++;
  let s = '', n = codeN;
  for (let i = 0; i < 5; i++) { s = ALPHABET[n % ALPHABET.length] + s; n = Math.floor(n / ALPHABET.length) + 7; }
  return s;
}

export function resetTables() { TABLES.clear(); codeN = 0; seqN = 0; }

function ordered(s) { return (s.players || []).slice().sort((a, b) => a.order - b.order); }

function setTurn(s, idx, dir) {
  const ps = ordered(s); if (!ps.length) { s.turn = null; return; }
  const i = ((idx % ps.length) + ps.length) % ps.length;
  const p = ps[i];
  const round = s.turn
    ? s.turn.round + ((dir > 0 && i === 0 && ps.length > 1) ? 1 : (dir < 0 && i === ps.length - 1 && ps.length > 1) ? -1 : 0)
    : 1;
  s.turn = { playerId: p.id, index: i, round: Math.max(1, round), startedAt: now(), seq: (s.seq = (s.seq || 0) + 1) };
  s.history = (s.history || []).concat([{ playerId: p.id, at: now() }]).slice(-50);
}

// companion.mjs pub(): strips hostToken and every player's token/deviceId.
export function pub(s) {
  const o = Object.assign({}, s);
  o.players = (s.players || []).map((p) => ({ id: p.id, name: p.name, color: p.color, order: p.order, local: !!p.local, joinedAt: p.joinedAt }));
  delete o.hostToken; o.serverNow = now(); return o;
}

const err = (status, error) => ({ status, body: { error } });

function create(b) {
  const c = newCode();
  const host = b.host || {};
  const s = {
    code: c, kind: 'turns', status: 'lobby', hostToken: tok(), players: [], turn: null,
    direction: 1, seq: 0, round: 0, version: 1,
    settings: { timerSec: Math.min(3600, Math.max(0, Number((b.settings || {}).timerSec) || 0)), showNames: true },
    createdAt: now(), history: []
  };
  let me = null;
  if (host.name) {
    me = { id: rid('p'), name: clean(host.name), color: cleanColor(host.color), token: tok(), deviceId: clean(host.deviceId, 40) || null, order: 1, joinedAt: now(), isHost: true };
    s.players.push(me);
  }
  TABLES.set(c, s);
  return { status: 201, body: { code: c, hostToken: s.hostToken, playerId: me ? me.id : null, token: me ? me.token : null, state: pub(s) } };
}

function join(code, b) {
  const s = TABLES.get(code); if (!s) return err(404, 'no such table');
  const name = clean(b.name); if (!name) return err(400, 'name required');
  if (s.status === 'ended') return err(410, 'table closed');
  const dev = clean(b.deviceId, 40);
  let p = dev ? s.players.find((x) => x.deviceId === dev) : null;
  if (p) { p.name = name; p.color = cleanColor(b.color); }
  else {
    if (s.players.length >= 16) return err(429, 'table full (16)');
    if (s.players.some((x) => x.color === cleanColor(b.color))) return err(409, 'that color is taken');
    p = { id: rid('p'), name, color: cleanColor(b.color), token: tok(), deviceId: dev || null, order: s.players.reduce((m, x) => Math.max(m, x.order), 0) + 1, joinedAt: now() };
    s.players.push(p);
  }
  s.version++;
  return { status: 200, body: { playerId: p.id, token: p.token, state: pub(s) } };
}

function action(code, b) {
  const s = TABLES.get(code); if (!s) return err(404, 'no such table');
  const a = String(b.action || '');
  const isHost = b.token && b.token === s.hostToken;
  const me = s.players.find((p) => p.token === b.token) || null;
  if (!isHost && !me) return err(401, 'not at this table');
  const cur = s.turn ? s.players.find((p) => p.id === s.turn.playerId) : null;

  switch (a) {
    case 'endTurn': {
      if (s.status !== 'live') return err(409, 'game not running');
      if (!(isHost || (me && cur && cur.id === me.id) || (cur && cur.local && me))) return err(403, 'not your turn');
      setTurn(s, s.turn.index + s.direction, s.direction); break;
    }
    case 'leave': {
      if (!me) return { status: 200, body: { ok: true, state: pub(s) } };
      s.players = s.players.filter((p) => p.id !== me.id);
      if (s.turn && s.turn.playerId === me.id) setTurn(s, s.turn.index, s.direction);
      break;
    }
    case 'setMe': {
      if (!me) return err(403, 'no player');
      if (b.name) me.name = clean(b.name);
      if (b.color) {
        const c = cleanColor(b.color);
        if (s.players.some((p) => p.id !== me.id && p.color === c)) return err(409, 'color taken');
        me.color = c;
      }
      break;
    }
    default: {
      if (!isHost) return err(403, 'host only');
      switch (a) {
        case 'start':
          if (!s.players.length) return err(409, 'no players');
          s.status = 'live'; s.turn = null; setTurn(s, Number(b.startIndex) || 0, 1); s.turn.round = 1; break;
        case 'pause': s.status = 'paused'; if (s.turn) s.turn.pausedAt = now(); break;
        case 'resume': s.status = 'live'; if (s.turn && s.turn.pausedAt) { s.turn.startedAt += now() - s.turn.pausedAt; delete s.turn.pausedAt; } break;
        case 'next': if (!s.turn) return err(409, 'not started'); setTurn(s, s.turn.index + s.direction, s.direction); break;
        case 'prev': if (!s.turn) return err(409, 'not started'); setTurn(s, s.turn.index - s.direction, -s.direction); break;
        case 'reverse': s.direction = -s.direction; break;
        case 'setOrder': {
          const ids = Array.isArray(b.order) ? b.order : []; let i = 1;
          ids.forEach((id) => { const p = s.players.find((x) => x.id === id); if (p) p.order = i++; });
          s.players.filter((p) => ids.indexOf(p.id) < 0).sort((x, y) => x.order - y.order).forEach((p) => { p.order = i++; });
          if (s.turn) { const ps = ordered(s); s.turn.index = Math.max(0, ps.findIndex((p) => p.id === s.turn.playerId)); }
          break;
        }
        case 'addLocal': {
          const name = clean(b.name); if (!name) return err(400, 'name required');
          if (s.players.length >= 16) return err(429, 'table full');
          const c = cleanColor(b.color);
          if (s.players.some((p) => p.color === c)) return err(409, 'color taken');
          s.players.push({ id: rid('p'), name, color: c, token: null, local: true, order: s.players.reduce((m, x) => Math.max(m, x.order), 0) + 1, joinedAt: now() });
          break;
        }
        case 'remove': {
          const p = s.players.find((x) => x.id === b.playerId); if (!p) return err(404, 'no such player');
          s.players = s.players.filter((x) => x.id !== p.id);
          if (s.turn && s.turn.playerId === p.id) setTurn(s, s.turn.index, s.direction);
          else if (s.turn) { const ps = ordered(s); s.turn.index = Math.max(0, ps.findIndex((x) => x.id === s.turn.playerId)); }
          break;
        }
        case 'setSettings': {
          const st = b.settings || {};
          if (st.timerSec != null) s.settings.timerSec = Math.min(3600, Math.max(0, Number(st.timerSec) || 0));
          if (st.showNames != null) s.settings.showNames = !!st.showNames;
          break;
        }
        case 'reset': s.status = 'lobby'; s.turn = null; s.history = []; s.direction = 1; break;
        case 'end': s.status = 'ended'; s.endedAt = now(); break;
        default: return err(400, 'unknown action');
      }
    }
  }
  s.version++;
  return { status: 200, body: { ok: true, state: pub(s) } };
}

// Router, shaped like liveApi(): returns null when the path is not ours, so
// mock-api.mjs can fall through to everything else.
//   POST /api/companion/tables
//   GET  /api/companion/tables/:code/state?v=N
//   POST /api/companion/tables/:code/join
//   POST /api/companion/tables/:code/action
//   GET  /api/companion/time
export function companionApi(pathname, method, url, body) {
  if (pathname.indexOf('/api/companion') !== 0) return null;
  const parts = pathname.replace(/^\/api\/companion\/?/, '').split('/').filter(Boolean);
  const head = parts[0] || '';
  if (head === 'time' && method === 'GET') return { status: 200, body: { serverNow: now() } };
  if (head !== 'tables') return err(404, 'not found');

  const code = String(parts[1] || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const sub = parts[2] || '';
  if (!code) return method === 'POST' ? create(body || {}) : err(400, 'table code required');

  if (sub === 'state' && method === 'GET') {
    const s = TABLES.get(code); if (!s) return err(404, 'no such table');
    const v = Number(url.searchParams.get('v')) || 0;
    if (v && v === s.version) return { status: 200, body: { unchanged: true, serverNow: now(), version: s.version } };
    return { status: 200, body: pub(s) };
  }
  if (sub === 'join' && method === 'POST') return join(code, body || {});
  if (sub === 'action' && method === 'POST') return action(code, body || {});
  return err(404, 'not found');
}
