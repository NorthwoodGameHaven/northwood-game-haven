// NGH-BUILD 2026-09-12l
// tests/_speedgaming-hooks.mjs — module hooks for speedgaming.mjs.
//
// Replaces _shared/db.mjs with a REAL in-memory table rather than a stub that
// echoes canned rows. `speedgaming_sessions` here honours the version column
// the same way Postgres does — an UPDATE whose `WHERE version = expected` no
// longer matches affects zero rows — so mutate()'s optimistic-concurrency retry
// loop is genuinely exercised instead of being assumed to work. Two Gurus
// tapping at once is a thing that will actually happen on the night.
//
// `qrcode` is stubbed because the real package isn't installed in this checkout
// and a PNG isn't what any of these tests are about.
//
// The `sgmock:` URL scheme is namespaced deliberately. tests/_mock-hooks.mjs
// uses `mock:`, and if both hook sets are ever registered in one process the
// loader chains them — each would be handed the other's URLs and return an
// undefined source. Isolation between suites is the real fix (the test runner
// gives each FILE its own process); this just means a mistake is inert.

const DB = `
  globalThis.__sg = globalThis.__sg || {};
  const S = globalThis.__sg;
  S.rows = S.rows || new Map();          // id -> { id, data, version, status, created_at, updated_at }
  S.calls = S.calls || [];
  S.clock = S.clock || { t: 0 };         // bumped so ORDER BY updated_at is stable
  S.beforeUpdate = S.beforeUpdate || null;  // test hook: simulate a racing writer

  const norm = t => t.replace(/\\s+/g, ' ').trim();

  export const sql = (strings, ...v) => {
    const text = norm(strings.join('$'));
    S.calls.push(text);

    if (/^CREATE TABLE/i.test(text)) return Promise.resolve([]);

    if (/^INSERT INTO speedgaming_sessions/i.test(text)) {
      // Only id and data are interpolated — version and status are SQL
      // literals in the statement, so they are NOT in the values array.
      const [id, data] = v;
      if (S.rows.has(id)) { const e = new Error('duplicate key'); e.code = '23505'; return Promise.reject(e); }
      S.rows.set(id, { id, data: JSON.parse(data), version: 1, status: 'lobby', created_at: ++S.clock.t, updated_at: S.clock.t });
      return Promise.resolve([{ id }]);
    }

    if (/^SELECT data, version, status FROM speedgaming_sessions WHERE id/i.test(text)) {
      const r = S.rows.get(v[0]);
      // Deep clone: the handler mutates what it reads, and a real driver hands
      // back a fresh object every time. Sharing it would hide write bugs.
      return Promise.resolve(r ? [{ data: JSON.parse(JSON.stringify(r.data)), version: r.version, status: r.status }] : []);
    }

    if (/^UPDATE speedgaming_sessions SET/i.test(text)) {
      const [data, version, status, id, expected] = v;
      if (S.beforeUpdate) { const f = S.beforeUpdate; S.beforeUpdate = null; f(S); }
      const r = S.rows.get(id);
      if (!r || r.version !== expected) return Promise.resolve([]);      // lost the race
      r.data = JSON.parse(data); r.version = version; r.status = status; r.updated_at = ++S.clock.t;
      return Promise.resolve([{ version }]);
    }

    if (/^SELECT id, data, version, status FROM speedgaming_sessions WHERE status IN/i.test(text)) {
      const live = [...S.rows.values()].filter(r => r.status === 'lobby' || r.status === 'live')
        .sort((a, b) => b.updated_at - a.updated_at);
      return Promise.resolve(live.slice(0, 1).map(r => ({ id: r.id, data: r.data, version: r.version, status: r.status })));
    }

    if (/^SELECT id, data, status, created_at, updated_at FROM speedgaming_sessions/i.test(text)) {
      return Promise.resolve([...S.rows.values()].sort((a, b) => b.created_at - a.created_at).slice(0, 25));
    }

    if (/^DELETE FROM speedgaming_sessions/i.test(text)) { S.rows.delete(v[0]); return Promise.resolve([]); }

    return Promise.resolve([]);
  };

  export async function ensureSchema() {}
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  export function json(body, status = 200) { return new Response(body == null ? '' : JSON.stringify(body), { status, headers: CORS }); }
  export function bad(msg, status = 400) { return json({ error: msg }, status); }
  export function noContent() { return new Response(null, { status: 204, headers: CORS }); }
  export function preflight() { return new Response(null, { status: 204, headers: CORS }); }
  export function issueToken() { return 'admin-ok'; }
  export function verifyToken(t) { return t === 'admin-ok'; }
  export function requireAdmin(req) { return (req.headers.get('authorization') || '') === 'Bearer admin-ok'; }
`;

const QRCODE = `
  export default { toBuffer: async () => Buffer.from('PNG-STUB') };
  export const toBuffer = async () => Buffer.from('PNG-STUB');
`;

const MOCKS = { 'db.mjs': DB, 'qrcode': QRCODE };

export async function resolve(specifier, context, next) {
  if (specifier === 'qrcode') return { url: 'sgmock:qrcode', shortCircuit: true };
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const u = new URL(specifier, context.parentURL);
    const m = /\/_shared\/([a-z0-9-]+\.mjs)$/.exec(u.pathname);
    if (m && MOCKS[m[1]]) return { url: 'sgmock:' + m[1], shortCircuit: true };
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('sgmock:')) return { format: 'module', shortCircuit: true, source: MOCKS[url.slice(7)] };
  return next(url, context);
}
