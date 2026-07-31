// netlify/functions/birthday.mjs
// POST — receives a birthday party booking request from site/birthday.html.
//
// CLOSES THE SOP GAP (NGH-SOP-EVT-001 §2): a birthday request is no longer
// "only an email." Every request now:
//   1. is conflict-checked server-side against bookings, events & blackouts
//      (hard conflicts get a friendly 409 so the customer picks a new time);
//   2. creates a real PENDING booking in the bookings table — so it appears
//      in the Guru Console Request List AND on every calendar, and soft-holds
//      its rooms per the scheduling authority ladder (§6.2 #4);
//   3. emails staff (with the booking ref + console link) and the customer
//      ("your date is tentatively held while we confirm").
// Staff then approve/adjust/reject it in the console exactly like any other
// booking — approval emails, pay links, deposit adjustment, auto-cancel and
// door codes all work unchanged. Includes a honeypot ("website") for spam.
import { sql, ensureSchema, json, bad, preflight } from './_shared/db.mjs';
import { sendBrandedMail } from './_shared/email.mjs';
import { checkWindow, loadBlockers, describe, toMins, fmtT, roomLabel } from './_shared/conflicts.mjs';

const clip = (v, max) => String(v ?? '').replace(/[\r\u0000-\u0008\u000B-\u001F]/g, '').slice(0, max).trim();

const SALES_TAX_PERCENT = (process.env.SALES_TAX_PERCENT != null && process.env.SALES_TAX_PERCENT !== '')
  ? Number(process.env.SALES_TAX_PERCENT) : 5.5;
const DEPOSIT = { 1: 40, 2: 80, 3: 100 };   // by room count — same schedule as booking.html

// Which rooms each package occupies, and for how long. Matched by keyword so
// price tweaks in birthday.html never break the mapping. Price is parsed from
// the "( $NNN )" in the package string, with these as fallbacks.
const PACKAGES = [
  { match: /raft deluxe/i,  rooms: ['holt', 'den'],           hours: 4, price: 199 },
  { match: /pup party/i,    rooms: ['holt'],                  hours: 4, price: 149 },
  { match: /den party/i,    rooms: ['den'],                   hours: 4, price: 89 },
  { match: /dungeon crawl/i,rooms: ['depths', 'holt'],        hours: 4, price: 129 },
  { match: /takeover/i,     rooms: ['holt', 'den', 'depths'], hours: 4, price: 449 }
];
function pkgInfo(pkg) {
  const found = PACKAGES.find(p => p.match.test(pkg)) || { rooms: ['holt', 'den', 'depths'], hours: 4, price: 0 };
  const m = /\$\s*(\d+(?:\.\d{1,2})?)/.exec(pkg);
  return { rooms: found.rooms.slice(), hours: found.hours, price: m ? Number(m[1]) : found.price };
}
function newId() { return 'NGH-' + Date.now().toString(36).toUpperCase().slice(-6) + '-' + Math.floor(Math.random() * 900 + 100); }
function endLabelOf(startM, hours) {
  const em = startM + hours * 60;
  return em >= 1440 ? (fmtT(em - 1440) + ' (next day)') : fmtT(em);
}

export default async (req) => {
  try { return await _handler(req); }
  catch (e) {
    console.error('[birthday] error', e);
    return bad('Server error: ' + (e && e.message ? e.message : String(e)), 500);
  }
};

