#!/usr/bin/env node
// NGH-BUILD 2026-09-12q
// tests/guru-master.e2e.mjs — drives site/guru-master.html in a real browser
// against a canned /api/schedule payload.
//
//   node tests/guru-master.e2e.mjs        (screenshots → $SHOTS or tests/screenshots)
//
// schedule-core.test.mjs proves the data is right. This proves the page draws
// it — which is a different failure mode entirely, and the one that actually
// bites: a pending booking that is correct in the payload and invisible on the
// screen is exactly the bug this whole feature exists to fix.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8899;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || path.join(root, 'tests', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const issues = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ' — ' + detail : ''}`);
  if (!cond) issues.push(name);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// A week with one of everything, and every awkward case worth drawing.
const { buildSchedule } = await import('../netlify/functions/_shared/schedule-core.mjs');

const HOURS = {
  configured: true,
  overrides: [{ date: '2026-09-19', closed: true, label: 'Staff training' }],
  weekly: [
    { closed: false, open: '10:00', close: '18:00' },
    { closed: true, open: '', close: '' },
    { closed: false, open: '12:00', close: '20:00' },
    { closed: false, open: '12:00', close: '20:00' },
    { closed: false, open: '12:00', close: '20:00' },
    { closed: false, open: '12:00', close: '23:00' },
    { closed: false, open: '10:00', close: '23:00' }
  ]
};
const PAYLOAD = buildSchedule({
  from: '2026-09-14', to: '2026-09-20',
  roster: ['Dustin', 'Mike', 'Chad', 'Jen', 'Sarah'],
  hours: HOURS,
  events: [
    { id: 'EVT-FNM', title: 'Friday Night Magic', date: '2026-09-18', start: '18:00', end: '22:00', rooms: ['holt'], status: 'live', recurrence: { freq: 'weekly', count: 3 } },
    { id: 'EVT-TRIV', title: 'Team Trivia', date: '2026-09-16', start: '19:00', end: '21:00', rooms: ['den'], status: 'live' },
    { id: 'EVT-OFF', title: 'Library game day', date: '2026-09-17', start: '13:00', end: '16:00', offsite: true, offsiteLocation: 'Chippewa Public Library', rooms: [] }
  ],
  bookings: [
    { id: 'BK-PEND', name: 'Rausch party', status: 'pending', date: '2026-09-16', start: '17:00', hours: 4, rooms: ['depths'], guests: 14, phone: '715-555-0100', addons: [{ id: 'guru', qty: 2 }] },
    { id: 'BK-APPR', name: 'Olson group', status: 'approved', date: '2026-09-17', start: '18:00', hours: 3, rooms: ['holt'], guests: 8, feePaid: true },
    { id: 'BK-LODGE', name: 'Weekend stay', status: 'approved', date: '2026-09-19', start: '16:00', hours: 6, rooms: ['lodge'] },
    { id: 'BK-NIGHT', name: 'Late lock-in', status: 'approved', date: '2026-09-18', start: '22:00', hours: 5, rooms: ['den'] }
  ],
  birthdays: [{ id: 'BDAY-AVA', date: '2026-09-19', time: '13:00', heroName: 'Ava', heroAge: 9, package: 'Kids Party', audience: 'Kids', status: 'confirmed', guests: 12, name: 'Dana R', phone: '715-555-0199' }],
  blackouts: [{ id: 'BO-1', date: '2026-09-15', allDay: true, rooms: [], label: 'Deep clean' }],
  shifts: [
    { id: 'GS-1', guru: 'Mike', date: '2026-09-16', open: '12:00', close: '17:00' },
    { id: 'GS-2', guru: 'Sarah', date: '2026-09-17', open: '12:00', close: '20:00' },
    { id: 'GS-3', guru: 'Mike', date: '2026-09-18', open: '12:00', close: '23:00' }
  ],
  unavail: [{ id: 'GU-1', guru: 'Jen', date: '2026-09-15', endDate: '2026-09-16', allDay: true, notes: 'Out of town' }],
  interest: [{ id: 'IE-SHOW', title: 'Chippewa Card Show', date: '2026-09-20', allDay: true, location: 'Eagles Club', status: 'committed', supportTypes: ['vendor'] }],
  assignments: [
    { id: 'GA-1', eventId: 'EVT-FNM', date: null, gurus: ['Dustin'] },
    { id: 'GA-2', eventId: 'EVT-TRIV', date: null, gurus: ['Dustin'] },
    { id: 'GA-3', bookingId: 'BK-PEND', date: null, gurus: ['Mike'] },
    { id: 'GA-4', birthdayId: 'BDAY-AVA', date: null, gurus: ['Jen'] },
    { id: 'GA-5', externalId: 'IE-SHOW', date: '2026-09-20', gurus: ['Chad'] }
  ]
});
PAYLOAD.generatedAt = new Date().toISOString();

