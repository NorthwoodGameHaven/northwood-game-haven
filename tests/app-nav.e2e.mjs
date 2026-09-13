#!/usr/bin/env node
// NGH-BUILD 2026-09-13a
// tests/app-nav.e2e.mjs — the four things a real phone found that no test had:
//
//   1. Hardware back walked the WebView's history TAPE, so leaving the turn
//      tracker took you to the life counter — the tool you had already left.
//      Reproduced here exactly, then asserted against the hierarchy.
//   2. Enough back presses dropped you out of the app with no warning, and out
//      of a live rotation with no way in again.
//   3. The table code and its QR lived only on the lobby screen, so once the
//      game went live the phone could not be handed down the table.
//   4. The crest never changed with the season.
//
//   node tests/app-nav.e2e.mjs        (screenshots → $SHOTS or tests/screenshots)
//
// Runs against tests/mock-api.mjs, which now serves the real Turn Tracker
// routes (tests/mock-companion.mjs), so the live rotation is a real one.
// Exits 1 on any failed assertion or unexpected console/page error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8891;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || path.join(root, 'tests', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0; const issues = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { issues.push(name); console.log('FAIL  ' + name + (detail != null ? '  — ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORE = /fonts\.googleapis\.com|fonts\.gstatic\.com|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY|ERR_TUNNEL|favicon/;

try { const r = await fetch(BASE + '/api/events'); console.error(`Port ${PORT} is already serving (HTTP ${r.status}) — stop it first.`); process.exit(2); } catch {}
const mock = spawn(process.execPath, [path.join(root, 'tests', 'mock-api.mjs')], { env: { ...process.env, PORT: String(PORT), QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let mockDied = false;
mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
mock.on('exit', (c) => { if (c) mockDied = true; });
for (let i = 0; i < 50; i++) { if (mockDied) { console.error('mock server exited early'); process.exit(2); } try { if ((await fetch(BASE + '/api/events')).ok) break; } catch {} await sleep(100); }

const browser = await chromium.launch();
const consoleErrors = [];
const vp = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'America/Chicago' };

async function newPage(ctx, label) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) consoleErrors.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { const t = `${r.url()} ${(r.failure() && r.failure().errorText) || ''}`; if (!IGNORE.test(t)) consoleErrors.push(`[${label}] requestfailed: ${t}`); });
  // Any window.confirm() left in the app would hang the run; fail loudly instead.
  page.on('dialog', (d) => { consoleErrors.push(`[${label}] blocking ${d.type()} dialog: ${d.message()}`); d.dismiss(); });
  // ngh-app.js only treats localhost:8888 as "on site". On any other port it
  // takes the bundled-native path and reads window.NGH_SITE_URL for the API —
  // which is the path the packaged Android app takes, so this is the more
  // faithful of the two anyway.
  if (PORT !== 8888) await page.addInitScript(() => { window.NGH_SITE_URL = location.origin; });
  return page;
}
const here = (p) => new URL(p.url()).pathname;
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, n + '.png') });
// NGH.goBack() is what the Android hardware button calls. It is exported, so
// the whole model is drivable from a desktop browser — no device required.
async function back(page) {
  await page.waitForFunction(() => !!window.NGH, null, { timeout: 8000 });
  // goBack() may call location.replace() synchronously, which tears down the
  // execution context this evaluate is running in — that is a success, not a
  // failure, so the rejection is swallowed and the load waited out instead.
  await page.evaluate(() => NGH.goBack()).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(200);
}

