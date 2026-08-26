// netlify/functions/retro.mjs                          NGH-BUILD 2026-08-26c
// Event Retrospectives — the "lessons learned" loop (WI-105 in software form).
// Admin only. Powers site/guru-retro.html, the carryover banner in the
// booking-console event editor, and the carryover strip on guru-promo.html.
//
//   GET  /retro?queue=1            -> { today, due[], upcoming[], recent[] }
//        due:      past occurrences (last 60 days) of non-draft events that
//                  have NO retro yet, with auto-metrics (regs / check-ins /
//                  revenue) precomputed from the registrations table.
//        upcoming: occurrences in the next 21 days whose event still has OPEN
//                  improvement actions from earlier retros.
//        recent:   the 20 most recently written retros.
//   GET  /retro?event=EVT-…        -> { event, occurrences[], retros[] }
//                  full history for one event: every past occurrence with its
//                  auto-metrics and retro (if written), newest first.
//   GET  /retro?carryover=EVT-…    -> { eventId, actions[] }  open actions
//                  only, newest retro first (event-editor banner).
//   GET  /retro?feed=promo         -> { actions[] }  open PROMOTION actions
//                  for events with an occurrence in the next 7 days
//                  (guru-promo.html carryover strip).
//   POST /retro { retro:{...} }    -> upsert one retro (keyed eventId+occDate)
//   POST /retro { actionDone:{ retroId, actionId, status } } -> tick an action
//
// Retro shape (data JSONB):
//   { id, eventId, occDate, guru, ts, updated,
//     targets:{ attendance, revenue },
//     actuals:{ regs, checkedIn, revenue, attendance, notes },
//     scores:{ turnout, energy, promo, prizes, logistics },   // 0–5
//     wins, issues,
//     actions:[ { id, area, text, assignee, status:'open'|'done', ts, doneAt } ] }
// action.assignee: the Guru who owns carrying this into the next plan (CI owner).
// retro.decision (v2026-08-26c): the recorded G3 outcome for that occurrence —
//   continue | move | narrow | split | graduate | handoff | retire  (SOP §6.5).
// Series health (v2026-08-26c): ?health=1 auto-evaluates the ATTENDANCE pivot
// triggers from check-in / retro data, so the portfolio review reads flags:
//   move    — 3 straight occurrences under ~4 attending
//   split   — 3 straight occurrences over ~12
//   declining — newest 3 average ≥25% below the previous 3
// action.area: promotion | details | prizes | scheduling | other — the area
// tag is what routes a lesson forward (promo tracker vs. event editor).
import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { expandOccurrences } from './_shared/conflicts.mjs';
import { chicagoToday } from './_shared/promo.mjs';

let _ready = false;
function isAlreadyExists(e) { const c = e && e.code; return c === '23505' || c === '42P07' || c === '42710'; }
async function ensureRetros() {
  if (_ready) return;
  try {
    await sql`CREATE TABLE IF NOT EXISTS event_retros (
      id         TEXT PRIMARY KEY,
      event_id   TEXT NOT NULL,
      occ_date   DATE NOT NULL,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
  } catch (e) { if (!isAlreadyExists(e)) throw e; }
  try {
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS event_retros_ev_occ
              ON event_retros (event_id, occ_date)`;
  } catch (e) { if (!isAlreadyExists(e)) throw e; }
  _ready = true;
}

