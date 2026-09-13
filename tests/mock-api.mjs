#!/usr/bin/env node
// NGH-BUILD 2026-09-11a
// =====================================================================
// NGH mock API — local dev server for the app pages that talk to the
// Lightspeed / shop / account routes (see docs/NGH-LIGHTSPEED-INTEGRATION.md §5).
//
//   node tests/mock-api.mjs            → http://localhost:8812
//   PORT=8888 node tests/mock-api.mjs  → http://localhost:8888  (ngh-app.js treats
//                                         localhost:8888 as "on site", so relative
//                                         /api calls hit this mock instead of prod)
//
// Serves ../site statically (symlinks followed) and implements, in memory:
//   POST /api/admin-login                 {code}  code = ADMIN_CODE env or "1234"
//   POST /api/account/start|verify|signup|logout, GET/PUT /api/account/me
//        (any email works; the 6-digit code is LOGIN_CODE env or "123456";
//         emails not already known return customer:null → sign-up flow)
//   GET  /api/shop/catalog, GET /api/shop/product/:id, POST /api/shop/sync (admin)
//   POST /api/shop/orders, GET /api/shop/orders (admin), GET /api/shop/orders/:id?t=
//   POST /api/shop/orders/:id/status (admin)
//   GET  /api/lightspeed/status, POST /api/lightspeed/disconnect|replay (admin)
//   GET  /api/lightspeed/connect?token=  → simulates OAuth, bounces back ?connected=1
//   GET  /api/tv/qr.png?data=&s=         placeholder QR-style PNG
//   GET  /api/events                      []
// Plain node:http, zero dependencies.
// =====================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { liveApi, EVENTS } from './mock-live.mjs';
import { companionApi } from './mock-companion.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(__dirname, '..', 'site');
const PORT = Number(process.env.PORT) || 8812;
const ADMIN_CODE = process.env.ADMIN_CODE || '1234';
const LOGIN_CODE = process.env.LOGIN_CODE || '123456';
const QUIET = !!process.env.QUIET;

// ---------------------------------------------------------------- data
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const todayAt = (h, m = 0, dayOffset = 0) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };

const PRODUCTS = [
  { id: 'p_catan', name: 'Catan (5th Edition)', sku: 'CATAN-5E', price: 49.99, priceExTax: 47.38, image: '/brand/crest.png', thumb: '/brand/crest.png', type: 'Board Games', brand: 'Catan Studio', stock: 4, tags: ['strategy', 'family', '3-4 players'],
    description: 'Trade, build and settle the island of Catan. The classic gateway game — 3–4 players, about 90 minutes. Ask a Guru about the 5–6 player extension.' },
  { id: 'p_sv_booster', name: 'Pokémon TCG: Scarlet & Violet Booster Pack', sku: 'PKM-SV-BST', price: 4.99, priceExTax: 4.73, image: '/brand/crest.png', thumb: '/brand/crest.png', type: 'TCG', brand: 'Pokémon', stock: 120, tags: ['pokemon', 'booster'],
    description: '10 cards per pack. Limit 12 per order for pickup — need a box? Message us.' },
  { id: 'p_mtg_cmdr', name: 'Magic: The Gathering — Commander Deck (Bloomburrow)', sku: 'MTG-BLB-CMD', price: 44.99, priceExTax: 42.64, image: '/brand/crest.png', thumb: '/brand/crest.png', type: 'TCG', brand: 'Wizards of the Coast', stock: 2, tags: ['magic', 'commander'],
    description: 'Ready-to-play 100-card Commander deck. Bring it to Commander Night on Thursdays.' },
  { id: 'p_float', name: 'Haven Root Beer Float', sku: 'CAFE-FLOAT', price: 5.5, priceExTax: 5.21, image: null, thumb: null, type: 'Café', brand: 'Haven Café', stock: 0, tags: ['drink', 'dessert'],
    description: 'Sprecher root beer over two scoops of vanilla. Made when you pick up.' },
  { id: 'p_nes_ctrl', name: 'Retro NES-style USB Controller', sku: 'RETRO-NESUSB', price: 19.99, priceExTax: 18.95, image: '/brand/crest.png', thumb: '/brand/crest.png', type: 'Retro', brand: 'Retro-Bit', stock: 5, tags: ['retro', 'accessory'],
    description: 'Wired USB controller for PC, Mac and Raspberry Pi. Works great with the Haven retro cabinets too.' }
];
const TYPES = ['Board Games', 'TCG', 'Café', 'Retro'];
const BRANDS = ['Catan Studio', 'Pokémon', 'Wizards of the Coast', 'Haven Café', 'Retro-Bit'];
let syncedAt = iso(now - 12 * 60000);

