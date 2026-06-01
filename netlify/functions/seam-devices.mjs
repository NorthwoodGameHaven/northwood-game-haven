// netlify/functions/seam-devices.mjs
// Admin-only helper: lists all locks in the Seam workspace with their
// device_id, name, and online status. Used to fill in the SEAM_DOORS mapping.
// GET /seam-devices  (admin token required)
import { json, bad, preflight, requireAdmin } from './_shared/db.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (!requireAdmin(req)) return bad('unauthorized', 401);

  const key = process.env.SEAM_API_KEY || '';
  if (!key) return json({ configured: false, message: 'SEAM_API_KEY is not set in Netlify yet.' });

  try {
    const res = await fetch('https://connect.getseam.com/devices/list', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return bad('Seam ' + res.status + ': ' + JSON.stringify(data), 502);
    const devices = (data.devices || []).map(d => ({
      device_id: d.device_id,
      name: (d.properties && (d.properties.name || d.properties.appearance?.name)) || d.display_name || '(unnamed)',
      online: d.properties ? d.properties.online : undefined,
      manufacturer: d.properties && d.properties.manufacturer
    }));
    return json({ configured: true, count: devices.length, devices });
  } catch (e) {
    return bad('Could not reach Seam: ' + (e.message || e), 502);
  }
};
