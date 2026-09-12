// NGH-BUILD 2026-09-11a
// tests/karaoke.e2e.mjs — end-to-end Karaoke Battle + Turn Tracker walkthrough.
// Runs the REAL karaoke.mjs / companion.mjs through tests/karaoke-harness.mjs
// (in-memory db stand-in) and drives TV, host and two phones with Playwright.
//   node tests/karaoke.e2e.mjs            (starts the harness itself on 8888)
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // global install (npm -g)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8888, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.SHOTS || path.join(ROOT, 'tests', 'screenshots'); fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ✓', label); } else { fail++; console.log('  ✗', label); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitPort() { for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/api/karaoke/time'); if (r.ok) return true; } catch {} await sleep(250); } return false; }
let harness = null;
if (!(await waitPort().catch(() => false))) {
  harness = spawn(process.execPath, ['--import', './tests/_register-karaoke.mjs', 'tests/karaoke-harness.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });
  if (!(await waitPort())) { console.error('harness did not start'); process.exit(2); }
}

const browser = await chromium.launch();
const errors = [];
async function ctx(vp, name) {
  const c = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: vp.width < 600, hasTouch: vp.width < 600 });
  const p = await c.newPage();
  p.on('dialog', d => d.accept());   // confirm() prompts in the host console
  p.on('pageerror', e => errors.push(name + ': ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|net::ERR|favicon/.test(m.text())) errors.push(name + ': ' + m.text()); });
  return p;
}
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, n + '.png') });