const _handler = async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return bad('Method not allowed', 405);
  await ensureSchema();

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
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad('date required');
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return bad('time required');
  if (!name) return bad('name required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('valid email required');
  if (!guests || Number(guests) < 1) return bad('guest count required');

  const adminEmail = process.env.ADMIN_EMAIL || 'stash@northwoodgamehaven.com';
  const SITE = (process.env.SITE_URL || 'https://gamehaven.guru').replace(/\/$/, '');
  const info = pkgInfo(pkg);

  // ---- server-side conflict check (same engine as bookings & events) ----
  // Hard blocks (approved bookings, one-time/limited events, blackouts) bounce
  // the request with a friendly 409 so the customer picks another time.
  // Soft overlaps (pending requests, recurring-event occurrences, tight
  // changeovers) go through but are flagged to staff for adjudication at
  // approval — per the scheduling authority ladder (SOP §6.2).
  const startM = toMins(time);
  const endM = startM + info.hours * 60;
  const blockers = await loadBlockers(sql);
  const { red, tight } = checkWindow({ date, startM, endM, rooms: info.rooms }, blockers, {});
  const softRed = red.filter(c => (c.kind === 'booking' && c.st && c.st !== 'approved') || (c.kind === 'event' && c.rec));
  const hardRed = red.filter(c => softRed.indexOf(c) < 0);
  if (hardRed.length) {
    return json({
      error: 'That date and time is already reserved for ' + hardRed.map(c => roomLabel(c.room)).filter((v, i, a) => a.indexOf(v) === i).join(' and ') +
        ' (' + hardRed[0].win + '). Please pick a different time or day — or call/text 715-379-4946 and we’ll find you a slot.',
      code: 'overlap'
    }, 409);
  }

  // ---- create the PENDING booking (the calendar hold) ----
  const price = info.price;
  const tax = Math.round(price * (SALES_TAX_PERCENT / 100) * 100) / 100;
  const deposit = DEPOSIT[Math.min(info.rooms.length, 3)] || 0;
  const bookingAddons = [{ id: 'bdaypkg', title: '🎂 Birthday Package: ' + pkg + ' (' + audience + ')', comment: heroName ? ('Birthday hero: ' + heroName + (heroAge ? (', turning ' + heroAge) : '')) : '' }]
    .concat(addons.map(a => ({ id: 'bdayaddon', title: '🎂 ' + a, comment: '' })));
  const commentBits = [
    'BIRTHDAY PARTY REQUEST (from gamehaven.guru/birthday)',
    'Package: ' + pkg + ' (' + audience + ')',
    heroName ? ('Birthday hero: ' + heroName + (heroAge ? (' — turning ' + heroAge) : '')) : '',
    videoGames ? ('Video game requests: ' + videoGames) : '',
    boardGames ? ('Board game requests: ' + boardGames) : '',
    notes ? ('Notes: ' + notes) : '',
    'Package price is flat ($' + price.toFixed(2) + ') — adjust hours/rooms/deposit in this card if the party needs it.'
  ].filter(Boolean);
  const booking = {
    id: newId(),
    submitted: new Date().toISOString(),
    status: 'pending',
    payment: 'due',
    feePaid: false,
    depositPaid: false,
    milRequested: false, milVerified: null,
    name, phone, email, guests,
    rooms: info.rooms, date, hours: info.hours, start: time,
    endLabel: endLabelOf(startM, info.hours),
    addons: bookingAddons,
    guruReach: false,
    overnightInterest: addons.some(a => /overnight|vrbo/i.test(a)),
    wantsInvoice: false,
    expeditePay: true,
    comments: commentBits.join('\n'),
    subtotal: price, discount: 0, costBooking: price, deposit, tax,
    taxRate: SALES_TAX_PERCENT / 100, totalDue: price + tax + deposit,
    adminQuestions: '', invoiceLink: '', invoiceFileName: '',
    groupId: null, recIndex: null, recTotal: null, recFreq: null,
    birthdayParty: true, birthdayPackage: pkg, birthdayAudience: audience,
    birthdayHero: heroName || null, birthdayHeroAge: heroAge || null
  };
  await sql`INSERT INTO bookings (id, data, status, group_id, date)
            VALUES (${booking.id}, ${JSON.stringify(booking)}::jsonb, 'pending', ${null}, ${date})
            ON CONFLICT (id) DO NOTHING`;

  const softNotes = [];
  if (softRed.length) softNotes.push('⚠ SOFT CONFLICT — overlaps: ' + describe(softRed) + '. Adjudicate at approval (authority ladder SOP §6.2: pending requests are soft; a recurring occurrence may be canceled to take the revenue — registrants are auto-notified if you cancel it).');
  if (tight.length) softNotes.push('⚠ TIGHT CHANGEOVER (<15 min) with: ' + describe(tight) + '. Name a changeover owner or shift the time at approval.');

  const detailLines = [
    `Booking ref:   ${booking.id}  (PENDING — holding ${info.rooms.map(roomLabel).join(', ')})`,
    `Package:       ${pkg}  (${audience})`,
    `Date:          ${date}`,
    `Time:          ${fmtT(startM)} – ${booking.endLabel}  (${info.hours}h hold — adjust in console if needed)`,
    `Guests:        ${guests}`,
    heroName ? `Birthday hero: ${heroName}${heroAge ? ` (turning ${heroAge})` : ''}` : '',
    '',
    `Contact:       ${name}`,
    `Email:         ${email}`,
    phone ? `Phone:         ${phone}` : '',
    '',
    `Package price: $${price.toFixed(2)} + $${tax.toFixed(2)} tax · deposit $${deposit.toFixed(2)} (standard — reduce/waive in console if desired)`,
    '',
    addons.length ? 'Add-ons requested:\n' + addons.map(a => `  • ${a}`).join('\n') : 'Add-ons requested: (none)',
    '',
    videoGames ? `Video game requests:\n${videoGames}` : '',
    boardGames ? `Board game requests:\n${boardGames}` : '',
    notes ? `Notes:\n${notes}` : '',
    softNotes.length ? '\n' + softNotes.join('\n') : ''
  ].filter(l => l !== '').join('\n');

  // 1) Staff notification (best-effort — the calendar hold already exists)
  const staffResult = await sendBrandedMail(
    adminEmail,
    `🎂 Birthday party request — ${pkg} on ${date} (${booking.id})`,
    {
      heading: 'New Birthday Party Request — on the calendar as PENDING',
      bodyText: detailLines + '\n\nThis request is already on the calendar as a PENDING booking holding its rooms. Approve it in the Guru Console to confirm and send the payment link — or adjust/reject it there. Unworked pending requests do NOT auto-expire.',
      buttons: [{ label: 'Open Guru Console', url: SITE + '/booking.html?admin=1', primary: true }],
      replyTo: email
    }
  );
  if (!staffResult.ok && !staffResult.simulated) {
    console.error('[birthday] staff email failed', staffResult);
  }

  // 2) Customer confirmation (best-effort; the request is safely recorded)
  const custBody = [
    `Hi ${name},`,
    '',
    `We got your birthday party request — and your date is tentatively held on our calendar while we confirm it. Here's what you asked for:`,
    '',
    `Reference:  ${booking.id}`,
    `Package:    ${pkg}`,
    `Date:       ${date} at ${fmtT(startM)}`,
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
  ].filter(l => l !== null && l !== '').join('\n');

  const custResult = await sendBrandedMail(
    email,
    'Your birthday party request — Northwood Game Haven',
    { heading: '🎂 Party Request Received!', bodyText: custBody }
  );
  if (!custResult.ok && !custResult.simulated) {
    console.warn('[birthday] customer confirmation failed (request still recorded + staff notified)', custResult);
  }

  return json({ ok: true, ref: booking.id });
};
