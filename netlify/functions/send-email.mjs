// netlify/functions/send-email.mjs
// POST { to, subject, body }  -> sends a plain-text email via Resend.
// Customer-facing emails (approval / hold / cancel) are sent on behalf of staff
// actions, so this requires admin auth EXCEPT the very first "new request"
// notification to staff, which is allowed unauthenticated so a guest's
// submission can notify you. We restrict that case to ADMIN_EMAIL only.
import { json, bad, preflight, requireAdmin } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return bad('Method not allowed', 405);

  let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }
  const { to, subject, body: text, heading, buttons } = body || {};
  if (!to || !subject) return bad('to and subject required');

  const adminEmail = process.env.ADMIN_EMAIL || '';
  const isAdmin = requireAdmin(req);
  // Guests may only trigger the staff-notification email (to your own inbox).
  if (!isAdmin && to !== adminEmail) return bad('unauthorized', 401);

  const result = await sendBrandedMail(to, subject, { heading: heading || '', bodyText: text || '', buttons: buttons || [] });
  if (!result.ok && !result.simulated) return bad('Email provider error', 502);
  return json({ ok: true });
};
