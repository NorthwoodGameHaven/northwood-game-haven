// netlify/functions/promo-tasks.mjs
// Event-promotion task API (admin only — powers guru-promo.html).
//   GET  /promo-tasks?date=YYYY-MM-DD  -> { date, today[], overdue[], standing[] }
//                                         (date defaults to today, America/Chicago)
//   POST /promo-tasks {id, done, label?} -> mark a task done (or undo with done:false)
//
// Completion model per the promotion SOP: clicking a task's share link counts
// as done — the front end POSTs here at click time, then refreshes the list.
import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { computeTasks, ensurePromoSchema, chicagoToday } from './_shared/promo.mjs';

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[promo-tasks] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (!requireAdmin(req)) return bad('unauthorized', 401);
  await ensureSchema();
  await ensurePromoSchema(sql);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const qd = url.searchParams.get('date');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(qd || '') ? qd : chicagoToday();
    return json(await computeTasks(sql, date));
  }

  if (req.method === 'POST') {
    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }
    const id = String(b.id || '');
    if (!/^(weekly|daily|vo|cd|poster|assign|extend|dchan|dcd|dpre):/.test(id)) return bad('bad task id');
    if (b.done === false) {
      await sql`DELETE FROM promo_tasks WHERE id = ${id}`;
      return json({ id, done: false });
    }
    const data = { label: String(b.label || '').slice(0, 300) };
    await sql`INSERT INTO promo_tasks (id, data) VALUES (${id}, ${JSON.stringify(data)}::jsonb)
              ON CONFLICT (id) DO UPDATE SET done_at = now(), data = EXCLUDED.data`;
    return json({ id, done: true });
  }

  return bad('Method not allowed', 405);
};