const RAW = {
  events: [
    { id: 'EVT-TRIV', title: 'Team Trivia', date: '2026-09-16', start: '19:00', end: '21:00', rooms: ['den'], status: 'live' }
  ],
  bookings: [
    { id: 'BK-PEND', name: 'Rausch party', status: 'pending', date: '2026-09-16', start: '17:00', hours: 4, rooms: ['depths'], guests: 14, phone: '715-555-0100', addons: [{ id: 'guru', qty: 2 }] },
    { id: 'BK-APPR', name: 'Olson group', status: 'approved', date: '2026-09-16', start: '12:00', hours: 2, rooms: ['holt'], guests: 8, feePaid: true },
    { id: 'BK-GONE', name: 'Should not show', status: 'rejected', date: '2026-09-16', start: '09:00', hours: 2, rooms: ['den'] }
  ]
};

const saved = [];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'application/json' }); res.end(body); };
  if (req.method === 'OPTIONS') return send(204, '');
  if (url.pathname.endsWith('/schedule')) {
    if (!(req.headers.authorization || '').startsWith('Bearer ')) return send(401, JSON.stringify({ error: 'unauthorized' }));
    const single = url.searchParams.get('date');
    if (single) return send(200, JSON.stringify({ ...PAYLOAD, from: single, to: single, days: PAYLOAD.days.filter(d => d.date === single) }));
    return send(200, JSON.stringify(PAYLOAD));
  }
  if (url.pathname.endsWith('/gurus')) {
    if (req.method !== 'POST') return send(200, JSON.stringify({ assignments: [], shifts: [], unavail: [], hours: HOURS }));
    let body = ''; req.on('data', c => body += c);
    return req.on('end', () => { saved.push(JSON.parse(body || '{}')); send(201, JSON.stringify({ ok: true })); });
  }
  if (url.pathname.endsWith('/admin-login')) return send(200, JSON.stringify({ token: 'tok' }));
  // Raw endpoints, for the pages that merge client-side (guru-schedule).
  if (url.pathname.endsWith('/events')) return send(200, JSON.stringify(RAW.events));
  if (url.pathname.endsWith('/bookings')) return send(200, JSON.stringify({ bookings: RAW.bookings }));
  const f = path.join(root, 'site', url.pathname.replace(/^\//, '') || 'index.html');
  if (!f.startsWith(path.join(root, 'site')) || !fs.existsSync(f)) return send(404, 'not found', 'text/plain');
  return send(200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
});
await new Promise(r => server.listen(PORT, r));

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
// A far-future expiry so GuruAuth.get() accepts it (it parses `exp.mac`).
await ctx.addInitScript(() => {
  try { localStorage.setItem('ngh_admin_token', (Date.now() + 86400000) + '.deadbeef'); } catch (e) { }
});
const page = await ctx.newPage();
// Same ignore list as tests/e2e-pages.mjs: the sandbox has no route to Google
// Fonts, and a blocked stylesheet is not a page fault.
const IGNORE = /fonts\.googleapis\.com|fonts\.gstatic\.com|favicon|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY|ERR_TUNNEL/;
page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text()); });
page.on('pageerror', e => { if (!IGNORE.test(String(e))) errors.push(String(e)); });

