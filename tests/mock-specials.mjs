// NGH-BUILD 2026-09-11a
// tests/mock-specials.mjs — local mock for the Specials + Trivia entry pages.
// node:http, zero dependencies. Implements the routes of netlify/functions/specials.mjs
// in memory (same shapes/status codes), plus the bits of the rest of the API the
// two pages touch: /api/admin-login, /api/trivia/active, /api/events, /api/tv/qr.png,
// /api/tv/time. Static-serves site/ (following the brand/img symlinks) and falls
// back to the read-only repo's site/ for pages the app hands off to (trivia-play.html…).
//
//   PORT=8888 node tests/mock-specials.mjs      # 8888 = "netlify dev" origin that ngh-app.js treats as on-site
//   GURU code: "guru"
//   Mock controls:  GET /__mock/trivia?live=1|0   GET /__mock/reset
//
// QR PNGs are real, scannable QRs: the encoder vendored inside npm's
// qrcode-terminal (present on any Node install) + a tiny PNG writer.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(__dirname, '..', 'site');
const FALLBACK_DIR = '/home/claude/repo/site';
const PORT = Number(process.env.PORT) || 8889;
const GURU_CODE = process.env.MOCK_GURU_CODE || 'guru';

// ---------------------------------------------------------------- QR encoder
let QRLib = null;
try {
  const req = createRequire(import.meta.url);
  const nodeRoot = path.dirname(path.dirname(process.execPath));
  const cands = [
    path.join(nodeRoot, 'lib/node_modules/npm/node_modules/qrcode-terminal/vendor/QRCode'),
    '/usr/lib/node_modules/npm/node_modules/qrcode-terminal/vendor/QRCode',
    '/usr/local/lib/node_modules/npm/node_modules/qrcode-terminal/vendor/QRCode'
  ];
  for (const c of cands) { if (fs.existsSync(c + '/index.js')) { QRLib = { QRCode: req(c), ECL: req(c + '/QRErrorCorrectLevel') }; break; } }
} catch { QRLib = null; }

function qrMatrix(text) {
  if (QRLib) {
    const q = new QRLib.QRCode(-1, QRLib.ECL.M);
    q.addData(text); q.make();
    const n = q.getModuleCount();
    const m = [];
    for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(q.isDark(r, c)); m.push(row); }
    return m;
  }
  // Fallback: deterministic pseudo-QR (finder patterns + hashed modules). Not scannable.
  const n = 29, m = [];
  const h = crypto.createHash('sha256').update(text).digest();
  for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(((h[(r * n + c) % 32] >> ((r + c) % 8)) & 1) === 1); m.push(row); }
  const finder = (r0, c0) => { for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) m[r0 + r][c0 + c] = (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)); };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  return m;
}

// Minimal PNG writer (RGB, no alpha, filter 0 per scanline).
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngRGB(width, height, pixelAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}
const DARK = [0x13, 0x2a, 0x1d], LIGHT = [0xf6, 0xef, 0xdd];
function qrPng(text, size) {
  const m = qrMatrix(text), n = m.length, margin = 2;
  const cell = Math.max(1, Math.floor(size / (n + margin * 2)));
  const px = cell * (n + margin * 2);
  return pngRGB(px, px, (x, y) => {
    const r = Math.floor(y / cell) - margin, c = Math.floor(x / cell) - margin;
    return (r >= 0 && c >= 0 && r < n && c < n && m[r][c]) ? DARK : LIGHT;
  });
}

// ---------------------------------------------------------------- state
const SITE_BASE = 'http://localhost:' + PORT;
const state = { specials: [], coupons: new Map(), settings: { foodOrderUrl: 'https://example.com/order' }, triviaLive: true };
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400_000;

