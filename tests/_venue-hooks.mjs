// NGH-BUILD 2026-09-12m
// tests/_venue-hooks.mjs — in-memory stand-in for venue.mjs's single state row.
// Namespaced URL scheme (vmock:) for the same reason the speedgaming hooks are:
// the loader chains every registered hook, so two mock sets sharing a scheme
// hand each other URLs they cannot resolve.

const DB = `
  globalThis.__venue = globalThis.__venue || { row: { data: {}, version: 1 }, calls: [] };
  const V = globalThis.__venue;
  const norm = t => t.replace(/\\s+/g, ' ').trim();
  export const sql = (strings, ...v) => {
    const text = norm(strings.join('$'));
    V.calls.push(text);
    if (/^CREATE TABLE/i.test(text)) return Promise.resolve([]);
    if (/^INSERT INTO venue_state/i.test(text)) return Promise.resolve([]);
    if (/^SELECT data, version FROM venue_state/i.test(text)) {
      // Deep clone: the handler mutates what it reads and a real driver hands
      // back a fresh object each time.
      return Promise.resolve([{ data: JSON.parse(JSON.stringify(V.row.data)), version: V.row.version }]);
    }
    if (/^UPDATE venue_state SET/i.test(text)) {
      V.row.data = JSON.parse(v[0]); V.row.version = v[1];
      return Promise.resolve([{ version: v[1] }]);
    }
    return Promise.resolve([]);
  };
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  export function json(body, status = 200) { return new Response(body == null ? '' : JSON.stringify(body), { status, headers: CORS }); }
  export function bad(msg, status = 400) { return json({ error: msg }, status); }
  export function noContent() { return new Response(null, { status: 204, headers: CORS }); }
  export function preflight() { return new Response(null, { status: 204, headers: CORS }); }
  export function issueToken() { return 'admin-ok'; }
  export function verifyToken(t) { return t === 'admin-ok'; }
  export function requireAdmin(req) { return (req.headers.get('authorization') || '') === 'Bearer admin-ok'; }
  export async function ensureSchema() {}
`;

const MOCKS = { 'db.mjs': DB };

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const u = new URL(specifier, context.parentURL);
    const m = /\/_shared\/([a-z0-9-]+\.mjs)$/.exec(u.pathname);
    if (m && MOCKS[m[1]]) return { url: 'vmock:' + m[1], shortCircuit: true };
  }
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith('vmock:')) return { format: 'module', shortCircuit: true, source: MOCKS[url.slice(6)] };
  return next(url, context);
}