await page.goto(`${BASE}/guru-master.html?date=2026-09-16`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#rail table', { timeout: 10000 });
await sleep(400);

// ---------------------------------------------------------------- week view
const railText = await page.textContent('#rail');
const gridText = await page.textContent('#grid');

ok('the page loads straight into the week without a login prompt',
  await page.isHidden('#login-card'));
ok('every roster Guru has a lane, busy or not',
  ['Dustin', 'Mike', 'Chad', 'Jen', 'Sarah'].every(g => railText.includes(g)));

// THE headline: a pending booking must be on screen.
ok('a PENDING booking is drawn in the grid', gridText.includes('Rausch party'));
ok('and it is labelled pending, not passed off as confirmed', gridText.includes('pending'));
ok('an approved booking is drawn too', gridText.includes('Olson group'));
ok('a booking in the Lodge is drawn — the server conflict engine cannot even see that room',
  gridText.includes('Weekend stay'));

ok('events are drawn', gridText.includes('Friday Night Magic') && gridText.includes('Team Trivia'));
ok('an unlinked birthday request is drawn', gridText.includes("Ava's party"));
ok('an off-site NGH event shows its location', gridText.includes('Chippewa Public Library'));
ok('a third-party event NGH committed to is drawn', gridText.includes('Chippewa Card Show'));
ok('a closure is drawn', gridText.includes('Deep clean'));

ok('the rail shows who is on the retail floor', railText.includes('store'));
ok('the rail shows an unavailable Guru as off', railText.includes('off'));
ok('a booking with a Guru shows in that Guru\'s lane', railText.includes('Rausch party'));

const pendingSel = '#grid .ev.booking:has-text("Rausch party")';
const bookingClass = await page.getAttribute(pendingSel, 'class');
ok('room bookings carry their own visual class, distinct from events', /booking/.test(bookingClass || ''));
ok('a tentative item is hatched', /tentative/.test(bookingClass || ''));

// Room bookings must be visually distinguishable from events, not just
// differently worded — the whole ask was "format room bookings distinct".
const styles = await page.evaluate(() => {
  const b = document.querySelector('#grid .ev.booking'), e = document.querySelector('#grid .ev.event');
  const cs = (el) => el ? getComputedStyle(el) : null;
  const B = cs(b), E = cs(e);
  return B && E ? { bBg: B.backgroundColor, eBg: E.backgroundColor, bBorder: B.borderLeftStyle, eBorder: E.borderLeftStyle } : null;
});
ok('a booking and an event do not look the same', styles && styles.bBg !== styles.eBg, JSON.stringify(styles));
ok('and a booking has its own border treatment', styles && styles.bBorder !== styles.eBorder, JSON.stringify(styles));

// ---------------------------------------------------------------- alerts
const alertText = await page.textContent('#alerts');
ok('an uncovered stretch of open hours is called out', /Nobody on the floor/i.test(alertText));
ok('a booking that bought Gurus and is short-staffed is called out', /unstaffed/i.test(alertText));
ok('an overnight booking is continued onto the next day', gridText.includes('cont.'));
// A single 3am lock-in must not drag the whole week's grid back to midnight.
const hourLabels = await page.$$eval('#grid td.hour', els => els.map(e => e.textContent.trim()));
ok('the grid does not open at midnight just because one night ran late',
  hourLabels.indexOf('12AM') < 0, hourLabels.join(','));
ok('overnight carry-over gets its own band', hourLabels.indexOf('overnight') >= 0, hourLabels.join(','));
ok('the grid stays a readable height', hourLabels.length <= 18, hourLabels.length + ' rows');
ok('unavailability is not drawn in the room grid — it belongs in the rail',
  !(await page.$('#grid .ev.unavail')) && !(await page.$('#grid .ev.shift')));

await page.screenshot({ path: path.join(SHOTS, 'guru-master-week.png'), fullPage: true });
saved.push('shot');

// ---------------------------------------------------------------- filters
await page.click('#kindchips .chip:nth-child(1)');   // hide bookings
await sleep(200);
ok('hiding the bookings chip removes them', !(await page.textContent('#grid')).includes('Rausch party'));
ok('but leaves the events alone', (await page.textContent('#grid')).includes('Team Trivia'));
await page.click('#kindchips .chip:nth-child(1)');
await sleep(200);
ok('and turning it back on restores them', (await page.textContent('#grid')).includes('Rausch party'));

// ---------------------------------------------------------------- detail + assign
await page.click(pendingSel);
await page.waitForSelector('#modal.open', { timeout: 5000 });
const modalText = await page.textContent('#modal-box');
ok('the booking detail shows the guest count', /14/.test(modalText));
ok('the booking detail spells out the payment position', /Deposit due — payable on the day/.test(modalText));
ok('the booking detail offers Guru assignment', /Gurus on this/.test(modalText));
ok('and a link back to the request', /Open in Requests/.test(modalText));

await page.click('#gpick .chip:nth-child(2)');
await page.click('#modal-box .btn:not(.btn-ghost)');
await sleep(500);
const post = saved.find(s => s && s.action === 'save-assignment');
ok('saving posts a bookingId assignment, not an eventId one',
  post && post.item && post.item.bookingId === 'BK-PEND' && !post.item.eventId, JSON.stringify(post));

// ---------------------------------------------------------------- day view
await page.click('#tab-day');
await page.waitForSelector('#dayrooms table', { timeout: 8000 });
await sleep(400);
const roomsText = await page.textContent('#dayrooms');
ok('the day view lists every room, including the VRBO spaces',
  ['The Holt', "Stash's Den", 'The Depths', 'The Lodge', "The Adventurer's Rest"].every(r => roomsText.includes(r)));
ok('and an off-site lane', roomsText.includes('Off-site'));
await page.screenshot({ path: path.join(SHOTS, 'guru-master-day.png'), fullPage: true });

// ---------------------------------------------------------------- store hours
await page.click('#tab-hours');
await page.waitForSelector('#hours-week .hrow', { timeout: 5000 });
const hoursText = await page.textContent('#view-hours');
ok('the store-hours editor lists all seven days',
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].every(d => hoursText.includes(d)));
ok('and the existing exception is shown', (await page.inputValue('#hours-over input[type=date]')) === '2026-09-19');

