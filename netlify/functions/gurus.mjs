// netlify/functions/gurus.mjs
// Game Guru scheduling backend (admin-only except the signed ICS feed).
//
//   GET  /gurus                          -> { assignments, shifts, unavail }   (admin Bearer)
//   GET  /gurus?feedkey=1                -> { key }  signed ICS feed key       (admin Bearer)
//   GET  /gurus?ics=1&key=...&gurus=A,B  -> text/calendar feed (public w/ key; Google Calendar subscribe)
//   POST /gurus  { action, item }        -> mutate (admin Bearer)
//        actions: save-assignment | delete-assignment
//                 save-shift      | delete-shift
//                 save-unavail    | delete-unavail
//
// HARD RULE enforced server-side: save-assignment is REJECTED (409) if any
// selected guru has an "unavailable" entry overlapping any occurrence of the
// event. Every other conflict (double-booked guru, store-shift overlap,
// tight spacing) is advisory only and handled client-side with
// proceed-anyway confirms.
//
// Data lives in one table:
//   guru_data (id TEXT PK, kind TEXT, data JSONB, created_at)
//     kind='assignment' data: { id, eventId, date|null, gurus:[..], none:bool, updatedAt }
//                             date null = applies to every occurrence;
//                             date set  = override for that one occurrence.
//     kind='shift'      data: { id, guru, date, open:"HH:MM", close:"HH:MM",
//                               recurrence:{freq,count}|null, notes }
//     kind='unavail'    data: { id, guru, date, endDate|null, allDay:bool,
//                               start, end, notes }
import { sql, ensureSchema, json, bad, noContent, preflight, requireAdmin } from './_shared/db.mjs';
import crypto from 'node:crypto';

