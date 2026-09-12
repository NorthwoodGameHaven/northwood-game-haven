// NGH-BUILD 2026-09-11a
// tests/specials.e2e.mjs — end-to-end check of the Specials + Guru + Trivia pages
// against tests/mock-specials.mjs, using Playwright (chromium) at 390×844.
//
//   node tests/specials.e2e.mjs [--shots DIR]
//
// Steps: (1) vm.Script-validate every inline <script> of the three pages,
// (2) start the mock on :8888 (ngh-app.js treats localhost:8888 as the site
// origin; waits up to 2 min if the port is busy), (3) drive the flows and
// screenshot each state, (4) fail on any console error (Google Fonts ignored).
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8888;
const BASE = 'http://localhost:' + PORT;
const argv = process.argv.slice(2);
const SHOTS = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function ok(name, pass, detail) { results.push({ name, pass: !!pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); if (!pass) process.exitCode = 1; }

// ---------- 1. validate inline <script> blocks ----------
const PAGES = ['site/app/specials.html', 'site/app/guru-specials.html', 'site/app/trivia/play.html'];
for (const rel of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0, bad = null;
  while ((m = re.exec(html))) { n++; try { new vm.Script(m[1], { filename: rel + '#script' + n }); } catch (e) { bad = e.message; } }
  ok('vm.Script ' + rel + ' (' + n + ' inline block' + (n === 1 ? '' : 's') + ')', n > 0 && !bad, bad || '');
}

// ---------- 2. start the mock on 8888 (wait for the port if busy) ----------
function portFree(port) {
  return new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
}
async function waitForPort(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await portFree(port)) return true; await new Promise(r => setTimeout(r, 3000)); }
  return false;
}
if (!(await waitForPort(PORT, 120_000))) { console.error('port ' + PORT + ' stayed busy for 2 minutes — aborting'); process.exit(2); }
const mock = spawn(process.execPath, [path.join(__dirname, 'mock-specials.mjs')], { env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
mock.stdout.on('data', d => process.stdout.write('[mock] ' + d));
mock.stderr.on('data', d => process.stderr.write('[mock:err] ' + d));
async function waitHttp(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.ok) return true; } catch {} await new Promise(r => setTimeout(r, 200)); }
  return false;
}
if (!(await waitHttp(BASE + '/api/specials/settings', 10_000))) { console.error('mock did not come up'); mock.kill(); process.exit(2); }