try {
  // =================================================================== KARAOKE
  console.log('\nKaraoke Battle');
  const host = await ctx({ width: 1024, height: 900 }, 'host');
  await host.goto(BASE + '/app/karaoke/host.html');
  await host.fill('#code', '1234'); await host.click('#btnLogin');
  await host.waitForSelector('#pSessions.on');
  await host.click('#btnCreate');
  await host.waitForSelector('#pLive.on');
  const CODE = (await host.textContent('#lvCode')).trim();
  ok(/^[A-Z]{4}$/.test(CODE), 'host created session ' + CODE);
  await host.waitForFunction(() => document.querySelector('#queue') && /Queue is empty/.test(document.querySelector('#queue').textContent), null, { timeout: 10000 });

  const tv = await ctx({ width: 1920, height: 1080 }, 'tv');
  await tv.goto(BASE + '/app/karaoke/tv.html?s=' + CODE + '&room=holt');
  await tv.waitForSelector('#lobby.show', { timeout: 15000 });
  ok(await tv.textContent('#lobbyCode') === CODE, 'TV shows lobby with code');
  await shot(tv, 'karaoke-tv-lobby');

  const jen = await ctx({ width: 390, height: 844 }, 'jen');
  await jen.goto(BASE + '/app/karaoke/join.html?s=' + CODE);
  await jen.waitForSelector('#pJoin.on', { timeout: 15000 });
  await jen.click('.room-chip[data-r="holt"]'); await jen.fill('#nameIn', 'Jen'); await jen.click('#btnJoin');
  await jen.waitForSelector('#pNow.on', { timeout: 15000 });
  ok(/Jen/.test(await jen.textContent('#whoAmI')), 'Jen joined The Holt');
  await shot(jen, 'karaoke-phone-now-empty');
  await jen.click('#tabs a[data-p="pAdd"]'); await jen.fill('#q', 'otter');
  await jen.waitForSelector('#results .song button', { timeout: 10000 }); await jen.click('#results .song button');
  await jen.waitForSelector('.sheet'); const inputs = await jen.$$('.sheet input'); await inputs[1].fill('Sarah');
  await jen.click('#shAdd'); await jen.waitForSelector('#pNow.on');
  await jen.waitForFunction(() => /Otter Slide/.test(document.querySelector('#mySongs').textContent), null, { timeout: 10000 });
  ok(true, 'Jen queued Otter Slide with 2 singers');

  const mike = await ctx({ width: 390, height: 844 }, 'mike');
  await mike.goto(BASE + '/app/karaoke/join.html?s=' + CODE);
  await mike.waitForSelector('#pJoin.on'); await mike.click('.room-chip[data-r="depths"]'); await mike.fill('#nameIn', 'Mike'); await mike.click('#btnJoin');
  await mike.waitForSelector('#pNow.on'); await mike.click('#tabs a[data-p="pAdd"]'); await mike.fill('#q', 'meeple');
  await mike.waitForSelector('#results .song button'); await mike.click('#results .song button'); await mike.waitForSelector('.sheet'); await mike.click('#shAdd');
  await mike.waitForFunction(() => /Meeple Moon/.test(document.querySelector('#mySongs').textContent), null, { timeout: 10000 });
  ok(true, 'Mike queued Meeple Moon for The Depths');

  await host.waitForFunction(() => document.querySelectorAll('#queue .q').length === 2, null, { timeout: 10000 });
  ok(true, 'host sees 2 queued songs');
  await host.click('#tStart'); await host.click('#tPlay');
  await tv.waitForFunction(() => document.querySelector('#nowSong').textContent === 'Otter Slide', null, { timeout: 15000 });
  ok(!(await tv.$eval('#lobby', el => el.classList.contains('show'))), 'TV left the lobby when the song started');
  ok(/Jen & Sarah/.test(await tv.textContent('#nowSingers')), 'TV shows both singers');
  await tv.waitForFunction(() => document.querySelectorAll('#lyricsBox .kl.cur .kw').length > 0, null, { timeout: 15000 });
  await sleep(6500);
  const fillW = await tv.$eval('#lyricsBox .kl.cur .kw > i', i => parseFloat(i.style.width) || 0);
  ok(fillW > 0, 'TV lyric word highlight is sweeping (' + fillW.toFixed(0) + '%)');
  ok(/Sing it, /.test(await tv.textContent('#banner')), 'TV in The Holt shows the "sing it" banner for its own room');
  await shot(tv, 'karaoke-tv-lyrics');
  await jen.click('#tabs a[data-p="pNow"]');
  await jen.waitForFunction(() => document.querySelectorAll('#lyricsBox .kl.cur .kw').length > 0, null, { timeout: 15000 });
  ok(true, 'Jen\'s phone renders the synced lyrics');
  await shot(jen, 'karaoke-phone-lyrics');
  ok(/Otter Slide/.test(await host.textContent('#npTitle')), 'host console shows now playing');
  await shot(host, 'karaoke-host-live');

  await host.click('#tEnd');
  await tv.waitForSelector('#scoring.show', { timeout: 15000 });
  ok(true, 'TV shows the scoring overlay');
  await mike.waitForSelector('#pVote.on', { timeout: 15000 });
  ok(true, 'Mike (other room) was pulled into the vote screen');
  const cs = await mike.$$('#stChoice button'); await cs[4].click(); const ds = await mike.$$('#stDelivery button'); await ds[3].click();
  await shot(mike, 'karaoke-phone-vote');
  await mike.click('#btnVote');
  await tv.waitForFunction(() => document.querySelector('#scCount').textContent === '1', null, { timeout: 15000 });
  ok(true, 'TV tally shows 1 vote');
  await jen.waitForFunction(() => /being scored/.test(document.querySelector('#vNone').textContent), null, { timeout: 15000 });
  ok(true, 'Jen (singing room) cannot vote on her own room');
  await shot(tv, 'karaoke-tv-scoring');
  await host.click('#tClose');
  await tv.waitForSelector('#result.show', { timeout: 15000 });
  const pts = await tv.textContent('#resPts');
  ok(pts === '13.0', 'points = choice 5 + delivery 4×2 = 13.0 (got ' + pts + ')');
  await shot(tv, 'karaoke-tv-result');
  await tv.waitForFunction(() => /13\.0/.test(document.querySelector('#scoreBody').textContent), null, { timeout: 10000 });
  ok(true, 'scoreboard credits The Holt with 13.0');

  await host.click('#tPlay');
  await tv.waitForFunction(() => document.querySelector('#nowSong').textContent === 'Meeple Moon', null, { timeout: 15000 });
  ok(true, 'rotation: next song is The Depths\' Meeple Moon');
  await host.click('#btnTvOn');
  await host.waitForFunction(() => /switched to karaoke/.test((document.querySelector('.toast') || {}).textContent || ''), null, { timeout: 10000 });
  ok(true, 'host pushed the display to the TV network');
  await host.click('#btnTvOff');
  await host.waitForFunction(() => /TVs restored to slideshow/.test((document.querySelector('.toast') || {}).textContent || ''), null, { timeout: 10000 });
  ok(true, 'host restored the TVs\' previous slideshow');
  await host.click('#tSkip');
  await host.evaluate((code) => NGH.admin.fetch(KClient.sessionUrl(code) + '/queue', { method: 'POST', body: { songId: 'local:test3', singers: ['Chad'], room: 'den' } }), CODE);
  await host.waitForFunction(() => /Twenty-Sided Heart/.test(document.querySelector('#queue').textContent), null, { timeout: 10000 });
  await tv.waitForFunction(() => /Up next|Karaoke Battle/.test(document.querySelector('#msgBig').textContent), null, { timeout: 15000 });
  const lyr0 = await (await fetch(BASE + '/api/karaoke/songs/local:test3/lyrics')).json();
  ok(lyr0.cdg === null && lyr0.cdgPending === true, 'browsers never get the rack PC LAN URL (cdg pending until hosted)', lyr0);
  await host.click('#tPlay');
  await tv.waitForFunction(() => document.querySelector('#nowSong').textContent === 'Twenty-Sided Heart' && /Loading the lyric screen/.test(document.querySelector('#msgSub').textContent), null, { timeout: 15000 });
  ok(true, 'TV waits for the CD+G upload');
  const needed = await (await fetch(BASE + '/api/karaoke/media/needed?session=' + CODE, { headers: { Authorization: 'Bearer admin-ok' } })).json();
  ok(needed.songs.length === 1 && needed.songs[0].id === 'local:test3', 'media/needed lists the queued CD+G for the rack player', needed);
  const up = await fetch(BASE + '/api/karaoke/media/local:test3/cdg', { method: 'PUT', headers: { Authorization: 'Bearer admin-ok', 'Content-Type': 'application/json' }, body: JSON.stringify({ b64: fs.readFileSync(path.join(ROOT, 'tests/fixtures/test.cdg')).toString('base64') }) });
  ok(up.status === 200, 'rack-player style CD+G upload accepted');
  await tv.waitForFunction(() => document.querySelector('#cdgCanvas').style.display === 'block', null, { timeout: 15000 });
  ok(/The Depths · 0 songs/.test(await tv.textContent('#scoreBody')), 'a skipped song does not count for the room');
  await sleep(4500);
  const cdgPx = await tv.evaluate(() => { const c = document.querySelector('#cdgCanvas'); const d = c.getContext('2d').getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.48), 1, 1).data; return [d[0], d[1], d[2]]; });
  ok(JSON.stringify(cdgPx) === JSON.stringify([238, 187, 68]) || JSON.stringify(cdgPx) === JSON.stringify([17, 153, 170]), 'TV plays a CD+G track on the canvas (' + cdgPx + ')');
  await shot(tv, 'karaoke-tv-cdg');
  await host.click('#tSkip');
  // no session -> phone code entry
  const anon = await ctx({ width: 390, height: 844 }, 'anon');
  await anon.goto(BASE + '/app/karaoke/join.html'); await anon.waitForSelector('#activeCard:not([hidden])', { timeout: 10000 });
  ok(true, 'join page without a code offers the live session');
  await shot(anon, 'karaoke-phone-code');

  // =================================================================== TURN TRACKER
  console.log('\nTurn Tracker');
  const th = await ctx({ width: 390, height: 844 }, 'turn-host');
  await th.goto(BASE + '/app/companion/turn-tracker.html');
  await th.click('#btnHost'); await th.waitForSelector('#pMe.on'); await th.click('.sw[data-c="#d7263d"]'); await th.fill('#nameIn', 'Dustin'); await th.click('#btnMeGo');
  await th.waitForSelector('#pLobby.on', { timeout: 10000 });
  const TCODE = (await th.textContent('#lobbyCode')).trim();
  ok(/^[A-Z2-9]{5}$/.test(TCODE), 'table created ' + TCODE);
  await shot(th, 'turns-lobby');
  const tg = await ctx({ width: 390, height: 844 }, 'turn-guest');
  await tg.goto(BASE + '/app/companion/turn-tracker.html?t=' + TCODE);
  await tg.waitForSelector('#pMe.on');
  ok(await tg.$eval('.sw[data-c="#d7263d"]', el => el.classList.contains('taken')), 'guest sees red as taken');
  await tg.click('.sw[data-c="#1f6fd6"]'); await tg.fill('#nameIn', 'Jen'); await tg.click('#btnMeGo');
  await tg.waitForSelector('#pLobby.on', { timeout: 10000 });
  await th.waitForFunction(() => document.querySelectorAll('#playerList li').length === 2, null, { timeout: 10000 });
  ok(true, 'host lobby lists both players');
  await th.click('#btnStart');
  await th.waitForSelector('#live.on', { timeout: 10000 }); await tg.waitForSelector('#live.on', { timeout: 10000 });
  await tg.waitForFunction(() => /Dustin's turn|Red's turn/.test(document.querySelector('#liveWho').textContent), null, { timeout: 10000 });
  await tg.waitForFunction(() => getComputedStyle(document.querySelector('#liveInner')).backgroundColor === 'rgb(215, 38, 61)', null, { timeout: 5000 });
  const gBg = await tg.$eval('#liveInner', el => getComputedStyle(el).backgroundColor), gOuter = await tg.$eval('#live', el => getComputedStyle(el).backgroundColor);
  ok(gBg === 'rgb(215, 38, 61)' && gOuter === 'rgb(31, 111, 214)', 'guest: red centre + blue border on Dustin\'s turn');
  ok(await tg.$eval('#endTurn', el => el.hidden), 'guest has no End Turn button');
  ok(await th.$eval('#liveWho', el => el.textContent === 'Your turn'), 'host sees "Your turn"');
  await shot(th, 'turns-host-myturn'); await shot(tg, 'turns-guest-waiting');
  await th.click('#endTurn');
  await tg.waitForFunction(() => document.querySelector('#liveWho').textContent === 'Your turn', null, { timeout: 10000 });
  await tg.waitForFunction(() => getComputedStyle(document.querySelector('#liveInner')).backgroundColor === 'rgb(31, 111, 214)', null, { timeout: 5000 }); // CSS transition settles
  const gBg2 = await tg.$eval('#liveInner', el => getComputedStyle(el).backgroundColor);
  ok(gBg2 === 'rgb(31, 111, 214)' && !(await tg.$eval('#endTurn', el => el.hidden)), 'guest: all blue + End Turn on her turn');
  await th.waitForFunction(() => /Jen's turn/.test(document.querySelector('#liveWho').textContent), null, { timeout: 10000 });
  await th.waitForFunction(() => getComputedStyle(document.querySelector('#liveInner')).backgroundColor === 'rgb(31, 111, 214)', null, { timeout: 5000 });
  ok(await th.$eval('#live', el => getComputedStyle(el).backgroundColor) === 'rgb(215, 38, 61)', 'host: red border with blue centre');
  await shot(tg, 'turns-guest-myturn'); await shot(th, 'turns-host-waiting');
  await tg.click('#endTurn');
  await th.waitForFunction(() => document.querySelector('#liveWho').textContent === 'Your turn' && /Round 2/.test(document.querySelector('#liveRound').textContent), null, { timeout: 10000 });
  ok(true, 'turn wrapped back to the host, round 2');
} catch (e) { fail++; console.log('  ✗ exception:', e.message); }

console.log('\nconsole/page errors:', errors.length ? errors : 'none');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
if (harness) harness.kill();
process.exit(fail || errors.length ? 1 : 0);
