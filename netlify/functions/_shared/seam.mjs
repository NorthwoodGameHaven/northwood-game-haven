// netlify/functions/_shared/seam.mjs
// Seam (seam.co) API client for issuing time-bound door PIN codes to
// after-hours booking guests. Seam is a unified smart-lock API (Schlage, Yale,
// August, Kwikset, etc.) — simpler and cheaper than RemoteLock for multi-lock
// setups. Auth is a single API key.
//
// Set these Netlify env vars:
//   SEAM_API_KEY  = your Seam API key (starts with "seam_")
//   SEAM_DOORS    = JSON mapping NGH room id -> Seam device_id(s).
//        Use the "front" key for the shared entrance everyone needs.
//        Example (6 locks):
//        {"front":"DEVICE-FRONT","holt":"DEVICE-HOLT","den":"DEVICE-DEN",
//         "depths":"DEVICE-DEPTHS","lodge":"DEVICE-LODGE","rest":"DEVICE-REST"}
//
// If unconfigured, all functions no-op and return { configured:false } so the
// booking flow keeps working (staff can set codes manually in the Seam dash).

const API = 'https://connect.getseam.com';

function cfg() {
  let doors = {};
  try { doors = JSON.parse(process.env.SEAM_DOORS || '{}'); } catch { doors = {}; }
  return { key: process.env.SEAM_API_KEY || '', doors };
}
export function seamConfigured() { const c = cfg(); return !!(c.key && Object.keys(c.doors).length); }

async function seam(path, body) {
  const { key } = cfg();
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.error?.message || data.error?.type)) || ('Seam ' + res.status);
    const e = new Error(msg); e.status = res.status; e.seam = data; throw e;
  }
  return data;
}

// Which Seam device_ids does a booking need? Always include the shared
// entrance ("front") if configured, plus each booked room's lock.
function devicesForRooms(rooms, doors) {
  const ids = new Set();
  if (doors.front) [].concat(doors.front).forEach(d => ids.add(d));
  (rooms || []).forEach(r => { const d = doors[r]; if (d) [].concat(d).forEach(x => ids.add(x)); });
  return Array.from(ids);
}

// Create ONE time-bound PIN shared across all the doors this booking needs.
// Returns { configured, pin, accessCodeIds, commonCodeKey } or { configured:false }.
export async function issueBookingCode({ name, rooms, startsAt, endsAt }) {
  const c = cfg();
  if (!seamConfigured()) return { configured: false };
  const deviceIds = devicesForRooms(rooms, c.doors);
  if (!deviceIds.length) return { configured: false, error: 'no devices mapped for these rooms' };

  // create_multiple programs the SAME pin on every needed lock and returns a
  // common_code_key tying them together (so we can remove them as a group).
  const out = await seam('/access_codes/create_multiple', {
    device_ids: deviceIds,
    name: (name || 'NGH Guest') + ' — booking',
    starts_at: startsAt,
    ends_at: endsAt,
    behavior_when_code_cannot_be_shared: 'create_random_code'
  });
  const codes = out.access_codes || [];
  const pin = codes.length ? codes[0].code : null;
  return {
    configured: true,
    pin,
    accessCodeIds: codes.map(x => x.access_code_id),
    commonCodeKey: out.common_code_key || (codes[0] && codes[0].common_code_key) || null,
    deviceIds
  };
}

// Remove a previously issued set of codes (e.g. on cancellation).
export async function revokeCode(accessCodeIds) {
  const c = cfg();
  if (!seamConfigured() || !accessCodeIds || !accessCodeIds.length) return { configured: false };
  let ok = true;
  for (const id of accessCodeIds) {
    try { await seam('/access_codes/delete', { access_code_id: id }); }
    catch (e) { ok = false; console.error('[seam] delete failed', id, e.message); }
  }
  return { ok };
}