const customers = new Map(); // email → customer
customers.set('jordan@example.com', {
  id: '0af1c2d3-1111-4c5e-9a1b-0123456789ab', first_name: 'Jordan', last_name: 'Rivers', email: 'jordan@example.com',
  phone: '(715) 555-0142', mobile: '(715) 555-0142', customer_code: 'NGH-4821', loyalty_balance: 12.5, balance: 0,
  customer_group: 'Haven Regulars', enable_loyalty: true, do_not_email: false
});
const LOYALTY = { ratio: 0.05, currency: 'USD' };

const TAX_RATE = 0.055;
function lines(items) { return items.map((i) => { const pr = PRODUCTS.find((x) => x.id === i.id); return { id: i.id, sku: pr.sku, name: pr.name, qty: i.qty, price: pr.price, lineTotal: Math.round(pr.price * i.qty * 100) / 100 }; }); }
function totals(items) { const subtotal = Math.round(items.reduce((t, l) => t + l.lineTotal, 0) * 100) / 100; return { subtotal, taxIncluded: Math.round((subtotal - subtotal / (1 + TAX_RATE)) * 100) / 100, total: subtotal, taxRate: TAX_RATE }; }
function seedOrder(o) { const items = lines(o.items); return { ...o, items, ...totals(items) }; }
// shop_orders rows as the backend returns them (data JSONB + status). `token` is stripped from public views.
const orders = [
  seedOrder({ id: 'ORD-7F3K', token: 'tok_7f3k', status: 'paid', pay: 'online', paid: true, name: 'Jordan Rivers', email: 'jordan@example.com', phone: '(715) 555-0142', customerId: '0af1c2d3-1111-4c5e-9a1b-0123456789ab',
    items: [{ id: 'p_catan', qty: 1 }, { id: 'p_sv_booster', qty: 3 }], pickupAt: todayAt(18, 30), note: 'Gift — can you bag it?', createdAt: iso(now - 25 * 60000),
    history: [{ status: 'paid', at: iso(now - 24 * 60000) }], sale: { saleId: 'ls_sale_9001', at: iso(now - 24 * 60000) }, paymentPI: 'pi_secret_should_not_leak' }),
  seedOrder({ id: 'ORD-Q8MZ', token: 'tok_q8mz', status: 'parked', pay: 'pickup', paid: false, name: 'Sam Okafor', email: 'sam@example.com', phone: '(715) 555-0199', customerId: null,
    items: [{ id: 'p_nes_ctrl', qty: 2 }], pickupAt: todayAt(19, 15), note: '', createdAt: iso(now - 8 * 60000), history: [], sale: { saleId: 'ls_sale_9002', at: iso(now - 8 * 60000) } })
];

