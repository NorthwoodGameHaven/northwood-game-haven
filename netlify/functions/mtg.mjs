// netlify/functions/mtg.mjs
// NGH-BUILD 2026-09-12l — Magic night board (WPN / EventLink companion piece)
// ---------------------------------------------------------------------
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not scrape EventLink, drive a headless browser against it, or hold a
// WotC session. That approach was considered and rejected:
//
//   * EventLink already has a first-party answer — **EventLink Mirror** — which
//     puts event name, code, pairings, standings and the round timer on a
//     second monitor. It is always correct, needs no maintenance, and breaks on
//     nobody's schedule but Wizards'. Re-deriving that by scraping the same
//     data out of the same page is strictly worse in every dimension: it breaks
//     when their DOM changes, it needs a logged-in session sitting in a
//     headless browser, and it is a support conversation nobody wants to have.
//   * Each event's Mirror has its own URL —
//     https://eventlink.wizards.com/stores/<store>/events/<event>/mirror —
//     so the right move is to POINT AT IT, not to re-implement it. We store
//     that link and put it on a QR and a button; we never fetch it. (It answers
//     403 to a plain server-side fetch anyway, which is a fair signal that
//     scraping it is not a road worth going down.)
//
// So: EventLink Mirror runs on one screen and owns pairings. THIS owns the
// screen next to it, and answers the questions EventLink does not:
//
//     what is tonight, what does it cost, what do I win, WHAT IS THE CODE,
//     how do I get the Companion app, and what's on next week
//
// The event code is the single most-asked question at FNM, and Companion joins
// by typed code only — there is no deep link or join QR to generate, which is
// exactly why showing the code enormously is worth a screen of its own.
//
// State is one row, set by a Guru in seconds. No recurrence logic lives here:
// the Guru picks which event is tonight, because they know, and a rule engine
// that gets it wrong on a pre-release night is worse than useless.
//
// Routes (via /api/mtg/* alias in netlify.toml):
//   GET  /mtg/time                  PUBLIC {serverNow}
//   GET  /mtg/board?v=N             PUBLIC the board (version-gated poll)
//   PUT  /mtg/board                 admin  {eventId,date,code,format,entry,prizes,note,nextNote,mirrorUrl,live}
//   POST /mtg/board/clear           admin  take it down
//   GET  /mtg/join-qr.png           PUBLIC QR -> gamehaven.guru/mtg
//   GET  /mtg/mirror-qr.png         PUBLIC QR -> tonight's EventLink Mirror (if set)
// ---------------------------------------------------------------------

import QRCode from 'qrcode';
import { sql, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';

const SITE = process.env.PUBLIC_SITE_URL || 'https://gamehaven.guru';

let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
async function mk(stmt) { try { await stmt; } catch (e) { if (!isAlreadyExists(e)) throw e; } }
async function ensureSchema() {
  if (_ready) return;
  await mk(sql`CREATE TABLE IF NOT EXISTS mtg_board (
    id INTEGER PRIMARY KEY DEFAULT 1,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ DEFAULT now())`);
  await mk(sql`INSERT INTO mtg_board (id, data, version) VALUES (1, '{}'::jsonb, 1) ON CONFLICT (id) DO NOTHING`);
  _ready = true;
}

const now = () => Date.now();
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 120);
// Event codes are read off a screen and typed into a phone across a noisy room,
// so normalise hard: upper case, alphanumerics only.
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
async function readBody(req) { try { return await req.json(); } catch { return {}; } }

async function loadBoard() {
  const rows = await sql`SELECT data, version FROM mtg_board WHERE id = 1`;
  if (!rows.length) return { data: {}, version: 1 };
  return { data: rows[0].data || {}, version: rows[0].version };
}