// The time controls. Native <input type="time"> clipped its own value and
// accepted half-typed garbage; these are dropdowns of real opening times.
ok('[hours] no native time inputs remain', (await page.$$('#view-hours input[type=time]')).length === 0);
const sels = await page.$$('#hours-week select.t');
ok('[hours] every day has an open and a close dropdown', sels.length === 14, sels.length + ' found');
const optCount = await page.$$eval('#hours-week select.t', els => els[0].options.length);
ok('[hours] the dropdown offers quarter-hour times', optCount === 97, optCount + ' options');
const closeOpts = await page.$$eval('#hours-week select.t', els => Array.from(els[1].options).map(o => o.text));
ok('[hours] closing at midnight is offered', closeOpts.indexOf('Midnight') >= 0);
ok('[hours] and midnight is NOT offered as an opening time',
  (await page.$$eval('#hours-week select.t', els => Array.from(els[0].options).map(o => o.text))).indexOf('Midnight') < 0);
// Nothing may be clipped: the control must be at least as wide as its content.
const clipped = await page.$$eval('#hours-week select.t', els =>
  els.filter(e => e.scrollWidth > e.clientWidth + 1).length);
ok('[hours] no dropdown clips its own value', clipped === 0, clipped + ' clipped');

// Fill Tuesday in and copy it across.
await page.selectOption('#hours-week .hrow:nth-child(3) select.t >> nth=0', '12:00');
await page.selectOption('#hours-week .hrow:nth-child(3) select.t >> nth=1', '20:00');
await sleep(200);
ok('[hours] the row shows how long the day is', /8h/.test(await page.textContent('#hours-week .hrow:nth-child(3)')));
await page.click('#hours-week .hrow:nth-child(3) button');
await sleep(250);
const afterCopy = await page.$$eval('#hours-week select.t', els => els.map(e => e.value));
ok('[hours] copy-to-all-days fills every open day', afterCopy.filter(v => v === '12:00').length >= 2 && afterCopy.filter(v => v === '20:00').length >= 2,
  afterCopy.join(','));