try {
  // ============================================================ back hierarchy
  console.log('\nBack button — hierarchy, not history');
  const ctx = await browser.newContext(vp);
  const p = await newPage(ctx, 'nav');

  // Walk the app the way the bug report describes: into one tool, back out via
  // the on-screen ‹, then into another. That is what loads the history tape.
  await p.goto(BASE + '/app/index.html');
  await p.click('.tile[href="/app/companion/index.html"]');
  await p.waitForURL('**/companion/index.html');
  await p.click('.tile[href="/app/companion/life-counter.html"]');
  await p.waitForURL('**/life-counter.html');
  // The life counter opens on its own setup sheet, which covers the header ‹.
  // A goto pushes the same history entry a tap on ‹ would, and the tape is the
  // only thing this step is here to build.
  await p.goto(BASE + '/app/companion/index.html');
  await p.click('.tile[href="/app/companion/turn-tracker.html"]');
  await p.waitForURL('**/turn-tracker.html');
  const depth = await p.evaluate(() => history.length);
  ok('the history tape really is loaded (' + depth + ' entries)', depth >= 5, 'depth ' + depth);

  await back(p);
  ok('back from the turn tracker → the companion index', here(p) === '/app/companion/index.html', here(p));
  await back(p);
  // The whole point: the tape says life-counter, the hierarchy says home.
  ok('back again → the app home, NOT the life counter', here(p) === '/app/index.html', here(p));

  await back(p);
  ok('back on the home screen does not leave silently', here(p) === '/app/index.html', here(p));
  ok('…it asks first', await p.isVisible('.sheet'), 'no confirm sheet appeared');
  ok('…and the sheet says what it will do', /close/i.test(await p.textContent('.sheet') || ''));
  await shot(p, 'nav-exit-confirm');
  await p.click('.sheet .btn.ghost');
  await sleep(120);
  ok('“Stay” dismisses it', !(await p.isVisible('.sheet')));

  // a page whose ‹ points off the bundled shell must still land inside it
  await p.goto(BASE + '/app/shop-orders.html');
  await sleep(200);
  ok('a ‹ pointing at /guru.html is a website link', (await p.getAttribute('.app-header .back', 'href')) === '/guru.html');
  await back(p);
  ok('…but hardware back stays in the app', here(p) === '/app/index.html', here(p));

  // guards
  await p.waitForFunction(() => !!window.NGH, null, { timeout: 8000 });
  const guard = await p.evaluate(async () => {
    const seen = [];
    NGH.onBack(() => { seen.push('outer'); return true; });
    const off = NGH.onBack(() => { seen.push('inner'); return true; });
    NGH.goBack();
    off();
    NGH.goBack();
    return seen;
  });
  ok('the newest guard runs first', guard[0] === 'inner', JSON.stringify(guard));
  ok('unregistering falls through to the next one', guard[1] === 'outer', JSON.stringify(guard));
  await p.close();

  // ============================================================ seasonal crest
  console.log('\nSeasonal crest');
  const s = await newPage(ctx, 'season');
  await s.goto(BASE + '/app/index.html?logo=halloween');
  const swapped = await s.waitForFunction(() => document.querySelector('.app-header .logo').src.indexOf('halloween') > 0, null, { timeout: 4000 })
    .then(() => true).catch(() => false);
  ok('?logo= swaps the header crest', swapped, await s.getAttribute('.app-header .logo', 'src'));
  const heroSrc = await s.getAttribute('.hero img', 'src');
  ok('…and the hero crest with it', /halloween/.test(heroSrc || ''), heroSrc);
  const heroOk = await s.evaluate(() => { const i = document.querySelector('.hero img'); return i.complete && i.naturalWidth > 0; });
  ok('…and the file it points at actually loads', heroOk);
  await shot(s, 'nav-seasonal-halloween');
  await s.goto(BASE + '/app/specials.html');
  ok('the choice sticks across pages', /halloween/.test(await s.getAttribute('.app-header .logo', 'src') || ''));
  await s.goto(BASE + '/app/index.html?logo=auto');
  const auto = await s.evaluate(() => NGH.logoKey());
  ok('?logo=auto hands it back to the calendar (' + auto + ')', auto === (await s.evaluate(() => NGH.seasonKey(new Date()))));
  await s.close();

  // ============================================================ turn tracker
  console.log('\nTurn Tracker — the code goes everywhere the phone does');
  const t = await newPage(ctx, 'turns');
  await t.goto(BASE + '/app/companion/turn-tracker.html');
  ok('no badge before you have a table', await t.isHidden('#tb'));

  await t.click('#btnHost');
  await t.fill('#nameIn', 'Dustin');
  await t.click('.sw[data-c="#2e9e4f"]');
  await t.click('#btnMeGo');
  await t.waitForSelector('#pLobby.on');
  const code = (await t.textContent('#lobbyCode') || '').trim();
  ok('hosting a table returns a code (' + code + ')', /^[A-Z0-9]{5}$/.test(code), code);
  ok('the badge appears with the table', await t.isVisible('#tb'));
  ok('…showing the same code as the lobby', (await t.textContent('#tbCode') || '').trim() === code);
  const badgeQr = await t.evaluate(() => { const i = document.getElementById('tbQr'); return { src: i.getAttribute('src') || '', done: i.complete && i.naturalWidth > 0 }; });
  ok('…and a QR that loaded', badgeQr.done, badgeQr.src);
  ok('…pointing at this table', decodeURIComponent(badgeQr.src).indexOf('turn-tracker.html?t=' + code) > 0, badgeQr.src);

  // A second phone: its own context, so it gets its own localStorage and so its
  // own NGH.DEVICE_ID. In one context the join would match the host's device id
  // and quietly rename the host instead of adding a player.
  const ctx2 = await browser.newContext(vp);
  const g = await newPage(ctx2, 'guest');
  await g.goto(BASE + '/app/companion/turn-tracker.html?t=' + code);
  await g.waitForSelector('#pMe.on');
  await g.fill('#nameIn', 'Sam');
  await g.click('.sw[data-c="#d7263d"]');
  await g.click('#btnMeGo');
  await g.waitForSelector('#pLobby.on');
  ok('a second phone can join with the code', (await g.textContent('#lobbyCode') || '').trim() === code);
  ok('the guest gets the badge too', await g.isVisible('#tb'));

  await t.waitForFunction(() => document.querySelectorAll('#playerList li').length === 2, null, { timeout: 6000 });
  await t.click('#btnStart');
  await t.waitForSelector('#live.on');
  ok('the game goes live', await t.isVisible('#live'));
  // This is the ask: the code stays reachable once the lobby is covered up.
  ok('the badge survives the full-screen live view', await t.isVisible('#tb'));
  const above = await t.evaluate(() => {
    const b = document.getElementById('tb').getBoundingClientRect();
    const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!(el && el.closest('#tb'));
  });
  ok('…and is on top of it, not behind it', above);
  await shot(t, 'nav-turns-live-badge');

  await t.click('#tb');
  await t.waitForSelector('.sheet');
  ok('tapping the badge opens the pass-it-down sheet', await t.isVisible('.sheet'));
  ok('…with the code spelled out', (await t.textContent('.sheet .codebig') || '').trim() === code);
  // The QR is a real network fetch. Reading img.complete the instant the sheet
  // opens is a coin flip — wait for it, then measure.
  const qrDone = await t.waitForFunction(() => { const i = document.querySelector('.pd-qr img'); return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 })
    .then(() => true).catch(() => false);
  const bigQr = await t.evaluate(() => document.querySelector('.pd-qr img').getBoundingClientRect().width);
  ok('…and a QR big enough for another phone to read (' + Math.round(bigQr) + 'px)', qrDone && bigQr >= 200, 'loaded=' + qrDone + ' width=' + Math.round(bigQr));
  await shot(t, 'nav-turns-pass-it-down');
  await back(t);
  ok('back closes the sheet rather than leaving the game', !(await t.isVisible('.sheet')) && here(t) === '/app/companion/turn-tracker.html');
  ok('…and the game is still live underneath', await t.isVisible('#live.on'));

  // ============================================================ the exit guard
  console.log('\nTurn Tracker — you cannot fall out of the rotation');
  await back(t);
  await t.waitForSelector('.sheet');
  ok('back inside a live table asks first', /leave the turn tracker/i.test(await t.textContent('.sheet') || ''));
  ok('…and says the seat is kept', new RegExp('stays in the rotation', 'i').test(await t.textContent('.sheet') || ''));
  await shot(t, 'nav-turns-leave-confirm');
  await t.click('.sheet .btn.ghost');
  await sleep(150);
  ok('“Stay” keeps you at the table', here(t) === '/app/companion/turn-tracker.html' && await t.isVisible('#live.on'));

  await back(t);
  await t.waitForSelector('.sheet');
  await t.click('.sheet .btn:not(.ghost)');
  await t.waitForURL('**/companion/index.html', { timeout: 5000 });
  ok('“Leave” backs out to the Game Companion', here(t) === '/app/companion/index.html', here(t));

  // …and the seat is still there, which is the half that was missing
  const stillThere = await (await fetch(`${BASE}/api/companion/tables/${code}/state`)).json();
  ok('the seat is still in the rotation on the server', (stillThere.players || []).length === 2, JSON.stringify(stillThere.players || []));
  ok('the game is still running', stillThere.status === 'live', stillThere.status);

  ok('the companion index offers the way back in', await t.isVisible('#rejoin'));
  ok('…naming the table', (await t.textContent('#rejoinSub') || '').indexOf(code) >= 0, await t.textContent('#rejoinSub'));
  await shot(t, 'nav-companion-rejoin');
  await t.click('#rejoinBtn');
  await t.waitForSelector('#live.on', { timeout: 8000 });
  ok('Rejoin drops you straight back into the live game', await t.isVisible('#live.on'));
  ok('…as the same player, not a new one', await t.isVisible('#tb') && (await t.textContent('#tbCode') || '').trim() === code);
  const after = await (await fetch(`${BASE}/api/companion/tables/${code}/state`)).json();
  ok('…and the table did not grow a duplicate', (after.players || []).length === 2, JSON.stringify((after.players || []).map((x) => x.name)));

  await g.close(); await t.close(); await ctx2.close(); await ctx.close();
} finally {
  await browser.close();
  mock.kill();
}

for (const e of consoleErrors) { issues.push(e); console.log('FAIL  ' + e); }
console.log(`\n${pass} passed, ${issues.length} failed`);
process.exit(issues.length ? 1 : 0);
