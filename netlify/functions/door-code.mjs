// netlify/functions/door-code.mjs
// Admin endpoint to issue (or revoke) a time-bound door access code for a
// booking via RemoteLock. The PIN is created to be valid only during the
// booking's window (plus a small buffer), so the guest can receive it ahead of
// time but it only works near/at their reservation.
//
// POST { id:<bookingId>, action:"issue"|"revoke" }   (admin only)
import { sql, ensureSchema, json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { issueBookingCode, revokeCode, seamConfigured } from './_shared/seam.mjs';

// Build ISO start/end from a booking's date + start time + hours, with buffers.
function windowFor(b) {
  // booking.date = 'YYYY-MM-DD', booking.start = 'HH:MM', booking.hours = number
  const startLocal = new Date(b.date + 'T' + (b.start || '00:00') + ':00');
  const beforeMin = 60, afterMin = 60; // 1-hour grace buffers before start and after end
  const starts = new Date(startLocal.getTime() - beforeMin * 60000);
  const ends = new Date(startLocal.getTime() + ((Number(b.hours) || 1) * 60 + afterMin) * 60000);
  return { startsAt: starts.toISOString(), endsAt: ends.toISOString() };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return bad('Method not allowed', 405);
  if (!requireAdmin(req)) return bad('unauthorized', 401);
  await ensureSchema();

  let p; try { p = await req.json(); } catch { return bad('Invalid JSON'); }
  const rows = await sql`SELECT data FROM bookings WHERE id = ${p.id}`;
  if (!rows.length) return bad('booking not found', 404);
  const b = rows[0].data;

  if (!seamConfigured()) {
    return json({ configured: false, message: 'Door locks are not configured yet. Set SEAM_API_KEY and SEAM_DOORS to enable automatic door codes.' });
  }

  if (p.action === 'revoke') {
    const res = await revokeCode(b.doorAccessCodeIds);
    b.doorCode = null; b.doorAccessCodeIds = null; b.doorCodeRevokedAt = new Date().toISOString();
    await sql`UPDATE bookings SET data = ${JSON.stringify(b)}::jsonb WHERE id = ${b.id}`;
    return json({ ok: true, revoked: true });
  }

  // default: issue
  const win = windowFor(b);
  try {
    const result = await issueBookingCode({
      name: b.name, rooms: b.rooms || [],
      startsAt: win.startsAt, endsAt: win.endsAt
    });
    if (!result.configured) return json({ configured: false });
    b.doorCode = result.pin;
    b.doorAccessCodeIds = result.accessCodeIds;
    b.doorCommonCodeKey = result.commonCodeKey;
    b.doorCodeWindow = win;
    b.doorCodeIssuedAt = new Date().toISOString();
    await sql`UPDATE bookings SET data = ${JSON.stringify(b)}::jsonb WHERE id = ${b.id}`;
    return json({ ok: true, pin: result.pin, window: win });
  } catch (e) {
    console.error('[door-code] issue failed', e);
    return bad('Could not issue door code: ' + (e.message || e), 502);
  }
};