// normalizeSale() rows
const purchases = [
  { id: 'ls_sale_8871', date: iso(now - 3 * 86400000), status: 'CLOSED', invoice: '8871', total: 32.47, totalTax: 1.69, loyalty: 1.62, items: [{ productId: 'p_sv_booster', name: 'Pokémon TCG: Scarlet & Violet Booster Pack', qty: 3, price: 14.97 }, { productId: 'p_float', name: 'Haven Root Beer Float', qty: 1, price: 5.5 }] },
  { id: 'ls_sale_8790', date: iso(now - 12 * 86400000), status: 'CLOSED', invoice: '8790', total: 89.99, totalTax: 4.69, loyalty: 4.5, items: [{ productId: 'p_x', name: 'Ticket to Ride: Europe', qty: 1, price: 89.99 }] },
  { id: 'ls_sale_8612', date: iso(now - 40 * 86400000), status: 'CLOSED', invoice: '8612', total: 12.0, totalTax: 0.63, loyalty: 0.6, items: [{ productId: 'p_y', name: 'Dice set', qty: 2, price: 12 }] }
];
// account.mjs projections of bookings / registrations rows (past ones included, newest first)
const bookings = [
  { id: 'bk_20260919_holt', date: ymdOffset(8), start: '18:00', hours: 2, endLabel: '8:00 PM', rooms: ['The Holt'], status: 'confirmed', payment: 'stripe', feePaid: true, depositPaid: true, costBooking: 120, deposit: 50, birthdayParty: true },
  { id: 'bk_20260801_den', date: ymdOffset(-41), start: '17:00', hours: 3, endLabel: '8:00 PM', rooms: ["Stash's Den"], status: 'confirmed', payment: 'stripe', feePaid: true, depositPaid: true, costBooking: 90, deposit: 50, birthdayParty: false }
];
const registrations = [
  { id: 'reg_a1b2', eventId: 'ev_cmdr', eventTitle: 'Commander Night', occDate: ymdOffset(3), qty: 1, status: 'confirmed', feePaid: true, payment: 'stripe', ticketUrl: '/ticket/T-A1B2C3' }
];
function ymdOffset(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
const deletionRequests = [];   // POST /api/account/delete-request

let lightspeed = {
  connected: true, mode: 'oauth', domain: 'northwoodgamehaven', expires: Math.floor(now / 1000) + 42 * 60, redirectUri: 'https://gamehaven.guru/api/lightspeed/callback',
  scopes: 'customers:read customers:write products:read inventory:read sales:read sales:write payment_types:read taxes:read registers:read outlets:read users:read retailer:read',
  retailer: { name: 'Northwood Game Haven', loyalty_ratio: 0.05, currency: 'USD' }
};
const REFERENCE = {
  outlets: [{ id: '0242ac12-0001-11ec-a5f1-0242ac120002', name: 'Northwood Game Haven — Chippewa Falls', physical_address_1: '115 W Spring St', currency: 'USD' }],
  registers: [
    { id: '0242ac12-0002-11ec-a5f1-0242ac120002', name: 'Front Counter', outlet_id: '0242ac12-0001-11ec-a5f1-0242ac120002' },
    { id: '0242ac12-0003-11ec-a5f1-0242ac120002', name: 'Website', outlet_id: '0242ac12-0001-11ec-a5f1-0242ac120002' }
  ],
  users: [
    { id: '0242ac12-0010-11ec-a5f1-0242ac120002', display_name: 'Stash (owner)', username: 'stash', account_type: 'admin' },
    { id: '0242ac12-0011-11ec-a5f1-0242ac120002', display_name: 'Website', username: 'website', account_type: 'cashier' }
  ],
  payment_types: [
    { id: '0242ac12-0020-11ec-a5f1-0242ac120002', name: 'Lightspeed Payments', payment_type_id: 1 },
    { id: '0242ac12-0021-11ec-a5f1-0242ac120002', name: 'Cash', payment_type_id: 2 },
    { id: '0242ac12-0022-11ec-a5f1-0242ac120002', name: 'Online — Stripe', payment_type_id: 4 },
    { id: '0242ac12-0023-11ec-a5f1-0242ac120002', name: 'On Account', payment_type_id: 3 },
    { id: '0242ac12-0024-11ec-a5f1-0242ac120002', name: 'Loyalty', payment_type_id: 106 }
  ],
  taxes: [
    { id: '0242ac12-0030-11ec-a5f1-0242ac120002', name: 'WI Sales Tax (Chippewa)', rate: 0.055, is_default: true },
    { id: '0242ac12-0031-11ec-a5f1-0242ac120002', name: 'No Tax', rate: 0, is_default: false }
  ],
  retailer: { name: 'Northwood Game Haven', loyaltyRatio: 0.05, currency: 'USD' }
};
// cfg() as /status reports it (env var → camelCase key)
const ENV = {
  clientId: true, clientSecret: true, apiVersion: '2.0',
  outletId: '0242ac12-0001-11ec-a5f1-0242ac120002',
  registerId: '0242ac12-0003-11ec-a5f1-0242ac120002',
  userId: '0242ac12-0011-11ec-a5f1-0242ac120002',
  paymentTypeOnline: '0242ac12-0022-11ec-a5f1-0242ac120002',
  paymentTypeOnAccount: '',
  taxId: '0242ac12-0030-11ec-a5f1-0242ac120002',
  sku: { room: 'NGH-ROOM', deposit: 'NGH-DEPOSIT', karaoke: 'NGH-KARAOKE', event: 'NGH-EVENT', fee: '' }
};
// ls_sales_log rows without a sale id
let unsynced = [
  { source_id: 'reg_z9y8', kind: 'registration', error: 'customer create failed: 422 email invalid', created_at: iso(now - 3 * 3600000) },
  { source_id: 'bk_20260905_holt:deposit', kind: 'booking', error: 'HTTP 500 from register_sales', created_at: iso(now - 26 * 3600000) }
];

// ---------------------------------------------------------------- auth
const adminTokens = new Set();
const sessions = new Map();   // session → email
const pendingCodes = new Map(); // email → code
function issueAdminToken() { const t = (Date.now() + 12 * 3600000) + '.' + crypto.randomBytes(12).toString('hex'); adminTokens.add(t); return t; }
function isAdmin(req, url) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') || '');
  return adminTokens.has(t);
}
function sessionEmail(req) { const s = req.headers['x-ngh-session']; return s && sessions.has(s) ? sessions.get(s) : null; }
function makeSession(email) { const c = customers.get(email); const s = (c ? c.id : 'pending') + '.' + (Date.now() + 30 * 86400000) + '.' + crypto.randomBytes(8).toString('hex'); sessions.set(s, email); return s; }