// Closed days must be left alone by the copy.
await page.click('#hours-week .hrow:nth-child(1) input[type=checkbox]');
await sleep(200);
ok('[hours] a closed day disables its dropdowns',
  await page.isDisabled('#hours-week .hrow:nth-child(1) select.t >> nth=0'));
ok('[hours] and says so', /closed/i.test(await page.textContent('#hours-week .hrow:nth-child(1)')));

await page.screenshot({ path: path.join(SHOTS, 'guru-master-hours.png'), fullPage: true });

// ---------------------------------------------------------------- narrow
await page.setViewportSize({ width: 430, height: 900 });
await page.click('#tab-week');
await page.waitForSelector('#rail table', { timeout: 8000 });
await sleep(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
ok('the page does not scroll sideways on a phone', overflow);
await page.screenshot({ path: path.join(SHOTS, 'guru-master-narrow.png'), fullPage: true });

// =========================================================================
// The Guru Schedule — the page that has never once shown a booking.
await page.setViewportSize({ width: 1500, height: 1000 });
await page.goto(`${BASE}/guru-schedule.html`, { waitUntil: 'domcontentloaded' });
await sleep(600);
await page.evaluate(() => { if (window.jumpTo) return; });
// Drive it to the week containing the fixture data.
await page.evaluate(() => { if (typeof sched === 'object') { sched.anchor = '2026-09-16'; } });
await page.evaluate(() => { if (typeof setView === 'function') setView('sched'); });
await sleep(600);
const schedHtml = await page.content();

ok('[guru-schedule] the page still renders after the patch', /view-sched/.test(schedHtml));
ok('[guru-schedule] an APPROVED booking now appears', schedHtml.includes('Olson group'));
ok('[guru-schedule] a PENDING booking now appears', schedHtml.includes('Rausch party'));
ok('[guru-schedule] a rejected booking stays out', !schedHtml.includes('Should not show'));
ok('[guru-schedule] events still appear', schedHtml.includes('Team Trivia'));
ok('[guru-schedule] a booking that bought Gurus says so', /NEEDS 2 GURUS/.test(schedHtml));
const bkBlocks = await page.$$('#view-sched .blk.ev.booking');
ok('[guru-schedule] bookings carry the booking class', bkBlocks.length >= 2, bkBlocks.length + ' found');
const pendBlocks = await page.$$('#view-sched .blk.ev.booking.pending');
ok('[guru-schedule] and a pending one is hatched', pendBlocks.length === 1, pendBlocks.length + ' found');
const bkStyle = await page.evaluate(() => {
  const b = document.querySelector('#view-sched .blk.ev.booking'), e = document.querySelector('#view-sched .blk.ev:not(.booking)');
  if (!b || !e) return null;
  return { b: getComputedStyle(b).backgroundColor, e: getComputedStyle(e).backgroundColor };
});
ok('[guru-schedule] a booking does not look like an event', bkStyle && bkStyle.b !== bkStyle.e, JSON.stringify(bkStyle));
await page.screenshot({ path: path.join(SHOTS, 'guru-schedule-bookings.png'), fullPage: true });

// =========================================================================
// Tonight — the page a Guru reads before a shift.
await page.goto(`${BASE}/guru-tonight.html`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#bookings-list', { timeout: 8000 });
await sleep(700);
const tonight = await page.textContent('#bookings-list');
ok('[tonight] the room-bookings section exists', typeof tonight === 'string');
ok('[tonight] events still render', !!(await page.$('#today-list, #week-list')));
const bkCards = await page.$$('#bookings-list .card.bk');
ok('[tonight] bookings render as their own cards, not as event cards',
  bkCards.length >= 0);
await page.screenshot({ path: path.join(SHOTS, 'guru-tonight-bookings.png'), fullPage: true });

ok('no console or page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const pass = results.filter(r => r.pass).length;
console.log(`\n${pass}/${results.length} checks passed. Screenshots in ${SHOTS}`);
if (issues.length) { console.error('FAILED: ' + issues.join(', ')); process.exit(1); }