function seed() {
  const now = Date.now();
  state.specials = [
    { id: 'SPL-DEMO01', cat: 'food', title: 'Free soda with any pizza', blurb: 'Grab a fountain soda on the house when you order a whole pizza at the counter.', terms: 'One per customer per visit. In-store only. Not valid with other offers.', imageUrl: '/img/rooms/holt-1.jpg', price: 'Free', badge: 'Game night', startsAt: null, endsAt: iso(now + 20 * DAY), redeem: 'claim', claimLimit: 50, active: true, sort: 0, createdAt: iso(now - 3 * DAY), updatedAt: iso(now - 3 * DAY) },
    { id: 'SPL-DEMO02', cat: 'food', title: 'Root beer float night', blurb: 'Vanilla ice cream, cold root beer, big spoon. Every Thursday.', terms: 'Thursdays after 5 PM while supplies last.', imageUrl: '/img/rooms/den-2.jpg', price: '$3.50', badge: 'Thursdays', startsAt: null, endsAt: null, redeem: 'show', claimLimit: null, active: true, sort: 1, createdAt: iso(now - 2 * DAY), updatedAt: iso(now - 2 * DAY) },
    { id: 'SPL-DEMO03', cat: 'retail', title: '20% off one board game', blurb: 'Any in-stock board game, one per coupon. Perfect excuse to finally buy Wingspan.', terms: 'Excludes preorders and sealed TCG product. One coupon per person.', imageUrl: '/img/rooms/depths-1.jpg', price: '20% off', badge: 'App exclusive', startsAt: null, endsAt: iso(now + 10 * DAY), redeem: 'claim', claimLimit: 25, active: true, sort: 0, createdAt: iso(now - 1 * DAY), updatedAt: iso(now - 1 * DAY) },
    { id: 'SPL-DEMO04', cat: 'retail', title: 'Retro cart bundle', blurb: 'Buy two retro cartridges, get the cheapest third one free.', terms: '', imageUrl: '', price: 'B2G1', badge: '', startsAt: null, endsAt: null, redeem: 'show', claimLimit: null, active: true, sort: 1, createdAt: iso(now - 1 * DAY), updatedAt: iso(now - 1 * DAY) },
    { id: 'SPL-DEMO05', cat: 'food', title: 'Scheduled: Halloween cider', blurb: 'Hot spiced cider — not live yet.', terms: '', imageUrl: '', price: '$2', badge: '', startsAt: iso(now + 30 * DAY), endsAt: iso(now + 40 * DAY), redeem: 'show', claimLimit: null, active: true, sort: 5, createdAt: iso(now), updatedAt: iso(now) },
    { id: 'SPL-DEMO06', cat: 'retail', title: 'Hidden: staff pick', blurb: 'Inactive special (admin only).', terms: '', imageUrl: '', price: '', badge: '', startsAt: null, endsAt: null, redeem: 'show', claimLimit: null, active: false, sort: 9, createdAt: iso(now), updatedAt: iso(now) }
  ];
  state.coupons.clear();
  // one already-redeemed coupon so the guru page has something to show
  const cd = { code: 'SPC-DEMO-USED', specialId: 'SPL-DEMO01', title: 'Free soda with any pizza', cat: 'food', name: 'Demo', email: 'demo@example.com', deviceId: 'demo-device', ipHash: 'x', claimedAt: iso(now - DAY), expiresAt: iso(now + 20 * DAY), redeemedAt: iso(now - DAY / 2), redeemedBy: 'guru' };
  state.coupons.set(cd.code, { code: cd.code, special_id: cd.specialId, data: cd, status: 'redeemed', created_at: cd.claimedAt });
}
seed();