// ---------------------------------------------------------------- helpers
function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, Object.assign({ 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8'), 'Content-Length': buf.length, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-NGH-Session', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Cache-Control': 'no-store' }, headers));
  res.end(buf);
}
const json = (res, body, status = 200) => send(res, status, body);
const bad = (res, msg, status = 400) => send(res, status, { error: msg });
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({ __invalid: true }); } }); });
}
function orderId() { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 4; i++) s += a[crypto.randomInt(0, a.length)]; return 'ORD-' + s; }
function publicOrder(o) { const { token, paymentPI, checkoutSessionId, ...rest } = o; return rest; }
function log(...a) { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...a); }

// ---- placeholder QR-style PNG (no deps): finder patterns + hash-driven modules ----
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function fakeQrPng(data, size) {
  const N = 29, quiet = 2, modules = N + quiet * 2, scale = Math.max(1, Math.floor(size / modules)), px = modules * scale;
  const hash = crypto.createHash('sha256').update(String(data)).digest();
  const bit = (x, y) => (hash[((y * N + x) >> 3) % hash.length] >> ((y * N + x) & 7)) & 1;
  const finder = (x, y) => { const fx = [0, N - 7].some((ox) => x >= ox && x < ox + 7), fy = [0, N - 7].some((oy) => y >= oy && y < oy + 7); if (!(fx && fy) || (x >= N - 7 && y >= N - 7)) return -1; const lx = x < 7 ? x : x - (N - 7), ly = y < 7 ? y : y - (N - 7); const ring = Math.max(Math.abs(lx - 3), Math.abs(ly - 3)); return ring === 3 || ring <= 1 ? 1 : 0; };
  const dark = [0x13, 0x2a, 0x1d], light = [0xf6, 0xef, 0xdd];
  const raw = Buffer.alloc((px * 3 + 1) * px);
  for (let y = 0; y < px; y++) {
    raw[y * (px * 3 + 1)] = 0;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet;
      let on = 0;
      if (mx >= 0 && my >= 0 && mx < N && my < N) { const f = finder(mx, my); on = f >= 0 ? f : (mx === 6 || my === 6) ? ((mx + my) & 1) ^ 1 : bit(mx, my); }
      const c = on ? dark : light, o = y * (px * 3 + 1) + 1 + x * 3; raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(px, 0); ihdr.writeUInt32BE(px, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- static
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/\\/g, '/');
  if (rel.includes('\0') || rel.split('/').includes('..')) return bad(res, 'Not found', 404);
  let file = path.join(SITE_DIR, rel);
  try {
    let st = fs.statSync(file); // follows symlinks (site/brand → repo/site/brand)
    if (st.isDirectory()) { if (!pathname.endsWith('/')) { res.writeHead(302, { Location: pathname + '/' }); return res.end(); } file = path.join(file, 'index.html'); st = fs.statSync(file); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch {
    // NGH-BUILD 2026-09-12y — Netlify serves /foo from foo.html without any
    // redirect rule, and real URLs depend on that: /privacy and /account-delete
    // are both given out extensionless (the latter goes in the Play Data safety
    // form). The mock 404'd them, so a page could pass its own tests and still
    // be unreachable at the address we publish.
    if (!path.extname(rel)) {
      try {
        const alt = path.join(SITE_DIR, rel + '.html');
        const st = fs.statSync(alt);
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(alt).pipe(res);
      } catch { /* fall through to the 404 below */ }
    }
    // customer-facing site pages that live in the production repo, not here
    send(res, 404, `<!doctype html><meta charset="utf-8"><title>Not in mock</title><body style="font-family:sans-serif;padding:40px;background:#132a1d;color:#f6efdd"><h1>Not served by the mock</h1><p><code>${pathname.replace(/</g, '&lt;')}</code> is not under <code>site/</code>. <a style="color:#e8b84b" href="/app/">Back to the app</a></p>`, { 'Content-Type': 'text/html; charset=utf-8' });
  }
}

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const p = url.pathname.replace(/\/+$/, ''), m = req.method;
  const body = (m === 'POST' || m === 'PUT') ? await readBody(req) : {};
  if (body.__invalid) return bad(res, 'Invalid JSON');

  // ---- the app's live screens (specials / karaoke / trivia / speed gaming / Magic) ----
  const live = liveApi(p, m, url);
  if (live) return json(res, live.body, live.status || 200);

  // ---- Game Companion shared tables (Turn Tracker) ----
  const comp = companionApi(p, m, url, body);
  if (comp) return json(res, comp.body, comp.status || 200);

  // ---- misc used by the app shell ----
  if (p === '/api/events' && m === 'GET') return json(res, EVENTS());
  if (p === '/api/tv/time' && m === 'GET') return json(res, { serverNow: Date.now() });
  if (p === '/api/tv/qr.png' && m === 'GET') {
    const data = String(url.searchParams.get('data') || ''); if (!/^(https?:\/\/|\/)/i.test(data)) return bad(res, 'bad data');
    const size = Math.min(960, Math.max(120, Number(url.searchParams.get('s')) || 420));
    return send(res, 200, fakeQrPng(data, size), { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' });
  }

  // ---- admin login ----
  if (p === '/api/admin-login' && m === 'POST') {
    if (body.code !== ADMIN_CODE) { await new Promise((r) => setTimeout(r, 300)); return bad(res, 'Incorrect code', 401); }
    return json(res, { token: issueAdminToken() });
  }

  // ---- account ----
  if (p === '/api/account/start' && m === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'Invalid email');
    pendingCodes.set(email, LOGIN_CODE);
    log(`login code for ${email}: ${LOGIN_CODE}`);
    return json(res, { ok: true, sent: true });
  }
  if (p === '/api/account/verify' && m === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!pendingCodes.has(email)) return bad(res, 'no code has been sent to that email — request a new one');
    if (String(body.code).replace(/\D/g, '') !== pendingCodes.get(email)) return bad(res, 'incorrect code');
    pendingCodes.delete(email);
    const session = makeSession(email);
    return json(res, { session, customer: customers.get(email) || null, email });
  }
  if (p === '/api/account/logout' && m === 'POST') { const s = req.headers['x-ngh-session']; if (s) sessions.delete(s); return json(res, { ok: true }); }
  // NGH-BUILD 2026-09-12y — deliberately above the session gate below, exactly
  // like the real account.mjs: /account-delete.html has to work signed out.
  if (p === '/api/account/delete-request' && m === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'please enter a valid email address');
    deletionRequests.push({ id: 'del_mock_' + deletionRequests.length, email, name: String(body.name || ''), note: String(body.note || ''), source: req.headers['x-ngh-session'] ? 'app' : 'web' });
    log('deletion request', email);
    return json(res, { ok: true, queued: true, id: 'del_mock_' + (deletionRequests.length - 1) });
  }

  const email = sessionEmail(req) || (body.session && sessions.get(body.session)) || null;
  if (p.startsWith('/api/account/')) {
    if (!email) return bad(res, 'Sign in required', 401);
    if (p === '/api/account/signup' && m === 'POST') {
      if (customers.has(email)) return json(res, { session: makeSession(email), customer: customers.get(email), existing: true });
      if (!body.first_name || !body.last_name) return bad(res, 'first_name and last_name are required');
      const c = { id: crypto.randomUUID(), first_name: String(body.first_name), last_name: String(body.last_name), email, phone: String(body.phone || ''), mobile: String(body.phone || ''), customer_code: 'NGH-' + crypto.randomBytes(2).toString('hex').toUpperCase(), loyalty_balance: 0, balance: 0, customer_group: 'All Customers', enable_loyalty: true, do_not_email: !body.marketing };
      customers.set(email, c); log('created customer', c.customer_code, email);
      return json(res, { session: makeSession(email), customer: c });
    }
    if (p === '/api/account/me' && m === 'GET') {
      const c = customers.get(email);
      if (!c) return json(res, { customer: null, email, loyalty: null, purchases: [], bookings: [], registrations: [], orders: [] });
      const mine = orders.filter((o) => o.email === email).map((o) => ({ id: o.id, status: o.status, createdAt: o.createdAt, total: o.total, pay: o.pay, pickupAt: o.pickupAt, items: o.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price })), token: o.token }));
      return json(res, { customer: c, loyalty: LOYALTY, purchases: c.email === 'jordan@example.com' ? purchases : [], bookings: c.email === 'jordan@example.com' ? bookings : [], registrations: c.email === 'jordan@example.com' ? registrations : [], orders: mine });
    }
    if (p === '/api/account/me' && m === 'PUT') {
      const c = customers.get(email); if (!c) return bad(res, 'No customer', 404);
      ['first_name', 'last_name', 'phone', 'email'].forEach((k) => { if (body[k] != null) c[k] = String(body[k]); });
      if (body.phone != null) c.mobile = String(body.phone);
      if (body.do_not_email != null) c.do_not_email = !!body.do_not_email;
      if (c.email !== email) { customers.delete(email); customers.set(c.email, c); for (const [s, e] of sessions) if (e === email) sessions.set(s, c.email); }
      return json(res, { customer: c });
    }
    return bad(res, 'Not found', 404);
  }

  // ---- shop: catalog ----
  if (p === '/api/shop/catalog' && m === 'GET') return json(res, { products: PRODUCTS, types: TYPES, brands: BRANDS, syncedAt });
  let mm;
  if ((mm = p.match(/^\/api\/shop\/product\/([^/]+)$/)) && m === 'GET') { const pr = PRODUCTS.find((x) => x.id === mm[1]); return pr ? json(res, pr) : bad(res, 'Not found', 404); }
  if (p === '/api/shop/sync' && m === 'POST') { if (!isAdmin(req, url)) return bad(res, 'Unauthorized', 401); syncedAt = iso(Date.now()); return json(res, { ok: true, products: PRODUCTS.length, inventory: PRODUCTS.length, syncedAt }); }

  // ---- shop: orders ----
  if (p === '/api/shop/orders' && m === 'POST') {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return bad(res, 'Cart is empty');
    if (!body.name || !body.email) return bad(res, 'Name and email are required');
    if (!['online', 'pickup'].includes(body.pay)) return bad(res, 'pay must be online or pickup');
    const wanted = [];
    for (const it of items) {
      const pr = PRODUCTS.find((x) => x.id === String(it.id)); const qty = Math.min(20, Math.floor(Number(it.qty) || 0));
      if (!pr) return bad(res, `an item in your cart is no longer available: ${it.id}`); if (qty < 1) return bad(res, 'bad quantity');
      if (pr.stock != null && qty > pr.stock) return bad(res, `only ${pr.stock} left of ${pr.name}`);
      wanted.push({ id: pr.id, qty });
    }
    const cust = email ? customers.get(email) : null;
    const o = seedOrder({ id: orderId(), token: 'tok_' + crypto.randomBytes(6).toString('hex'), status: body.pay === 'online' ? 'new' : 'parked', pay: body.pay, paid: false, name: String(body.name).slice(0, 80), email: String(body.email).toLowerCase(), phone: String(body.phone || '').slice(0, 30), customerId: cust ? cust.id : null, items: wanted, pickupAt: String(body.pickupAt || '').slice(0, 60), note: String(body.note || '').slice(0, 500), createdAt: iso(Date.now()), history: [] });
    if (o.pay === 'pickup') o.sale = { saleId: 'ls_sale_' + Math.floor(9000 + Math.random() * 999), at: iso(Date.now()) };
    orders.push(o); log('new order', o.id, o.pay, `$${o.total}`, o.name);
    const out = { order: { ...publicOrder(o), token: o.token } };
    if (o.pay === 'online') out.checkoutUrl = `/api/mock/stripe?order=${o.id}&t=${o.token}`; // stands in for Stripe Checkout
    return json(res, out);
  }
  if (p === '/api/mock/stripe' && m === 'GET') { // pretend the customer paid at Stripe and the webhook ran
    const oidQ = url.searchParams.get('order') || url.searchParams.get('id') || '', t = url.searchParams.get('t') || '';
    const o = orders.find((x) => x.id === oidQ);
    if (o && o.token === t) { o.status = 'paid'; o.paid = true; o.history.push({ status: 'paid', at: iso(Date.now()) }); o.sale = { saleId: 'ls_sale_' + Math.floor(9000 + Math.random() * 999), at: iso(Date.now()) }; }
    res.writeHead(302, { Location: `/app/shop.html?paid=1&order=${encodeURIComponent(oidQ)}&t=${encodeURIComponent(t)}` }); return res.end();
  }
  if (p === '/api/shop/orders' && m === 'GET') {
    if (!isAdmin(req, url)) return bad(res, 'unauthorized', 401);
    const all = url.searchParams.get('all') === '1';
    const statuses = all ? ['new', 'paid', 'parked', 'ready', 'picked_up', 'canceled'] : String(url.searchParams.get('status') || 'new,paid,parked,ready').split(',');
    const list = orders.filter((o) => statuses.includes(o.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
    return json(res, { orders: list.map(publicOrder), serverNow: Date.now() });
  }
  if ((mm = p.match(/^\/api\/shop\/orders\/([^/]+)$/)) && m === 'GET') {
    const o = orders.find((x) => x.id === mm[1].toUpperCase()); if (!o) return bad(res, 'order not found', 404);
    if (!isAdmin(req, url) && url.searchParams.get('t') !== o.token) return bad(res, 'unauthorized', 401);
    return json(res, { order: publicOrder(o), serverNow: Date.now() });
  }
  if ((mm = p.match(/^\/api\/shop\/orders\/([^/]+)\/status$/)) && m === 'POST') {
    if (!isAdmin(req, url)) return bad(res, 'unauthorized', 401);
    const o = orders.find((x) => x.id === mm[1].toUpperCase()); if (!o) return bad(res, 'order not found', 404);
    if (!['ready', 'picked_up', 'canceled'].includes(body.status)) return bad(res, 'status must be ready | picked_up | canceled');
    o.status = body.status; o.history.push({ status: body.status, at: iso(Date.now()) });
    log('order', o.id, '→', o.status);
    return json(res, { order: publicOrder(o) });
  }

  // ---- lightspeed ----
  if (p === '/api/lightspeed/connect' && m === 'GET') {
    if (!isAdmin(req, url)) return bad(res, 'Unauthorized', 401);
    lightspeed.connected = true; lightspeed.expires = Math.floor(Date.now() / 1000) + 86400; log('lightspeed: simulated OAuth consent');
    res.writeHead(302, { Location: '/app/guru-lightspeed.html?connected=1&domain=northwoodgamehaven' }); return res.end();
  }
  if (p === '/api/lightspeed/callback' && m === 'GET') { res.writeHead(302, { Location: '/app/guru-lightspeed.html?connected=1&domain=northwoodgamehaven' }); return res.end(); }
  if (p.startsWith('/api/lightspeed/') && !isAdmin(req, url)) return bad(res, 'Unauthorized', 401);
  if (p === '/api/lightspeed/status' && m === 'GET') {
    const counts = {}; orders.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; });
    return json(res, { ...lightspeed, expiresInSec: lightspeed.connected ? lightspeed.expires - Math.floor(Date.now() / 1000) : null, env: ENV,
      reference: lightspeed.connected ? REFERENCE : null, referenceError: null, unsynced, catalog: { products: PRODUCTS.length, version: 4211, synced_at: syncedAt }, orders: counts });
  }
  if (p === '/api/lightspeed/unsynced' && m === 'GET') return json(res, { unsynced });
  if (p === '/api/lightspeed/disconnect' && m === 'POST') { lightspeed.connected = false; log('lightspeed: disconnected'); return json(res, { ok: true, connected: false }); }
  if (p === '/api/lightspeed/replay' && m === 'POST') {
    if (!['booking', 'registration', 'order'].includes(body.kind)) return bad(res, 'kind must be booking | registration | order');
    if (!body.id) return bad(res, 'id required');
    const results = [];
    const parts = body.kind === 'booking' ? (body.part ? [String(body.part)] : ['fee', 'deposit']) : [null];
    for (const part of parts) {
      const sid = part ? body.id + ':' + part : String(body.id);
      const i = unsynced.findIndex((u) => u.source_id === sid);
      if (i >= 0) { unsynced.splice(i, 1); results.push({ ...(part ? { part } : {}), ok: true, saleId: 'ls_sale_' + Math.floor(9000 + Math.random() * 999) }); }
      else results.push({ ...(part ? { part } : {}), ok: true, skipped: true, reason: 'already synced', saleId: 'ls_sale_9001' });
    }
    log('replay', body.kind, body.id, JSON.stringify(results));
    return json(res, { results });
  }
  return bad(res, 'Not found: ' + m + ' ' + p, 404);
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/') { res.writeHead(302, { Location: '/app/' }); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) { console.error(e); return bad(res, 'Mock error: ' + e.message, 500); }
});
server.listen(PORT, () => {
  console.log(`NGH mock API + static site on http://localhost:${PORT}/app/`);
  console.log(`  Guru code: ${ADMIN_CODE} · account login code: ${LOGIN_CODE} · existing customer: jordan@example.com (any other email → sign-up)`);
  if (PORT !== 8888) console.log('  NOTE: ngh-app.js only treats localhost:8888 as on-site; run with PORT=8888 so /api calls hit this mock.');
});