function publicBoard(d, version) {
  return {
    live: !!d.live,
    eventId: d.eventId || null,
    date: d.date || null,
    title: d.title || null,
    format: d.format || null,
    startLabel: d.startLabel || null,
    entry: d.entry || null,
    prizes: d.prizes || null,
    code: d.code || null,
    note: d.note || null,
    nextNote: d.nextNote || null,
    mirrorUrl: d.mirrorUrl || null,
    updatedAt: d.updatedAt || null,
    version, serverNow: now()
  };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    await ensureSchema();
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^.*\/mtg\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    const head = parts[0] || '';

    if (head === 'time' && req.method === 'GET') return json({ serverNow: now() });

    if (head === 'join-qr.png' && req.method === 'GET') {
      // Points at our own page rather than an app store, because the right
      // store link depends on the phone and the code is what they came for.
      const png = await QRCode.toBuffer(SITE + '/mtg', { width: 480, margin: 1 });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600', 'Access-Control-Allow-Origin': '*' } });
    }

    if (head === 'mirror-qr.png' && req.method === 'GET') {
      const { data } = await loadBoard();
      if (!data.mirrorUrl) return bad('no mirror link set', 404);
      const png = await QRCode.toBuffer(data.mirrorUrl, { width: 480, margin: 1 });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
    }

    if (head === 'board' && !parts[1] && req.method === 'GET') {
      const { data, version } = await loadBoard();
      const v = Number(url.searchParams.get('v') || 0);
      if (v && v === version) return json({ unchanged: true, version, serverNow: now() });
      return json(publicBoard(data, version));
    }

    if (head === 'board' && !parts[1] && req.method === 'PUT') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const b = await readBody(req);
      const { data: prev, version } = await loadBoard();
      // Merge, so setting just the code mid-evening does not wipe the rest.
      const d = Object.assign({}, prev);
      if (b.eventId !== undefined) d.eventId = clean(b.eventId, 40) || null;
      if (b.date !== undefined) d.date = clean(b.date, 10) || null;
      if (b.title !== undefined) d.title = clean(b.title, 80) || null;
      if (b.format !== undefined) d.format = clean(b.format, 40) || null;
      if (b.startLabel !== undefined) d.startLabel = clean(b.startLabel, 40) || null;
      if (b.entry !== undefined) d.entry = clean(b.entry, 40) || null;
      if (b.prizes !== undefined) d.prizes = clean(b.prizes, 200) || null;
      if (b.code !== undefined) d.code = cleanCode(b.code) || null;
      if (b.note !== undefined) d.note = clean(b.note, 200) || null;
      if (b.nextNote !== undefined) d.nextNote = clean(b.nextNote, 200) || null;
      // The Mirror URL is WotC's own public-ish pairings view for this event
      // (https://eventlink.wizards.com/stores/<store>/events/<event>/mirror).
      // We never fetch it — we point screens and phones AT it. Restricted to
      // eventlink.wizards.com so a mistyped paste cannot turn our TV QR into a
      // link to somewhere else entirely.
      if (b.mirrorUrl !== undefined) {
        const raw = clean(b.mirrorUrl, 300);
        if (!raw) d.mirrorUrl = null;
        else {
          let ok = false;
          try { const u = new URL(raw); ok = u.protocol === 'https:' && /(^|\.)eventlink\.wizards\.com$/i.test(u.hostname); } catch (e) { ok = false; }
          if (!ok) return bad('the mirror link must be an https eventlink.wizards.com URL');
          d.mirrorUrl = raw;
        }
      }
      if (b.live !== undefined) d.live = !!b.live;
      d.updatedAt = now();
      const next = version + 1;
      await sql`UPDATE mtg_board SET data = ${JSON.stringify(d)}::jsonb, version = ${next}, updated_at = now() WHERE id = 1`;
      return json(publicBoard(d, next));
    }

    if (head === 'board' && parts[1] === 'clear' && req.method === 'POST') {
      if (!requireAdmin(req)) return bad('unauthorized', 401);
      const { version } = await loadBoard();
      const next = version + 1;
      await sql`UPDATE mtg_board SET data = '{}'::jsonb, version = ${next}, updated_at = now() WHERE id = 1`;
      return json(publicBoard({}, next));
    }

    return bad('not found', 404);
  } catch (e) {
    console.error('[mtg]', e);
    return bad('server error: ' + (e && e.message || e), 500);
  }
};
