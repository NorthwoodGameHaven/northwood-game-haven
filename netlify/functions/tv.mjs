// netlify/functions/tv.mjs
// NGH-BUILD 2026-08-24e — NGH TV Network backend
// ---------------------------------------------------------------------
// Drives the in-store TV displays (Google TV Streamer 4K running tv.html
// in a kiosk browser). All TVs poll here; content is published from
// guru-tv.html. Synchronization model matches the trivia engine:
//   - No WebSockets on Netlify Functions. Displays poll with their last
//     seen (channel, version); server replies {unchanged:true} (tiny)
//     until an admin publish bumps the version.
//   - Slideshows synchronize deterministically: config carries `anchor`
//     (server epoch ms at publish). Every display computes the current
//     slide from offset-corrected local time, so all TVs show the same
//     slide (and the same Ken Burns direction) within clock-sync error.
//
// API (after /api/tv):
//   GET  /time                          PUBLIC — {serverNow}
//   GET  /config?d=NAME&c=CH&v=N        PUBLIC — resolve config for device
//         NAME; doubles as heartbeat (upserts device last_seen).
//         Returns {unchanged:true, serverNow} when resolved channel/version
//         match what the display already has.
//   GET  /admin/overview                admin  — devices + all channels
//   PUT  /admin/channel/:id             admin  — set channel config, bump version
//   DELETE /admin/channel/:id           admin  — delete a device override
//                                                ('all' cannot be deleted)
//   DELETE /admin/device/:id            admin  — forget a device
//
// Channels: 'all' is the default channel every display follows. Creating
// a channel whose id equals a device name overrides that one TV.
// Config shape (data JSONB):
//   { mode: 'slideshow'|'trivia'|'url'|'idle',
//     slides: [{url, dur, caption, fit}], transition: 'kenburns'|'fade',
//     anchor: <epoch ms>,          // set at publish for slideshow sync
//     trivia: '<gameId>',          // mode 'trivia'
//     url: 'https://...',          // mode 'url'
//     note: '<admin note>' }
// ---------------------------------------------------------------------

