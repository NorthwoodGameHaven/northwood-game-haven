// NGH-BUILD 2026-09-11a
// tests/_karaoke-hooks.mjs — node:module hooks that let the REAL karaoke.mjs and
// companion.mjs run in-process against an in-memory stand-in for Neon.
// The stand-in routes each tagged-template statement the two functions issue to a
// small JS implementation (tables are Maps). Anything unrecognised throws so a
// new query in the function is caught by the harness instead of silently
// returning [].

const DB_MOCK = String.raw`
globalThis.__kdb = globalThis.__kdb || { sessions: new Map(), songs: new Map(), votes: new Map(), players: new Map(), tables: new Map(), media: new Map(), calls: [] };
const D = globalThis.__kdb;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
function nowIso() { return new Date().toISOString(); }
export const sql = (strings, ...v) => {
  const q = norm(strings.join(' $ '));
  D.calls.push(q);
  return Promise.resolve(run(q, v));
};
function like(hay, pat) { const re = new RegExp('^' + pat.replace(/[.*+?^(){}|[\]\\$]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i'); return re.test(hay); }
function run(q, v) {
  if (/^(CREATE|ALTER)/i.test(q)) return [];
  // ---------------- karaoke_sessions ----------------
  if (/^SELECT data, version, status FROM karaoke_sessions WHERE id = \$/.test(q)) { const r = D.sessions.get(v[0]); return r ? [{ data: JSON.parse(JSON.stringify(r.data)), version: r.version, status: r.status }] : []; }
  if (/^UPDATE karaoke_sessions SET data = \$ ::jsonb, version = \$ , status = \$ , updated_at = now\(\) WHERE id = \$ AND version = \$ RETURNING version/.test(q)) {
    const r = D.sessions.get(v[3]); if (!r || r.version !== v[4]) return []; r.data = JSON.parse(v[0]); r.version = v[1]; r.status = v[2]; r.updated_at = nowIso(); return [{ version: r.version }]; }
  if (/^INSERT INTO karaoke_sessions \(id, data, version, status\) VALUES/.test(q)) { D.sessions.set(v[0], { id: v[0], data: JSON.parse(v[1]), version: 1, status: 'lobby', created_at: nowIso(), updated_at: nowIso() }); return []; }
  if (/^SELECT 1 FROM karaoke_sessions WHERE id = \$/.test(q)) return D.sessions.has(v[0]) ? [{ '?column?': 1 }] : [];
  if (/^SELECT id, status, data->>'mode' AS mode, version FROM karaoke_sessions WHERE status IN \('lobby','live'\) ORDER BY updated_at DESC LIMIT 1/.test(q)) {
    const rows = [...D.sessions.values()].filter(r => r.status === 'lobby' || r.status === 'live').sort((a, b) => b.updated_at.localeCompare(a.updated_at)); return rows.slice(0, 1).map(r => ({ id: r.id, status: r.status, mode: r.data.mode, version: r.version })); }
  if (/^SELECT id, status, version, created_at, updated_at, data->>'mode' AS mode, jsonb_array_length/.test(q)) return [...D.sessions.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 20).map(r => ({ id: r.id, status: r.status, version: r.version, created_at: r.created_at, updated_at: r.updated_at, mode: r.data.mode, members: (r.data.members || []).length }));
  // ---------------- karaoke_songs ----------------
  if (/^SELECT id, title, artist, duration_ms, provider, data FROM karaoke_songs WHERE id = \$/.test(q)) { const s = D.songs.get(v[0]); return s ? [s] : []; }
  if (/^SELECT data FROM karaoke_songs WHERE id = \$/.test(q)) { const s = D.songs.get(v[0]); return s ? [{ data: s.data }] : []; }
  /* NGH-BUILD 2026-09-12l: Name That Tune song picks. ORDER BY random() is
     deterministic here on purpose — a test that shuffles is a test that
     flakes. The handler returns catalog order and the caller filters out
     songs already used tonight, which is the behaviour under test.
     (No backticks in this comment: the whole mock is one template literal.) */
  if (/^SELECT id, title, artist, data FROM karaoke_songs WHERE id = \$/.test(q)) { const s = D.songs.get(v[0]); return s ? [{ id: s.id, title: s.title, artist: s.artist, data: s.data }] : []; }
  if (/^SELECT id, title, artist, data FROM karaoke_songs ORDER BY random\(\) LIMIT/.test(q)) { return [...D.songs.values()].map(s => ({ id: s.id, title: s.title, artist: s.artist, data: s.data })); }
  if (/^SELECT id, title, artist, duration_ms, provider, \(data->'lyrics'\) IS NOT NULL AS has_lyrics, data->'media'->>'cdg' IS NOT NULL AS has_cdg FROM karaoke_songs ORDER BY updated_at DESC LIMIT/.test(q)) return [...D.songs.values()].slice(0, v[0]).map(songRow);
  if (/^SELECT id, title, artist, duration_ms, provider, \(data->'lyrics'\) IS NOT NULL AS has_lyrics, data->'media'->>'cdg' IS NOT NULL AS has_cdg FROM karaoke_songs WHERE lower\(title\) LIKE/.test(q)) {
    const [l1, l2, p1, p2, lim] = v; return [...D.songs.values()].filter(s => like(s.title.toLowerCase(), l1) || like(s.artist.toLowerCase(), l2)).sort((a, b) => (like(b.title.toLowerCase(), p1) - like(a.title.toLowerCase(), p1)) || a.title.localeCompare(b.title)).slice(0, lim).map(songRow); }
  if (/^SELECT count\(\*\)::int AS songs/.test(q)) { const all = [...D.songs.values()]; return [{ songs: all.length, with_lyrics: all.filter(s => s.data.lyrics).length, with_cdg: all.filter(s => s.data.media && s.data.media.cdg).length }]; }
  if (/^SELECT provider, count\(\*\)::int AS n FROM karaoke_songs GROUP BY provider/.test(q)) { const m = {}; for (const s of D.songs.values()) m[s.provider] = (m[s.provider] || 0) + 1; return Object.keys(m).map(p => ({ provider: p, n: m[p] })); }
  if (/^INSERT INTO karaoke_songs \(id, provider, title, artist, duration_ms, data, updated_at\)/.test(q)) { const ex = D.songs.get(v[0]); D.songs.set(v[0], { id: v[0], provider: v[1], title: v[2], artist: v[3], duration_ms: v[4] != null ? v[4] : (ex ? ex.duration_ms : null), data: JSON.parse(v[5]), updated_at: nowIso() }); return []; }
  if (/^DELETE FROM karaoke_songs WHERE id = \$/.test(q)) { D.songs.delete(v[0]); return []; }
  // ---------------- karaoke_media (hosted CD+G) ----------------
  if (/^SELECT song_id FROM karaoke_media WHERE kind = 'cdg' AND song_id = ANY\( \$ \)/.test(q)) return (v[0] || []).filter(id => D.media.has(id + '|cdg')).map(id => ({ song_id: id }));
  if (/^SELECT b64 FROM karaoke_media WHERE song_id = \$ AND kind = 'cdg'/.test(q)) { const m = D.media.get(v[0] + '|cdg'); return m ? [{ b64: m.b64 }] : []; }
  if (/^DELETE FROM karaoke_media WHERE updated_at </.test(q)) return [];
  if (/^INSERT INTO karaoke_media \(song_id, kind, b64, bytes, updated_at\)/.test(q)) { D.media.set(v[0] + '|cdg', { b64: v[1], bytes: v[2] }); return []; }
  if (/^UPDATE karaoke_songs SET data = \$ ::jsonb, updated_at = now\(\) WHERE id = \$/.test(q)) { const s = D.songs.get(v[1]); if (s) s.data = JSON.parse(v[0]); return []; }
  // ---------------- karaoke_votes ----------------
  if (/^INSERT INTO karaoke_votes/.test(q)) { D.votes.set(v[0] + '|' + v[1] + '|' + v[2], { session_id: v[0], entry_id: v[1], member_id: v[2], room: v[3], choice: v[4], delivery: v[5] }); return []; }
  if (/^SELECT room, choice, delivery FROM karaoke_votes WHERE session_id = \$ AND entry_id = \$/.test(q)) return [...D.votes.values()].filter(x => x.session_id === v[0] && x.entry_id === v[1]).map(x => ({ room: x.room, choice: x.choice, delivery: x.delivery }));
  if (/^SELECT count\(\*\)::int AS n, avg\(choice\)::float AS c, avg\(delivery\)::float AS d FROM karaoke_votes/.test(q)) { const rows = [...D.votes.values()].filter(x => x.session_id === v[0] && x.entry_id === v[1]); const n = rows.length; return [{ n, c: n ? rows.reduce((a, r) => a + r.choice, 0) / n : null, d: n ? rows.reduce((a, r) => a + r.delivery, 0) / n : null }]; }
  // ---------------- karaoke_players ----------------
  if (/^INSERT INTO karaoke_players/.test(q)) { D.players.set(v[0] + '|' + v[1], { session_id: v[0], name: v[1], data: JSON.parse(v[2]), last_seen: nowIso() }); return []; }
  if (/^SELECT name, data, last_seen FROM karaoke_players WHERE session_id = \$/.test(q)) return [...D.players.values()].filter(p => p.session_id === v[0]).map(p => ({ name: p.name, data: p.data, last_seen: p.last_seen }));
  // ---------------- companion_tables ----------------
  if (/^DELETE FROM companion_tables WHERE updated_at </.test(q)) return [];
  if (/^SELECT 1 FROM companion_tables WHERE id = \$/.test(q)) return D.tables.has(v[0]) ? [{ '?column?': 1 }] : [];
  if (/^INSERT INTO companion_tables \(id, data, version\) VALUES/.test(q)) { D.tables.set(v[0], { data: JSON.parse(v[1]), version: 1 }); return []; }
  if (/^SELECT data, version FROM companion_tables WHERE id = \$/.test(q)) { const r = D.tables.get(v[0]); return r ? [{ data: JSON.parse(JSON.stringify(r.data)), version: r.version }] : []; }
  if (/^UPDATE companion_tables SET data = \$ ::jsonb, version = \$ , updated_at = now\(\) WHERE id = \$ AND version = \$ RETURNING version/.test(q)) { const r = D.tables.get(v[2]); if (!r || r.version !== v[3]) return []; r.data = JSON.parse(v[0]); r.version = v[1]; return [{ version: r.version }]; }
  throw new Error('mock db: unhandled statement: ' + q);
}
function songRow(s) { return { id: s.id, title: s.title, artist: s.artist, duration_ms: s.duration_ms, provider: s.provider, has_lyrics: !!(s.data && s.data.lyrics), has_cdg: !!(s.data && s.data.media && s.data.media.cdg) }; }
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
export function json(body, status = 200) { return new Response(body == null ? '' : JSON.stringify(body), { status, headers: CORS }); }
export function bad(msg, status = 400) { return json({ error: msg }, status); }
export function noContent() { return new Response(null, { status: 204, headers: CORS }); }
export function preflight() { return new Response(null, { status: 204, headers: CORS }); }
export function requireAdmin(req) { return (req.headers.get('authorization') || '') === 'Bearer admin-ok'; }
export async function ensureSchema() {}
`;

const QR_MOCK = `
// 1x1 PNG stub — enough for <img> tags to load without errors.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export default { toBuffer: async () => PNG };
`;

export async function resolve(specifier, context, next) {
  if (specifier === 'qrcode') return { url: 'mock:qrcode', shortCircuit: true };
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && /\/_shared\/db\.mjs$/.test(new URL(specifier, context.parentURL).pathname)) return { url: 'mock:db', shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url === 'mock:db') return { format: 'module', shortCircuit: true, source: DB_MOCK };
  if (url === 'mock:qrcode') return { format: 'module', shortCircuit: true, source: QR_MOCK };
  return next(url, context);
}
