#!/usr/bin/env node
// NGH-BUILD 2026-09-12x
// tests/app-store-shots.mjs — walks every screen of the packaged app at phone
// size, checks it actually rendered, and writes Play-ready screenshots.
//
//   node tests/app-store-shots.mjs          → tests/store-shots/*.png
//   DUMP=1 node tests/app-store-shots.mjs   → also print what each screen said
//
// Two jobs in one pass, on purpose. The Google Play listing needs phone
// screenshots, and the app has never been run on a phone — so the same walk
// that produces the marketing images is also the first honest check that every
// screen loads, renders content, and throws nothing. A screenshot of a broken
// screen fails the assertion before it ever reaches the listing.
//
// Play wants 1080x1920-ish, 24-bit PNG, no alpha. A 360x640 viewport at
// deviceScaleFactor 3 gives exactly 1080x1920 and matches a real mid-range
// Android phone's CSS pixel size, so the layout under test is the real one.
//
// The `must` patterns below deliberately match content that ONLY appears when
// the API answered. The first version of this file used loose patterns like
// /karaoke|sing|join/, which the "nothing on right now" empty state satisfies
// just as well as the live screen — so six screens were passing, and being
// photographed, with no data in them at all. Match the data, not the chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8888;                       // ngh-app.js treats localhost:8888 as on-site
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.SHOTS || path.join(root, 'tests', 'store-shots');
const DUMP = !!process.env.DUMP;
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const issues = [];
function ok(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ' — ' + detail : ''}`);
  if (!cond) issues.push(name);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Google Fonts / gstatic are unreachable from this sandbox (the egress proxy
// refuses the CONNECT), so the pages render in their declared fallbacks —
// Georgia for the Cinzel headings, system sans for Nunito. That is a property
// of the sandbox, not a defect in the app, and it is also exactly what the app
// looks like on a phone with no connectivity. It is reported at the end.
const IGNORE = /fonts\.googleapis|fonts\.gstatic|favicon|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY|ERR_TUNNEL|discord|facebook|instagram|maps\.google/;

// ---- mock API + static site -------------------------------------------------
try {
  const r = await fetch(BASE + '/api/events');
  console.error(`Port ${PORT} already serving (HTTP ${r.status}) — stop it first.`); process.exit(2);
} catch { }
const mock = spawn(process.execPath, [path.join(root, 'tests', 'mock-api.mjs')],
  { env: { ...process.env, PORT: String(PORT), QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let mockDied = false;
mock.stderr.on('data', d => process.stderr.write('[mock] ' + d));
mock.on('exit', c => { if (c) mockDied = true; });
for (let i = 0; i < 60; i++) {
  if (mockDied) { console.error('mock server exited early'); process.exit(2); }
  try { if ((await fetch(BASE + '/api/events')).ok) break; } catch { }
  await sleep(100);
}

// Every screen the app shell actually offers, with something that proves the
// LIVE state rendered rather than the empty state, a 404, or a script death.
const SCREENS = [
  { file: '01-home', url: '/app/', must: /Commander Night/i, label: 'App home' },
  { file: '02-specials-food', url: '/app/specials.html?cat=food', must: /Two-Slice Tuesday/i, label: 'Food specials' },
  { file: '03-specials-retail', url: '/app/specials.html?cat=retail', must: /Three Boosters/i, label: 'Retail specials' },
  { file: '04-shop', url: '/app/shop.html', must: /Catan/i, label: 'Shop' },
  { file: '05-account', url: '/app/account.html', must: /account|sign in|email|reward/i, label: 'Account & rewards' },
  { file: '06-companion', url: '/app/companion/', must: /life|turn|first player|initiative/i, label: 'Game Companion' },
  { file: '07-life-counter', url: '/app/companion/life-counter.html', must: /\b(20|40)\b/, label: 'Life counter' },
  { file: '08-turn-tracker', url: '/app/companion/turn-tracker.html', must: /turn|player|start/i, label: 'Turn tracker' },
  { file: '09-karaoke', url: '/app/karaoke/', must: /HAVN/, label: 'Karaoke Battle' },
  { file: '10-karaoke-join', url: '/app/karaoke/join.html', must: /battle is on|join it/i, label: 'Karaoke join' },
  { file: '11-trivia', url: '/app/trivia/play.html', must: /Team Trivia/i, label: 'Team Trivia' },
  { file: '12-speedgaming', url: '/app/speedgaming/', must: /Speed Gaming Meet-up|table/i, label: 'Speed Gaming' },
  { file: '13-mtg', url: '/app/mtg/', must: /FNM7K2/, label: 'Magic night' },
  { file: '14-first-player', url: '/app/companion/first-player.html', must: /first|player|tap|who/i, label: 'Who goes first' },
  { file: '15-rpg', url: '/app/companion/rpg.html', must: /rpg|initiative|hp|dice|roll/i, label: 'RPG tools' }
];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 360, height: 640 },
  deviceScaleFactor: 3,                       // → 1080 x 1920 PNGs
  isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Mobile Safari/537.36'
});
// Speed Gaming shows the check-in form until the device remembers who you are;
// the table/partner/countdown screen — the one worth photographing — only
// renders for a checked-in player. Seed the same localStorage key the page
// writes after a real check-in (meStore = NGH.store('ngh_sg_' + code)).
await ctx.addInitScript(() => {
  try { localStorage.setItem('ngh_sg_SG4T', JSON.stringify({ playerId: 'p13', token: 'tok_demo', name: 'Cole' })); } catch (e) { }
});
const page = await ctx.newPage();
const errs = [];
const apiFails = [];
let current = '';
page.on('console', m => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(current + ' :: ' + m.text()); });
page.on('pageerror', e => { if (!IGNORE.test(String(e))) errs.push(current + ' :: ' + String(e)); });
// A generic "404 (Not Found)" in the console does not say WHICH request died.
// Capture the URL, so a missing endpoint names itself instead of hiding.
page.on('response', r => {
  if (r.status() >= 400 && r.url().startsWith(BASE)) apiFails.push(current + '  ->  ' + r.status() + ' ' + r.url().replace(BASE, ''));
});

for (const s of SCREENS) {
  const before = errs.length, apiBefore = apiFails.length;
  current = s.url;
  let status = 0;
  try {
    const resp = await page.goto(BASE + s.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    status = resp ? resp.status() : 0;
  } catch (e) {
    ok(`${s.label} loads`, false, e.message); continue;
  }
  await sleep(900);
  const text = await page.evaluate(() => document.body ? document.body.innerText : '');
  if (DUMP) console.log(`      ${s.url} → ${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 180))}`);
  ok(`${s.label} loads (HTTP ${status})`, status === 200, s.url);
  ok(`${s.label} renders real content`, text.trim().length > 40, `only ${text.trim().length} chars`);
  ok(`${s.label} shows live data`, s.must.test(text), 'no match for ' + s.must + ' in: ' + text.slice(0, 140).replace(/\s+/g, ' '));
  ok(`${s.label} every request answered`, apiFails.length === apiBefore, apiFails.slice(apiBefore).join(' | '));
  ok(`${s.label} throws nothing`, errs.length === before, errs.slice(before).join(' | ').slice(0, 200));

  // No sideways scroll on a phone — the single most common packaged-app defect.
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  ok(`${s.label} fits the screen`, !wide,
    await page.evaluate(() => document.documentElement.scrollWidth + ' > ' + window.innerWidth));

  await page.screenshot({ path: path.join(OUT, s.file + '.png') });
}

// Play rejects screenshots with an alpha channel, and rejects anything under
// 320px on a side. Check the files we just wrote rather than trusting the
// viewport maths.
for (const s of SCREENS) {
  const f = path.join(OUT, s.file + '.png');
  if (!fs.existsSync(f)) { ok(`${s.label} screenshot written`, false); continue; }
  const buf = fs.readFileSync(f);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), colorType = buf[25];
  ok(`${s.label} screenshot is 1080x1920`, w === 1080 && h === 1920, `${w}x${h}`);
  ok(`${s.label} screenshot has no alpha (Play rejects it)`, colorType === 2, 'PNG colour type ' + colorType);
}

// Did the webfonts actually load? Not a failure — but the caller needs to know
// whether these images carry the shipping typography or the fallback stack.
// document.fonts.check() is useless here: with no matching @font-face rule in
// the document it returns TRUE, on the assumption the family is a system font.
// It reported "Cinzel loaded" on a run where the stylesheet had died at the
// proxy. Measure instead — if asking for Cinzel renders at exactly the width of
// a family that cannot exist, Cinzel is not there.
const fontsLoaded = await page.evaluate(() => {
  const probe = (family) => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = '600 40px ' + family;
    return c.measureText('Northwood Game Haven').width;
  };
  const missing = probe('"__ngh_no_such_font__"');
  return Math.abs(probe('"Cinzel", "__ngh_no_such_font__"') - missing) > 0.5;
});

await browser.close();
mock.kill();

const pass = results.filter(r => r.pass).length;
console.log(`\n${pass}/${results.length} checks passed. Screenshots in ${OUT}`);
console.log(fontsLoaded
  ? 'Webfonts: Cinzel loaded — these images carry the shipping typography.'
  : 'Webfonts: Cinzel did NOT load (no egress to fonts.googleapis.com from this sandbox).\n' +
    '  Layout and content are accurate; headings fall back to Georgia. Re-shoot on a\n' +
    '  networked machine or the phone itself before these go on the listing.');
if (errs.length) { console.log('\nConsole/page errors seen:'); errs.slice(0, 12).forEach(e => console.log('  ' + e)); }
if (apiFails.length) { console.log('\nRequests that failed:'); [...new Set(apiFails)].slice(0, 20).forEach(e => console.log('  ' + e)); }
if (issues.length) { console.error('FAILED: ' + issues.join(', ')); process.exit(1); }