import QRCode from 'qrcode';
import { sql, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { expandOccurrences } from './_shared/conflicts.mjs';

let _ready = false;
function isAlreadyExists(e) {
  const c = e && e.code;
  return c === '23505' || c === '42P07' || c === '42710';
}
async function createIfMissing(stmt) {
  try { await stmt; }
  catch (e) { if (!isAlreadyExists(e)) throw e; }
}
async function ensureTvSchema() {
  if (_ready) return;
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS tv_channels (
    id          TEXT PRIMARY KEY,
    version     INTEGER NOT NULL DEFAULT 1,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS tv_devices (
    id          TEXT PRIMARY KEY,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen   TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS tv_decks (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`CREATE TABLE IF NOT EXISTS tv_floormaps (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ DEFAULT now()
  )`);
  await createIfMissing(sql`INSERT INTO tv_channels (id, version, data)
    VALUES ('all', 1, '{"mode":"idle"}'::jsonb)
    ON CONFLICT (id) DO NOTHING`);
  _ready = true;
}

const MODES = new Set(['slideshow', 'trivia', 'url', 'idle', 'arcade', 'announce', 'deck']);

function cleanDeviceId(raw) {
  return String(raw || '').toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Validate + normalize an incoming channel config. Returns {ok, data|error}.
function normalizeConfig(body) {
  const mode = String(body.mode || 'idle');
  if (!MODES.has(mode)) return { ok: false, error: 'bad mode' };
  const out = { mode };

  if (typeof body.note === 'string') out.note = body.note.slice(0, 200);

  if (mode === 'slideshow') {
    const raw = Array.isArray(body.slides) ? body.slides : [];
    const slides = [];
    for (const s of raw.slice(0, 60)) {
      const url = String((s && s.url) || '').trim();
      if (!url) continue;
      if (!/^(https?:\/\/|\/)/i.test(url)) continue; // absolute or site-relative only
      const dur = Math.min(120, Math.max(3, Number(s.dur) || 10));
      const slide = { url, dur };
      if (s.caption) slide.caption = String(s.caption).slice(0, 160);
      slide.fit = s.fit === 'contain' ? 'contain' : 'cover';
      slides.push(slide);
    }
    if (!slides.length) return { ok: false, error: 'slideshow needs at least one slide' };
    out.slides = slides;
    out.transition = body.transition === 'fade' ? 'fade' : 'kenburns';
    // Anchor: keep the caller's anchor if it looks sane (lets an admin
    // re-save captions without re-syncing everyone to slide 0); otherwise
    // stamp now.
    const a = Number(body.anchor);
    out.anchor = (isFinite(a) && a > 1_700_000_000_000) ? a : Date.now();
  } else if (mode === 'trivia') {
    const g = String(body.trivia || '').trim().slice(0, 60);
    if (!g) return { ok: false, error: 'trivia mode needs a game id' };
    out.trivia = g;
  } else if (mode === 'url') {
    const u = String(body.url || '').trim();
    if (!/^(https?:\/\/|\/)/i.test(u)) return { ok: false, error: 'url mode needs an absolute or site-relative URL' };
    out.url = u.slice(0, 500);
  } else if (mode === 'arcade') {
    const a = String(body.arcade || '').trim().toUpperCase().slice(0, 12);
    if (!/^[A-Z0-9]{3,12}$/.test(a)) return { ok: false, error: 'arcade mode needs a session code' };
    out.arcade = a;
  } else if (mode === 'deck') {
    const dk = String(body.deck || '').trim().slice(0, 40);
    if (!/^[a-z0-9-]{2,40}$/.test(dk)) return { ok: false, error: 'deck mode needs a deck id' };
    out.deck = dk;
    const a = Number(body.anchor);
    out.anchor = (isFinite(a) && a > 1_700_000_000_000) ? a : Date.now();
  } else if (mode === 'announce') {
    const txt = String(body.text || '').trim().slice(0, 120);
    if (!txt) return { ok: false, error: 'announce mode needs text' };
    out.text = txt;
    if (body.sub) out.sub = String(body.sub).trim().slice(0, 200);
  }
  // Optional QR overlay. Trivia auto-shows a join QR unless qr === false;
  // slideshow/url/idle can opt in with {url, label}.
  if (body.qr === false) out.qr = false;
  else if (body.qr && typeof body.qr === 'object') {
    const qu = String(body.qr.url || '').trim();
    if (/^(https?:\/\/|\/)/i.test(qu)) {
      out.qr = { url: qu.slice(0, 300), label: String(body.qr.label || '').slice(0, 60) };
    }
  }
  return { ok: true, data: out };
}

// ---- decks -----------------------------------------------------------
const SLIDE_KINDS = new Set(['image', 'custom', 'gslides', 'stayplay', 'product',
  'auto:weekly', 'auto:recurring', 'auto:event', 'floormap']);
function cleanSlide(s) {
  if (!s || typeof s !== 'object') return null;
  const kind = String(s.kind || '');
  if (!SLIDE_KINDS.has(kind)) return null;
  const out = { kind, dur: Math.min(300, Math.max(4, Number(s.dur) || 12)) };
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const urlish = (v, n) => { const u = str(v, n).trim(); return /^(https?:\/\/|\/)/i.test(u) ? u : ''; };
  if (kind === 'image') {
    out.url = urlish(s.url, 500); if (!out.url) return null;
    if (s.caption) out.caption = str(s.caption, 160);
    out.fit = s.fit === 'contain' ? 'contain' : 'cover';
  } else if (kind === 'gslides') {
    const u = urlish(s.url, 600);
    if (!u || !/docs\.google\.com/i.test(u)) return null;
    out.url = u;
  } else if (kind === 'stayplay') {
    out.qrUrl = urlish(s.qrUrl, 300) || '/';
  } else if (kind === 'product') {
    out.name = str(s.name, 80); if (!out.name) return null;
    out.price = str(s.price, 20);
    if (s.salePrice) out.salePrice = str(s.salePrice, 20);
    if (s.badge) out.badge = str(s.badge, 30);
    if (s.blurb) out.blurb = str(s.blurb, 220);
    if (s.img) out.img = urlish(s.img, 500);
    if (s.qrUrl) out.qrUrl = urlish(s.qrUrl, 300);
  } else if (kind === 'floormap') {
    out.map = str(s.map, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!out.map) return null;
    if (s.title) out.title = str(s.title, 80);
  } else if (kind === 'auto:recurring') {
    const d = Number(s.dow);
    if (!(d >= 0 && d <= 6)) return null;
    out.dow = d;
  } else if (kind === 'auto:event') {
    out.event = str(s.event, 60); if (!out.event) return null;
  } else if (kind === 'custom') {
    out.bg = str(s.bg, 400);
    const els = Array.isArray(s.els) ? s.els : [];
    out.els = [];
    for (const e of els.slice(0, 40)) {
      if (!e || typeof e !== 'object') continue;
      const t = String(e.t || '');
      const base = {
        t,
        x: Math.max(-400, Math.min(2200, Math.round(Number(e.x) || 0))),
        y: Math.max(-400, Math.min(1400, Math.round(Number(e.y) || 0))),
        w: Math.max(20, Math.min(1920, Math.round(Number(e.w) || 200))),
        h: Math.max(20, Math.min(1080, Math.round(Number(e.h) || 100)))
      };
      if (t === 'text') {
        base.txt = str(e.txt, 300); base.size = Math.max(12, Math.min(260, Number(e.size) || 48));
        base.color = str(e.color, 20); base.font = ['alfa', 'nunito', 'caveat'].includes(e.font) ? e.font : 'nunito';
        base.align = ['left', 'center', 'right'].includes(e.align) ? e.align : 'left';
        base.bold = !!e.bold;
      } else if (t === 'img') {
        base.url = urlish(e.url, 500); if (!base.url) continue;
        base.fit = e.fit === 'cover' ? 'cover' : 'contain';
      } else if (t === 'qr') {
        base.url = urlish(e.url, 300); if (!base.url) continue;
        base.label = str(e.label, 60);
      } else if (t === 'panel') {
        base.color = str(e.color, 20); base.alpha = Math.max(0, Math.min(1, Number(e.alpha) || 0.85));
        base.radius = Math.max(0, Math.min(120, Number(e.radius) || 20));
      } else continue;
      out.els.push(base);
    }
  }
  return out;
}
const MAP_ELS = new Set(['table', 'label', 'wall']);
function cleanMap(body, id) {
  const name = String((body && body.name) || id).slice(0, 60);
  const raw = Array.isArray(body && body.els) ? body.els : [];
  const els = [];
  for (const e of raw.slice(0, 120)) {
    if (!e || !MAP_ELS.has(String(e.t))) continue;
    const o = {
      t: String(e.t),
      x: Math.max(0, Math.min(1920, Math.round(Number(e.x) || 0))),
      y: Math.max(0, Math.min(1080, Math.round(Number(e.y) || 0))),
      w: Math.max(20, Math.min(1920, Math.round(Number(e.w) || 120))),
      h: Math.max(20, Math.min(1080, Math.round(Number(e.h) || 80)))
    };
    if (o.t === 'table') {
      o.n = String(e.n == null ? '' : e.n).slice(0, 8);
      o.shape = e.shape === 'round' ? 'round' : 'rect';
      o.seats = Math.max(0, Math.min(12, Math.round(Number(e.seats) || 4)));
    } else if (o.t === 'label') {
      o.txt = String(e.txt || '').slice(0, 60);
      o.size = Math.max(14, Math.min(120, Number(e.size) || 34));
    }
    els.push(o);
  }
  return { name, els };
}
async function deckVersion(id) {
  const r = await sql`SELECT version FROM tv_decks WHERE id = ${id}`;
  return r.length ? Number(r[0].version) : 0;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureTvSchema();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/tv/, '').split('/').filter(Boolean);
  const head = parts[0] || '';

  // ---- PUBLIC: server time ----
  if (head === 'time' && req.method === 'GET') {
    return json({ serverNow: Date.now() });
  }

  // ---- PUBLIC: QR PNG (join links etc.) ----
  if (head === 'qr.png' && req.method === 'GET') {
    const data = String(url.searchParams.get('data') || '').slice(0, 300);
    if (!/^(https?:\/\/|\/)/i.test(data)) return bad('bad data');
    const size = Math.min(960, Math.max(120, Number(url.searchParams.get('s')) || 420));
    const target = data.startsWith('/') ? (url.origin + data) : data;
    const png = await QRCode.toBuffer(target, {
      type: 'png', width: size, margin: 2,
      color: { dark: '#132a1d', light: '#f6efdd' }
    });
    return new Response(png, { status: 200, headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    }});
  }

  // ---- PUBLIC: resolve config + heartbeat ----
  if (head === 'config' && req.method === 'GET') {
    const dev = cleanDeviceId(url.searchParams.get('d'));
    const haveCh = String(url.searchParams.get('c') || '');
    const haveV = Number(url.searchParams.get('v') || 0);

    // Heartbeat (best-effort; never block the poll on it)
    if (dev) {
      const ua = (req.headers.get('user-agent') || '').slice(0, 200);
      try {
        await sql`INSERT INTO tv_devices (id, data, last_seen)
          VALUES (${dev}, ${JSON.stringify({ ua })}::jsonb, now())
          ON CONFLICT (id) DO UPDATE
          SET last_seen = now(),
              data = tv_devices.data || ${JSON.stringify({ ua })}::jsonb`;
      } catch (e) { /* heartbeat is non-critical */ }
    }

    // Resolve: device-named channel wins, else 'all'
    let row = null;
    if (dev) {
      const r = await sql`SELECT id, version, data FROM tv_channels WHERE id = ${dev}`;
      if (r.length) row = r[0];
    }
    if (!row) {
      const r = await sql`SELECT id, version, data FROM tv_channels WHERE id = 'all'`;
      row = r.length ? r[0] : { id: 'all', version: 1, data: { mode: 'idle' } };
    }

    let deckV = 0;
    if (row.data && row.data.mode === 'deck' && row.data.deck) {
      deckV = await deckVersion(row.data.deck);
    }
    const haveDv = Number(url.searchParams.get('dv') || 0);
    if (row.id === haveCh && Number(row.version) === haveV && deckV === haveDv) {
      return json({ unchanged: true, serverNow: Date.now() });
    }
    return json({
      channel: row.id,
      version: Number(row.version),
      deckV,
      config: row.data,
      serverNow: Date.now()
    });
  }

  // ---- PUBLIC: read a deck (content is display-facing anyway) ----
  if (head === 'decks' && parts[1] && req.method === 'GET') {
    const id = cleanDeviceId(parts[1]);
    const r = await sql`SELECT id, name, version, data FROM tv_decks WHERE id = ${id}`;
    if (!r.length) return bad('deck not found', 404);
    return json({ id: r[0].id, name: r[0].name, version: Number(r[0].version),
      slides: (r[0].data && r[0].data.slides) || [] });
  }

  // ---- PUBLIC: read a floor map (rendered on tournament TVs + deck slides) ----
  if (head === 'floormaps' && parts[1] && req.method === 'GET') {
    const id = cleanDeviceId(parts[1]);
    const r = await sql`SELECT id, name, version, data FROM tv_floormaps WHERE id = ${id}`;
    if (!r.length) return bad('map not found', 404);
    return json({ id: r[0].id, name: r[0].name, version: Number(r[0].version),
      els: (r[0].data && r[0].data.els) || [] });
  }

  // ---- PUBLIC: aggregated event feed for auto slides ----
  // Draft + private events are excluded. Recurrence expansion uses the
  // shared expandOccurrences() — the ONE true implementation (weekday-drift
  // rule). Cached 5 min at the edge; displays also cache 5 min client-side.
  if (head === 'eventfeed' && req.method === 'GET') {
    const rows = await sql`SELECT data FROM events ORDER BY created_at ASC`;
    const events = rows.map(r => r.data)
      .filter(e => e && e.status !== 'draft' && !e.private && e.title && e.date);
    // Server-local UTC would drift for a WI store; derive America/Chicago.
    const chi = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const today = iso(chi);
    const plus = n => { const x = new Date(chi); x.setDate(x.getDate() + n); return iso(x); };
    const horizon60 = plus(60), horizon7 = plus(6);

    const brief = e => ({ id: e.id, title: e.title, start: e.start || '', end: e.end || '',
      allDay: !!e.allDay, hasPhoto: !!e.photo });

    // weekly: next 7 days incl. today
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = plus(i);
      days.push({ date: d, dow: new Date(d + 'T12:00:00').getDay(), events: [] });
    }
    const byDate = {}; days.forEach(d => { byDate[d.date] = d; });
    for (const e of events) {
      for (const o of expandOccurrences(e)) {
        if (byDate[o.date]) byDate[o.date].events.push({ ...brief(e), start: o.start || e.start || '', title: o.title || e.title });
      }
    }
    days.forEach(d => d.events.sort((a, b) => String(a.start).localeCompare(String(b.start))));

    // recurring weekday series (weekly / biweekly cadence)
    const recurring = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const e of events) {
      const f = e.recurrence && e.recurrence.freq;
      if (f !== 'weekly' && f !== 'biweekly') continue;
      const occ = expandOccurrences(e).filter(o => o.date >= today);
      if (!occ.length) continue;                       // series has ended
      const dow = new Date(e.date + 'T12:00:00').getDay();
      recurring[dow].push({ ...brief(e), cadence: f, nextDate: occ[0].date,
        blurb: String(e.notes || '').slice(0, 220) });
    }
    Object.keys(recurring).forEach(k =>
      recurring[k].sort((a, b) => String(a.start).localeCompare(String(b.start))));

    // specials: non-recurring, today..+60d
    const specials = events
      .filter(e => !e.recurrence && e.date >= today && e.date <= horizon60)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(0, 24)
      .map(e => ({ ...brief(e), date: e.date, blurb: String(e.notes || '').slice(0, 240) }));

    return new Response(JSON.stringify({
      generated: Date.now(), today, weekly: days, recurring, specials
    }), { status: 200, headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300'
    }});
  }

  // ---- ADMIN ----
  if (head === 'admin') {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    const sub = parts[1] || '';
    const id = parts[2] ? cleanDeviceId(parts[2]) : '';

    if (sub === 'overview' && req.method === 'GET') {
      const devices = await sql`SELECT id, data, last_seen,
          (now() - last_seen) < interval '20 seconds' AS online
        FROM tv_devices ORDER BY id`;
      const channels = await sql`SELECT id, version, data, updated_at FROM tv_channels ORDER BY (id <> 'all'), id`;
      return json({ devices, channels, serverNow: Date.now() });
    }

    if (sub === 'decks' && !parts[2] && req.method === 'GET') {
      const rows = await sql`SELECT id, name, version, updated_at,
          jsonb_array_length(COALESCE(data->'slides', '[]'::jsonb)) AS slides
        FROM tv_decks ORDER BY updated_at DESC`;
      return json({ decks: rows });
    }

    if (sub === 'decks' && parts[2] && req.method === 'PUT') {
      const did = cleanDeviceId(parts[2]);
      if (!did) return bad('bad deck id');
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const name = String((body && body.name) || did).slice(0, 60);
      const raw = Array.isArray(body && body.slides) ? body.slides : [];
      const slides = [];
      for (const s of raw.slice(0, 80)) { const c = cleanSlide(s); if (c) slides.push(c); }
      const rows = await sql`INSERT INTO tv_decks (id, name, version, data, updated_at)
        VALUES (${did}, ${name}, 1, ${JSON.stringify({ slides })}::jsonb, now())
        ON CONFLICT (id) DO UPDATE
        SET name = ${name},
            version = tv_decks.version + 1,
            data = ${JSON.stringify({ slides })}::jsonb,
            updated_at = now()
        RETURNING id, name, version`;
      return json(rows[0]);
    }

    if (sub === 'decks' && parts[2] && req.method === 'DELETE') {
      const did = cleanDeviceId(parts[2]);
      await sql`DELETE FROM tv_decks WHERE id = ${did}`;
      return json({ ok: true });
    }

    if (sub === 'floormaps' && !parts[2] && req.method === 'GET') {
      const rows = await sql`SELECT id, name, version, updated_at,
          jsonb_array_length(COALESCE(data->'els', '[]'::jsonb)) AS els
        FROM tv_floormaps ORDER BY updated_at DESC`;
      return json({ maps: rows });
    }
    if (sub === 'floormaps' && parts[2] && req.method === 'PUT') {
      const mid = cleanDeviceId(parts[2]);
      if (!mid) return bad('bad map id');
      let body; try { body = await req.json(); } catch { return bad('bad json'); }
      const cm = cleanMap(body, mid);
      const rows = await sql`INSERT INTO tv_floormaps (id, name, version, data, updated_at)
        VALUES (${mid}, ${cm.name}, 1, ${JSON.stringify({ els: cm.els })}::jsonb, now())
        ON CONFLICT (id) DO UPDATE
        SET name = ${cm.name},
            version = tv_floormaps.version + 1,
            data = ${JSON.stringify({ els: cm.els })}::jsonb,
            updated_at = now()
        RETURNING id, name, version`;
      return json(rows[0]);
    }
    if (sub === 'floormaps' && parts[2] && req.method === 'DELETE') {
      await sql`DELETE FROM tv_floormaps WHERE id = ${cleanDeviceId(parts[2])}`;
      return json({ ok: true });
    }

    if (sub === 'channel' && id && req.method === 'PUT') {
      let body;
      try { body = await req.json(); } catch { return bad('bad json'); }
      const norm = normalizeConfig(body || {});
      if (!norm.ok) return bad(norm.error);
      const rows = await sql`INSERT INTO tv_channels (id, version, data, updated_at)
        VALUES (${id}, 1, ${JSON.stringify(norm.data)}::jsonb, now())
        ON CONFLICT (id) DO UPDATE
        SET version = tv_channels.version + 1,
            data = ${JSON.stringify(norm.data)}::jsonb,
            updated_at = now()
        RETURNING id, version, data`;
      return json(rows[0]);
    }

    if (sub === 'channel' && id && req.method === 'DELETE') {
      if (id === 'all') return bad("the 'all' channel cannot be deleted");
      await sql`DELETE FROM tv_channels WHERE id = ${id}`;
      return json({ ok: true });
    }

    if (sub === 'device' && id && req.method === 'DELETE') {
      await sql`DELETE FROM tv_devices WHERE id = ${id}`;
      return json({ ok: true });
    }

    return bad('not found', 404);
  }

  return bad('not found', 404);
};
