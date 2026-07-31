// netlify/functions/birthday.mjs
// POST  — receives a birthday party booking request from site/birthday.html.
//         Saves it to the database (so staff can review it in the Guru Hub),
//         then emails the full request to staff (ADMIN_EMAIL) and a branded
//         confirmation to the customer. No payment is taken here; staff
//         confirm availability and send a payment link.
//         Includes a honeypot field ("website") for spam.
// GET   — (admin) list all birthday requests, newest first.
// PATCH /birthday/:id — (admin) update {status, staffNotes, linkedBookingId}.
//         Statuses: new | contacted | confirmed | declined | archived
import { sql, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';

const clip = (v, max) => String(v ?? "").replace(/[\r\u0000-\u0008\u000B-\u001F]/g, "").slice(0, max).trim();

const STATUSES = ['new', 'contacted', 'confirmed', 'declined', 'archived'];

// Same concurrency-safe bootstrap pattern as _shared/db.mjs ensureSchema().
let _ready = false;
function isAlreadyExists(e) {
  const c = e && e.code;
  return c === '23505' || c === '42P07' || c === '42710';
}
async function ensureBirthdaySchema() {
  if (_ready) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS birthday_requests (
      id            TEXT PRIMARY KEY,
      data          JSONB NOT NULL,
      status        TEXT,
      date          DATE,
      created_at    TIMESTAMPTZ DEFAULT now()
    )`;
  } catch (e) { if (!isAlreadyExists(e)) throw e; }
  _ready = true;
}

function newId() {
  const n = Math.floor(Math.random() * 900) + 100;
  return 'BDAY-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + n;
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/birthday/, '').split('/').filter(Boolean);

  /* ---------- GET (admin): list requests ---------- */
  if (req.method === 'GET') {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    await ensureBirthdaySchema();
    const rows = await sql`SELECT data FROM birthday_requests ORDER BY created_at DESC`;
    return json({ requests: rows.map(r => r.data) });
  }

  /* ---------- PATCH /birthday/:id (admin): update review fields ---------- */
  if (req.method === 'PATCH') {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    const id = parts[0];
    if (!id) return bad('id required');
    let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }
    await ensureBirthdaySchema();
    const rows = await sql`SELECT data FROM birthday_requests WHERE id = ${id}`;
    if (!rows.length) return bad('not found', 404);
    const rec = rows[0].data;
    if (body.status !== undefined) {
      const st = clip(body.status, 20);
      if (!STATUSES.includes(st)) return bad('invalid status');
      rec.status = st;
    }
    if (body.staffNotes !== undefined) rec.staffNotes = clip(body.staffNotes, 2000);
    if (body.linkedBookingId !== undefined) rec.linkedBookingId = clip(body.linkedBookingId, 40);
    rec.updatedAt = new Date().toISOString();
    await sql`UPDATE birthday_requests SET data = ${JSON.stringify(rec)}::jsonb, status = ${rec.status} WHERE id = ${id}`;
    return json({ ok: true, request: rec });
  }

  if (req.method !== 'POST') return bad('Method not allowed', 405);

  /* ---------- POST (public): new request ---------- */
  let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }

  // Honeypot — bots fill it, humans never see it. Pretend success.
  if (clip(body.website, 50)) return json({ ok: true });

  const pkg      = clip(body.package, 80);
  const audience = clip(body.audience, 10) === 'kids' ? 'Kids' : 'Adults 21+';
  const date     = clip(body.date, 20);
  const time     = clip(body.time, 20);
  const guests   = clip(body.guests, 6);
  const heroName = clip(body.heroName, 80);
  const heroAge  = clip(body.heroAge, 4);
  const name     = clip(body.name, 120);
  const email    = clip(body.email, 160);
  const phone    = clip(body.phone, 30);
  const notes    = clip(body.notes, 1000);
  const videoGames = clip(body.videoGames, 600);
  const boardGames = clip(body.boardGames, 600);
  const addons = Array.isArray(body.addons) ? body.addons.map(a => clip(a, 140)).filter(Boolean).slice(0, 12) : [];

  if (!pkg)  return bad('package required');
  if (!date) return bad('date required');
  if (!time) return bad('time required');
  if (!name) return bad('name required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('valid email required');
  if (!guests || Number(guests) < 1) return bad('guest count required');

  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';

  // 1) Persist FIRST — the request must never exist only as an email.
  //    (If the database write fails we still send the emails, so nothing
  //    is lost either way; the id just won't appear in the Guru Hub.)
  const rec = {
    id: newId(), package: pkg, audience, date, time, guests,
    heroName, heroAge, name, email, phone, notes, videoGames, boardGames, addons,
    status: 'new', staffNotes: '', linkedBookingId: '',
    submitted: new Date().toISOString(),
  };
  let saved = false;
  try {
    await ensureBirthdaySchema();
    await sql`INSERT INTO birthday_requests (id, data, status, date)
              VALUES (${rec.id}, ${JSON.stringify(rec)}::jsonb, ${rec.status}, ${date})`;
    saved = true;
  } catch (e) {
    console.error('[birthday] DB save failed (continuing with email)', e);
  }

  const detailLines = [
    `Request ID:    ${rec.id}${saved ? '' : '  (⚠ DB save failed — email is the only copy)'}`,
    `Package:       ${pkg}  (${audience})`,
    `Date:          ${date}`,
    `Start time:    ${time}`,
    `Guests:        ${guests}`,
    heroName ? `Birthday hero: ${heroName}${heroAge ? ` (turning ${heroAge})` : ''}` : '',
    '',
    `Contact:       ${name}`,
    `Email:         ${email}`,
    phone ? `Phone:         ${phone}` : '',
    '',
    addons.length ? 'Add-ons requested:\n' + addons.map(a => `  • ${a}`).join('\n') : 'Add-ons requested: (none)',
    '',
    videoGames ? `Video game requests:\n${videoGames}` : '',
    boardGames ? `Board game requests:\n${boardGames}` : '',
    notes ? `Notes:\n${notes}` : ''
  ].filter(l => l !== '').join('\n');

  // 2) Staff notification
  const site = process.env.SITE_URL || process.env.URL || 'https://gamehaven.guru';
  const staffResult = await sendBrandedMail(
    adminEmail,
    `🎂 Birthday party request — ${pkg} on ${date}`,
    {
      heading: 'New Birthday Party Request',
      bodyText: detailLines + '\n\nReview it in the Guru Hub (Birthday Requests), reply to the customer to confirm availability, then create the booking to hold the room and send a payment link to lock the date.',
      buttons: [{ label: '🦦 Open Guru Hub', url: site + '/guru.html#birthdays', primary: true }],
      replyTo: email
    }
  );
  if (!staffResult.ok && !staffResult.simulated) {
    console.error('[birthday] staff email failed', staffResult);
    // If the record saved, the request is still reviewable in the Hub — don't fail the customer.
    if (!saved) return bad('Email provider error', 502);
  }

  // 3) Customer confirmation (best-effort; the request already reached staff)
  const custBody = [
    `Hi ${name},`,
    '',
    `We got your birthday party request — here's what you asked for:`,
    '',
    `Package:    ${pkg}`,
    `Date:       ${date} at ${time}`,
    `Guests:     ${guests}`,
    heroName ? `Guest of honor: ${heroName}${heroAge ? ` (turning ${heroAge})` : ''}` : '',
    addons.length ? '\nAdd-ons: ' + addons.join('; ') : '',
    '',
    `We'll confirm your date within one business day and send a secure payment link to lock it in. Nothing is due until then.`,
    '',
    `Every party includes the Party Float Kit, and bringing your own cake is always welcome at no charge.`,
    '',
    `Questions in the meantime? Just reply to this email or call/text 715-379-4946.`,
    '',
    `"I never forget a birthday. Mostly because there's cake." — Stash the Otter`
  ].filter(l => l !== null).join('\n');

  const custResult = await sendBrandedMail(
    email,
    'Your birthday party request — Northwood Game Haven',
    { heading: '🎂 Party Request Received!', bodyText: custBody }
  );
  if (!custResult.ok && !custResult.simulated) {
    console.warn('[birthday] customer confirmation failed (request still delivered to staff)', custResult);
  }

  return json({ ok: true, id: rec.id });
};
