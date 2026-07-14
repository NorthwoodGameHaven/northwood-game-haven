// netlify/functions/events.mjs
// Public NGH events (admin-managed; readable by the public calendar).
//   GET    /events            -> list (public — used to grey out booked slots)
//   POST   /events   {event}  -> create (admin)
//   PUT    /events/:id {event}-> update (admin)
//   DELETE /events/:id        -> delete (admin)
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import { checkWindow, loadBlockers, describe, expandOccurrences, eventRoomsOf, toMins, MIN_GAP_MINS } from './_shared/conflicts.mjs';

// Conflict guard for admin event create/edit.
// RED (room overlap with a booking or another event) is a hard block.
// TIGHT (< MIN_GAP_MINS changeover in the same room) requires allowTight:true.
// Blackouts don't block events (staff often blackout AROUND their own events).
async function eventConflicts(ev, ignoreEventId) {
  const rooms = eventRoomsOf(ev);
  if (!rooms.length) return { red: [], tight: [] };               // offsite holds nothing
  const blockers = await loadBlockers(sql);
  const red = [], tight = [];
  for (const occ of expandOccurrences(ev)) {
    let startM, endM;
    if (occ.allDay) { startM = 0; endM = 1440; }
    else {
      if (!occ.start || !occ.end) continue;
      startM = toMins(occ.start); endM = toMins(occ.end);
      if (endM <= startM) endM = 1440;                            // overnight head; tail covered by busy logic
    }
    const r = checkWindow(
      { date: occ.date, startM, endM, rooms },
      blockers,
      { ignoreEventId, includeBlackouts: false }
    );
    r.red.forEach(c => red.push({ ...c, date: occ.date }));
    r.tight.forEach(c => tight.push({ ...c, date: occ.date }));
  }
  return { red, tight };
}
function describeDated(list) { return list.map(c => c.date + ' · ' + describe([c])).join('; '); }

function newId() { return 'EVT-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100); }

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[events] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/events/, '').split('/').filter(Boolean);
  const id = parts[0] ? decodeURIComponent(parts[0]) : null;

  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM events ORDER BY created_at ASC`;
    // Admin-only field: strip strategy scoring from public responses.
    // (strip strategy marker -- do not remove this comment)
    const isAdmin = requireAdmin(req);
    return json(rows.map(r => {
      if (isAdmin) return r.data;
      const d = Object.assign({}, r.data);
      delete d.strategy;
      return d;
    }));
  }

  // everything below mutates -> admin only
  if (!requireAdmin(req)) return bad('unauthorized', 401);

  if (req.method === 'POST') {
    let ev; try { ev = await req.json(); } catch { return bad('Invalid JSON'); }
    if (!ev.title || !ev.date) return bad('title and date required');
    const allowTight = !!ev.allowTight; delete ev.allowTight;
    const allowPend = !!ev.allowPendingOverlap; delete ev.allowPendingOverlap;
    const { red, tight } = await eventConflicts(ev, null);
    const pendRed = red.filter(c => c.kind === 'booking' && c.st && c.st !== 'approved');
    const hardRed = red.filter(c => !(c.kind === 'booking' && c.st && c.st !== 'approved'));
    if (hardRed.length) return json({ error: 'Room overlap — ' + describeDated(hardRed), code: 'overlap', conflicts: hardRed }, 409);
    if (pendRed.length && !allowPend) return json({ error: 'Overlaps PENDING booking request(s) — ' + describeDated(pendRed), code: 'pending', conflicts: pendRed }, 409);
    if (tight.length && !allowTight) return json({ error: 'Back-to-back (<' + MIN_GAP_MINS + ' min changeover) — ' + describeDated(tight), code: 'tight', conflicts: tight }, 409);
    ev.id = ev.id || newId();
    ev.public = true;
    await sql`INSERT INTO events (id, data) VALUES (${ev.id}, ${JSON.stringify(ev)}::jsonb)`;
    return json(ev, 201);
  }

  if (req.method === 'PUT' && id) {
    let ev; try { ev = await req.json(); } catch { return bad('Invalid JSON'); }
    ev.id = id; ev.public = true;
    const allowTight = !!ev.allowTight; delete ev.allowTight;
    const allowPend = !!ev.allowPendingOverlap; delete ev.allowPendingOverlap;
    const { red, tight } = await eventConflicts(ev, id);
    const pendRed = red.filter(c => c.kind === 'booking' && c.st && c.st !== 'approved');
    const hardRed = red.filter(c => !(c.kind === 'booking' && c.st && c.st !== 'approved'));
    if (hardRed.length) return json({ error: 'Room overlap — ' + describeDated(hardRed), code: 'overlap', conflicts: hardRed }, 409);
    if (pendRed.length && !allowPend) return json({ error: 'Overlaps PENDING booking request(s) — ' + describeDated(pendRed), code: 'pending', conflicts: pendRed }, 409);
    if (tight.length && !allowTight) return json({ error: 'Back-to-back (<' + MIN_GAP_MINS + ' min changeover) — ' + describeDated(tight), code: 'tight', conflicts: tight }, 409);
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