/* ---------------- helpers ---------------- */
const ymd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function addDaysYmd(s, n) {
  const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const AREAS = ['promotion', 'details', 'prizes', 'scheduling', 'other'];
function clampScore(v) { const n = parseInt(v, 10); return isFinite(n) ? Math.max(0, Math.min(5, n)) : 0; }
function numOrNull(v) { const n = Number(v); return isFinite(n) && v !== '' && v !== null ? n : null; }

// registrations aggregated per eventId -> occDate -> {regs, checkedIn, revenue}
// Regs with no occ_date (single-date events) are keyed '' and folded onto the
// event's own date by the callers.
async function loadRegAgg() {
  const rows = await sql`SELECT event_id, data FROM registrations`;
  const agg = {};
  for (const r of rows) {
    const d = r.data || {};
    const st = String(d.status || '').toLowerCase();
    if (st === 'canceled' || st === 'cancelled' || st === 'rejected' || st === 'removed') continue;
    const ev = r.event_id || d.eventId; if (!ev) continue;
    // occDate comes from the JSONB (always a plain YYYY-MM-DD string) — the
    // DATE column can come back as a JS Date object depending on the driver.
    const occ = ymd(d.occDate) ? d.occDate : '';
    const slot = ((agg[ev] = agg[ev] || {})[occ] = agg[ev][occ] || { regs: 0, checkedIn: 0, revenue: 0 });
    slot.regs      += Math.max(1, parseInt(d.qty, 10) || 1);
    slot.checkedIn += Number(d.checkedIn) || 0;
    slot.revenue   += (Number(d.amountPaidCents) || 0) / 100;
  }
  return agg;
}
function metricsFor(agg, eventId, occDate, eventDate) {
  const per = agg[eventId] || {};
  const m = { regs: 0, checkedIn: 0, revenue: 0 };
  const hit = per[occDate];
  if (hit) { m.regs += hit.regs; m.checkedIn += hit.checkedIn; m.revenue += hit.revenue; }
  // undated regs belong to a single-date event's one occurrence
  if (per[''] && occDate === eventDate) { m.regs += per[''].regs; m.checkedIn += per[''].checkedIn; m.revenue += per[''].revenue; }
  m.revenue = Math.round(m.revenue * 100) / 100;
  return m;
}
async function loadEvents() {
  const rows = await sql`SELECT data FROM events ORDER BY created_at ASC`;
  return rows.map(r => r.data).filter(e => e && e.id);
}
async function loadRetros(eventId) {
  const rows = eventId
    ? await sql`SELECT data FROM event_retros WHERE event_id = ${eventId} ORDER BY occ_date DESC`
    : await sql`SELECT data FROM event_retros ORDER BY occ_date DESC`;
  return rows.map(r => r.data);
}
function openActionsOf(retros) {
  const out = [];
  for (const rt of retros) {
    for (const a of (rt.actions || [])) {
      if ((a.status || 'open') === 'open') {
        out.push({ retroId: rt.id, id: a.id, area: a.area || 'other', text: a.text || '',
                   assignee: a.assignee || '', occDate: rt.occDate, ts: a.ts || rt.ts });
      }
    }
  }
  return out;
}

const DECISIONS = ['continue', 'move', 'narrow', 'split', 'graduate', 'handoff', 'retire'];

/* Series health — auto-evaluated attendance pivot triggers (SOP §6.5).
   Attendance per occurrence prefers the retro's human numbers (actuals.attendance,
   then actuals.checkedIn) and falls back to ticketing check-ins; occurrences with
   no data at all are skipped so unticketed nights without retros don't read as 0. */
function seriesHealth(events, agg, retrosByEvent, today) {
  const out = [];
  for (const ev of events) {
    if (ev.status === 'draft' || !ev.recurrence) continue;
    const byOcc = {}; (retrosByEvent[ev.id] || []).forEach(rt => { byOcc[rt.occDate] = rt; });
    const occs = expandOccurrences(ev).map(o => o.date)
      .filter(d => d && d < today).sort().slice(-6);
    const series = [];
    for (const d of occs) {
      const rt = byOcc[d];
      let att = null;
      if (rt && rt.actuals) {
        if (rt.actuals.attendance != null) att = Number(rt.actuals.attendance);
        else if (rt.actuals.checkedIn != null) att = Number(rt.actuals.checkedIn);
      }
      if (att == null) {
        const m = metricsFor(agg, ev.id, d, ev.date);
        if (m.checkedIn > 0 || m.regs > 0) att = m.checkedIn;
      }
      if (att != null && isFinite(att)) series.push({ date: d, att });
    }
    if (series.length < 3) continue;
    const last3 = series.slice(-3).map(s => s.att);
    let flag = null, msg = '';
    if (last3.every(a => a < 4)) { flag = 'move'; msg = '3 straight under ~4 attending — try a new day or time before killing the concept (SOP §6.5).'; }
    else if (last3.every(a => a > 12)) { flag = 'split'; msg = '3 straight over ~12 — spin off a second night as its own event, with its own scores.'; }
    else if (series.length >= 4) {
      const newer = last3.reduce((a, b) => a + b, 0) / 3;
      const prev = series.slice(0, -3).slice(-3);
      const older = prev.reduce((a, b) => a + b.att, 0) / prev.length;
      if (older > 0 && newer <= older * 0.75) { flag = 'declining'; msg = 'Attendance down ' + Math.round((1 - newer / older) * 100) + '% vs the prior runs — worth a look before the trigger trips.'; }
    }
    if (flag) out.push({ eventId: ev.id, title: ev.title || 'NGH event', flag, msg, series });
  }
  return out;
}

/* ---------------- handler ---------------- */
export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[retro] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (!requireAdmin(req)) return bad('unauthorized', 401);
  await ensureSchema();
  await ensureRetros();

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const q = (k) => url.searchParams.get(k);

    /* ---- one event's full history ---- */
    if (q('event')) {
      const eventId = String(q('event'));
      const events = await loadEvents();
      const ev = events.find(e => e.id === eventId);
      if (!ev) return bad('event not found', 404);
      const today = chicagoToday();
      const agg = await loadRegAgg();
      const retros = await loadRetros(eventId);
      const byOcc = {}; retros.forEach(rt => { byOcc[rt.occDate] = rt; });
      const occurrences = expandOccurrences(ev)
        .filter(o => o.date && o.date < today)
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .map(o => ({ occDate: o.date, ...metricsFor(agg, eventId, o.date, ev.date), retro: byOcc[o.date] || null }));
      return json({
        event: { id: ev.id, title: ev.title || 'NGH event', date: ev.date,
                 recurrence: ev.recurrence || null, status: ev.status || 'live',
                 strategyType: (ev.strategy && ev.strategy.type) || null },
        occurrences, retros
      });
    }

    /* ---- open actions for one event (editor banner) ---- */
    if (q('carryover')) {
      const eventId = String(q('carryover'));
      const retros = await loadRetros(eventId);
      return json({ eventId, actions: openActionsOf(retros) });
    }

    /* ---- CI planning feed: open actions from prior runs AND related/similar
            events, for the Draft Review console + event editor. Relatedness:
            prior run (same id) > similar title (shared meaningful token) >
            same strategy type. ---- */
    if (q('planning')) {
      const eventId = String(q('planning'));
      const events = await loadEvents();
      const srcEv = events.find(e => e.id === eventId) || null;
      const srcTitle = q('title') || (srcEv && srcEv.title) || '';
      const srcType = q('type') || (srcEv && srcEv.strategy && (srcEv.strategy.typeKey || srcEv.strategy.type)) || null;
      const stop = { the:1, and:1, night:1, day:1, event:1, ngh:1, weekly:1, monthly:1, club:1 };
      const toks = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/).filter(w => w.length >= 3 && !stop[w]);
      const st = toks(srcTitle);
      const retros = await loadRetros(null);
      const byEvent = {};
      retros.forEach(rt => { (byEvent[rt.eventId] = byEvent[rt.eventId] || []).push(rt); });
      const rank = { 'prior run': 0, 'similar title': 1, 'same strategy type': 2 };
      const actions = [];
      for (const ev of events) {
        const open = openActionsOf(byEvent[ev.id] || []);
        if (!open.length) continue;
        let rel = null;
        if (ev.id === eventId) rel = 'prior run';
        else if (st.length && toks(ev.title).some(w => st.indexOf(w) >= 0)) rel = 'similar title';
        else {
          const t = ev.strategy && (ev.strategy.typeKey || ev.strategy.type);
          if (srcType && t && String(t) === String(srcType)) rel = 'same strategy type';
        }
        if (!rel) continue;
        open.forEach(a => actions.push({ ...a, sourceEventId: ev.id,
          sourceTitle: ev.title || 'NGH event', relation: rel }));
      }
      actions.sort((a, b) => (rank[a.relation] - rank[b.relation]) ||
        ((a.occDate || '') < (b.occDate || '') ? 1 : -1));
      return json({ eventId, actions: actions.slice(0, 25) });
    }

    /* ---- series health: auto-evaluated pivot triggers ---- */
    if (q('health')) {
      const today = chicagoToday();
      const events = await loadEvents();
      const agg = await loadRegAgg();
      const retros = await loadRetros(null);
      const byEvent = {};
      retros.forEach(rt => { (byEvent[rt.eventId] = byEvent[rt.eventId] || []).push(rt); });
      return json({ health: seriesHealth(events, agg, byEvent, today) });
    }

    /* ---- hub stat tile counts ---- */
    if (q('stats')) {
      const today = chicagoToday(), since = addDaysYmd(today, -60);
      const events = await loadEvents();
      const agg = await loadRegAgg();
      const retros = await loadRetros(null);
      const have = {}; retros.forEach(rt => { have[rt.eventId + '|' + rt.occDate] = true; });
      const byEvent = {};
      retros.forEach(rt => { (byEvent[rt.eventId] = byEvent[rt.eventId] || []).push(rt); });
      let retrosDue = 0, openActions = 0;
      retros.forEach(rt => (rt.actions || []).forEach(a => { if ((a.status || 'open') === 'open') openActions++; }));
      for (const ev of events) {
        if (ev.status === 'draft') continue;
        for (const o of expandOccurrences(ev)) {
          if (o.date && o.date >= since && o.date < today && !have[ev.id + '|' + o.date]) retrosDue++;
        }
      }
      const pivotFlags = seriesHealth(events, agg, byEvent, today).length;
      return json({ retrosDue, openActions, pivotFlags });
    }

    /* ---- open promotion actions for the promo tracker ---- */
    if (q('feed') === 'promo') {
      const today = chicagoToday(), horizon = addDaysYmd(today, 7);
      const events = await loadEvents();
      const retros = await loadRetros(null);
      const byEvent = {};
      retros.forEach(rt => { (byEvent[rt.eventId] = byEvent[rt.eventId] || []).push(rt); });
      const actions = [];
      for (const ev of events) {
        if (ev.status === 'draft') continue;
        const open = openActionsOf(byEvent[ev.id] || []).filter(a => a.area === 'promotion');
        if (!open.length) continue;
        const next = expandOccurrences(ev).map(o => o.date)
          .filter(d => d && d >= today && d <= horizon).sort()[0];
        if (!next) continue;
        open.forEach(a => actions.push({ ...a, eventId: ev.id, eventTitle: ev.title || 'NGH event', nextDate: next }));
      }
      actions.sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
      return json({ actions });
    }

    /* ---- default: the queue (due + upcoming carryover + recent) ---- */
    const today = chicagoToday();
    const since = addDaysYmd(today, -60), horizon = addDaysYmd(today, 21);
    const events = await loadEvents();
    const agg = await loadRegAgg();
    const retros = await loadRetros(null);
    const have = {}; retros.forEach(rt => { have[rt.eventId + '|' + rt.occDate] = true; });
    const byEvent = {};
    retros.forEach(rt => { (byEvent[rt.eventId] = byEvent[rt.eventId] || []).push(rt); });

    const due = [], upcoming = [];
    for (const ev of events) {
      if (ev.status === 'draft') continue;
      const occs = expandOccurrences(ev).map(o => o.date).filter(Boolean);
      for (const d of occs) {
        if (d >= since && d < today && !have[ev.id + '|' + d]) {
          due.push({ eventId: ev.id, title: ev.title || 'NGH event', occDate: d,
                     recurring: !!ev.recurrence, strategyType: (ev.strategy && ev.strategy.type) || null,
                     ...metricsFor(agg, ev.id, d, ev.date) });
        }
      }
      const open = openActionsOf(byEvent[ev.id] || []);
      if (open.length) {
        const next = occs.filter(d => d >= today && d <= horizon).sort()[0];
        if (next) upcoming.push({ eventId: ev.id, title: ev.title || 'NGH event', occDate: next, openActions: open });
      }
    }
    due.sort((a, b) => (a.occDate < b.occDate ? 1 : -1));
    upcoming.sort((a, b) => (a.occDate < b.occDate ? -1 : 1));
    const recent = retros
      .slice().sort((a, b) => ((b.updated || b.ts || '') < (a.updated || a.ts || '') ? -1 : 1))
      .slice(0, 20);
    return json({ today, due, upcoming, recent });
  }

  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }

    /* ---- tick a single improvement action ---- */
    if (b.actionDone) {
      const retroId = String(b.actionDone.retroId || '');
      const actionId = String(b.actionDone.actionId || '');
      const status = b.actionDone.status === 'open' ? 'open' : 'done';
      if (!retroId || !actionId) return bad('retroId and actionId required');
      const rows = await sql`SELECT data FROM event_retros WHERE id = ${retroId}`;
      if (!rows.length) return bad('retro not found', 404);
      const rt = rows[0].data;
      let hit = false;
      (rt.actions || []).forEach(a => {
        if (a.id === actionId) { hit = true; a.status = status; a.doneAt = status === 'done' ? new Date().toISOString() : null; }
      });
      if (!hit) return bad('action not found', 404);
      rt.updated = new Date().toISOString();
      await sql`UPDATE event_retros SET data = ${JSON.stringify(rt)}::jsonb, updated_at = now() WHERE id = ${retroId}`;
      return json({ retroId, actionId, status });
    }

    /* ---- upsert a retro ---- */
    const r = b.retro || b;
    const eventId = String(r.eventId || '');
    const occDate = String(r.occDate || '');
    if (!eventId || !ymd(occDate)) return bad('eventId and occDate (YYYY-MM-DD) required');
    const now = new Date().toISOString();
    const clean = {
      eventId, occDate,
      guru: String(r.guru || 'Guru').trim().slice(0, 60) || 'Guru',
      targets: { attendance: numOrNull(r.targets && r.targets.attendance),
                 revenue:    numOrNull(r.targets && r.targets.revenue) },
      actuals: { regs:       numOrNull(r.actuals && r.actuals.regs),
                 checkedIn:  numOrNull(r.actuals && r.actuals.checkedIn),
                 revenue:    numOrNull(r.actuals && r.actuals.revenue),
                 attendance: numOrNull(r.actuals && r.actuals.attendance),
                 notes:      String((r.actuals && r.actuals.notes) || '').slice(0, 2000) },
      scores: { turnout:  clampScore(r.scores && r.scores.turnout),
                energy:   clampScore(r.scores && r.scores.energy),
                promo:    clampScore(r.scores && r.scores.promo),
                prizes:   clampScore(r.scores && r.scores.prizes),
                logistics:clampScore(r.scores && r.scores.logistics) },
      decision: DECISIONS.indexOf(r.decision) >= 0 ? r.decision : 'continue',
      wins:   String(r.wins || '').slice(0, 4000),
      issues: String(r.issues || '').slice(0, 4000),
      actions: (Array.isArray(r.actions) ? r.actions : []).slice(0, 40).map((a, i) => ({
        id: String(a.id || ('A' + (i + 1) + '-' + Math.random().toString(36).slice(2, 6))),
        area: AREAS.indexOf(a.area) >= 0 ? a.area : 'other',
        assignee: String(a.assignee || '').trim().slice(0, 40),
        text: String(a.text || '').trim().slice(0, 500),
        status: a.status === 'done' ? 'done' : 'open',
        ts: a.ts || now,
        doneAt: a.status === 'done' ? (a.doneAt || now) : null
      })).filter(a => a.text)
    };
    const existing = await sql`SELECT id, data FROM event_retros WHERE event_id = ${eventId} AND occ_date = ${occDate}`;
    if (existing.length) {
      const prev = existing[0].data || {};
      clean.id = existing[0].id; clean.ts = prev.ts || now; clean.updated = now;
      await sql`UPDATE event_retros SET data = ${JSON.stringify(clean)}::jsonb, updated_at = now()
                WHERE id = ${clean.id}`;
    } else {
      clean.id = 'RETRO-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(Math.random() * 900 + 100);
      clean.ts = now; clean.updated = now;
      await sql`INSERT INTO event_retros (id, event_id, occ_date, data)
                VALUES (${clean.id}, ${eventId}, ${occDate}, ${JSON.stringify(clean)}::jsonb)`;
    }
    return json(clean);
  }

  return bad('Method not allowed', 405);
};
