// netlify/functions/registrations.mjs
// Event registrations.
//   GET  /registrations?event=<id>&date=<yyyy-mm-dd>   -> PUBLIC summary: counts only
//   GET  /registrations?mine=<email>                   -> PUBLIC: that email's own regs (full)
//   GET  /registrations                                -> ADMIN: all regs (full detail)
//   POST /registrations {registration}                 -> PUBLIC: create a registration
//   PATCH /registrations/:id {fields}                  -> ADMIN: approve/unapprove/cancel
//   DELETE /registrations/:id                           -> customer self-cancel (by token) or admin
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';

function newId() { return 'REG-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100); }

// Server-side email (no guest auth restriction — runs with server privileges).
async function sendMail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Northwood Game Haven <bookings@northwoodgamehaven.com>';
  if (!apiKey) { console.log('[registrations] email (simulated):', to, subject); return; }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text })
    });
  } catch (e) { console.error('[registrations] email failed', e); }
}
function fmtT(t){ if(!t) return ''; const p=String(t).split(':'); let h=+p[0], m=p[1], ap=h>=12?'PM':'AM', hh=h%12; if(hh===0)hh=12; return hh+':'+m+' '+ap; }

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[registrations] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/registrations/, '').split('/').filter(Boolean);
  const id = parts[0] ? decodeURIComponent(parts[0]) : null;

  if (req.method === 'GET') {
    const isAdmin = requireAdmin(req);
    const eventId = url.searchParams.get('event');
    const occDate = url.searchParams.get('date');
    const mine = (url.searchParams.get('mine') || '').trim().toLowerCase();

    if (isAdmin && !eventId && !mine) {
      const rows = await sql`SELECT data FROM registrations ORDER BY created_at ASC`;
      return json(rows.map(r => r.data));
    }
    if (mine) {
      const rows = await sql`SELECT data FROM registrations ORDER BY created_at ASC`;
      const list = rows.map(r => r.data).filter(d => d.email && d.email.trim().toLowerCase() === mine && d.status !== 'canceled');
      return json(list);
    }
    // public summary for one event occurrence: counts only (approved counts toward fire/cap)
    if (eventId) {
      const rows = await sql`SELECT data FROM registrations WHERE event_id = ${eventId} ORDER BY created_at ASC`;
      let all = rows.map(r => r.data).filter(d => d.status !== 'canceled');
      if (occDate) all = all.filter(d => d.occDate === occDate);
      const approved = all.filter(d => d.status !== 'unapproved');
      return json({ total: all.length, approved: approved.length });
    }
    return bad('event or mine parameter required', 400);
  }

  if (req.method === 'POST') {
    let reg; try { reg = await req.json(); } catch { return bad('Invalid JSON'); }
    if (!reg.eventId || !reg.name || !reg.email) return bad('eventId, name, email required');
    // verify the event exists and registration is enabled, enforce cap server-side
    const evRows = await sql`SELECT data FROM events WHERE id = ${reg.eventId}`;
    if (!evRows.length) return bad('event not found', 404);
    const ev = evRows[0].data;
    const r = ev.registration || {};
    if (!r.enabled) return bad('registration is not open for this event', 400);
    if (r.max) {
      const existing = await sql`SELECT data FROM registrations WHERE event_id = ${reg.eventId}`;
      let count = existing.map(x => x.data).filter(d => d.status !== 'canceled' && d.status !== 'unapproved');
      if (reg.occDate) count = count.filter(d => d.occDate === reg.occDate);
      if (count.length >= r.max) return bad('this event is full', 409);
    }
    reg.id = newId();
    reg.status = 'approved';          // default approved
    reg.cancelToken = Math.random().toString(36).slice(2, 12);
    reg.feePaid = false;
    reg.submitted = new Date().toISOString();
    await sql`INSERT INTO registrations (id, event_id, occ_date, data)
              VALUES (${reg.id}, ${reg.eventId}, ${reg.occDate || null}, ${JSON.stringify(reg)}::jsonb)`;

    // Confirmation emails (registrant + staff) — server-side, so both addresses allowed.
    const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
    const when = (reg.occDate || ev.date) + (ev.allDay ? '' : (', ' + fmtT(ev.start) + '–' + fmtT(ev.end)));
    const cost = Number(reg.cost) || 0;
    const costLine = cost > 0
      ? ('Cost: $' + cost.toFixed(2) + ' per person. Payment is due no later than 1 hour before the event starts — pay in person, or ' + (reg.wantsInvoice ? 'watch for an emailed invoice.' : 'request an emailed invoice.'))
      : 'This event is free.';
    await sendMail(reg.email, "You're registered: " + (ev.title || 'NGH Event'),
      'Hi ' + reg.name + ',\n\nYou are registered for ' + (ev.title || 'NGH Event') + ' on ' + when + ' at Northwood Game Haven.\n\n' + costLine + '\n\nNeed to cancel? Use the "See or cancel your registration" link on the event page.\n\nSee you at the table!\n— Northwood Game Haven');
    await sendMail(adminEmail, 'New registration: ' + (ev.title || 'NGH Event'),
      'New event registration\n\nEvent: ' + (ev.title || 'NGH Event') + '\nWhen: ' + when + '\nName: ' + reg.name + '\nEmail: ' + reg.email + '\nPhone: ' + (reg.phone || '—') + '\nComments: ' + (reg.comments || '—') + '\nInvoice requested: ' + (reg.wantsInvoice ? 'YES' : 'no') + '\n' + costLine);

    return json(reg, 201);
  }

  if (req.method === 'PATCH' && id) {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    let fields; try { fields = await req.json(); } catch { return bad('Invalid JSON'); }
    const rows = await sql`SELECT data FROM registrations WHERE id = ${id}`;
    if (!rows.length) return bad('not found', 404);
    const reg = Object.assign({}, rows[0].data, fields, { id });
    await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${id}`;
    return json(reg);
  }

  if (req.method === 'DELETE' && id) {
    // customer self-cancel with token, or admin
    const token = url.searchParams.get('token') || '';
    const rows = await sql`SELECT data FROM registrations WHERE id = ${id}`;
    if (!rows.length) return noContent();
    const reg = rows[0].data;
    const isAdmin = requireAdmin(req);
    if (!isAdmin && reg.cancelToken !== token) return bad('unauthorized', 401);
    reg.status = 'canceled';
    reg.canceledAt = new Date().toISOString();
    await sql`UPDATE registrations SET data = ${JSON.stringify(reg)}::jsonb WHERE id = ${id}`;
    return json(reg);
  }

  return bad('Method not allowed', 405);
};
