// netlify/functions/draft-notes.mjs
// Discussion notes on draft events (admin only — powers guru-draft.html).
//   GET  /draft-notes?eventId=EVT-…   -> { eventId, notes:[{id,eventId,guru,text,ts}] }
//   POST /draft-notes {eventId, guru, text} -> append a note
// Notes persist after publish (they're the decision record for the event).
import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';

let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
async function ensureNotes() {
  if (_ready) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS draft_notes (
      id         TEXT PRIMARY KEY,
      event_id   TEXT NOT NULL,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
  } catch (e) { if (!isAlreadyExists(e)) throw e; }
  _ready = true;
}

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[draft-notes] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (!requireAdmin(req)) return bad('unauthorized', 401);
  await ensureSchema();
  await ensureNotes();

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const eventId = String(url.searchParams.get('eventId') || '');
    if (!eventId) return bad('eventId required');
    const rows = await sql`SELECT data FROM draft_notes WHERE event_id = ${eventId} ORDER BY created_at ASC`;
    return json({ eventId, notes: rows.map(r => r.data) });
  }

  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    const eventId = String(b.eventId || '');
    const text = String(b.text || '').trim().slice(0, 2000);
    const guru = String(b.guru || 'Guru').trim().slice(0, 60) || 'Guru';
    if (!eventId || !text) return bad('eventId and text required');
    const note = { id: 'DN-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
                   eventId, guru, text, ts: new Date().toISOString() };
    await sql`INSERT INTO draft_notes (id, event_id, data) VALUES (${note.id}, ${eventId}, ${JSON.stringify(note)}::jsonb)`;
    return json(note);
  }

  return bad('Method not allowed', 405);
};
