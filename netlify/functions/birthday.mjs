// netlify/functions/birthday.mjs
// POST — receives a birthday party booking request from site/birthday.html.
// Emails the full request to staff (ADMIN_EMAIL) and a branded confirmation
// to the customer. No payment is taken here; staff confirm availability and
// send a payment link. Includes a honeypot field ("website") for spam.
import { json, bad, preflight } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';

const clip = (v, max) => String(v ?? '').replace(/[\r\u0000-\u0008\u000B-\u001F]/g, '').slice(0, max).trim();

export default async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return bad('Method not allowed', 405);

  let body; try { body = await req.json(); } catch { return bad('Invalid JSON'); }

  // Honeypot — bots fill it, humans never see it. Pretend success.
  if (clip(body.website, 50)) return json({ ok: true });

  const pkg      = clip(body.package, 80);
  const audience = clip(body.audience, 10) === 'kids' ? 'Kids' : 'Adults 21+';
  const date     = clip(body.date, 20);
  const time     = clip(body.time, 20);
  const guests   = clip(body.guests, 6);
  const heroName = clip(body.heroName, 80);
  const heroAge  = clip(body.heroAge, 4);
  const name     = clip(body.name, 120);
  const email    = clip(body.email, 160);
  const phone    = clip(body.phone, 30);
  const notes    = clip(body.notes, 1000);
  const videoGames = clip(body.videoGames, 600);
  const boardGames = clip(body.boardGames, 600);
  const addons = Array.isArray(body.addons) ? body.addons.map(a => clip(a, 140)).filter(Boolean).slice(0, 12) : [];

  if (!pkg)  return bad('package required');
  if (!date) return bad('date required');
  if (!time) return bad('time required');
  if (!name) return bad('name required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('valid email required');
  if (!guests || Number(guests) < 1) return bad('guest count required');

  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';

  const detailLines = [
    `Package:       ${pkg}  (${audience})`,
    `Date:          ${date}`,
    `Start time:    ${time}`,
    `Guests:        ${guests}`,
    heroName ? `Birthday hero: ${heroName}${heroAge ? ` (turning ${heroAge})` : ''}` : '',
    '',
    `Contact:       ${name}`,
    `Email:         ${email}`,
    phone ? `Phone:         ${phone}` : '',
    '',
    addons.length ? 'Add-ons requested:\n' + addons.map(a => `  • ${a}`).join('\n') : 'Add-ons requested: (none)',
    '',
    videoGames ? `Video game requests:\n${videoGames}` : '',
    boardGames ? `Board game requests:\n${boardGames}` : '',
    notes ? `Notes:\n${notes}` : ''
  ].filter(l => l !== '').join('\n');

  // 1) Staff notification
  const staffResult = await sendBrandedMail(
    adminEmail,
    `🎂 Birthday party request — ${pkg} on ${date}`,
    {
      heading: 'New Birthday Party Request',
      bodyText: detailLines + '\n\nReply to the customer to confirm availability, then send a payment link to lock the date.',
      replyTo: email
    }
  );
  if (!staffResult.ok && !staffResult.simulated) {
    console.error('[birthday] staff email failed', staffResult);
    return bad('Email provider error', 502);
  }

  // 2) Customer confirmation (best-effort; the request already reached staff)
  const custBody = [
    `Hi ${name},`,
    '',
    `We got your birthday party request — here's what you asked for:`,
    '',
    `Package:    ${pkg}`,
    `Date:       ${date} at ${time}`,
    `Guests:     ${guests}`,
    heroName ? `Guest of honor: ${heroName}${heroAge ? ` (turning ${heroAge})` : ''}` : '',
    addons.length ? '\nAdd-ons: ' + addons.join('; ') : '',
    '',
    `We'll confirm your date within one business day and send a secure payment link to lock it in. Nothing is due until then.`,
    '',
    `Every party includes the Party Float Kit, and bringing your own cake is always welcome at no charge.`,
    '',
    `Questions in the meantime? Just reply to this email or call/text 715-379-4946.`,
    '',
    `"I never forget a birthday. Mostly because there's cake." — Stash the Otter`
  ].filter(l => l !== null).join('\n');

  const custResult = await sendBrandedMail(
    email,
    'Your birthday party request — Northwood Game Haven',
    { heading: '🎂 Party Request Received!', bodyText: custBody }
  );
  if (!custResult.ok && !custResult.simulated) {
    console.warn('[birthday] customer confirmation failed (request still delivered to staff)', custResult);
  }

  return json({ ok: true });
};
