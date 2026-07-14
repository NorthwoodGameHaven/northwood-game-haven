// netlify/functions/bookings.mjs
// Routes (all under /.netlify/functions):
//   GET    /bookings                      -> list all (admin only)
//   POST   /bookings        { bookings:[] } -> bulk insert (public; server-side conflict check)
//   PATCH  /bookings/:id    { ...patch }    -> update one (admin only)
//   PATCH  /bookings/group/:groupId {patch} -> update every instance in a series (admin only)
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { checkWindow, loadBlockers, describe, toMins as cToMins, MIN_GAP_MINS } from './_shared/conflicts.mjs';

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

  // ---- GET: list ----
  // Admin (authenticated) gets full records. Public callers get a SAFE subset
  // — only what's needed to show availability (date, time, rooms, status) with
  // no names, emails, phones, or notes. This lets the customer page check for
  // conflicts without exposing anyone's private details.
  //
  // Special case: GET /bookings?mine=<email> returns FULL detail for ONLY the
  // bookings matching that exact email (case-insensitive). This powers the
  // customer "see my own bookings" lookup without exposing anyone else's.
  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM bookings ORDER BY created_at ASC`;
    if (requireAdmin(req)) {
      return json(rows.map(r => r.data));
    }
    const mine = (url.searchParams.get('mine') || '').trim().toLowerCase();
    const active = rows.filter(r => r.data && r.data.status !== 'rejected');
    const publicRows = active.map(r => {
      const d = r.data;
      const isMine = mine && d.email && d.email.trim().toLowerCase() === mine;
      if (isMine) {
        // their own booking — full detail
        return Object.assign({}, d, { mine: true });
      }
      // someone else's — anonymized busy block
      return {
        id: d.id, status: d.status, date: d.date, start: d.start,
        hours: d.hours, rooms: d.rooms, groupId: d.groupId ? true : false,
        endLabel: d.endLabel, name: 'Reserved', mine: false
      };
    });
    return json(publicRows);
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
      const blockers = await loadBlockers(sql);
      const startM = cToMins(b.start);
      const { red, tight } = checkWindow(
        { date: b.date, startM, endM: startM + (Number(b.hours) || 1) * 60, rooms: b.rooms },
        blockers,
        { ignoreBookingId: b.id }
      );
      if (red.length) {
        return json({ error: 'Time conflicts with an existing booking, event, or blackout — ' + describe(red), code: 'overlap', conflicts: red }, 409);
      }
      if (tight.length && !body.allowTight) {
        return json({ error: 'Back-to-back with less than ' + MIN_GAP_MINS + ' minutes of changeover — ' + describe(tight), code: 'tight', conflicts: tight }, 409);
      }
    }

    for (const b of list) {
      await sql`INSERT INTO bookings (id, data, status, group_id, date)
                VALUES (${b.id}, ${JSON.stringify(b)}::jsonb, ${b.status || 'pending'}, ${b.groupId || null}, ${b.date})
                ON CONFLICT (id) DO NOTHING`;
    }
    // Notify the customer (acknowledgement) and the Game Guru (review request).
    // Best-effort: never fail the booking if email has a hiccup.
    try { await notifyNewBooking(list); } catch (e) { console.error('[bookings] notify email failed', e); }
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

// ---- email notifications on a new booking request ----
function fmtT(t) { if (!t) return ''; const p = String(t).split(':'); let h = +p[0]; const m = p[1], ap = h >= 12 ? 'PM' : 'AM'; let hh = h % 12; if (hh === 0) hh = 12; return hh + ':' + m + ' ' + ap; }
function roomLabel(id) { return ({ holt: 'The Holt', den: "Stash's Den", depths: 'The Depths' })[id] || id; }

async function notifyNewBooking(list) {
  if (!list || !list.length) return;
  const first = list[0];
  const SITE = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
  const rooms = (first.rooms || []).map(roomLabel).join(', ') || '—';
  const dates = list.map(b => b.date).join(', ');
  const recurring = list.length > 1;
  const whenLine = (recurring ? (list.length + ' dates (' + dates + ')') : first.date) +
    ' · ' + fmtT(first.start) + (first.endLabel ? ('–' + first.endLabel) : '');
  const addonList = (first.addons || []).map(a => a.title + (a.qty ? (' ×' + a.qty) : '')).join(', ') || 'None';

  // 1) Customer acknowledgement
  if (first.email) {
    await sendBrandedMail(
      first.email,
      'We got your booking request — Northwood Game Haven',
      {
        heading: 'Request received! 🎲',
        bodyText:
          'Hi ' + (first.name || 'there') + ',\n\n' +
          'Thanks for your play-space booking request at Northwood Game Haven. A Game Guru will review it and reply within 1 business day to confirm your reservation and send secure links to pay your booking fee and refundable deposit.\n\n' +
          'What you requested:\n' +
          'Room(s): ' + rooms + '\n' +
          'When: ' + whenLine + '\n' +
          'Duration: ' + first.hours + ' hour(s)\n' +
          'Add-ons: ' + addonList + '\n\n' +
          'Questions? Just reply to this email or reach us at ' + adminEmail + '.\n\n' +
          '— The Northwood Game Haven Gurus',
        buttons: [{ label: 'Visit gamehaven.guru', url: SITE, primary: false }],
        replyTo: adminEmail
      }
    );
  }

  // 2) Game Guru notification
  await sendBrandedMail(
    adminEmail,
    'New booking request: ' + rooms + ' on ' + first.date,
    {
      heading: '📥 New Booking Request',
      bodyText:
        'A new play-space booking request was submitted.\n\n' +
        'Name: ' + (first.name || '—') + '\n' +
        'Email: ' + (first.email || '—') + '\n' +
        'Phone: ' + (first.phone || '—') + '\n' +
        'Max concurrent guests: ' + (first.guests || '—') + '\n\n' +
        'Room(s): ' + rooms + '\n' +
        'When: ' + whenLine + '\n' +
        'Duration: ' + first.hours + ' hour(s)\n' +
        (recurring ? ('Recurring: ' + list.length + ' occurrences\n') : '') +
        'Add-ons: ' + addonList + '\n' +
        'Military / first-responder discount: ' + (first.milRequested ? 'REQUESTED (verify ID)' : 'no') + '\n\n' +
        'Review and approve in the Guru Console.',
      buttons: [{ label: 'Open Guru Console', url: SITE + '/booking.html?admin=1', primary: true }],
      replyTo: first.email || undefined
    }
  );
}
