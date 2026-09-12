#!/usr/bin/env node
// NGH-BUILD 2026-09-11a
// tests/companion.e2e.mjs — end-to-end walk of the Game Companion offline tools:
//   /app/companion/life-counter.html  (MTG Commander life counter)
//   /app/companion/rpg.html           (Dice / Combat / Character / Rules / Notes)
// Both pages are pure localStorage apps, so a plain static server is enough.
//   node tests/companion.e2e.mjs            (serves site/ on $PORT or 8811 if nothing is there)
// Prints ✓/✗ lines, writes screenshots to $SHOTS or tests/screenshots, exits 1 on any
// failed assertion or any console / page error other than Google Fonts / proxy noise.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // global install (npm -g)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8811, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || path.join(ROOT, 'tests', 'screenshots'); fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
function ok(cond, label, detail) { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label + (detail != null ? '  — ' + detail : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORE = /fonts\.googleapis|fonts\.gstatic|ERR_TUNNEL|ERR_PROXY|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|favicon/;

// ---- static server (only if nothing already serves site/) ----
async function up() { try { const r = await fetch(BASE + '/app/index.html'); return r.status === 200; } catch { return false; } }
let server = null;
if (!(await up())) {
  server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: path.join(ROOT, 'site'), stdio: 'ignore' });
  let live = false; for (let i = 0; i < 40 && !live; i++) { await sleep(150); live = await up(); }
  if (!live) { console.error('could not start a static server on ' + PORT); process.exit(2); }
}

const browser = await chromium.launch();
const errors = [];
async function newPage(name) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US' });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(name + ' pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  p.on('requestfailed', (r) => { const t = r.url() + ' ' + (r.failure() && r.failure().errorText); if (!IGNORE.test(t)) errors.push(name + ' requestfailed: ' + t); });
  p.on('dialog', (d) => d.accept());
  return p;
}
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, n + '.png') });
async function noScroll(p) { return p.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, ih: window.innerHeight, iw: window.innerWidth })); }
async function clickN(p, sel, n) { for (let i = 0; i < n; i++) { await p.click(sel); await sleep(40); } }
const text = async (p, sel) => (await p.textContent(sel) || '').trim();
const errCount = () => errors.length;

