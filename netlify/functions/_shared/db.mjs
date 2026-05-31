// netlify/functions/_shared/db.mjs
// Shared helpers: Neon Postgres connection, schema bootstrap, admin auth, JSON responses.
import { neon } from '@netlify/neon';
import crypto from 'node:crypto';

// @netlify/neon reads NETLIFY_DATABASE_URL automatically, but we pass it
// explicitly too so the connection is unambiguous regardless of how the
// variable was provisioned (extension vs. manually set).
export const sql = neon(process.env.NETLIFY_DATABASE_URL);

// ---- schema bootstrap ----
// Each statement runs independently. We do NOT cache a rejected promise:
// if bootstrap fails, the next request retries instead of being poisoned
// forever by a one-time/transient error.
//
// IMPORTANT: `CREATE TABLE IF NOT EXISTS` is NOT safe under concurrency in
// Postgres — when several serverless functions cold-start at the same instant
// and all try to create the same table, the loser of the race throws a
// duplicate-key error on an internal catalog (codes 23505 / 42P07 / 42710).
// Those errors are harmless (the table now exists), so we swallow them.
let _schemaReady = false;
function isAlreadyExists(e) {
  const c = e && e.code;
  return c === '23505' || c === '42P07' || c === '42710';
}
async function createIfMissing(stmt) {
  try { await stmt; }
  catch (e) { if (!isAlreadyExists(e)) throw e; }
}
export async function ensureSchema() {
  if (_schemaReady) return;
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS bookings (
    id            TEXT PRIMARY KEY,
    data          JSONB NOT NULL,
    status        TEXT,
    group_id      TEXT,
    date          DATE,
    created_at    TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,
    data          JSONB NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS blackouts (
    id            INTEGER PRIMARY KEY DEFAULT 1,
    data          JSONB NOT NULL DEFAULT '[]'::jsonb
  )`);
  await createIfMissing(sql`INSERT INTO blackouts (id, data) VALUES (1, '[]'::jsonb)
            ON CONFLICT (id) DO NOTHING`);
  _schemaReady = true;
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