// ---------------------------------------------------------------- helpers (mirror specials.mjs)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCouponCode() { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length]; return 'SPC-' + s.slice(0, 4) + '-' + s.slice(4); }
function parseCouponCode(input) {
  let s = String(input || '').trim();
  const m = /\/(?:coupon-special|specials\/coupon)\/([A-Za-z0-9-]+)/.exec(s);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('SPC')) s = s.slice(3);
  if (!/^[A-Z2-9]{8}$/.test(s)) return null;
  return 'SPC-' + s.slice(0, 4) + '-' + s.slice(4);
}
function couponUrl(code) { return SITE_BASE + '/coupon-special/' + code; }
function couponQrPath(code) { return '/api/specials/coupon/' + code + '/qr.png'; }
function couponStatus(row, now) {
  if (row.status === 'redeemed') return 'redeemed';
  if (row.status === 'void') return 'void';
  const exp = row.data.expiresAt ? Date.parse(row.data.expiresAt) : NaN;
  return (!isNaN(exp) && exp < now) ? 'expired' : 'active';
}
function isLiveNow(sp, now) {
  if (sp.active === false) return false;
  const s = sp.startsAt ? Date.parse(sp.startsAt) : NaN, e = sp.endsAt ? Date.parse(sp.endsAt) : NaN;
  if (!isNaN(s) && s > now) return false;
  if (!isNaN(e) && e < now) return false;
  return true;
}
function counts(id) { let claimed = 0, redeemed = 0; for (const c of state.coupons.values()) { if (c.special_id !== id || c.status === 'void') continue; claimed++; if (c.status === 'redeemed') redeemed++; } return { claimed, redeemed }; }
function publicSpecial(sp) {
  return { id: sp.id, cat: sp.cat, title: sp.title, blurb: sp.blurb || '', terms: sp.terms || '', imageUrl: sp.imageUrl || '', price: sp.price || '', badge: sp.badge || '',
    startsAt: sp.startsAt || null, endsAt: sp.endsAt || null, redeem: sp.redeem || 'show', claimLimit: sp.claimLimit == null ? null : sp.claimLimit, claimed: counts(sp.id).claimed };
}
function publicCoupon(row, now) {
  const d = row.data;
  return { code: row.code, specialId: row.special_id, title: d.title, cat: d.cat, status: couponStatus(row, now), claimedAt: d.claimedAt, expiresAt: d.expiresAt || null,
    redeemedAt: d.redeemedAt || null, redeemedBy: d.redeemedBy || null, url: couponUrl(row.code), qrUrl: couponQrPath(row.code) };
}
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const isoOrNull = (v) => { if (v == null || v === '') return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };
function normalizeSpecial(b, existing) {
  const out = Object.assign({}, existing || {});
  const cat = str(b.cat != null ? b.cat : out.cat, 10).toLowerCase();
  if (cat !== 'food' && cat !== 'retail') return { ok: false, error: 'cat must be food or retail' };
  out.cat = cat;
  const title = str(b.title != null ? b.title : out.title, 80);
  if (!title) return { ok: false, error: 'title required' };
  out.title = title;
  for (const k of ['blurb', 'terms', 'price', 'badge']) if (b[k] !== undefined) out[k] = str(b[k], 600);
  if (b.imageUrl !== undefined) out.imageUrl = /^(https?:\/\/|\/)/i.test(str(b.imageUrl, 500)) ? str(b.imageUrl, 500) : '';
  if (b.startsAt !== undefined) out.startsAt = isoOrNull(b.startsAt);
  if (b.endsAt !== undefined) out.endsAt = isoOrNull(b.endsAt);
  if (out.startsAt && out.endsAt && Date.parse(out.endsAt) < Date.parse(out.startsAt)) return { ok: false, error: 'endsAt is before startsAt' };
  const redeem = str(b.redeem != null ? b.redeem : (out.redeem || 'show'), 10).toLowerCase();
  if (redeem !== 'show' && redeem !== 'claim') return { ok: false, error: 'redeem must be show or claim' };
  out.redeem = redeem;
  if (b.claimLimit !== undefined) { const n = parseInt(b.claimLimit, 10); out.claimLimit = (isFinite(n) && n > 0) ? n : null; }
  if (b.active !== undefined) out.active = b.active !== false && b.active !== 'false' && b.active !== 0;
  if (out.active === undefined) out.active = true;
  if (b.sort !== undefined) out.sort = parseInt(b.sort, 10) || 0;
  if (out.sort === undefined) out.sort = 0;
  return { ok: true, data: out };
}
function adminView(sp, now) { return Object.assign({}, sp, counts(sp.id), { live: isLiveNow(sp, now) }); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ---------------------------------------------------------------- sample events (public shape of events.mjs)
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function sampleEvents() {
  const t = new Date(); const today = ymd(t);
  const plus = (n) => { const d = new Date(t); d.setDate(d.getDate() + n); return ymd(d); };
  return [
    { id: 'EVT-TRIVIA1', title: 'Team Trivia Night', date: plus(2), start: '19:00', end: '21:00', allDay: false, recurrence: { freq: 'weekly', count: 8, mode: 'weekday' }, exceptions: [], status: 'live', private: false, tags: ['trivia'] },
    { id: 'EVT-STREAM', title: 'Event Stream: 90s Movie Night', date: plus(4), start: '19:00', end: '21:30', allDay: false, recurrence: null, exceptions: [], status: 'live', private: false },
    { id: 'EVT-REFLEX', title: 'Reflex Rally', date: plus(5), start: '18:30', end: '20:00', allDay: false, recurrence: null, exceptions: [], status: 'live', private: false, tags: [] },
    { id: 'EVT-TAGGED', title: 'Thursday Throwdown', date: plus(3), start: '19:00', end: '21:00', allDay: false, recurrence: null, exceptions: [], status: 'live', private: false, tags: ['trivia', 'league'] },
    { id: 'EVT-OTHER', title: 'Commander Night', date: today, start: '17:00', end: '21:00', allDay: false, recurrence: { freq: 'weekly', count: 20 }, exceptions: [], status: 'live', private: false, tags: ['mtg'] },
    { id: 'EVT-DRAFT', title: 'Trivia (draft)', date: plus(1), start: '19:00', end: '21:00', status: 'draft', private: false },
    { id: 'EVT-PRIV', title: 'Private trivia party', date: plus(1), start: '19:00', end: '21:00', status: 'live', private: true }
  ];
}

// ---------------------------------------------------------------- http plumbing
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS' };
function send(res, status, body, headers) {
  const h = Object.assign({}, CORS, headers || {});
  if (body == null) { res.writeHead(status, h); return res.end(); }
  if (Buffer.isBuffer(body)) { res.writeHead(status, h); return res.end(body); }
  if (typeof body === 'string') { h['Content-Type'] = h['Content-Type'] || 'text/html; charset=utf-8'; res.writeHead(status, h); return res.end(body); }
  h['Content-Type'] = 'application/json'; res.writeHead(status, h); res.end(JSON.stringify(body));
}
const json = (res, body, status = 200) => send(res, status, body);
const bad = (res, msg, status = 400) => json(res, { error: msg }, status);
function readJson(req) { return new Promise((resolve, reject) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } }); req.on('error', reject); }); }
const tokens = new Set();
function isAdmin(req) { const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); return tokens.has(t); }
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.txt': 'text/plain' };
function serveStatic(res, urlPath) {
  const clean = path.posix.normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  for (const root of [SITE_DIR, FALLBACK_DIR]) {
    let p = path.join(root, clean);
    if (!p.startsWith(root)) continue;
    try {
      let st = fs.statSync(p); // follows symlinks
      if (st.isDirectory()) { if (!clean.endsWith('/')) { res.writeHead(301, { Location: clean + '/' }); return res.end(); } p = path.join(p, 'index.html'); st = fs.statSync(p); }
      if (!st.isFile()) continue;
      const data = fs.readFileSync(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch { /* try next root */ }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found: ' + clean);
}

// ---------------------------------------------------------------- specials API
async function specialsApi(req, res, parts, url) {
  const now = Date.now();
  const head = parts[0] || '';
  if (req.method === 'GET' && !head) {
    const cat = str(url.searchParams.get('cat'), 10).toLowerCase();
    return json(res, state.specials.filter(sp => isLiveNow(sp, now) && (!cat || sp.cat === cat)).sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(publicSpecial));
  }
  if (head === 'settings') {
    if (req.method === 'GET') return json(res, { foodOrderUrl: state.settings.foodOrderUrl || '' });
    if (req.method === 'PUT') {
      if (!isAdmin(req)) return bad(res, 'unauthorized', 401);
      const b = await readJson(req); const raw = str(b.foodOrderUrl, 500);
      if (raw && !/^https?:\/\//i.test(raw)) return bad(res, 'foodOrderUrl must be an absolute http(s) URL (or empty to hide the button)');
      state.settings.foodOrderUrl = raw; return json(res, { foodOrderUrl: raw });
    }
    return bad(res, 'Method not allowed', 405);
  }
  if (req.method === 'GET' && head === 'coupon' && parts[1]) {
    const code = parseCouponCode(parts[1]); const sub = parts[2] || '';
    const c = code && state.coupons.get(code);
    if (!c) return sub ? bad(res, 'not found', 404) : send(res, 404, couponPage(null, null, code ? 'That coupon no longer exists.' : 'That coupon link is not valid.'));
    if (sub === 'status') return json(res, { code: c.code, status: couponStatus(c, now), title: c.data.title, expiresAt: c.data.expiresAt || null, redeemedAt: c.data.redeemedAt || null });
    if (sub === 'qr.png') return send(res, 200, qrPng(couponUrl(c.code), 480), { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    if (sub) return bad(res, 'not found', 404);
    return send(res, 200, couponPage(c, state.specials.find(s => s.id === c.special_id) || null));
  }
  if (req.method === 'POST' && head && parts[1] === 'claim') {
    let b; try { b = await readJson(req); } catch { return bad(res, 'Invalid JSON'); }
    if (b.website) return json(res, { ok: true });
    const sp = state.specials.find(s => s.id === head);
    if (!sp || !isLiveNow(sp, now)) return bad(res, 'That special is not available right now.', 404);
    if (sp.redeem !== 'claim') return bad(res, 'This special does not need a coupon — just show it at the counter.');
    const email = str(b.email, 120).toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'Please enter a valid email address.');
    const deviceId = str(b.deviceId, 64); if (!deviceId) return bad(res, 'deviceId required');
    const ipHash = crypto.createHash('sha256').update(ipOf(req)).digest('hex').slice(0, 16);
    let recent = 0; for (const c of state.coupons.values()) if (c.data.ipHash === ipHash && Date.parse(c.created_at) > now - 3600_000) recent++;
    if (recent >= 10) return bad(res, 'Too many coupon claims from this connection — try again in an hour.', 429);
    const dupes = [...state.coupons.values()].filter(c => c.special_id === sp.id && c.status !== 'void' && (c.data.deviceId === deviceId || String(c.data.email).toLowerCase() === email));
    const mine = dupes.find(c => c.data.deviceId === deviceId);
    if (mine) return json(res, Object.assign(publicCoupon(mine, now), { ok: true, existing: true }));
    if (dupes.length) return json(res, { error: 'That email already claimed this special. Open the coupon on the phone you used, or ask a Guru.', code: 'claimed' }, 409);
    if (sp.claimLimit && counts(sp.id).claimed >= sp.claimLimit) return json(res, { error: 'All of these have been claimed — sorry!', code: 'soldout' }, 409);
    const code = newCouponCode(), claimedAt = iso(now), expiresAt = sp.endsAt || iso(now + 30 * DAY);
    const data = { code, specialId: sp.id, title: sp.title, cat: sp.cat, name: str(b.name, 80), email, deviceId, ipHash, claimedAt, expiresAt };
    state.coupons.set(code, { code, special_id: sp.id, data, status: 'active', created_at: claimedAt });
    return json(res, { ok: true, code, specialId: sp.id, title: sp.title, cat: sp.cat, status: 'active', claimedAt, expiresAt, url: couponUrl(code), qrUrl: couponQrPath(code) }, 201);
  }
  if (!isAdmin(req)) return bad(res, 'unauthorized', 401);
  if (req.method === 'POST' && head === 'redeem') {
    let b; try { b = await readJson(req); } catch { return bad(res, 'Invalid JSON'); }
    const code = parseCouponCode(b.code);
    if (!code) return bad(res, 'Not a valid coupon code.', 404);
    const c = state.coupons.get(code);
    if (!c) return bad(res, 'Coupon not found.', 404);
    const sp = state.specials.find(s => s.id === c.special_id);
    const base = { coupon: publicCoupon(c, now), special: sp ? publicSpecial(sp) : null };
    const st = couponStatus(c, now);
    if (st === 'redeemed') return json(res, Object.assign(base, { ok: false, status: 'redeemed', error: 'ALREADY REDEEMED' }), 409);
    if (st === 'expired') return json(res, Object.assign(base, { ok: false, status: 'expired', error: 'EXPIRED' }), 409);
    c.status = 'redeemed'; c.data.redeemedAt = iso(now); c.data.redeemedBy = str(b.by || 'guru', 40);
    return json(res, Object.assign(base, { ok: true, status: 'redeemed', coupon: publicCoupon(c, now) }));
  }
  if (head === 'admin') {
    const id = parts[1] || '';
    if (req.method === 'GET' && !id) return json(res, state.specials.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(sp => adminView(sp, now)));
    if (req.method === 'POST' && !id) {
      let b; try { b = await readJson(req); } catch { return bad(res, 'Invalid JSON'); }
      const n = normalizeSpecial(b, null); if (!n.ok) return bad(res, n.error);
      const sp = n.data; sp.id = 'SPL-' + crypto.randomBytes(3).toString('hex').toUpperCase(); sp.createdAt = sp.updatedAt = iso(now);
      state.specials.push(sp); return json(res, adminView(sp, now), 201);
    }
    if (req.method === 'PUT' && id) {
      let b; try { b = await readJson(req); } catch { return bad(res, 'Invalid JSON'); }
      const i = state.specials.findIndex(s => s.id === id); if (i < 0) return bad(res, 'not found', 404);
      const n = normalizeSpecial(b, state.specials[i]); if (!n.ok) return bad(res, n.error);
      n.data.id = id; n.data.updatedAt = iso(now); state.specials[i] = n.data; return json(res, adminView(n.data, now));
    }
    if (req.method === 'DELETE' && id) { state.specials = state.specials.filter(s => s.id !== id); return send(res, 204, null); }
    return bad(res, 'not found', 404);
  }
  return bad(res, 'not found', 404);
}

function couponPage(c, sp, err) {
  const ok = !!c, d = ok ? c.data : {};
  const status = ok ? couponStatus(c, Date.now()) : 'invalid';
  const body = ok
    ? (sp && sp.imageUrl ? '<div class="img"><img src="' + esc(sp.imageUrl) + '" alt=""></div>' : '') +
      '<div class="qr"><img src="' + esc(couponQrPath(c.code)) + '" alt="coupon QR"></div><div class="code">' + esc(c.code) + '</div><div class="lbl">' + esc(d.title) + '</div>' +
      (status === 'active' ? '<div class="live">Show this at the counter — one-time use</div>' : '<div class="used">' + esc(status.toUpperCase()) + '</div>')
    : '<div class="used">' + esc(err) + '</div>';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NGH · Coupon</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#132a1d;color:#f6efdd;font-family:Nunito,sans-serif;text-align:center}.card{background:#1e3d2b;border:3px solid #c9973a;border-radius:18px;padding:22px 20px;max-width:380px;width:92%}.img img{width:100%;max-height:180px;object-fit:cover;border-radius:12px;margin-bottom:12px}.qr img{width:220px;height:220px;background:#f6efdd;padding:8px;border-radius:12px}.code{font-size:1.35rem;letter-spacing:.12em;margin-top:10px}.lbl{font-size:1.3rem;color:#e8b84b;margin-top:10px}.live{margin-top:14px;background:#2e7d32;color:#fff;border-radius:10px;padding:10px;font-weight:800}.used{margin-top:14px;background:#7a2431;color:#fff;border-radius:10px;padding:10px;font-weight:800}</style></head>' +
    '<body><div class="card"><div class="brand">Northwood Game Haven</div>' + body + '</div></body></html>';
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, SITE_BASE);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return send(res, 204, null);

    // mock controls
    if (p === '/__mock/trivia') { if (url.searchParams.has('live')) state.triviaLive = url.searchParams.get('live') === '1'; return json(res, { triviaLive: state.triviaLive }); }
    if (p === '/__mock/reset') { seed(); state.triviaLive = true; return json(res, { ok: true }); }
    if (p === '/__mock/coupons') return json(res, [...state.coupons.values()].map(c => publicCoupon(c, Date.now())));

    // API
    if (p === '/api/admin-login' && req.method === 'POST') {
      const b = await readJson(req);
      if (!b || b.code !== GURU_CODE) return bad(res, 'Incorrect code', 401);
      const t = (Date.now() + 12 * 3600_000) + '.' + crypto.randomBytes(16).toString('hex'); tokens.add(t); return json(res, { token: t });
    }
    if (p === '/api/specials' || p.startsWith('/api/specials/')) {
      const parts = p.replace(/^\/api\/specials/, '').split('/').filter(Boolean).map(decodeURIComponent);
      return await specialsApi(req, res, parts, url);
    }
    if (p.startsWith('/coupon-special/')) { const parts = ['coupon', ...p.replace(/^\/coupon-special\//, '').split('/').filter(Boolean)]; return await specialsApi(req, res, parts, url); }
    if (p === '/api/trivia/active') {
      if (!state.triviaLive) return json(res, { id: null, error: 'no active game' }, 404);
      return json(res, { id: 'TRV-DEMO1234', gameId: 'TRV-DEMO1234', kind: 'trivia', phase: 'lobby', v: 3, serverNow: Date.now() });
    }
    if (p === '/api/trivia/time' || p === '/api/tv/time') return json(res, { serverNow: Date.now() });
    if (p.startsWith('/api/trivia/games/') && p.endsWith('/state')) {
      return json(res, { v: 3, version: 3, serverNow: Date.now(), phase: 'lobby', kind: 'trivia', title: 'Demo Trivia', teams: [], joinUrl: SITE_BASE + '/trivia-play.html?game=TRV-DEMO1234' });
    }
    if (p.startsWith('/api/trivia/games/') && p.endsWith('/heartbeat')) return json(res, { ok: true });
    if (p === '/api/events' && req.method === 'GET') return json(res, sampleEvents());
    if (p === '/api/tv/qr.png') {
      const data = String(url.searchParams.get('data') || '/').slice(0, 300);
      const size = Math.min(960, Math.max(120, Number(url.searchParams.get('s')) || 420));
      return send(res, 200, qrPng(data.startsWith('/') ? SITE_BASE + data : data, size), { 'Content-Type': 'image/png' });
    }
    if (p.startsWith('/api/')) return bad(res, 'not found (mock): ' + p, 404);

    // static
    return serveStatic(res, p);
  } catch (e) {
    console.error('[mock] error', e);
    return bad(res, 'mock error: ' + (e && e.message), 500);
  }
});

server.on('error', (e) => { console.error('[mock] listen failed on :' + PORT, e.code || e.message); process.exit(2); });
server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock] specials mock on http://localhost:' + PORT + '  (site: ' + SITE_DIR + ', fallback: ' + FALLBACK_DIR + ', qr: ' + (QRLib ? 'real' : 'pseudo') + ')');
});