try {
  // =============================================================== LIFE COUNTER
  console.log('\nCommander Life Counter');
  const lc = await newPage('life');
  await lc.goto(BASE + '/app/companion/life-counter.html');
  await lc.waitForSelector('#shSetup:not([hidden])');
  ok(true, 'page loads with the setup sheet on first run');
  ok(await lc.isHidden('#setupCancel'), 'setup sheet cannot be dismissed before a game exists');

  // start a 4-player, 40-life, around-the-table game
  await lc.click('#chipsN .chip[data-v="4"]');
  await lc.click('#chipsLife .chip[data-v="40"]');
  await lc.click('#chipsLayout .chip[data-v="around"]');
  await lc.fill('[data-pe-name="1"]', 'Bea');
  await lc.click('#setupGo');
  await lc.waitForSelector('#shSetup', { state: 'hidden' });
  const tiles = await lc.$$eval('.pt', (els) => els.map((e) => ({ i: e.dataset.i, rot: e.classList.contains('rot'), life: e.querySelector('.pt-life').textContent, name: e.querySelector('.nm').textContent })));
  ok(tiles.length === 4 && tiles.every((t) => t.life === '40'), '4 tiles at 40 life', JSON.stringify(tiles));
  ok(tiles.filter((t) => t.rot).length === 2 && tiles[0].rot && tiles[1].rot && !tiles[2].rot && !tiles[3].rot, 'top row (first two tiles) is rotated, bottom row upright');
  ok(tiles.some((t) => t.name === 'Bea'), 'custom player name applied');
  const rotM = await lc.$eval('.pt.rot', (e) => getComputedStyle(e).transform);
  ok(/^matrix\(-1, 0, 0, -1/.test(rotM), 'rotated tiles use a 180° transform', rotM);

  // layout: tiles fill the viewport, no page scroll, no overflow
  {
    const s = await noScroll(lc);
    ok(s.h <= s.ih && s.w <= s.iw, 'around-the-table: no page scroll (' + s.h + '×' + s.w + ' in ' + s.ih + '×' + s.iw + ')');
    const r = await lc.$$eval('.pt', (els) => els.map((e) => e.getBoundingClientRect()).map((b) => [Math.round(b.top), Math.round(b.bottom), Math.round(b.left), Math.round(b.right)]));
    const hdr = await lc.$eval('#hdr', (e) => e.getBoundingClientRect().bottom);
    const inView = r.every((b) => b[0] >= hdr - 1 && b[1] <= 844 + 1 && b[2] >= 0 && b[3] <= 390 + 1);
    const fills = Math.min(...r.map((b) => b[0])) <= hdr + 12 && Math.max(...r.map((b) => b[1])) >= 844 - 12;
    ok(inView && fills, 'tiles fill the viewport below the header', JSON.stringify(r) + ' hdr=' + hdr);
    const lifePx = await lc.$eval('.pt[data-i="0"] .pt-life', (e) => parseFloat(getComputedStyle(e).fontSize));
    ok(lifePx >= 44, 'life total is big (' + lifePx + 'px)');
    await shot(lc, 'life-4p-around');
  }

  // tap gestures on an upright tile: +1 top half ×3, −1 bottom half ×2 → 41
  const area0 = await (await lc.$('.pt[data-i="0"] .pt-area')).boundingBox();
  for (let i = 0; i < 3; i++) { await lc.touchscreen.tap(area0.x + area0.width / 2, area0.y + area0.height * 0.25); await sleep(60); }
  for (let i = 0; i < 2; i++) { await lc.touchscreen.tap(area0.x + area0.width / 2, area0.y + area0.height * 0.75); await sleep(60); }
  ok(await text(lc, '.pt[data-i="0"] .pt-life') === '41', 'tap top ×3 / bottom ×2 → 41', await text(lc, '.pt[data-i="0"] .pt-life'));
  ok(await text(lc, '.pt[data-i="0"] .pt-delta') === '+1', 'delta bubble shows the merged change (+1)', await text(lc, '.pt[data-i="0"] .pt-delta'));
  // rotated tile: the player's "top" is the screen bottom
  const area2 = await (await lc.$('.pt[data-i="2"] .pt-area')).boundingBox();
  await lc.touchscreen.tap(area2.x + area2.width / 2, area2.y + area2.height * 0.8); await sleep(60);
  ok(await text(lc, '.pt[data-i="2"] .pt-life') === '41', 'rotated tile: tapping its (screen-bottom) upper half adds life');
  await lc.touchscreen.tap(area2.x + area2.width / 2, area2.y + area2.height * 0.2); await sleep(60);
  ok(await text(lc, '.pt[data-i="2"] .pt-life') === '40', 'rotated tile: tapping its (screen-top) lower half removes life');
  await sleep(1300); // let the merge window close so the next undo is its own step

  // commander damage from an opponent (Bea = player 1) → 5
  await lc.click('.pt[data-i="0"] .ib[data-a="cmd"]');
  await lc.waitForSelector('.pt[data-i="0"] .pt-ov:not([hidden]) .ov-row');
  const rows = await lc.$$eval('.pt[data-i="0"] .pt-ov .ov-row .who span', (els) => els.map((e) => e.textContent));
  ok(rows.length === 3 && rows.indexOf('Bea') >= 0 && rows.indexOf('Player 1') < 0, 'commander overlay lists the three opponents (not self)', rows.join(','));
  await clickN(lc, '.pt[data-i="0"] .pt-ov [data-cmd="1,0,1"]', 5);
  ok(await text(lc, '.pt[data-i="0"] .pt-life') === '36', 'commander damage 5 → life 36', await text(lc, '.pt[data-i="0"] .pt-life'));
  ok(await text(lc, '.pt[data-i="0"] .pt-ov [data-cmd="1,0,1"] ~ .v, .pt[data-i="0"] .pt-ov .stp .v') === '5', 'overlay stepper reads 5');
  ok(await text(lc, '.pt[data-i="0"] .ib[data-a="cmd"] .n') === '5', 'commander badge on the tile shows 5');
  await lc.click('.pt[data-i="0"] .pt-ov [data-x]');
  ok(await lc.isHidden('.pt[data-i="0"] .pt-ov'), 'overlay closes');
  await lc.click('#btnUndo');
  ok(await text(lc, '.pt[data-i="0"] .pt-life') === '41', 'undo → 41', await text(lc, '.pt[data-i="0"] .pt-life'));
  ok(await lc.isHidden('.pt[data-i="0"] .ib[data-a="cmd"] .n'), 'undo clears the commander badge');
  await sleep(1300);

  // poison to 10 → DEFEATED, then tap to return
  await lc.click('.pt[data-i="0"] .ib[data-a="poison"]');
  await lc.waitForSelector('.pt[data-i="0"] .pt-ov:not([hidden]) [data-ctr="poison,1"]');
  for (let i = 0; i < 10; i++) { await lc.click('.pt[data-i="0"] .pt-ov [data-ctr="poison,1"]'); await sleep(40); }
  ok(await lc.$eval('.pt[data-i="0"]', (e) => e.classList.contains('dead')), 'poison 10 → tile is dead');
  ok(await lc.isVisible('.pt[data-i="0"] .pt-stamp') && /DEFEATED/.test(await text(lc, '.pt[data-i="0"] .pt-stamp')), 'DEFEATED stamp shows');
  ok(await lc.isHidden('.pt[data-i="0"] .pt-ov'), 'counter overlay closes on defeat');
  ok(await text(lc, '.pt[data-i="0"] .ib[data-a="poison"] .n') === '10', 'poison badge reads 10');
  await shot(lc, 'life-defeated');
  await lc.touchscreen.tap(area0.x + area0.width / 2, area0.y + area0.height / 2); await sleep(80);
  ok(!(await lc.$eval('.pt[data-i="0"]', (e) => e.classList.contains('dead'))), 'tapping a defeated tile brings the player back');
  await lc.click('#btnUndo'); await sleep(60);
  ok(await lc.$eval('.pt[data-i="0"]', (e) => e.classList.contains('dead')), 'undo of the revive → defeated again');
  await lc.click('#btnUndo'); await sleep(60);
  ok(!(await lc.$eval('.pt[data-i="0"]', (e) => e.classList.contains('dead'))) && (await lc.isHidden('.pt[data-i="0"] .ib[data-a="poison"] .n')), 'undo of the poison step → alive, poison 0');
  await sleep(1300);

  // monarch moves between players
  await lc.click('.pt[data-i="1"] .ib[data-a="monarch"]'); await sleep(50);
  ok(await lc.$eval('.pt[data-i="1"]', (e) => e.classList.contains('monarch')), 'monarch → Bea');
  await lc.click('.pt[data-i="2"] .ib[data-a="monarch"]'); await sleep(50);
  const mon = await lc.$$eval('.pt', (els) => els.filter((e) => e.classList.contains('monarch')).map((e) => e.dataset.i));
  ok(mon.length === 1 && mon[0] === '2', 'monarch moves to Player 3 (only one crown)', mon.join(','));
  await lc.click('.pt[data-i="2"] .ib[data-a="monarch"]'); await sleep(50);
  ok((await lc.$$('.pt.monarch')).length === 0, 'tapping the monarch again removes it');
  await lc.click('.pt[data-i="3"] .ib[data-a="init"]'); await sleep(50);
  ok(await lc.$eval('.pt[data-i="3"] .ib[data-a="init"]', (e) => e.classList.contains('on')), 'initiative token toggles');
  await lc.click('.pt[data-i="3"] .ib[data-a="day"]'); await sleep(50);
  ok(await lc.$eval('body', (b) => b.classList.contains('night')), 'day/night toggles to night');
  await lc.click('#btnDay'); await sleep(50);
  ok(!(await lc.$eval('body', (b) => b.classList.contains('night'))), 'header sun/moon toggles back to day');

  // table menu: dice, history, random player, timer + next turn
  await lc.click('#btnMenu'); await lc.waitForSelector('#shMenu:not([hidden])');
  await lc.click('#mDice'); await lc.waitForSelector('#shDice:not([hidden])');
  await lc.click('[data-die="20"]');
  const d20 = parseInt(await text(lc, '#dieBig'), 10);
  ok(d20 >= 1 && d20 <= 20 && (await text(lc, '#dieLbl')) === 'd20', 'd20 rolls 1–20', d20);
  await lc.click('[data-die="coin"]');
  ok(/^(Heads|Tails)$/.test(await text(lc, '#dieBig')), 'coin flips');
  await lc.click('#shDice [data-close]');
  await lc.click('#btnMenu'); await lc.click('#mHist'); await lc.waitForSelector('#shHist:not([hidden])');
  const histN = (await lc.$$('#histList li')).length;
  ok(histN >= 5, 'history lists the game so far (' + histN + ' entries)');
  await lc.click('#histUndo'); await sleep(50);
  ok((await lc.$$('#histList li')).length === histN - 1, 'history sheet undo removes the newest entry');
  await lc.click('#shHist [data-close]');
  await lc.click('#btnMenu'); await lc.click('#mFirst'); await sleep(100);
  ok((await lc.$$('.pt.picked')).length === 1, 'random player highlights exactly one tile');
  await lc.click('#btnMenu'); await lc.click('#mTimer'); await sleep(50);
  ok(/on/.test(await text(lc, '#mTimerL')) && (await lc.isVisible('#mNext')), 'turn timer on → Next turn appears');
  await lc.click('#mNext'); await sleep(50);
  ok((await lc.$$('.pt.active')).length === 1 && (await lc.isVisible('.pt.active .tm')), 'next turn marks one active player with a clock');
  await lc.click('#btnMenu'); await lc.click('#mNext'); await sleep(50);
  const act2 = await lc.$$eval('.pt.active', (els) => els.map((e) => e.dataset.i));
  ok(act2.length === 1, 'next turn advances the active player');
  await lc.click('#btnMenu'); await lc.click('#mTimer'); await sleep(50);
  await lc.click('#shMenu [data-close]');

  // settings: rename + list layout, then back
  await lc.click('#btnSettings'); await lc.waitForSelector('#shSetup:not([hidden])');
  ok(await lc.isHidden('#setupNewOnly') && (await text(lc, '#setupGo')) === 'Save changes', 'settings sheet hides new-game-only controls');
  await lc.fill('[data-pe-name="0"]', 'Ana');
  await lc.click('#chipsLayout .chip[data-v="list"]');
  await lc.click('#setupGo'); await sleep(100);
  ok(await text(lc, '.pt[data-i="0"] .nm') === 'Ana' && (await lc.$$('.pt.rot')).length === 0, 'settings save renames and switches to the upright list layout');
  ok(await text(lc, '.pt[data-i="0"] .pt-life') === '41', 'life survives a relayout');
  await shot(lc, 'life-4p-list');
  await lc.click('#btnSettings'); await lc.click('#chipsLayout .chip[data-v="around"]'); await lc.click('#setupGo'); await sleep(100);
  ok((await lc.$$('.pt.rot')).length === 2, 'back to around-the-table');

  // reload → resume prompt → restored
  const lifeBefore = await lc.$$eval('.pt', (els) => els.map((e) => e.dataset.i + ':' + e.querySelector('.pt-life').textContent).sort().join(' '));
  await lc.reload();
  await lc.waitForSelector('#shResume:not([hidden])');
  ok(/4 players/.test(await text(lc, '#resumeInfo')) && /Ana 41/.test(await text(lc, '#resumeInfo')), 'reload → resume prompt describes the saved game', await text(lc, '#resumeInfo'));
  await lc.click('#resumeYes'); await sleep(100);
  const lifeAfter = await lc.$$eval('.pt', (els) => els.map((e) => e.dataset.i + ':' + e.querySelector('.pt-life').textContent).sort().join(' '));
  ok(lifeAfter === lifeBefore, 'resumed game restores every life total', lifeAfter);
  ok(await text(lc, '.pt[data-i="0"] .nm') === 'Ana' && (await lc.$$('.pt.rot')).length === 2, 'resumed game restores names + layout');
  await lc.click('#btnUndo'); await sleep(50);
  ok(!(await lc.$eval('#btnUndo', (b) => b.disabled)), 'undo still works after resume');
  // reload → "New game" from the resume prompt seeds the setup sheet
  await lc.reload(); await lc.waitForSelector('#shResume:not([hidden])');
  await lc.click('#resumeNo'); await lc.waitForSelector('#shSetup:not([hidden])');
  ok(await lc.inputValue('[data-pe-name="0"]') === 'Ana', 'resume → New game seeds the setup sheet with the old names');

  // every player count fits the viewport
  for (const n of [2, 3, 5, 6]) {
    await lc.click('#chipsN .chip[data-v="' + n + '"]');
    await lc.click('#chipsLayout .chip[data-v="around"]');
    await lc.click('#setupGo'); await sleep(120);
    const s = await noScroll(lc);
    const r = await lc.$$eval('.pt', (els) => els.map((e) => e.getBoundingClientRect()).map((b) => [Math.round(b.top), Math.round(b.bottom), Math.round(b.left), Math.round(b.right)]));
    const okFit = r.length === n && r.every((b) => b[0] >= 0 && b[1] <= 845 && b[2] >= 0 && b[3] <= 391) && s.h <= s.ih;
    const icons = await lc.$$eval('.pt .ib', (els) => els.every((e) => { const b = e.getBoundingClientRect(); return b.width >= 36 && b.height >= 36; }));
    ok(okFit && icons, n + ' players: tiles fit the viewport, icon buttons stay tappable', JSON.stringify(r) + ' scroll=' + s.h);
    await shot(lc, 'life-' + n + 'p');
    if (n !== 6) { await lc.click('#btnNew'); await lc.waitForSelector('#shSetup:not([hidden])'); }
  }
  ok(errCount() === 0, 'life counter: zero console / page errors', errors.join(' | '));

  // =============================================================== RPG COMPANION
  console.log('\nRPG Companion');
  const rp = await newPage('rpg');
  await rp.goto(BASE + '/app/companion/rpg.html');
  await rp.waitForSelector('#p-dice:not([hidden])');
  ok(true, 'page loads on the Dice tab');
  ok((await rp.$$eval('.tabbar a', (els) => els.map((a) => a.textContent.trim()))).length === 5, 'five tabs');

  // ---- Dice ----
  await rp.fill('#diceFormula', '4d6kh3+2');
  await rp.click('#btnRoll'); await sleep(100);
  const tot = parseInt(await text(rp, '#diceResult .total'), 10);
  const nDice = (await rp.$$('#diceResult .d:not(.mod)')).length, nDrop = (await rp.$$('#diceResult .d.drop')).length;
  ok(tot >= 5 && tot <= 20, '4d6kh3+2 totals 5–20 (' + tot + ')');
  ok(nDice === 4 && nDrop === 1, '4 dice shown, lowest dropped', nDice + '/' + nDrop);
  ok(/4d6kh3\+2/.test(await text(rp, '#diceResult .label')), 'result label echoes the formula');
  const sumCheck = await rp.$$eval('#diceResult .d', (els) => els.reduce((s, e) => s + (e.classList.contains('drop') ? 0 : parseInt(e.textContent.replace('−', '-').replace('+', ''), 10)), 0));
  ok(sumCheck === tot, 'kept dice + modifier add up to the total', sumCheck + ' vs ' + tot);
  ok((await rp.$$('#diceHist li[data-id]')).length >= 1, 'roll lands in history');
  await rp.click('#diceClear');
  await rp.click('.die-btn[data-die="20"]'); await rp.click('.die-btn[data-die="6"]'); await rp.click('.die-btn[data-die="6"]'); await rp.click('#modPlus'); await rp.click('#modPlus');
  ok(await rp.inputValue('#diceFormula') === '1d20+2d6+2', 'tapping dice + modifier builds a formula', await rp.inputValue('#diceFormula'));
  ok(await text(rp, '.die-btn[data-die="6"] .cnt') === '2' && (await text(rp, '#modVal')) === '+2', 'die badges and modifier readout track the formula');
  await rp.fill('#diceFormula', 'd20'); await rp.click('#advSeg [data-adv="adv"]'); await rp.click('#btnRoll'); await sleep(80);
  ok((await rp.$$('#diceResult .d:not(.mod)')).length === 2 && /advantage/.test(await text(rp, '#diceResult .label')), 'advantage rolls two d20 and keeps the higher');
  await rp.click('#advSeg [data-adv="norm"]');
  await rp.fill('#diceFormula', '2d6+'); await sleep(50);
  ok(await rp.$eval('#diceFormula', (e) => e.style.borderColor !== ''), 'invalid formula is flagged');
  await rp.fill('#diceFormula', '2d6+1');
  await rp.click('#diceHist li[data-id]'); await sleep(80);
  ok((await rp.$$('#diceHist li[data-id]')).length >= 3, 'tapping a history row rerolls it');
  await shot(rp, 'rpg-dice');

  // ---- Combat ----
  await rp.click('.tabbar a[data-tab="combat"]'); await rp.waitForSelector('#p-combat:not([hidden])');
  async function addCmb(name, init, hp, pc) {
    await rp.click('#btnAddCmb'); await rp.waitForSelector('#sheetCmb:not([hidden])');
    await rp.waitForFunction(() => document.activeElement && document.activeElement.id === 'cName'); // the sheet focuses the name field on a short timer
    await rp.fill('#cName', name); await rp.fill('#cInit', String(init)); await rp.fill('#cHp', String(hp)); await rp.fill('#cAc', '14');
    await rp.click('#cType [data-t="' + (pc ? 'pc' : 'npc') + '"]');
    await rp.click('#cSave'); await rp.waitForSelector('#sheetCmb', { state: 'hidden' }); await sleep(40);
  }
  await addCmb('Aria', 15, 30, true); await addCmb('Goblin', 8, 7, false); await addCmb('Owlbear', 20, 59, false);
  const order = await rp.$$eval('.cmb', (els) => els.map((e) => e.querySelector('.init').textContent + ':' + e.querySelector('.nm').firstChild.textContent));
  ok(order.join(' ') === '20:Owlbear 15:Aria 8:Goblin', 'initiative order 20, 15, 8', order.join(' '));
  ok(await text(rp, '#roundNum') === '1' && (await rp.$$('.cmb.active')).length === 0, 'round 1, nobody active yet');
  const active = async () => rp.$$eval('.cmb.active .nm', (els) => els.map((e) => e.firstChild.textContent).join(','));
  await rp.click('#btnNext'); await sleep(60); ok((await active()) === 'Owlbear', 'next turn → Owlbear');
  await rp.click('#btnNext'); await sleep(60); ok((await active()) === 'Aria', 'next turn → Aria');
  await rp.click('#btnNext'); await sleep(60); ok((await active()) === 'Goblin' && (await text(rp, '#roundNum')) === '1', 'next turn → Goblin, still round 1');
  await rp.click('#btnNext'); await sleep(60); ok((await active()) === 'Owlbear' && (await text(rp, '#roundNum')) === '2', 'wraps to Owlbear and round 2');
  await rp.click('#btnPrev'); await sleep(60); ok((await active()) === 'Goblin' && (await text(rp, '#roundNum')) === '1', 'previous turn steps back to Goblin / round 1');
  // damage the goblin 5 → 2/7
  await rp.click('.cmb:nth-child(3) .hpb'); await rp.waitForSelector('#sheetHP:not([hidden])');
  ok(await text(rp, '#hpTitle') === 'Goblin' && (await text(rp, '#hpCur')) === '7 / 7', 'HP keypad opens for the Goblin');
  await rp.click('#hpPad [data-k="5"]'); await rp.click('#hpDmg'); await rp.waitForSelector('#sheetHP', { state: 'hidden' }); await sleep(50);
  ok(/^2\s*\/7$/.test((await text(rp, '.cmb:nth-child(3) .hpb b')).replace(/\s+/g, '')) || (await text(rp, '.cmb:nth-child(3) .hpb b')).replace(/\s+/g, '') === '2/7', 'Goblin takes 5 → 2/7', await text(rp, '.cmb:nth-child(3) .hpb b'));
  ok(await rp.$eval('.cmb:nth-child(3) .hpbar i', (e) => e.classList.contains('warn')), 'HP bar turns amber at 28%');
  await rp.click('.cmb:nth-child(3) .hpb'); await rp.click('#hpPad [data-k="1"]'); await rp.click('#hpDmg'); await sleep(50);
  ok(await rp.$eval('.cmb:nth-child(3) .hpbar i', (e) => e.classList.contains('bad')), 'HP bar turns red at 14%');
  await rp.click('.cmb:nth-child(3) .hpb'); await rp.click('#hpPad [data-k="9"]'); await rp.click('#hpDmg'); await sleep(50);
  ok(await rp.$eval('.cmb:nth-child(3)', (e) => e.classList.contains('down')) && /Down/.test(await text(rp, '.cmb:nth-child(3) .nm')), 'Goblin drops to 0 → marked Down');
  // heal + temp hp on Aria
  await rp.click('.cmb:nth-child(2) .hpb'); await rp.click('#hpPad [data-k="1"]'); await rp.click('#hpPad [data-k="2"]'); await rp.click('#hpDmg'); await sleep(50);
  await rp.click('.cmb:nth-child(2) .hpb'); await rp.click('#hpPad [data-k="4"]'); await rp.click('#hpHeal'); await sleep(50);
  await rp.click('.cmb:nth-child(2) .hpb'); await rp.click('#hpPad [data-k="6"]'); await rp.click('#hpTmp'); await sleep(50);
  ok((await text(rp, '.cmb:nth-child(2) .hpb')).replace(/\s+/g, '') === '22/30+6tmp', 'Aria: −12, +4, temp 6 → 22/30 +6 tmp', (await text(rp, '.cmb:nth-child(2) .hpb')).replace(/\s+/g, ''));
  // conditions via the name menu
  await rp.click('.cmb:nth-child(2) .body'); await rp.waitForSelector('#sheetAct:not([hidden])');
  await rp.click('#actConds [data-cond="Prone"]'); await rp.click('#exhPlus'); await rp.check('#actConc'); await rp.click('#actDone'); await sleep(50);
  const conds = await rp.$$eval('.cmb:nth-child(2) .conds span', (els) => els.map((e) => e.textContent));
  ok(conds.join('|') === 'Prone|Exhaustion 1|Concentrating', 'conditions, exhaustion and concentration chips render', conds.join('|'));
  // PC death saves when Aria goes down
  await rp.click('.cmb:nth-child(2) .hpb'); await rp.click('#hpPad [data-k="9"]'); await rp.click('#hpPad [data-k="9"]'); await rp.click('#hpDmg'); await sleep(50);
  ok((await rp.$$('.cmb:nth-child(2) .dsaves button')).length === 6, 'PC at 0 HP shows death-save dots');
  await rp.click('.cmb:nth-child(2) .dsaves [data-ds="s"][data-n="3"]'); await sleep(50);
  ok(/Stable/.test(await text(rp, '.cmb:nth-child(2) .dsaves')), 'three successes → Stable');
  await shot(rp, 'rpg-combat');
  // persistence
  await rp.reload(); await rp.waitForSelector('#p-combat:not([hidden])');
  ok((await rp.$$('.cmb')).length === 3 && (await text(rp, '#roundNum')) === '1' && (await active()) === 'Goblin', 'combat state survives reload (tab, round, active)');
  await rp.click('.cmb:nth-child(3) .body'); await rp.waitForSelector('#sheetAct:not([hidden])'); await rp.click('#actRemove'); await sleep(60);
  ok((await rp.$$('.cmb')).length === 2, 'remove combatant');
  await rp.click('#btnEndEnc'); await sleep(60);
  ok((await rp.$$('.cmb')).length === 0 && (await rp.$$('#cmbList .empty')).length === 1, 'end encounter clears the list');

  // ---- Character ----
  await rp.click('.tabbar a[data-tab="char"]'); await rp.waitForSelector('#p-char:not([hidden])');
  await rp.waitForSelector('[data-k="abil.str"]');
  ok((await rp.$$('#charSel option')).length === 1, 'first visit creates a starter character');
  await rp.fill('[data-k="name"]', 'Thorin'); await rp.fill('[data-k="cls"]', 'Fighter'); await rp.fill('[data-k="level"]', '5');
  ok(/Thorin · Fighter 5/.test(await text(rp, '#charSel option')), 'name / class / level feed the picker');
  ok(await text(rp, '[data-d="pb"]') === '+3', 'level 5 → proficiency +3');
  await rp.fill('[data-k="abil.str"]', '16');
  ok(await text(rp, '[data-roll="abil:str"]') === '+3', 'STR 16 → +3 modifier');
  ok(await text(rp, '[data-roll="save:str"]') === '+3' && (await text(rp, '[data-roll="skill:3"]')) === '+3', 'STR save and Athletics start at +3');
  await rp.click('[data-save="str"]'); await sleep(30);
  ok(await text(rp, '[data-roll="save:str"]') === '+6' && (await rp.$eval('[data-save="str"]', (e) => e.classList.contains('p1'))), 'save proficiency → +6');
  await rp.click('[data-skill="3"]'); await sleep(30);
  ok(await text(rp, '[data-roll="skill:3"]') === '+6' && (await text(rp, '[data-skill="3"]')) === 'P', 'Athletics proficient → +6');
  await rp.click('[data-skill="3"]'); await sleep(30);
  ok(await text(rp, '[data-roll="skill:3"]') === '+9' && (await text(rp, '[data-skill="3"]')) === 'E', 'Athletics expertise → +9');
  await rp.click('[data-skill="3"]'); await sleep(30);
  ok(await text(rp, '[data-roll="skill:3"]') === '+3', 'third tap clears proficiency');
  await rp.fill('[data-k="abil.wis"]', '14'); await rp.click('[data-skill="11"]'); await sleep(30);
  ok(await text(rp, '[data-d="pp"]') === '15', 'passive Perception = 10 + WIS 2 + prof 3');
  await rp.fill('[data-k="abil.dex"]', '13'); await rp.fill('[data-k="initMisc"]', '2');
  ok(await text(rp, '[data-roll="init"]') === '+3', 'initiative = DEX +1 + misc 2');
  await rp.click('[data-roll="abil:str"]'); await sleep(80);
  ok(/Thorin · Strength check/.test(await text(rp, '#diceResult .label')), 'tapping a modifier rolls a d20 check into the dice tray');
  // HP
  await rp.fill('[data-k="hp.max"]', '44'); await sleep(30);
  ok(await text(rp, '[data-d="hpmax"]') === '44' && (await text(rp, '[data-d="hpcur"]')) === '10', 'max HP 44 keeps current at 10');
  await rp.click('[data-hp="1"]'); await rp.click('[data-hp="-1"]'); await rp.click('[data-hp="-1"]'); await sleep(30);
  ok(await text(rp, '[data-d="hpcur"]') === '9', '±1 HP buttons');
  await rp.click('[data-act="hp"]'); await rp.waitForSelector('#sheetHP:not([hidden])');
  await rp.click('#hpPad [data-k="2"]'); await rp.click('#hpPad [data-k="0"]'); await rp.click('#hpHeal'); await sleep(50);
  ok(await text(rp, '[data-d="hpcur"]') === '29' && (await rp.inputValue('[data-k="hp.max"]')) === '44', 'keypad heal 20 → 29');
  ok(await text(rp, '[data-d="hdleft"]') === '5' && (await text(rp, '[data-d="hdtotal"]')) === '5', 'hit dice = level');
  await rp.click('[data-act="short"]'); await rp.waitForSelector('#sheetRest:not([hidden])');
  await rp.click('#restPlus'); await rp.click('#restGo'); await sleep(60);
  ok(await text(rp, '[data-d="hdleft"]') === '3' && parseInt(await text(rp, '[data-d="hpcur"]'), 10) >= 29, 'short rest spends 2 hit dice and heals');
  await rp.click('[data-act="long"]'); await sleep(60);
  ok(await text(rp, '[data-d="hpcur"]') === '44' && (await text(rp, '[data-d="hdleft"]')) === '5', 'long rest restores HP and hit dice');
  // attacks / spells / items
  await rp.fill('#atkName', 'Longsword'); await rp.fill('#atkBonus', '6'); await rp.fill('#atkDmg', '1d8+3'); await rp.click('[data-act="atkAdd"]'); await sleep(30);
  ok((await rp.$$('#atkList .lrow')).length === 1 && (await rp.$$('#atkList [data-dmg]')).length === 1, 'attack added with a damage die');
  await rp.click('#atkList [data-dmg="0"]'); await sleep(60);
  ok(/Longsword damage/.test(await text(rp, '#diceResult .label')), 'damage button rolls 1d8+3');
  await rp.click('[data-act="editSlots"]'); await rp.click('[data-slot="1:1"]'); await rp.click('[data-slot="1:1"]'); await rp.click('[data-act="editSlots"]'); await sleep(30);
  ok((await rp.$$('#slotList .bub')).length === 2, 'two 1st-level slots');
  await rp.click('[data-bub="1:0"]'); await sleep(30);
  ok((await rp.$$('#slotList .bub.used')).length === 1, 'spend a slot');
  await rp.fill('#spName', 'Shield'); await rp.selectOption('#spLevel', '1'); await rp.click('[data-act="spAdd"]'); await sleep(30);
  await rp.click('#spellList [data-prep="0"]'); await sleep(30);
  ok(/Shield/.test(await text(rp, '#spellList')) && /prepared/.test(await text(rp, '#spellList')), 'spell added and prepared');
  await rp.fill('#itName', 'Rations'); await rp.fill('#itQty', '3'); await rp.click('[data-act="itAdd"]'); await rp.click('#itemList [data-qty="0:1"]'); await sleep(30);
  ok(await text(rp, '#itemList .qty') === '4', 'inventory qty stepper');
  // export json
  await rp.click('#btnCharMenu'); await rp.waitForSelector('#sheetCharMenu:not([hidden])');
  const dl = rp.waitForEvent('download', { timeout: 3000 }).catch(() => null);
  await rp.click('#cmExport');
  const d = await dl;
  ok(d && /Thorin\.json/.test(d.suggestedFilename()), 'export JSON downloads Thorin.json', d && d.suggestedFilename());
  const blobUrl = d ? d.url() : '';
  ok(/^blob:/.test(blobUrl), 'export uses a Blob URL', blobUrl);
  if (d) { const p = await d.path().catch(() => null); if (p) { const j = JSON.parse(fs.readFileSync(p, 'utf8')); ok(j.name === 'Thorin' && j.abil.str === 16, 'exported JSON carries the sheet'); } }
  await rp.waitForSelector('#sheetCharMenu', { state: 'hidden' });
  // duplicate + switch
  await rp.click('#btnCharMenu'); await rp.click('#cmDup'); await sleep(50);
  ok((await rp.$$('#charSel option')).length === 2 && /copy/.test(await rp.inputValue('[data-k="name"]')), 'duplicate creates a copy and selects it');
  await rp.selectOption('#charSel', { index: 0 }); await sleep(50);
  ok(await rp.inputValue('[data-k="name"]') === 'Thorin' && (await text(rp, '[data-roll="abil:str"]')) === '+3', 'switching characters re-renders the sheet');
  await shot(rp, 'rpg-character');
  await rp.reload(); await rp.waitForSelector('[data-k="abil.str"]');
  ok(await rp.inputValue('[data-k="abil.str"]') === '16' && (await text(rp, '[data-roll="skill:11"]')) === '+5', 'character survives reload');

  // ---- Rules ----
  await rp.click('.tabbar a[data-tab="rules"]'); await rp.waitForSelector('#p-rules:not([hidden])');
  const allSecs = (await rp.$$('#rulesBody .card')).length, allRules = (await rp.$$('#rulesBody .rule')).length;
  ok(allSecs >= 8 && allRules >= 40, 'rules render ' + allSecs + ' sections / ' + allRules + ' entries');
  ok(await rp.$eval('#rulesBody .card:first-child', (e) => !e.classList.contains('closed')) && (await rp.$eval('#rulesBody .card:nth-child(2)', (e) => e.classList.contains('closed'))), 'Conditions open, later sections collapsed');
  await rp.click('#rulesBody .card:nth-child(2) > h2'); await sleep(30);
  ok(await rp.$eval('#rulesBody .card:nth-child(2)', (e) => !e.classList.contains('closed')), 'tapping a section header expands it');
  await rp.fill('#rulesSearch', 'prone'); await sleep(250);
  const secs = (await rp.$$('#rulesBody .card')).length, rules = (await rp.$$('#rulesBody .rule')).length;
  const allMatch = await rp.$$eval('#rulesBody .rule', (els) => els.every((e) => /prone/i.test(e.textContent)));
  ok(secs < allSecs && rules < allRules && rules >= 2 && allMatch, 'search "prone" narrows to matching entries (' + secs + ' sections / ' + rules + ' entries)');
  ok(await rp.$$eval('#rulesBody .card', (els) => els.every((e) => !e.classList.contains('closed'))), 'search results are expanded');
  await shot(rp, 'rpg-rules');
  await rp.fill('#rulesSearch', 'zzzz'); await sleep(250);
  ok(/Nothing matches/.test(await text(rp, '#rulesBody')), 'no-match message');
  await rp.fill('#rulesSearch', ''); await sleep(250);
  ok((await rp.$$('#rulesBody .rule')).length === allRules, 'clearing the search restores everything');

  // ---- Notes ----
  await rp.click('.tabbar a[data-tab="notes"]'); await rp.waitForSelector('#p-notes:not([hidden])');
  ok(/No notes yet/.test(await text(rp, '#noteUl')), 'empty notes state');
  await rp.click('#btnNoteNew'); await rp.waitForSelector('#noteEditor:not([hidden])');
  await rp.fill('#noteTitle', 'Session 1'); await rp.fill('#noteBody', 'Met the innkeeper Marla. Owe her 5 gp.');
  await sleep(600);
  ok(/^Saved/.test(await text(rp, '#noteSaved')), 'autosave reports Saved');
  await shot(rp, 'rpg-notes');
  await rp.reload(); await rp.waitForSelector('#p-notes:not([hidden])');
  ok(/Session 1/.test(await text(rp, '#noteUl')) && /Marla/.test(await text(rp, '#noteUl')), 'note persists across reload');
  await rp.click('#noteUl li[data-id]'); await rp.waitForSelector('#noteEditor:not([hidden])');
  ok(await rp.inputValue('#noteTitle') === 'Session 1', 'reopening a note loads it');
  await rp.click('#btnNoteBack'); await sleep(50);
  ok(await rp.isVisible('#notesList') && (await rp.$$('#noteUl li[data-id]')).length === 1, 'back returns to the list');
  await rp.click('#noteUl li[data-id]'); await rp.click('#btnNoteDel'); await sleep(50);
  ok(/No notes yet/.test(await text(rp, '#noteUl')), 'delete note');

  // layout: every tab fits 390px wide
  for (const t of ['dice', 'combat', 'char', 'rules', 'notes']) {
    await rp.click('.tabbar a[data-tab="' + t + '"]'); await sleep(60);
    const s = await noScroll(rp);
    ok(s.w <= s.iw, t + ' tab: no horizontal overflow', s.w + ' > ' + s.iw);
  }
  ok(errCount() === 0, 'rpg: zero console / page errors', errors.join(' | '));
} catch (e) {
  fail++; console.log('  ✗ script error:', e && e.stack || e);
} finally {
  await browser.close();
  if (server) server.kill();
}
if (errors.length) { console.log('\nBrowser errors:'); errors.forEach((e) => console.log('  ' + e)); }
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail || errors.length ? 1 : 0);
