// netlify/functions/_shared/db.mjs
// Shared helpers: Neon Postgres connection, schema bootstrap, admin auth, JSON responses.
import { neon } from '@netlify/neon';
import crypto from 'node:crypto';

// @netlify/neon automatically reads the NETLIFY_DATABASE_URL env var that the
// Neon extension provisions for you. No manual connection string needed.
export const sql = neon();

// ---- one-time schema bootstrap (safe to call on every cold start) ----
let _ready = null;
export function ensureSchema() {
  if (_ready) return _ready;
  _ready = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS bookings (
      id            TEXT PRIMARY KEY,
      data          JSONB NOT NULL,
      status        TEXT,
      group_id      TEXT,
      date          DATE,
      created_at    TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS events (
      id            TEXT PRIMARY KEY,
      data          JSONB NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS blackouts (
      id            INTEGER PRIMARY KEY DEFAULT 1,
      data          JSONB NOT NULL DEFAULT '[]'::jsonb
    )`;
    await sql`INSERT INTO blackouts (id, data) VALUES (1, '[]'::jsonb)
              ON CONFLICT (id) DO NOTHING`;
  })();
  return _ready;
}

// ---- responses ----
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};
export function json(body, status = 200) {
  return new Response(body == null ? '' : JSON.stringify(body), { status, headers: CORS });
}
export function noContent() { return new Response('', { status: 204, headers: CORS }); }
export function preflight() { return new Response('', { status: 204, headers: CORS }); }
export function bad(msg, status = 400) { return json({ error: msg }, status); }

// ---- admin auth (stateless HMAC token) ----
// A token is "<expiryMs>.<hmac>". Verified without any session storage.
function secret() {
  return process.env.ADMIN_SECRET || process.env.ADMIN_CODE || 'change-me';
}
export function issueToken(hours = 12) {
  const exp = Date.now() + hours * 3600_000;
  const mac = crypto.createHmac('sha256', secret()).update(String(exp)).digest('hex');
  return `${exp}.${mac}`;
}
export function verifyToken(token) {
  if (!token) return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac) return false;
  if (Date.now() > Number(exp)) return false;
  const good = crypto.createHmac('sha256', secret()).update(String(exp)).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good)); } catch { return false; }
}
export function requireAdmin(req) {
  const h = req.headers.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '');
  return verifyToken(token);
}
