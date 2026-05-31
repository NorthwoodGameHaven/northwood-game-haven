// netlify/functions/blackouts.mjs
//   GET /blackouts            -> array (public; used to grey out slots)
//   PUT /blackouts {blackouts:[]} -> replace the whole list (admin)
import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[blackouts] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  await ensureSchema();

  if (req.method === 'GET') {
    const rows = await sql`SELECT data FROM blackouts WHERE id = 1`;
    return json(rows[0]?.data || []);
  }

  if (req.method === 'PUT') {
    if (!requireAdmin(req)) return bad('unauthorized', 401);
    let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }
    const list = Array.isArray(body?.blackouts) ? body.blackouts : [];
    await sql`UPDATE blackouts SET data = ${JSON.stringify(list)}::jsonb WHERE id = 1`;
    return json(list);
  }

  return bad('Method not allowed', 405);
};
