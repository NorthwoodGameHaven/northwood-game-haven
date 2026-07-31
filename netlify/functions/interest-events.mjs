// netlify/functions/interest-events.mjs
// NGH-BUILD 2026-07-31d
// Guru-only "Events of Interest" — external local events NGH may support
// (donation, vendor booth, event host, attend as NGH, sponsor, cross-promote).
// Entirely admin-gated: nothing here is ever publicly readable.
//
//   GET    /interest-events              -> list all            (admin)
//   POST   /interest-events   {item}     -> create              (admin)
//   PUT    /interest-events/:id {item}   -> update/replace      (admin)
//   DELETE /interest-events/:id          -> delete              (admin)
//   POST   /interest-events/:id/convert  -> create a linked DRAFT event on the
//          {occDate?, hostAtNGH?}           public events table, prefilled from
//                                           this item; marks item "converted".
//          The draft is then reviewed & published in the booking.html admin
//          console like any other event (drafts are hidden from customers).
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100);
}

// ---- own table bootstrap (kept local so _shared/db.mjs stays untouched) ----
let _ready = false;
function isAlreadyExists(e) {
  const c = e && e.code;
  return c === '23505' || c === '42P07' || c === '42710';
}
async function ensureInterestSchema() {
  if (_ready) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS interest_events (
      id          TEXT PRIMARY KEY,
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    )`;
  } catch (e) { if (!isAlreadyExists(e)) throw e; }
  _ready = true;
}

const SUPPORT_LABELS = {
  donation:  'Donation / prize support',
  vendor:    'Vendor booth',
  host:      'Host an event there',
  attend:    'Attend as Northwood Game Haven',
  sponsor:   'Sponsor / partner',
  promote:   'Cross-promote',
  other:     'Other'
};

function sanitize(item) {
  const out = {};
  out.title            = String(item.title || '').trim();
  out.category         = String(item.category || 'other');
  out.date             = String(item.date || '').trim();               // YYYY-MM-DD
  out.endDate          = item.endDate ? String(item.endDate).trim() : '';
  out.allDay           = item.allDay !== false;                        // default all-day
  out.start            = item.start ? String(item.start) : '';         // HH:MM
  out.end              = item.end ? String(item.end) : '';
  out.location         = String(item.location || '').trim();
  out.sourceUrl        = String(item.sourceUrl || '').trim();
  out.contact          = String(item.contact || '').trim();
  out.supportTypes     = Array.isArray(item.supportTypes) ? item.supportTypes.filter(k => SUPPORT_LABELS[k]) : [];
  out.supportOther     = String(item.supportOther || '').trim();
  out.status           = ['watching', 'considering', 'committed', 'converted', 'passed'].includes(item.status) ? item.status : 'watching';
  out.repeatWeeklyUntil = item.repeatWeeklyUntil ? String(item.repeatWeeklyUntil).trim() : '';
  out.notes            = String(item.notes || '').trim();
  out.linkedEventId    = item.linkedEventId || null;
  out.convertedAt      = item.convertedAt || null;
  return out;
}

function supportSummary(item) {
  const parts = (item.supportTypes || []).map(k => SUPPORT_LABELS[k] || k);
  if (item.supportOther) parts.push(item.supportOther);
  return parts.join(', ');
}

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[interest-events] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();

  // EVERYTHING here is Guru-only — no public reads, ever.
  if (!requireAdmin(req)) return bad('unauthorized', 401);

  await ensureInterestSchema();

  const url = new URL(req.url);
  const parts = url.pathname.replace(/^.*\/interest-events/, '').split('/').filter(Boolean);
  const id = parts[0] ? decodeURIComponent(parts[0]) : null;
  const action = parts[1] ? decodeURIComponent(parts[1]) : null;

  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM interest_events ORDER BY (data->>'date') ASC NULLS LAST, created_at ASC`;
    return json(rows.map(r => r.data));
  }

  if (req.method === 'POST' && !id) {
    let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }
    const item = sanitize(body);
    if (!item.title || !item.date) return bad('title and date required');
    item.id = newId('INT');
    item.createdAt = new Date().toISOString();
    item.updatedAt = item.createdAt;
    await sql`INSERT INTO interest_events (id, data) VALUES (${item.id}, ${JSON.stringify(item)}::jsonb)`;
    return json(item, 201);
  }

  if (req.method === 'PUT' && id && !action) {
    let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }
    const existing = await sql`SELECT data FROM interest_events WHERE id = ${id}`;
    if (!existing.length) return bad('not found', 404);
    const item = sanitize(body);
    if (!item.title || !item.date) return bad('title and date required');
    item.id = id;
    item.createdAt = existing[0].data.createdAt || null;
    // preserve conversion linkage unless explicitly changed
    if (!item.linkedEventId && existing[0].data.linkedEventId) item.linkedEventId = existing[0].data.linkedEventId;
    if (!item.convertedAt && existing[0].data.convertedAt) item.convertedAt = existing[0].data.convertedAt;
    item.updatedAt = new Date().toISOString();
    await sql`UPDATE interest_events SET data = ${JSON.stringify(item)}::jsonb WHERE id = ${id}`;
    return json(item);
  }

  if (req.method === 'DELETE' && id) {
    await sql`DELETE FROM interest_events WHERE id = ${id}`;
    return noContent();
  }

  // ---- CONVERT: spawn a linked DRAFT public event ----
  if (req.method === 'POST' && id && action === 'convert') {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const rows = await sql`SELECT data FROM interest_events WHERE id = ${id}`;
    if (!rows.length) return bad('not found', 404);
    const item = rows[0].data;

    await ensureSchema(); // events table

    const occDate = (body.occDate && /^\d{4}-\d{2}-\d{2}$/.test(body.occDate)) ? body.occDate : item.date;
    const hostAtNGH = !!body.hostAtNGH;

    const noteLines = [];
    noteLines.push('Created from Event of Interest ' + item.id + ' — ' + (item.category || 'other') + '.');
    const sup = supportSummary(item);
    if (sup) noteLines.push('Support plan: ' + sup + '.');
    if (item.sourceUrl) noteLines.push('Source: ' + item.sourceUrl);
    if (item.contact) noteLines.push('Contact: ' + item.contact);
    if (item.notes) noteLines.push('Guru notes: ' + item.notes);

    const ev = {
      id: newId('EVT'),
      title: item.title,
      date: occDate,
      allDay: !!item.allDay,
      start: item.allDay ? '' : (item.start || ''),
      end:   item.allDay ? '' : (item.end || ''),
      rooms: [],                               // draft holds no rooms until a Guru assigns them
      offsite: !hostAtNGH,
      offsiteLocation: !hostAtNGH ? (item.location || '') : '',
      notes: noteLines.join('\n'),
      status: 'draft',                         // hidden from customers until published in booking admin
      public: true,
      interestRef: item.id
    };
    await sql`INSERT INTO events (id, data) VALUES (${ev.id}, ${JSON.stringify(ev)}::jsonb)`;

    item.status = 'converted';
    item.linkedEventId = ev.id;
    item.convertedAt = new Date().toISOString();
    item.updatedAt = item.convertedAt;
    await sql`UPDATE interest_events SET data = ${JSON.stringify(item)}::jsonb WHERE id = ${id}`;

    return json({ interest: item, event: ev }, 201);
  }

  return bad('Method not allowed', 405);
};