function newId(p) { return p + '-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100); }
function feedSecret() { return process.env.ADMIN_SECRET || process.env.ADMIN_CODE || 'change-me'; }
function feedKey() { return crypto.createHmac('sha256', feedSecret()).update('guru-ics-feed-v1').digest('hex').slice(0, 32); }
function keyOk(k) {
  try { return !!k && crypto.timingSafeEqual(Buffer.from(String(k)), Buffer.from(feedKey())); }
  catch { return false; }
}

let _guruSchemaReady = false;
async function ensureGuruSchema() {
  if (_guruSchemaReady) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS guru_data (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
  } catch (e) {
    const c = e && e.code;
    if (c !== '23505' && c !== '42P07' && c !== '42710') throw e;
  }
  _guruSchemaReady = true;
}

// ---- date/time helpers (mirror booking.html conventions) ----
const pad = (n) => (n < 10 ? '0' : '') + n;
function timeToMins(t) { if (!t) return 0; const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addMonths(dateStr, n) { const d = new Date(dateStr + 'T12:00:00'); d.setMonth(d.getMonth() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function recurrenceDates(startDate, freq, count) {
  const dates = [startDate];
  for (let i = 1; i < count; i++) {
    if (freq === 'weekly') dates.push(addDays(dates[i - 1], 7));
    else if (freq === 'biweekly') dates.push(addDays(dates[i - 1], 14));
    else if (freq === 'monthly') dates.push(addMonths(startDate, i));
  }
  return dates;
}
function eventDates(e) {
  if (!e) return [];
  let dates = e.recurrence ? recurrenceDates(e.date, e.recurrence.freq, e.recurrence.count) : [e.date];
  if (e.exceptions && e.exceptions.length) dates = dates.filter((d) => e.exceptions.indexOf(d) < 0);
  return dates;
}
function shiftDates(s) {
  if (!s) return [];
  return s.recurrence ? recurrenceDates(s.date, s.recurrence.freq, s.recurrence.count) : [s.date];
}
function rangesOverlap(aS, aE, bS, bE) { return aS < bE && bS < aE; }
function inDateSpan(d, from, to) { return d >= from && d <= (to || from); }

// Unavailability check: does entry u block guru on date d between mins s..e?
function unavailBlocks(u, guru, d, allDay, s, e) {
  if (!u || u.guru !== guru) return false;
  if (!inDateSpan(d, u.date, u.endDate || u.date)) return false;
  if (u.allDay) return true;
  const us = timeToMins(u.start), ue = timeToMins(u.end);
  if (allDay) return true; // all-day event needs the guru during store day; any block conflicts
  return rangesOverlap(us, ue, s, e);
}

// ---- ICS feed ----
function icsEscape(t) { return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsDT(dateStr, timeStr) { return dateStr.replace(/-/g, '') + 'T' + (timeStr || '00:00').replace(':', '') + '00'; }
const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:America/Chicago',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE'
].join('\r\n');

function buildIcs(items) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Northwood Game Haven//Guru Schedule//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:NGH Guru Schedule', VTIMEZONE];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  for (const it of items) {
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + icsEscape(it.uid) + '@gamehaven.guru');
    lines.push('DTSTAMP:' + stamp);
    if (it.allDay) {
      lines.push('DTSTART;VALUE=DATE:' + it.date.replace(/-/g, ''));
      lines.push('DTEND;VALUE=DATE:' + addDays(it.date, 1).replace(/-/g, ''));
    } else {
      lines.push('DTSTART;TZID=America/Chicago:' + icsDT(it.date, it.start));
      lines.push('DTEND;TZID=America/Chicago:' + icsDT(it.endDate || it.date, it.end || it.start));
    }
    lines.push('SUMMARY:' + icsEscape(it.summary));
    if (it.desc) lines.push('DESCRIPTION:' + icsEscape(it.desc));
    lines.push('LOCATION:Northwood Game Haven\\, 115 W Spring St\\, Chippewa Falls\\, WI');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

async function loadAll() {
  const rows = await sql`SELECT id, kind, data FROM guru_data ORDER BY created_at ASC`;
  const out = { assignments: [], shifts: [], unavail: [] };
  for (const r of rows) {
    if (r.kind === 'assignment') out.assignments.push(r.data);
    else if (r.kind === 'shift') out.shifts.push(r.data);
    else if (r.kind === 'unavail') out.unavail.push(r.data);
  }
  return out;
}

async function loadEvents() {
  const rows = await sql`SELECT data FROM events ORDER BY created_at ASC`;
  return rows.map((r) => r.data);
}

// Occurrences (date + times) of an event, for feed/validation, capped to a window.
function occInWindow(e, from, to) {
  const out = [];
  for (const d of eventDates(e)) {
    if (d < from || d > to) continue;
    out.push({ date: d, allDay: !!e.allDay, start: e.start || null, end: e.end || e.start || null });
  }
  return out;
}

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[gurus] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  const url = new URL(req.url);

  // ---------- PUBLIC (signed) ICS FEED ----------
  if (req.method === 'GET' && url.searchParams.get('ics') === '1') {
    if (!keyOk(url.searchParams.get('key'))) return bad('bad key', 403);
    await ensureSchema(); await ensureGuruSchema();
    const filterRaw = url.searchParams.get('gurus') || '';
    const filter = filterRaw ? filterRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
    const wants = (g) => !filter || filter.indexOf(String(g).toLowerCase()) >= 0;

    const [store, events] = await Promise.all([loadAll(), loadEvents()]);
    const evById = {}; events.forEach((e) => { evById[e.id] = e; });
    const today = new Date(); const from = addDays(today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()), -7);
    const to = addDays(from, 187); // ~6 months forward

    const items = [];
    // Event assignments
    for (const a of store.assignments) {
      if (a.none || !a.gurus || !a.gurus.length) continue;
      const e = evById[a.eventId]; if (!e) continue;
      const gurus = a.gurus.filter(wants); if (!gurus.length) continue;
      const occs = occInWindow(e, from, to);
      for (const o of occs) {
        // date-specific overrides beat the event-level record for that date
        const override = store.assignments.find((x) => x.eventId === a.eventId && x.date === o.date);
        if (a.date == null && override) continue;
        if (a.date != null && a.date !== o.date) continue;
        items.push({
          uid: 'ga-' + a.eventId + '-' + o.date + '-' + gurus.join('_').replace(/\W+/g, ''),
          date: o.date, allDay: o.allDay, start: o.start, end: o.end,
          summary: gurus.join(' + ') + ' — ' + (e.title || 'NGH Event'),
          desc: 'Guru(s): ' + gurus.join(', ') + (e.notes ? ('\n' + e.notes) : '')
        });
      }
    }
    // Store shifts
    for (const s of store.shifts) {
      if (!wants(s.guru)) continue;
      for (const d of shiftDates(s)) {
        if (d < from || d > to) continue;
        items.push({
          uid: 'gs-' + s.id + '-' + d, date: d, allDay: false, start: s.open, end: s.close,
          summary: s.guru + ' — 🏪 Retail Store', desc: 'Retail store shift' + (s.notes ? ('\n' + s.notes) : '')
        });
      }
    }
    items.sort((a, b) => (a.date + (a.start || '')) < (b.date + (b.start || '')) ? -1 : 1);
    return new Response(buildIcs(items), {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="ngh-guru-schedule.ics"',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  // ---------- everything else requires admin ----------
  if (!requireAdmin(req)) return bad('unauthorized', 401);
  await ensureSchema(); await ensureGuruSchema();

  if (req.method === 'GET') {
    if (url.searchParams.get('feedkey') === '1') return json({ key: feedKey() });
    return json(await loadAll());
  }

  if (req.method === 'POST') {
    let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }
    const action = body && body.action;
    const item = (body && body.item) || {};

    if (action === 'save-assignment') {
      if (!item.eventId) return bad('eventId required');
      const gurus = Array.isArray(item.gurus) ? item.gurus.map((g) => String(g).trim()).filter(Boolean) : [];
      const none = !!item.none;
      if (!none && !gurus.length) return bad('Select at least one Guru, or choose None.');

      // HARD BLOCK: unavailability. Server-authoritative.
      if (!none && gurus.length) {
        const [events, store] = await Promise.all([loadEvents(), loadAll()]);
        const e = events.find((x) => x.id === item.eventId);
        if (!e) return bad('Event not found', 404);
        const occs = item.date
          ? [{ date: item.date, allDay: !!e.allDay, start: e.start, end: e.end }]
          : eventDates(e).map((d) => ({ date: d, allDay: !!e.allDay, start: e.start, end: e.end }));
        const s = timeToMins(e.start), en = timeToMins(e.end || e.start);
        const viol = [];
        for (const g of gurus) for (const o of occs) for (const u of store.unavail) {
          if (unavailBlocks(u, g, o.date, o.allDay, s, en)) {
            viol.push({ guru: g, date: o.date, unavailId: u.id, allDay: !!u.allDay, start: u.start || null, end: u.end || null, notes: u.notes || '' });
          }
        }
        if (viol.length) return json({ error: 'guru-unavailable', conflicts: viol }, 409);
      }

      const rec = {
        id: item.id || newId('GA'),
        eventId: item.eventId,
        date: item.date || null,
        gurus: none ? [] : gurus,
        none,
        updatedAt: new Date().toISOString()
      };
      await sql`INSERT INTO guru_data (id, kind, data) VALUES (${rec.id}, 'assignment', ${JSON.stringify(rec)}::jsonb)
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
      return json(rec, 201);
    }

    if (action === 'save-shift') {
      if (!item.guru || !item.date || !item.open || !item.close) return bad('guru, date, open, close required');
      const rec = {
        id: item.id || newId('GS'),
        guru: String(item.guru).trim(),
        date: item.date,
        open: item.open,
        close: item.close,
        recurrence: item.recurrence && item.recurrence.freq ? { freq: item.recurrence.freq, count: Math.max(1, Math.min(60, +item.recurrence.count || 1)) } : null,
        notes: item.notes || ''
      };
      await sql`INSERT INTO guru_data (id, kind, data) VALUES (${rec.id}, 'shift', ${JSON.stringify(rec)}::jsonb)
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
      return json(rec, 201);
    }

    if (action === 'save-unavail') {
      if (!item.guru || !item.date) return bad('guru and date required');
      if (!item.allDay && (!item.start || !item.end)) return bad('start and end required unless all-day');
      const rec = {
        id: item.id || newId('GU'),
        guru: String(item.guru).trim(),
        date: item.date,
        endDate: item.endDate || null,
        allDay: !!item.allDay,
        start: item.allDay ? null : item.start,
        end: item.allDay ? null : item.end,
        notes: item.notes || ''
      };
      await sql`INSERT INTO guru_data (id, kind, data) VALUES (${rec.id}, 'unavail', ${JSON.stringify(rec)}::jsonb)
                ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
      return json(rec, 201);
    }

    if (action === 'delete-assignment' || action === 'delete-shift' || action === 'delete-unavail') {
      if (!item.id) return bad('id required');
      await sql`DELETE FROM guru_data WHERE id = ${item.id}`;
      return noContent();
    }

    return bad('Unknown action');
  }

  return bad('Method not allowed', 405);
};
