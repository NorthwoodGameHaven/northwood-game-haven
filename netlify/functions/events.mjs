// netlify/functions/events.mjs
// Public NGH events (admin-managed; readable by the public calendar).
//   GET    /events            -> list (public — used to grey out booked slots)
//   POST   /events   {event}  -> create (admin)
//   PUT    /events/:id {event}-> update (admin)
//   DELETE /events/:id        -> delete (admin)
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';

function newId() { return 'EVT-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100); }

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/events/, '').split('/').filter(Boolean);
  const id = parts[0] ? decodeURIComponent(parts[0]) : null;

  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM events ORDER BY created_at ASC`;
    return json(rows.map(r => r.data));
  }

  // everything below mutates -> admin only
  if (!requireAdmin(req)) return bad('unauthorized', 401);

  if (req.method === 'POST') {
    let ev; try { ev = await req.json(); } catch { return bad('Invalid JSON'); }
    if (!ev.title || !ev.date) return bad('title and date required');
    ev.id = ev.id || newId();
    ev.public = true;
    await sql`INSERT INTO events (id, data) VALUES (${ev.id}, ${JSON.stringify(ev)}::jsonb)`;
    return json(ev, 201);
  }

  if (req.method === 'PUT' && id) {
    let ev; try { ev = await req.json(); } catch { return bad('Invalid JSON'); }
    ev.id = id; ev.public = true;
    await sql`INSERT INTO events (id, data) VALUES (${id}, ${JSON.stringify(ev)}::jsonb)
              ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
    return json(ev);
  }

  if (req.method === 'DELETE' && id) {
    await sql`DELETE FROM events WHERE id = ${id}`;
    return noContent();
  }

  return bad('Method not allowed', 405);
};
