// netlify/functions/bookings.mjs
// Routes (all under /.netlify/functions):
//   GET    /bookings                      -> list all (admin only)
//   POST   /bookings        { bookings:[] } -> bulk insert (public; server-side conflict check)
//   PATCH  /bookings/:id    { ...patch }    -> update one (admin only)
//   PATCH  /bookings/group/:groupId {patch} -> update every instance in a series (admin only)
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';

const ROOM_IDS = ['holt', 'den', 'depths'];

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[bookings] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();

  const url = new URL(req.url);
  // path after the function name
  const parts = url.pathname.replace(/^.*\/bookings/, '').split('/').filter(Boolean);

  // ---- GET: list (admin) ----
  if (req.method === 'GET') {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    const rows = await sql`SELECT data FROM bookings ORDER BY created_at ASC`;
    return json(rows.map(r => r.data));
  }

  // ---- POST: bulk create (public) ----
  if (req.method === 'POST' && parts.length === 0) {
    let body;
    try { body = await req.json(); } catch { return bad('Invalid JSON'); }
    const list = Array.isArray(body?.bookings) ? body.bookings : [];
    if (!list.length) return bad('No bookings provided');

    // Server-side double-booking guard for non-recurring single submissions.
    // (Recurring requests are reviewed per-instance by staff, so we allow them
    //  through and let the admin resolve conflicts during approval.)
    for (const b of list) {
      if (!b.id || !b.date || !b.start || !b.hours || !Array.isArray(b.rooms)) {
        return bad('Malformed booking record');
      }
    }
    if (list.length === 1) {
      const b = list[0];
      const clash = await hasConflict(b);
      if (clash) return bad('Time conflicts with an existing booking, event, or blackout', 409);
    }

    for (const b of list) {
      await sql`INSERT INTO bookings (id, data, status, group_id, date)
                VALUES (${b.id}, ${JSON.stringify(b)}::jsonb, ${b.status || 'pending'}, ${b.groupId || null}, ${b.date})
                ON CONFLICT (id) DO NOTHING`;
    }
    return json(list, 201);
  }

  // ---- PATCH: update one or group (admin) ----
  if (req.method === 'PATCH') {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    let patch;
    try { patch = await req.json(); } catch { return bad('Invalid JSON'); }

    // /bookings/group/:groupId
    if (parts[0] === 'group' && parts[1]) {
      const groupId = decodeURIComponent(parts[1]);
      const rows = await sql`SELECT data FROM bookings WHERE group_id = ${groupId}`;
      for (const row of rows) {
        const merged = { ...row.data, ...patch };
        await sql`UPDATE bookings
                  SET data = ${JSON.stringify(merged)}::jsonb,
                      status = ${merged.status || null}
                  WHERE id = ${merged.id}`;
      }
      return json({ updated: rows.length });
    }

    // /bookings/:id
    if (parts[0]) {
      const id = decodeURIComponent(parts[0]);
      const rows = await sql`SELECT data FROM bookings WHERE id = ${id}`;
      if (!rows.length) return bad('Not found', 404);
      const merged = { ...rows[0].data, ...patch };
      await sql`UPDATE bookings
                SET data = ${JSON.stringify(merged)}::jsonb,
                    status = ${merged.status || null}
                WHERE id = ${id}`;
      return json(merged);
    }
    return bad('Missing booking id');
  }

  return bad('Method not allowed', 405);
};

// Returns true if booking b overlaps any non-rejected booking, public event, or blackout.
async function hasConflict(b) {
  const startM = toMins(b.start);
  const endM = Math.min(startM + b.hours * 60, 1440);
  const wantRooms = b.rooms.length ? b.rooms : ROOM_IDS;

  // existing bookings same date
  const bk = await sql`SELECT data FROM bookings WHERE date = ${b.date} AND status <> 'rejected'`;
  for (const row of bk) {
    const r = row.data;
    const rs = toMins(r.start), re = Math.min(rs + r.hours * 60, 1440);
    if (overlap(startM, endM, rs, re) && shareRoom(wantRooms, r.rooms || ROOM_IDS)) return true;
  }
  // events + blackouts (expand recurrence)
  const evRows = await sql`SELECT data FROM events`;
  const boRow = await sql`SELECT data FROM blackouts WHERE id = 1`;
  const blockers = [
    ...evRows.flatMap(r => expand(r.data)),
    ...((boRow[0]?.data) || []).flatMap(expand)
  ];
  for (const e of blockers) {
    if (e.date !== b.date) continue;
    const es = e.allDay ? 0 : toMins(e.start);
    const ee = e.allDay ? 1440 : toMins(e.end);
    const rooms = (e.rooms && e.rooms.length) ? e.rooms : ROOM_IDS;
    if (overlap(startM, endM, es, ee) && shareRoom(wantRooms, rooms)) return true;
  }
  return false;
}
function toMins(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
function overlap(a1, a2, b1, b2) { return a1 < b2 && b1 < a2; }
function shareRoom(a, b) { return a.some(x => b.includes(x)); }
function addDays(d, n) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }
function addMonths(d, n) { const x = new Date(d + 'T12:00:00'); x.setMonth(x.getMonth() + n); return x.toISOString().slice(0, 10); }
function expand(e) {
  if (!e.recurrence) return [e];
  const out = [], { freq, count } = e.recurrence;
  let cur = e.date;
  for (let i = 0; i < count; i++) {
    out.push({ ...e, date: cur });
    cur = freq === 'weekly' ? addDays(cur, 7) : freq === 'biweekly' ? addDays(cur, 14) : addMonths(e.date, i + 1);
  }
  return out;
}
