// netlify/functions/specials.mjs — NGH-BUILD 2026-09-11a Specials & coupon wallet
// Food & Drink / Retail specials for the NGH app (site/app/specials.html) with
// one-time coupons that Gurus redeem at the counter (guru-specials.html).
// Same idea as the Box Office promo coupons: a coupon is a row keyed by an
// unguessable code; the QR encodes the public coupon page URL so a scan on the
// Guru side resolves straight back to the code.
//
// Routes (via /api/specials/* alias in netlify.toml; /coupon-special/* → coupon page):
//   GET    /specials?cat=food|retail        PUBLIC  active specials (now within startsAt/endsAt, or open-ended)
//   GET    /specials/settings               PUBLIC  {foodOrderUrl}
//   PUT    /specials/settings               ADMIN   {foodOrderUrl}  (empty = hide the "Order food" button)
//   POST   /specials/:id/claim              PUBLIC  {name?, email, deviceId} → {code, qrUrl, expiresAt}
//                                                   one claim per email+special and per deviceId+special;
//                                                   respects claimLimit; 10 claims/hour per IP
//   GET    /specials/coupon/:code           PUBLIC  branded HTML coupon page
//   GET    /specials/coupon/:code/qr.png    PUBLIC  QR PNG (dark #132a1d on cream #f6efdd)
//   GET    /specials/coupon/:code/status    PUBLIC  {status:'active'|'redeemed'|'expired', title}
//   POST   /specials/redeem                 ADMIN   {code, by?} → marks redeemed (409 if already / expired); returns coupon + special
//   GET    /specials/admin                  ADMIN   all specials incl. inactive/scheduled + claim/redeem counts
//   POST   /specials/admin                  ADMIN   create special
//   PUT    /specials/admin/:id              ADMIN   update special
//   DELETE /specials/admin/:id              ADMIN   delete special (its coupons are kept for the audit trail)
//
// Tables (created on first call, createIfMissing pattern from tv.mjs; nothing is seeded):
//   specials          (id TEXT PK, data JSONB, created_at)
//   special_coupons   (code TEXT PK, special_id TEXT, data JSONB, status TEXT, created_at)
//   specials_settings (id INT PK DEFAULT 1, data JSONB)
//
// Special data shape:
//   { id, cat:'food'|'retail', title, blurb, terms, imageUrl, price, badge,
//     startsAt, endsAt (ISO or null), redeem:'show'|'claim', claimLimit (int|null),
//     active:bool, sort:int, createdAt, updatedAt }
// Coupon data shape:
//   { code, specialId, title, cat, name, email, deviceId, ipHash, claimedAt, expiresAt, redeemedAt?, redeemedBy? }
//   expiresAt = the special's endsAt when set, else claimedAt + 30 days.
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import { sql, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import { siteBase } from './_shared/ticket.mjs';

// ---- schema ----
let _ready = false;
function isAlreadyExists(e) {
  const c = e && e.code;
  return c === '23505' || c === '42P07' || c === '42710';
}
async function createIfMissing(stmt) {
  try { await stmt; }
  catch (e) { if (!isAlreadyExists(e)) throw e; }
}
async function ensureSpecialsSchema() {
  if (_ready) return;
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS specials (
    id          TEXT PRIMARY KEY,
    data        JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS special_coupons (
    code        TEXT PRIMARY KEY,
    special_id  TEXT NOT NULL,
    data        JSONB NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE INDEX IF NOT EXISTS special_coupons_special_idx ON special_coupons (special_id)`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS specials_settings (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  _ready = true;
}

// ---- constants / helpers ----
const CATS = new Set(['food', 'retail']);
const REDEEM = new Set(['show', 'claim']);
const CLAIMS_PER_HOUR_PER_IP = 10;
const DEFAULT_COUPON_DAYS = 30;
// Coupon code alphabet: no 0/O/1/I to keep typed entry at the counter painless.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function str(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function urlish(v, n) { const u = str(v, n); return /^(https?:\/\/|\/)/i.test(u) ? u : ''; }
function isoOrNull(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function newSpecialId() {
  return 'SPL-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
}
function newCouponCode() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return 'SPC-' + s.slice(0, 4) + '-' + s.slice(4);
}
// Accepts a bare code (any case, with or without dashes), a coupon page URL,
// or a QR PNG / status URL, and returns the canonical code or null.
export function parseCouponCode(input) {
  let s = String(input || '').trim();
  const m = /\/(?:coupon-special|specials\/coupon)\/([A-Za-z0-9-]+)/.exec(s);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('SPC')) s = s.slice(3);
  if (!/^[A-Z2-9]{8}$/.test(s)) return null;
  return 'SPC-' + s.slice(0, 4) + '-' + s.slice(4);
}
function couponUrl(code) { return siteBase() + '/coupon-special/' + code; }
function couponQrPath(code) { return '/api/specials/coupon/' + code + '/qr.png'; }
function clientIpHash(req) {
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || '';
  return crypto.createHash('sha256').update(ip.split(',')[0].trim()).digest('hex').slice(0, 16);
}

// Effective status: a stored 'active' coupon reads as 'expired' once past expiresAt.
function couponStatus(row, now) {
  if (row.status === 'redeemed') return 'redeemed';
  if (row.status === 'void') return 'void';
  const exp = row.data && row.data.expiresAt ? Date.parse(row.data.expiresAt) : NaN;
  if (!isNaN(exp) && exp < (now || Date.now())) return 'expired';
  return 'active';
}
function isLiveNow(sp, now) {
  if (sp.active === false) return false;
  const s = sp.startsAt ? Date.parse(sp.startsAt) : NaN;
  const e = sp.endsAt ? Date.parse(sp.endsAt) : NaN;
  if (!isNaN(s) && s > now) return false;
  if (!isNaN(e) && e < now) return false;
  return true;
}
function publicSpecial(sp, claimed) {
  return {
    id: sp.id, cat: sp.cat, title: sp.title, blurb: sp.blurb || '', terms: sp.terms || '',
    imageUrl: sp.imageUrl || '', price: sp.price || '', badge: sp.badge || '',
    startsAt: sp.startsAt || null, endsAt: sp.endsAt || null,
    redeem: sp.redeem || 'show', claimLimit: sp.claimLimit == null ? null : sp.claimLimit,
    claimed: Number(claimed) || 0
  };
}
function publicCoupon(row, now) {
  const d = row.data || {};
  return {
    code: row.code, specialId: row.special_id, title: d.title || '', cat: d.cat || '',
    status: couponStatus(row, now), claimedAt: d.claimedAt || null, expiresAt: d.expiresAt || null,
    redeemedAt: d.redeemedAt || null, redeemedBy: d.redeemedBy || null,
    url: couponUrl(row.code), qrUrl: couponQrPath(row.code)
  };
}

// Validate + normalize an incoming special (create or update). Returns {ok, data|error}.
function normalizeSpecial(body, existing) {
  const b = body || {};
  const out = Object.assign({}, existing || {});
  const cat = str(b.cat != null ? b.cat : out.cat, 10).toLowerCase();
  if (!CATS.has(cat)) return { ok: false, error: 'cat must be food or retail' };
  out.cat = cat;
  const title = str(b.title != null ? b.title : out.title, 80);
  if (!title) return { ok: false, error: 'title required' };
  out.title = title;
  if (b.blurb !== undefined) out.blurb = str(b.blurb, 300);
  if (b.terms !== undefined) out.terms = str(b.terms, 600);
  if (b.imageUrl !== undefined) out.imageUrl = urlish(b.imageUrl, 500);
  if (b.price !== undefined) out.price = str(b.price, 24);
  if (b.badge !== undefined) out.badge = str(b.badge, 30);
  if (b.startsAt !== undefined) out.startsAt = isoOrNull(b.startsAt);
  if (b.endsAt !== undefined) out.endsAt = isoOrNull(b.endsAt);
  if (out.startsAt && out.endsAt && Date.parse(out.endsAt) < Date.parse(out.startsAt)) return { ok: false, error: 'endsAt is before startsAt' };
  const redeem = str(b.redeem != null ? b.redeem : (out.redeem || 'show'), 10).toLowerCase();
  if (!REDEEM.has(redeem)) return { ok: false, error: 'redeem must be show or claim' };
  out.redeem = redeem;
  if (b.claimLimit !== undefined) {
    const n = parseInt(b.claimLimit, 10);
    out.claimLimit = (isFinite(n) && n > 0) ? Math.min(100000, n) : null;
  }
  if (b.active !== undefined) out.active = b.active !== false && b.active !== 'false' && b.active !== 0;
  if (out.active === undefined) out.active = true;
  if (b.sort !== undefined) out.sort = Math.max(-9999, Math.min(9999, parseInt(b.sort, 10) || 0));
  if (out.sort === undefined) out.sort = 0;
  return { ok: true, data: out };
}

async function loadSpecial(id) {
  const rows = await sql`SELECT id, data FROM specials WHERE id = ${id}`;
  return rows.length ? rows[0].data : null;
}
async function claimCounts() {
  const rows = await sql`SELECT special_id,
      COUNT(*) FILTER (WHERE status <> 'void')::int AS claimed,
      COUNT(*) FILTER (WHERE status = 'redeemed')::int AS redeemed
    FROM special_coupons GROUP BY special_id`;
  const out = {};
  rows.forEach(r => { out[r.special_id] = { claimed: r.claimed, redeemed: r.redeemed }; });
  return out;
}
async function loadSettings() {
  const rows = await sql`SELECT data FROM specials_settings WHERE id = 1`;
  return rows.length && rows[0].data ? rows[0].data : {};
}

export default async (req) => {
  try { return await handler(req); }
  catch (e) {
    console.error('[specials] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

async function handler(req) {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSpecialsSchema();
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/specials/, '').split('/').filter(Boolean).map(p => decodeURIComponent(p));
  const head = parts[0] || '';
  const now = Date.now();

  // ================= PUBLIC: active specials =================
  if (req.method === 'GET' && !head) {
    const cat = str(url.searchParams.get('cat'), 10).toLowerCase();
    const rows = await sql`SELECT id, data FROM specials ORDER BY created_at ASC`;
    const counts = await claimCounts();
    const list = rows.map(r => r.data)
      .filter(sp => sp && isLiveNow(sp, now) && (!cat || sp.cat === cat))
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .map(sp => publicSpecial(sp, counts[sp.id] ? counts[sp.id].claimed : 0));
    return json(list);
  }

  // ================= settings =================
  if (head === 'settings') {
    if (req.method === 'GET') {
      const s = await loadSettings();
      return json({ foodOrderUrl: s.foodOrderUrl || '' });
    }
    if (req.method === 'PUT') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const cur = await loadSettings();
      const raw = str(b.foodOrderUrl, 500);
      if (raw && !/^https?:\/\//i.test(raw)) return bad('foodOrderUrl must be an absolute http(s) URL (or empty to hide the button)');
      const next = Object.assign({}, cur, { foodOrderUrl: raw, updatedAt: new Date().toISOString() });
      await sql`INSERT INTO specials_settings (id, data) VALUES (1, ${JSON.stringify(next)}::jsonb)
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
      return json({ foodOrderUrl: next.foodOrderUrl });
    }
    return bad('Method not allowed', 405);
  }

  // ================= PUBLIC: coupon page / QR / status =================
  if (req.method === 'GET' && head === 'coupon' && parts[1]) {
    const code = parseCouponCode(parts[1]);
    const sub = parts[2] || '';
    if (!code) return sub ? bad('not found', 404) : couponPage(null, null, 'That coupon link is not valid.');
    const rows = await sql`SELECT code, special_id, data, status, created_at FROM special_coupons WHERE code = ${code}`;
    if (!rows.length) return sub ? bad('not found', 404) : couponPage(null, null, 'That coupon no longer exists.');
    const c = rows[0];
    if (sub === 'status') {
      return json({ code: c.code, status: couponStatus(c, now), title: (c.data && c.data.title) || '',
        expiresAt: (c.data && c.data.expiresAt) || null, redeemedAt: (c.data && c.data.redeemedAt) || null });
    }
    if (sub === 'qr.png') {
      const png = await QRCode.toBuffer(couponUrl(c.code), { type: 'png', width: 480, margin: 2, color: { dark: '#132a1d', light: '#f6efdd' } });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
    }
    if (sub) return bad('not found', 404);
    const sp = await loadSpecial(c.special_id);
    return couponPage(c, sp);
  }

  // ================= PUBLIC: claim a coupon =================
  if (req.method === 'POST' && head && parts[1] === 'claim') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    if (b.website) return json({ ok: true }); // honeypot: pretend success
    const sp = await loadSpecial(head);
    if (!sp || !isLiveNow(sp, now)) return bad('That special is not available right now.', 404);
    if ((sp.redeem || 'show') !== 'claim') return bad('This special does not need a coupon — just show it at the counter.');
    const email = str(b.email, 120).toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('Please enter a valid email address.');
    const name = str(b.name, 80);
    const deviceId = str(b.deviceId, 64);
    if (!deviceId) return bad('deviceId required');
    const ipHash = clientIpHash(req);

    // Rate limit: 10 claims per hour per IP (across all specials).
    const recent = await sql`SELECT COUNT(*)::int AS n FROM special_coupons
      WHERE data->>'ipHash' = ${ipHash} AND created_at > now() - interval '1 hour'`;
    if (recent[0].n >= CLAIMS_PER_HOUR_PER_IP) return bad('Too many coupon claims from this connection — try again in an hour.', 429);

    // One per device and one per email for this special. The same phone gets
    // its existing coupon back; a different phone with a used email is told so
    // (so a known address cannot be used to pull someone else's coupon).
    const dupes = await sql`SELECT code, special_id, data, status, created_at FROM special_coupons
      WHERE special_id = ${sp.id} AND status <> 'void'
        AND (data->>'deviceId' = ${deviceId} OR lower(data->>'email') = ${email})`;
    const mine = dupes.find(r => r.data && r.data.deviceId === deviceId);
    if (mine) {
      return json(Object.assign(publicCoupon(mine, now), { ok: true, existing: true }));
    }
    if (dupes.length) return json({ error: 'That email already claimed this special. Open the coupon on the phone you used, or ask a Guru.', code: 'claimed' }, 409);

    if (sp.claimLimit) {
      const cnt = await sql`SELECT COUNT(*)::int AS n FROM special_coupons WHERE special_id = ${sp.id} AND status <> 'void'`;
      if (cnt[0].n >= sp.claimLimit) return json({ error: 'All of these have been claimed — sorry!', code: 'soldout' }, 409);
    }

    const claimedAt = new Date(now).toISOString();
    const expiresAt = sp.endsAt || new Date(now + DEFAULT_COUPON_DAYS * 86400_000).toISOString();
    let code = newCouponCode();
    const data = { code, specialId: sp.id, title: sp.title, cat: sp.cat, name, email, deviceId, ipHash, claimedAt, expiresAt };
    // Retry on the (astronomically unlikely) code collision.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sql`INSERT INTO special_coupons (code, special_id, data, status)
                  VALUES (${code}, ${sp.id}, ${JSON.stringify(data)}::jsonb, 'active')`;
        break;
      } catch (e) {
        if (e && e.code === '23505' && attempt < 2) { code = newCouponCode(); data.code = code; continue; }
        throw e;
      }
    }
    return json({ ok: true, code, specialId: sp.id, title: sp.title, cat: sp.cat, status: 'active',
      claimedAt, expiresAt, url: couponUrl(code), qrUrl: couponQrPath(code) }, 201);
  }

  // ---- everything below is staff-only ----
  if (!requireAdmin(req)) return bad('unauthorized', 401);

  // ================= ADMIN: redeem =================
  if (req.method === 'POST' && head === 'redeem') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    const code = parseCouponCode(b.code);
    if (!code) return bad('Not a valid coupon code.', 404);
    const rows = await sql`SELECT code, special_id, data, status, created_at FROM special_coupons WHERE code = ${code}`;
    if (!rows.length) return bad('Coupon not found.', 404);
    const c = rows[0];
    const sp = await loadSpecial(c.special_id);
    const counts = sp ? await claimCounts() : {};
    const base = { coupon: publicCoupon(c, now), special: sp ? publicSpecial(sp, counts[sp.id] ? counts[sp.id].claimed : 0) : null };
    const st = couponStatus(c, now);
    if (st === 'redeemed') return json(Object.assign(base, { ok: false, status: 'redeemed', error: 'ALREADY REDEEMED' }), 409);
    if (st === 'expired') return json(Object.assign(base, { ok: false, status: 'expired', error: 'EXPIRED' }), 409);
    if (st === 'void') return json(Object.assign(base, { ok: false, status: 'void', error: 'VOIDED' }), 409);
    const d = Object.assign({}, c.data || {}, { redeemedAt: new Date(now).toISOString(), redeemedBy: str(b.by || 'guru', 40) });
    await sql`UPDATE special_coupons SET status = 'redeemed', data = ${JSON.stringify(d)}::jsonb WHERE code = ${code} AND status = 'active'`;
    c.status = 'redeemed'; c.data = d;
    return json(Object.assign(base, { ok: true, status: 'redeemed', coupon: publicCoupon(c, now) }));
  }

  // ================= ADMIN: specials CRUD =================
  if (head === 'admin') {
    const id = parts[1] || '';

    if (req.method === 'GET' && !id) {
      const rows = await sql`SELECT id, data, created_at FROM specials ORDER BY created_at ASC`;
      const counts = await claimCounts();
      const list = rows.map(r => {
        const sp = r.data || {};
        const c = counts[r.id] || { claimed: 0, redeemed: 0 };
        return Object.assign({}, sp, { id: r.id, live: isLiveNow(sp, now), claimed: c.claimed, redeemed: c.redeemed, createdAt: sp.createdAt || r.created_at });
      }).sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
      return json(list);
    }

    if (req.method === 'POST' && !id) {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const norm = normalizeSpecial(b, null);
      if (!norm.ok) return bad(norm.error);
      const sp = norm.data;
      sp.id = newSpecialId();
      sp.createdAt = new Date(now).toISOString();
      sp.updatedAt = sp.createdAt;
      await sql`INSERT INTO specials (id, data) VALUES (${sp.id}, ${JSON.stringify(sp)}::jsonb)`;
      return json(Object.assign({}, sp, { live: isLiveNow(sp, now), claimed: 0, redeemed: 0 }), 201);
    }

    if (req.method === 'PUT' && id) {
      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
      const cur = await loadSpecial(id);
      if (!cur) return bad('not found', 404);
      const norm = normalizeSpecial(b, cur);
      if (!norm.ok) return bad(norm.error);
      const sp = norm.data;
      sp.id = id;
      sp.updatedAt = new Date(now).toISOString();
      await sql`UPDATE specials SET data = ${JSON.stringify(sp)}::jsonb WHERE id = ${id}`;
      const counts = await claimCounts();
      const c = counts[id] || { claimed: 0, redeemed: 0 };
      return json(Object.assign({}, sp, { live: isLiveNow(sp, now), claimed: c.claimed, redeemed: c.redeemed }));
    }

    if (req.method === 'DELETE' && id) {
      await sql`DELETE FROM specials WHERE id = ${id}`;
      return noContent();
    }

    return bad('not found', 404);
  }

  return bad('not found', 404);
}

// ---- branded coupon page (what the QR opens) ----
function couponPage(c, sp, err) {
  const ok = !!c;
  const d = ok ? (c.data || {}) : {};
  const status = ok ? couponStatus(c, Date.now()) : 'invalid';
  const title = ok ? (d.title || 'Coupon') : 'Coupon';
  const fmt = iso => { try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }); } catch { return String(iso || '').slice(0, 10); } };
  const img = sp && sp.imageUrl ? '<div class="img"><img src="' + esc(sp.imageUrl) + '" alt=""></div>' : '';
  const stateBox = status === 'redeemed' ? '<div class="used">✅ Redeemed ' + esc(d.redeemedAt ? fmt(d.redeemedAt) : '') + '</div>'
    : status === 'expired' ? '<div class="used">⌛ Expired ' + esc(fmt(d.expiresAt)) + '</div>'
    : status === 'void' ? '<div class="used">Voided</div>'
    : '<div class="live">Show this at the counter — one-time use' + (d.expiresAt ? ' · valid through ' + esc(fmt(d.expiresAt)) : '') + '</div>';
  const body = ok
    ? img +
      '<div class="qr"><img src="' + esc(couponQrPath(c.code)) + '" alt="coupon QR"></div>' +
      '<div class="code">' + esc(c.code) + '</div>' +
      '<div class="lbl">' + esc(title) + '</div>' +
      (sp && sp.blurb ? '<div class="sub">' + esc(sp.blurb) + '</div>' : '') +
      (d.name ? '<div class="sub">Claimed by ' + esc(d.name) + '</div>' : '') +
      stateBox +
      (sp && sp.terms ? '<div class="terms">' + esc(sp.terms) + '</div>' : '')
    : '<div class="used">' + esc(err || 'Invalid coupon') + '</div>';
  const html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>NGH · ' + esc(title) + '</title>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600&family=Nunito:wght@400;700;800&display=swap" rel="stylesheet">' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#132a1d;color:#f6efdd;font-family:Nunito,sans-serif;text-align:center}' +
    '.card{background:#1e3d2b;border:3px solid #c9973a;border-radius:18px;padding:22px 20px;max-width:380px;width:92%;margin:16px 0}' +
    '.brand{font-family:Cinzel,Georgia,serif;font-weight:600;color:#e8b84b;font-size:1.15rem;margin-bottom:10px;letter-spacing:.04em}' +
    '.img img{width:100%;max-height:180px;object-fit:cover;border-radius:12px;margin-bottom:12px}' +
    '.qr img{width:220px;height:220px;background:#f6efdd;padding:8px;border-radius:12px}' +
    '.code{font-family:Cinzel,Georgia,serif;font-size:1.35rem;letter-spacing:.12em;color:#f6efdd;margin-top:10px}' +
    '.lbl{font-family:Cinzel,Georgia,serif;font-weight:600;font-size:1.3rem;color:#e8b84b;margin-top:10px}.sub{opacity:.85;font-size:.92rem;margin-top:4px}' +
    '.live{margin-top:14px;background:#2e7d32;color:#fff;border-radius:10px;padding:10px;font-weight:800}.used{margin-top:14px;background:#7a2431;color:#fff;border-radius:10px;padding:10px;font-weight:800}' +
    '.terms{margin-top:12px;font-size:.78rem;opacity:.7;line-height:1.35}</style></head>' +
    '<body><div class="card"><div class="brand">Northwood Game Haven</div>' + body + '</div></body></html>';
  return new Response(html, { status: ok ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
