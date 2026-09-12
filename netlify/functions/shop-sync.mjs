// netlify/functions/shop-sync.mjs
// NGH-BUILD 2026-09-11a — scheduled catalog sync (every 30 min, see netlify.toml)
// Pulls changed X-Series products + inventory into Neon (ls_products / ls_inventory)
// using version cursors. Same code as POST /api/shop/sync (admin).
import { json } from './_shared/db.mjs';
import { syncCatalog } from './shop.mjs';

export default async () => {
  try {
    const r = await syncCatalog();
    if (!r.ok) console.warn('[shop-sync] skipped:', r.error);
    return json(r, r.ok ? 200 : 503);
  } catch (e) {
    console.error('[shop-sync] failed', e);
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
};
