// netlify/functions/checkin.mjs
// Staff check-in by ticket QR. Admin Bearer token required (same token as the
// booking console / site/checkin.html scanner page).
//
//   GET  /checkin?code=<ticketCode-or-URL>   -> party preview (no changes)
//   POST /checkin { code, count }            -> check in `count` people
//   POST /checkin { code, undo: n }          -> undo n check-ins (fat-finger fix)
//
// `code` may be the raw ticket code ("REG-XXXX.sig") or the full ticket URL
// the QR encodes — we extract the code either way.
import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { parseTicketCode } from './_shared/ticket.mjs';

function extractCode(input) {
  const s = String(input || '').trim();
  const m = /\/ticket\/([A-Za-z0-9\-]+\.[a-f0-9]{20})/.exec(s);
  return m ? m[1] : s;
}
function view(r) {
  const qty = Math.max(1, parseInt(r.qty, 10) || 1);
  return {
    id: r.id,
    eventId: r.eventId,
    eventTitle: r.eventTitle || 'NGH Event',
    occDate: r.occDate || null,
    name: r.name,
    attendees: Array.isArray(r.attendees) && r.attendees.length ? r.attendees : [r.name],
    qty,
    checkedIn: Number(r.checkedIn) || 0,
    remaining: Math.max(0, qty - (Number(r.checkedIn) || 0)),
    status: r.status,
    feePaid: !!r.feePaid,
    cost: Number(r.cost) || 0,
    amountPaidCents: Number(r.amountPaidCents) || 0
  };
}

export default async (req) => {
  try {
    if (req.method === 'OPTIONS') return preflight();
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    await ensureSchema();

    let code, count = 0, undo = 0;
    if (req.method === 'GET') {
      const u = new URL(req.url);
      code = extractCode(u.searchParams.get('code'));
    } else if (req.method === 'POST') {
      let p; try { p = await req.json(); } catch { return bad('Invalid JSON'); }
      code = extractCode(p.code);
      count = Math.max(0, parseInt(p.count, 10) || 0);
      undo = Math.max(0, parseInt(p.undo, 10) || 0);
    } else {
      return bad('Method not allowed', 405);
    }

    const regId = parseTicketCode(code);
    if (!regId) return bad('not a valid NGH ticket code', 404);
    const rows = await sql`SELECT data FROM registrations WHERE id = ${regId}`;
    if (!rows.length) return bad('registration not found', 404);
    const r = rows[0].data;

    if (req.method === 'GET') return json(view(r));

    if (r.status === 'canceled') return bad('this registration was CANCELED — do not admit', 409);

    const qty = Math.max(1, parseInt(r.qty, 10) || 1);
    const already = Number(r.checkedIn) || 0;

    if (undo > 0) {
      r.checkedIn = Math.max(0, already - undo);
      r.checkins = (r.checkins || []).concat([{ at: new Date().toISOString(), count: -undo }]);
      await sql`UPDATE registrations SET data = ${JSON.stringify(r)}::jsonb WHERE id = ${regId}`;
      return json(Object.assign(view(r), { undone: undo }));
    }

    if (count < 1) return bad('count required', 400);
    if (already >= qty) return bad('all ' + qty + ' ticket' + (qty === 1 ? '' : 's') + ' on this registration are already checked in', 409);
    const admitted = Math.min(count, qty - already);
    r.checkedIn = already + admitted;
    r.checkins = (r.checkins || []).concat([{ at: new Date().toISOString(), count: admitted }]);
    await sql`UPDATE registrations SET data = ${JSON.stringify(r)}::jsonb WHERE id = ${regId}`;
    return json(Object.assign(view(r), { admitted }));
  } catch (e) {
    console.error('[checkin] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};