// ---------- 3. browser flows ----------
const browser = await chromium.launch({ headless: true });
// Error policy: any pageerror or console.error is a failure, except
//  - Google Fonts (blocked in the sandbox; the pages have real fallback stacks),
//  - Chrome's automatic "Failed to load resource … 4xx" line for API calls whose
//    4xx is the *expected* answer (wrong Guru code → 401, unknown coupon → 404,
//    /trivia/active → 404 when idle),
//  - requests aborted by our own navigation (ERR_ABORTED),
//  - anything inside the trivia-display.html iframe (third-party page: it loads
//    cdnjs / YouTube / open-meteo, which the sandbox cannot reach).
const IGNORE = /fonts\.googleapis\.com|fonts\.gstatic\.com/;
const EXPECTED_4XX = /\/api\/(admin-login|specials\/redeem|trivia\/active|specials\/coupon\/[^/]+\/status)$/;
function watch(page, label) {
  const errors = [];
  const mainFrame = () => page.mainFrame();
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const loc = (msg.location() && msg.location().url) || '';
    const text = msg.text();
    if (IGNORE.test(text) || IGNORE.test(loc)) return;
    if (/^Failed to load resource/.test(text) && (EXPECTED_4XX.test(loc) || (loc === '' && !/status of 5\d\d/.test(text)))) return;
    // our pages load nothing off-origin except Google Fonts; other hosts are the embedded trivia-display.html's CDN/YouTube/weather calls
    if (/^Failed to load resource/.test(text) && loc && !loc.startsWith(BASE)) return;
    errors.push(label + ': console.error: ' + text + (loc ? ' @ ' + loc : ''));
  });
  page.on('pageerror', e => errors.push(label + ': pageerror: ' + e.message));
  page.on('requestfailed', r => {
    const f = r.failure() ? r.failure().errorText : '';
    if (IGNORE.test(r.url()) || f === 'net::ERR_ABORTED' || r.frame() !== mainFrame()) return;
    errors.push(label + ': requestfailed: ' + r.url() + ' ' + f);
  });
  page.on('response', r => {
    if (r.status() < 400 || IGNORE.test(r.url()) || EXPECTED_4XX.test(r.url())) return;
    if (r.frame() !== mainFrame()) return;
    errors.push(label + ': HTTP ' + r.status() + ' ' + r.url());
  });
  return errors;
}
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'America/Chicago' });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' })); // offline sandbox: don't wait on fonts
const shot = (page, name, opts) => page.screenshot(Object.assign({ path: path.join(SHOTS, name + '.png'), fullPage: true }, opts || {}));
const shotView = (page, name) => shot(page, name, { fullPage: false }); // fixed overlays: capture the viewport as a phone would show it
// no horizontal scrolling anywhere: document, and any open sheet/overlay panel
const noXScroll = (page) => page.evaluate(() => {
  const bad = [];
  if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push('document ' + document.documentElement.scrollWidth + '>' + window.innerWidth);
  document.querySelectorAll('.sheet:not([hidden]) > div, .showview:not([hidden])').forEach(el => { if (el.scrollWidth > el.clientWidth + 1) bad.push(el.id || el.className); });
  return bad;
});
let claimedCode = null;

