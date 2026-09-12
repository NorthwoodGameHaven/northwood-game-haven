// tests/lyrics-cdg.test.mjs — NGH-BUILD 2026-09-11a
// Browser-side checks of the lyric model (LRC + enhanced LRC) and the CD+G decoder,
// run in headless Chromium against synthetic fixtures (tests/fixtures/test.lrc, test.cdg).
//   node tests/lyrics-cdg.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const ok = (c, l, d) => { if (c) { pass++; console.log('  ✓', l); } else { fail++; console.log('  ✗', l, d !== undefined ? '— ' + JSON.stringify(d) : ''); } };

const b = await chromium.launch(); const p = await b.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.setContent('<canvas id="c" width="576" height="384"></canvas><div id="ly" style="width:800px;height:300px"></div>');
await p.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'site/app/karaoke/karaoke-lyrics.js'), 'utf8') });
await p.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'site/app/karaoke/cdg.js'), 'utf8') });

console.log('\nLRC model');
const lrc = fs.readFileSync(path.join(ROOT, 'tests/fixtures/test.lrc'), 'utf8');
const L = await p.evaluate((t) => KLyrics.parseLRC(t), lrc);
ok(L.meta.title === 'Otter Slide' && L.meta.artist === 'The Stash Band', 'metadata tags parsed');
ok(L.lines.length === 4, 'multi-timestamp line expands (4 lines)', L.lines.length);
ok(L.lines[0].words.length === 4 && L.lines[0].words[1].t === 1500, 'enhanced LRC keeps word timings', L.lines[0].words);
ok(L.lines[1].words.length === 4 && L.lines[1].words[0].t === 3000 && L.lines[1].words[3].end === 5200, 'plain line: words spread across the line to the next timestamp');
ok(L.lines.every((l, i) => i === 0 || l.t >= L.lines[i - 1].t), 'lines sorted by time');
const kf = await p.evaluate(() => KLyrics.fromKaraFun({ lines: [{ start: 1, end: 2, syllables: [{ start: 1, end: 1.4, text: 'Hel' }, { start: 1.4, end: 2, text: 'lo' }] }] }));
ok(kf.lines[0].words[1].t === 1400 && kf.lines[0].text === 'Hello', 'KaraFun syllable adapter → ms timings', kf.lines[0]);
const fill = await p.evaluate((t) => { const r = KLyrics.Renderer(document.getElementById('ly')); r.setLyrics(KLyrics.parseLRC(t)); r.setPosition(1750); return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => { const w = [...document.querySelectorAll('#ly .kl.cur .kw > i')].map(i => parseFloat(i.style.width)); res(w); }))); }, lrc);
ok(fill[0] === 100 && fill[1] === 50 && fill[2] === 0, 'renderer highlight at 1.75 s: word1 100%, word2 50%, word3 0%', fill);

console.log('\nCD+G decoder');
const cdgB64 = fs.readFileSync(path.join(ROOT, 'tests/fixtures/test.cdg')).toString('base64');
const px = await p.evaluate((b64) => {
  const bin = atob(b64), buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const cv = document.getElementById('c'), pl = CDG.Player(cv); pl.load(buf.buffer);
  const at = (x, y) => { const d = cv.getContext('2d').getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
  // screen (sx,sy) in CDG pixels → canvas pixel: visible 288×192 area starts at (6,12); 576×384 canvas = scale 2
  const map = (sx, sy) => [Math.floor((sx - 6) * 2 + 1), Math.floor((sy - 12) * 2 + 1)];
  const out = {};
  pl.setPosition(500); out.bg = at(...map(150, 100));
  pl.setPosition(1500); out.block = at(...map(150, 100)); out.outside = at(...map(20, 30));
  pl.setPosition(2500); out.xor = at(...map(150, 100)); out.blockEdge = at(...map(70, 80));
  pl.setPosition(800); out.rewound = at(...map(150, 100));
  return out;
}, cdgB64);
ok(JSON.stringify(px.bg) === JSON.stringify([17, 51, 34]), 'memory preset + CLUT → dark green background', px.bg);
ok(JSON.stringify(px.block) === JSON.stringify([238, 187, 68]) && JSON.stringify(px.outside) === JSON.stringify([17, 51, 34]), 'tile blocks draw the gold rectangle at 1.5 s', px);
ok(JSON.stringify(px.xor) === JSON.stringify([17, 153, 170]) && JSON.stringify(px.blockEdge) === JSON.stringify([238, 187, 68]), 'XOR tiles recolor the inner block teal at 2.5 s', px);
ok(JSON.stringify(px.rewound) === JSON.stringify([17, 51, 34]), 'seeking backwards replays from the start', px.rewound);

ok(!errs.length, 'no page errors', errs);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
await b.close();
process.exit(fail ? 1 : 0);
