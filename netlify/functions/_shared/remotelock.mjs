// netlify/functions/_shared/remotelock.mjs
// Minimal RemoteLock API client for issuing time-bound door PIN codes to
// after-hours booking guests. Creates an "access guest" (a person with a PIN
// valid only for a date/time window) and grants them access to the doors that
// correspond to the rooms on a booking.
//
// Auth: RemoteLock uses OAuth2. The simplest setup for a single account is to
// store a long-lived access token (and refresh token) as env vars. Set:
//   REMOTELOCK_TOKEN          = OAuth access token
//   REMOTELOCK_REFRESH_TOKEN  = OAuth refresh token (optional; for auto-refresh)
//   REMOTELOCK_CLIENT_ID      = OAuth app client id (for refresh)
//   REMOTELOCK_CLIENT_SECRET  = OAuth app client secret (for refresh)
//   REMOTELOCK_DOORS          = JSON mapping NGH room id -> RemoteLock device id(s)
//        e.g. {"front":"DEVICE-FRONT","holt":"DEVICE-A","den":"DEVICE-B","depths":"DEVICE-C"}
//        Use the "front" key for a shared entrance everyone needs.
//
// If unconfigured, all functions no-op and return { configured:false } so the
// rest of the booking flow keeps working (staff can issue codes manually).

const API = 'https://api.remotelock.com';
const ACCEPT = 'application/vnd.lockstate+json; version=1';

function cfg() {
  let doors = {};
  try { doors = JSON.parse(process.env.REMOTELOCK_DOORS || '{}'); } catch { doors = {}; }
  return {
    token: process.env.REMOTELOCK_TOKEN || '',
    refresh: process.env.REMOTELOCK_REFRESH_TOKEN || '',
    clientId: process.env.REMOTELOCK_CLIENT_ID || '',
    clientSecret: process.env.REMOTELOCK_CLIENT_SECRET || '',
    doors
  };
}
export function remotelockConfigured() { const c = cfg(); return !!(c.token && Object.keys(c.doors).length); }

async function rl(method, path, body, token) {
  const opts = { method, headers: { 'Authorization': 'Bearer ' + token, 'Accept': ACCEPT } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(API + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error('RemoteLock ' + res.status + ' ' + JSON.stringify(data)); e.status = res.status; throw e; }
  return data;
}

// Resolve which RemoteLock device ids a booking needs based on its rooms.
// Always includes the shared entrance ("front") if configured.
function devicesForRooms(rooms, doors) {
  const ids = new Set();
  if (doors.front) [].concat(doors.front).forEach(d => ids.add(d));
  (rooms || []).forEach(r => { const d = doors[r]; if (d) [].concat(d).forEach(x => ids.add(x)); });
  // if no room mapped, at least give the entrance
  return Array.from(ids);
}

// Create a time-bound access guest with a PIN for a booking, grant the relevant
// doors, and (optionally) have RemoteLock email the guest. Returns
// { configured, pin, accessPersonId } or { configured:false }.
//
// startsAt / endsAt are ISO strings (UTC). We typically start the window a bit
// before the booking and end it a bit after.
export async function issueBookingCode({ name, email, rooms, startsAt, endsAt }) {
  const c = cfg();
  if (!remotelockConfigured()) return { configured: false };
  const token = c.token;

  // 1) create access guest with auto-generated PIN and validity window
  const created = await rl('POST', '/access_persons', {
    type: 'access_guest',
    attributes: {
      name: (name || 'NGH Guest') + ' — booking',
      email: email || undefined,
      generate_pin: true,
      starts_at: startsAt,
      ends_at: endsAt
    }
  }, token);
  const person = created && created.data ? created.data : created;
  const accessPersonId = person && person.id;
  const pin = person && person.attributes && person.attributes.pin;

  // 2) grant access to each relevant device
  const deviceIds = devicesForRooms(rooms, c.doors);
  for (const deviceId of deviceIds) {
    try {
      await rl('POST', '/access_persons/' + encodeURIComponent(accessPersonId) + '/accesses', {
        type: 'access', attributes: { accessible_id: deviceId, accessible_type: 'lock' }
      }, token);
    } catch (e) { console.error('[remotelock] grant failed for device', deviceId, e.message); }
  }

  return { configured: true, pin, accessPersonId, deviceIds };
}

// Revoke a previously issued code (e.g. on cancellation).
export async function revokeCode(accessPersonId) {
  const c = cfg();
  if (!remotelockConfigured() || !accessPersonId) return { configured: false };
  try { await rl('DELETE', '/access_persons/' + encodeURIComponent(accessPersonId), null, c.token); return { ok: true }; }
  catch (e) { console.error('[remotelock] revoke failed', e.message); return { ok: false, error: e.message }; }
}