try {
  // ===== specials.html =====
  {
    const page = await ctx.newPage(); const errs = watch(page, 'specials');
    await page.goto(BASE + '/app/specials.html?cat=food', { waitUntil: 'networkidle' });
    await page.waitForSelector('.special', { timeout: 10_000 });
    const cards = await page.locator('.special').count();
    ok('specials: food cards listed', cards === 2, cards + ' cards');
    ok('specials: order-food button shown (settings.foodOrderUrl)', await page.locator('#orderBtn').isVisible());
    ok('specials: title reflects ?cat=food', (await page.locator('#pageTitle').textContent()).includes('Food'));
    await shot(page, '01-specials-food');
    ok('specials: no horizontal overflow', (await noXScroll(page)).length === 0, (await noXScroll(page)).join(','));

    // show-at-counter flow
    await page.locator('.special button[data-act="show"]').first().click();
    await page.waitForSelector('#showView:not([hidden])');
    ok('specials: show-at-counter view opens with today\'s date', /\d{4}/.test(await page.locator('#showDate').textContent()));
    await shotView(page, '02-specials-show-at-counter');
    await page.locator('#showClose').click();

    // claim flow
    await page.locator('.special button[data-act="claim"]').first().click();
    await page.waitForSelector('#claimSheet:not([hidden])');
    await page.fill('#claimName', 'Test Otter');
    await page.fill('#claimEmail', 'otter@example.com');
    await shotView(page, '03-specials-claim-sheet');
    await page.locator('#claimGo').click();
    await page.waitForSelector('#couponSheet:not([hidden])', { timeout: 10_000 });
    claimedCode = (await page.locator('#cpnCode').textContent()).trim();
    ok('specials: claim issued a code', /^SPC-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(claimedCode), claimedCode);
    const qrOk = await page.waitForFunction(() => { const i = document.getElementById('cpnQr'); return i.complete && i.naturalWidth > 100; }, null, { timeout: 10_000 }).then(() => true).catch(() => false);
    const qrSrc = await page.locator('#cpnQr').getAttribute('src');
    ok('specials: coupon QR PNG loaded from server', qrOk && qrSrc === BASE + '/api/specials/coupon/' + claimedCode + '/qr.png', qrSrc);
    await shotView(page, '04-specials-coupon-qr');
    ok('specials: coupon sheet no horizontal overflow', (await noXScroll(page)).length === 0, (await noXScroll(page)).join(','));
    await page.locator('#cpnClose').click();
    const wallet = await page.evaluate(() => JSON.parse(localStorage.getItem('ngh_coupons') || '[]'));
    ok('specials: wallet stored in localStorage ngh_coupons', wallet.length === 1 && wallet[0].code === claimedCode);
    ok('specials: My coupons section visible', await page.locator('#walletCard').isVisible());
    const leftTxt = await page.locator('.special .left').first().textContent();
    ok('specials: claim count decremented locally', /48 left/.test(leftTxt), leftTxt);
    await shot(page, '05-specials-wallet');

    // reload → live status refresh + retail tab switch
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#walletList li');
    const pill = (await page.locator('#walletList .st').first().textContent()).trim();
    ok('specials: wallet status fetched on load', pill === 'Active', pill);
    await page.locator('#seg button[data-cat="retail"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.special').length === 2 && /Retail/.test(document.getElementById('pageTitle').textContent));
    ok('specials: retail tab switches + URL updated', page.url().includes('cat=retail'));
    ok('specials: order-food hidden on retail tab', !(await page.locator('#orderBtn').isVisible()));
    await shot(page, '06-specials-retail');

    // empty state: hide everything from the admin side then reload retail
    const tok = (await (await fetch(BASE + '/api/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'guru' }) })).json()).token;
    for (const id of ['SPL-DEMO03', 'SPL-DEMO04']) await fetch(BASE + '/api/specials/admin/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ active: false }) });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#empty:not([hidden])');
    ok('specials: empty state with Stash', await page.locator('#empty img').isVisible());
    await shot(page, '07-specials-empty');
    for (const id of ['SPL-DEMO03', 'SPL-DEMO04']) await fetch(BASE + '/api/specials/admin/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ active: true }) });

    ok('specials: zero console/page errors', errs.length === 0, errs.join(' | '));
    await page.close();
  }

  // ===== guru-specials.html =====
  {
    const page = await ctx.newPage(); const errs = watch(page, 'guru');
    await page.evaluate(() => localStorage.removeItem('ngh_admin_token')).catch(() => {});
    await page.goto(BASE + '/app/guru-specials.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('#loginCard:not([hidden])');
    ok('guru: login gate shown when logged out', await page.locator('#loginCard').isVisible());
    await page.fill('#loginCode', 'wrong'); await page.locator('#loginBtn').click();
    await page.waitForFunction(() => document.getElementById('loginErr').textContent.length > 0);
    ok('guru: wrong code rejected', /Incorrect/.test(await page.locator('#loginErr').textContent()));
    await page.fill('#loginCode', 'guru'); await page.locator('#loginBtn').click();
    await page.waitForSelector('#main:not([hidden])');
    await page.waitForSelector('.sp');
    const n0 = await page.locator('.sp').count();
    ok('guru: specials list loaded incl. inactive/scheduled', n0 === 6, n0 + ' rows');
    await shot(page, '08-guru-main');
    ok('guru: no horizontal overflow', (await noXScroll(page)).length === 0, (await noXScroll(page)).join(','));

    // create
    await page.locator('#newBtn').click();
    await page.waitForSelector('#editSheet:not([hidden])');
    await page.selectOption('#fCat', 'retail'); await page.selectOption('#fRedeem', 'claim');
    await page.fill('#fTitle', 'E2E: Buy a booster, get a sleeve pack');
    await page.fill('#fPrice', 'Free'); await page.fill('#fBadge', 'This weekend');
    await page.fill('#fBlurb', 'Created by the e2e test.'); await page.fill('#fTerms', 'While supplies last.');
    await page.fill('#fImage', '/img/rooms/lodge-1.jpg');
    await page.fill('#fEnd', '2030-12-31T21:00'); await page.fill('#fLimit', '10');
    await shotView(page, '09-guru-editor');
    ok('guru: editor sheet no horizontal overflow', (await noXScroll(page)).length === 0, (await noXScroll(page)).join(','));
    await page.locator('#editSave').click();
    await page.waitForFunction(() => document.getElementById('editSheet').hidden && document.querySelectorAll('.sp').length === 7);
    const created = await page.locator('.sp', { hasText: 'E2E: Buy a booster' }).count();
    ok('guru: create special → appears in list', created === 1);
    const pub = await (await fetch(BASE + '/api/specials?cat=retail')).json();
    ok('guru: created special is live on the public API', pub.some(s => s.title.startsWith('E2E:') && s.claimLimit === 10 && s.redeem === 'claim'));

    // edit
    await page.locator('.sp', { hasText: 'E2E: Buy a booster' }).locator('[data-act="edit"]').click();
    await page.waitForSelector('#editSheet:not([hidden])');
    ok('guru: editor prefilled (datetime-local)', (await page.inputValue('#fEnd')) === '2030-12-31T21:00' && (await page.inputValue('#fLimit')) === '10');
    await page.fill('#fTitle', 'E2E: edited title'); await page.locator('#editSave').click();
    await page.waitForFunction(() => document.getElementById('editSheet').hidden);
    await page.waitForSelector('.sp:has-text("E2E: edited title")');
    ok('guru: edit special persisted', true);

    // redeem: typed code → green; again → red; garbage → red
    await page.fill('#redeemCode', claimedCode.toLowerCase());
    await page.locator('#redeemBtn').click();
    await page.waitForSelector('#redeemResult .result');
    let cls = await page.locator('#redeemResult .result').getAttribute('class');
    let big = await page.locator('#redeemResult .big').textContent();
    ok('guru: redeem valid code → green REDEEMED', /\bok\b/.test(cls) && /REDEEMED/.test(big), big);
    await shot(page, '10-guru-redeem-ok');
    await page.fill('#redeemCode', BASE + '/coupon-special/' + claimedCode); // scan-style URL input
    await page.locator('#redeemBtn').click();
    await page.waitForSelector('#redeemResult .result.no');
    big = await page.locator('#redeemResult .big').textContent();
    ok('guru: redeem again (URL form) → red ALREADY REDEEMED', /ALREADY REDEEMED/.test(big), big);
    await shot(page, '11-guru-redeem-dupe');
    await page.fill('#redeemCode', 'SPC-ZZZZ-ZZZZ'); await page.locator('#redeemBtn').click();
    await page.waitForFunction(() => /NOT FOUND/.test((document.querySelector('#redeemResult .big') || {}).textContent || ''));
    ok('guru: unknown code → NOT FOUND', true);
    const scanVisible = await page.locator('#scanBtn').isVisible(), hintVisible = await page.locator('#scanHint').isVisible();
    ok('guru: BarcodeDetector guard (scan button XOR typed hint)', scanVisible !== hintVisible, 'scanBtn=' + scanVisible + ' hint=' + hintVisible);

    // settings
    await page.fill('#foodOrderUrl', 'https://order.example.com/ngh'); await page.locator('#settingsSave').click();
    await page.waitForFunction(() => !document.getElementById('settingsSave').disabled);
    const s = await (await fetch(BASE + '/api/specials/settings')).json();
    ok('guru: settings saved (foodOrderUrl)', s.foodOrderUrl === 'https://order.example.com/ngh');

    // delete the e2e special
    await page.locator('.sp', { hasText: 'E2E: edited title' }).locator('[data-act="edit"]').click();
    await page.waitForSelector('#editSheet:not([hidden])');
    page.once('dialog', d => d.accept());
    await page.locator('#editDelete').click();
    await page.waitForFunction(() => document.querySelectorAll('.sp').length === 6);
    ok('guru: delete special', true);

    // wallet reflects redeemed status
    await page.goto(BASE + '/app/specials.html?cat=food', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => (document.querySelector('#walletList .st') || {}).textContent === 'Redeemed');
    ok('specials: wallet shows Redeemed after guru redeem', true);
    await shot(page, '12-specials-wallet-redeemed');

    ok('guru: zero console/page errors', errs.length === 0, errs.join(' | '));
    await page.close();
  }

  // ===== trivia/play.html =====
  {
    await fetch(BASE + '/__mock/trivia?live=1');
    const page = await ctx.newPage(); const errs = watch(page, 'trivia');
    await page.goto(BASE + '/app/trivia/play.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('#live:not([hidden])');
    ok('trivia: LIVE hero shown when a game is active', /LIVE/.test(await page.locator('#liveTitle').textContent()));
    ok('trivia: kind label', (await page.locator('#liveKind').textContent()) === 'Team Trivia');
    const href = await page.locator('#joinBtn').getAttribute('href');
    ok('trivia: join button targets /trivia-play.html?game=<id>', href === BASE + '/trivia-play.html?game=TRV-DEMO1234', href);
    await shot(page, '13-trivia-live');
    await page.locator('#tvBtn').click();
    await page.waitForSelector('#tvCard:not([hidden])');
    const src = await page.locator('#tvFrame').getAttribute('src');
    ok('trivia: TV feed iframe src', /\/trivia-display\.html\?game=TRV-DEMO1234&display=PHONE-[a-z0-9]+$/.test(src || ''), src);
    const scale = await page.locator('#tvFrame').evaluate(f => f.style.transform);
    ok('trivia: iframe scaled to phone width', /scale\(0\.\d+\)/.test(scale), scale);
    await page.waitForTimeout(1500);
    await shot(page, '14-trivia-tv-feed');
    ok('trivia: no horizontal overflow with TV frame open', (await noXScroll(page)).length === 0, (await noXScroll(page)).join(','));
    // idle state
    await fetch(BASE + '/__mock/trivia?live=0');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#idle:not([hidden])');
    ok('trivia: idle state when /trivia/active has no game', /No trivia running/.test(await page.locator('#idle .display').textContent()));
    await page.waitForSelector('#nextCard:not([hidden]) li');
    const items = await page.locator('#nextList li').allTextContents();
    // mock: Team Trivia Night (+2d, title match) · Thursday Throwdown (+3d, tags:['trivia'] only) · Event Stream (+4d, title) ·
    //       Reflex Rally (+5d) · Commander Night (today, not trivia) · Trivia (draft) · Private trivia party → expect the first three, in date order
    ok('trivia: next 3 trivia-tagged events (title + tag match; draft/private/non-trivia excluded)',
      items.length === 3 && /Team Trivia Night/.test(items[0]) && /Thursday Throwdown/.test(items[1]) && /Event Stream/.test(items[2]) && !items.some(t => /Commander|draft|Private|Reflex/.test(t)), JSON.stringify(items));
    await shot(page, '15-trivia-idle');
    // poll flips it back to live without a reload
    await fetch(BASE + '/__mock/trivia?live=1');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForSelector('#live:not([hidden])', { timeout: 10_000 });
    ok('trivia: re-check flips idle → live without reload', true);
    ok('trivia: zero console/page errors', errs.length === 0, errs.join(' | '));
    await page.close();
  }
} catch (e) {
  ok('unexpected failure', false, (e && e.stack) || String(e));
} finally {
  await browser.close();
  mock.kill();
}

const failed = results.filter(r => !r.pass);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed' + (failed.length ? ' — FAILURES: ' + failed.map(f => f.name).join('; ') : '') + '\nscreenshots: ' + SHOTS);
process.exit(failed.length ? 1 : 0);
