// netlify/functions/send-email.mjs
// POST { to, subject, body }  -> sends a plain-text email via Resend.
// Customer-facing emails (approval / hold / cancel) are sent on behalf of staff
// actions, so this requires admin auth EXCEPT the very first "new request"
// notification to staff, which is allowed unauthenticated so a guest's
// submission can notify you. We restrict that case to ADMIN_EMAIL only.
import { json, bad, preflight, requireAdmin } from './_shared/db.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return bad('Method not allowed', 405);

  let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }
  const { to, subject, body: text } = body || {};
  if (!to || !subject) return bad('to and subject required');

  const adminEmail = process.env.ADMIN_EMAIL || '';
  const isAdmin = requireAdmin(req);
  // Guests may only trigger the staff-notification email (to your own inbox).
  if (!isAdmin && to !== adminEmail) return bad('unauthorized', 401);

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Northwood Game Haven <bookings@northwoodgamehaven.com>';
  if (!apiKey) {
    console.log('[send-email] RESEND_API_KEY not set; logging only:\n', to, subject);
    return json({ ok: true, simulated: true });
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text })
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('[send-email] Resend error', res.status, detail);
    return bad('Email provider error', 502);
  }
  return json({ ok: true });
};
