// netlify/functions/blueprints.mjs — Event Blueprints (reusable event templates)
// NGH-BUILD 2026-08-26b
//
// A blueprint is a saved, date-less copy of an event: title, times, rooms,
// registration, tournament config, prizes, Discord channels, promo plan and —
// crucially — the full strategy scoring. "New from blueprint" pre-fills the
// event form so a proven format (Team Trivia, FNM, Mahjong Monday…) spins up
// in seconds, already scored for the Draft Review publish-gate.
//
//   GET  /blueprints            -> { blueprints:[ {id,name,title,rooms,start,end,savedBy,ts, hasStrategy,hasReg,hasTournament} ] }
//   GET  /blueprints?id=BP-…    -> { blueprint:{ id, name, savedBy, ts, data:{…event fields…} } }
//   POST { blueprint:{ name, savedBy, data:{…} } }  -> saved blueprint
//   POST { delete:"BP-…" }                          -> { deleted }
// All admin-only.

import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';

let _ready = false;
async function ensureTable() {
  if (_ready) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS event_blueprints (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
  } catch (e) {
    const c = e && e.code;
    if (c !== '23505' && c !== '42P07' && c !== '42710') throw e;
  }
  _ready = true;
}

// Fields a blueprint carries — everything reusable, nothing occurrence-bound.
// (No id/date/status/groupId/exceptions; recurrence intentionally excluded —
// cadence is a per-launch decision.)
const FIELDS = ['title', 'allDay', 'start', 'end', 'rooms', 'offsite', 'offsiteLocation',
  'notes', 'photo', 'fbLink', 'discordChannels', 'tournament', 'prizes',
  'adminNotes', 'strategy', 'registration', 'promoPlan', 'private'];

function sanitize(d) {
  const out = {};
  for (const k of FIELDS) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  // Inline base64 photos would bloat rows and re-bloat booking.html on reuse —
  // keep URL photos only.
  if (typeof out.photo === 'string' && out.photo.slice(0, 5) === 'data:') delete out.photo;
  const s = JSON.stringify(out);
  if (s.length > 200000) throw new Error('blueprint too large');
  return out;
}

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[blueprints] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (!requireAdmin(req)) return bad('unauthorized', 401);
  await ensureSchema();
  await ensureTable();

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (id) {
      const rows = await sql`SELECT data FROM event_blueprints WHERE id = ${String(id)}`;
      if (!rows.length) return bad('blueprint not found', 404);
      return json({ blueprint: rows[0].data });
    }
    const rows = await sql`SELECT data FROM event_blueprints ORDER BY updated_at DESC`;
    return json({
      blueprints: rows.map(r => {
        const b = r.data || {}, d = b.data || {};
        return { id: b.id, name: b.name, title: d.title || '', rooms: d.rooms || [],
                 allDay: !!d.allDay, start: d.start || '', end: d.end || '',
                 savedBy: b.savedBy || '', ts: b.ts,
                 hasStrategy: !!(d.strategy && d.strategy.type),
                 hasReg: !!(d.registration && d.registration.enabled),
                 hasTournament: !!d.tournament };
      })
    });
  }

  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }

    if (b.delete) {
      const id = String(b.delete);
      await sql`DELETE FROM event_blueprints WHERE id = ${id}`;
      return json({ deleted: id });
    }

    const bp = b.blueprint || {};
    const name = String(bp.name || '').trim().slice(0, 120);
    if (!name) return bad('name required');
    if (!bp.data || typeof bp.data !== 'object') return bad('data required');
    const now = new Date().toISOString();
    const clean = {
      id: 'BP-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 900 + 100),
      name,
      savedBy: String(bp.savedBy || '').trim().slice(0, 60),
      ts: now,
      data: sanitize(bp.data)
    };
    await sql`INSERT INTO event_blueprints (id, data)
              VALUES (${clean.id}, ${JSON.stringify(clean)}::jsonb)`;
    return json(clean);
  }

  return bad('Method not allowed', 405);
};
