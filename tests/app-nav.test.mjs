// tests/app-nav.test.mjs — NGH-BUILD 2026-09-13a
// Run:  node --test tests/app-nav.test.mjs
//
// The two pure functions behind the back button and the seasonal crest, pulled
// out of the shipped ngh-app.js so they cannot drift from what actually runs.
// tests/app-nav.e2e.mjs drives the same code in a browser; this file is the
// cheap half — every branch of the calendar and the whole parent map, with no
// server and no clock to fake.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'site', 'app');
const SRC = fs.readFileSync(path.join(APP, 'ngh-app.js'), 'utf8');

// Comments in this repo explain the bugs they replaced, so they name the very
// things these tests forbid. Scan the code, not the prose.
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function lift(...names) {
  const ctx = {}; vm.createContext(ctx);
  for (const n of names) {
    const m = new RegExp('function ' + n + '\\([\\s\\S]*?\\n  \\}').exec(SRC);
    assert.ok(m, n + '() is not in ngh-app.js any more — this guard is gone');
    vm.runInContext(m[0], ctx);
  }
  return (call) => vm.runInContext(call, ctx);
}

describe('backTarget() — where one press of back goes', () => {
  const run = lift('withIndex', 'backTarget');
  const at = (here, href) => run(`backTarget(${JSON.stringify(here)}, ${href === null ? 'null' : JSON.stringify(href)})`);

  test('the app home screen is the end of the line', () => {
    // null is the signal to ask before closing the app, not to navigate.
    assert.equal(at('/app/index.html', null), null);
    assert.equal(at('/app/', null), null);
    assert.equal(at('/app/index.html?source=pwa', null), null);
    assert.equal(at('/app/index.html#top', null), null);
  });

  test('the header ‹ is the parent', () => {
    assert.equal(at('/app/companion/turn-tracker.html', '/app/companion/index.html'), '/app/companion/index.html');
    assert.equal(at('/app/karaoke/join.html', '/app/karaoke/index.html'), '/app/karaoke/index.html');
  });

  test('a ‹ written as a directory still resolves to a file', () => {
    // Capacitor serves the ROOT index.html for a path with no dot in its last
    // segment (12ah); back must not walk into that trap either.
    assert.equal(at('/app/companion/index.html', '/app/'), '/app/index.html');
    assert.equal(at('/app/karaoke/join.html', '/app/karaoke/'), '/app/karaoke/index.html');
  });

  test('a ‹ that leaves the bundled shell lands on the app home instead', () => {
    // /guru.html is a website page. In the packaged app it opens in a browser
    // sheet, so following it with the hardware back would leave you nowhere.
    for (const off of ['/guru.html', '/booking.html', 'https://gamehaven.guru/events.html']) {
      assert.equal(at('/app/shop-orders.html', off), '/app/index.html', off);
    }
  });

  test('a page with no ‹ at all falls back to the app home', () => {
    assert.equal(at('/app/specials.html', null), '/app/index.html');
    assert.equal(at('/app/mtg/index.html', ''), '/app/index.html');
  });

  test('every real page walks up to the home screen, and stops there', () => {
    // Follows the actual ‹ links on disk. A new page with a bad one — or a
    // cycle between two pages — fails here rather than on someone's phone.
    const pages = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.html')) pages.push(p);
      }
    })(APP);
    assert.ok(pages.length >= 15, 'expected the whole app, found ' + pages.length + ' pages');

    const hrefOf = (file) => {
      const m = /<a[^>]*class="back"[^>]*href="([^"]*)"/.exec(fs.readFileSync(file, 'utf8'));
      return m ? m[1] : null;
    };
    for (const file of pages) {
      let at_ = '/' + path.relative(path.join(ROOT, 'site'), file).split(path.sep).join('/');
      const seen = [at_];
      for (let i = 0; i < 8; i++) {
        const next = run(`backTarget(${JSON.stringify(at_)}, ${JSON.stringify(hrefOf(path.join(ROOT, 'site', at_.slice(1))) || '')})`);
        if (next === null) break;
        assert.ok(seen.indexOf(next) < 0, 'back loops: ' + seen.concat(next).join(' → '));
        assert.ok(fs.existsSync(path.join(ROOT, 'site', next.slice(1))), at_ + ' backs into a page that does not exist: ' + next);
        seen.push(next); at_ = next;
      }
      assert.equal(at_, '/app/index.html', seen.join(' → ') + ' never reached the home screen');
    }
  });
});

describe('seasonKey() — the crest calendar', () => {
  const run = lift('seasonKey');
  const on = (m, d) => run(`seasonKey(new Date(2026, ${m - 1}, ${d}))`);

  test('the four seasons, at both ends of each', () => {
    assert.equal(on(3, 20), 'blossom');   assert.equal(on(6, 19), 'blossom');
    assert.equal(on(6, 20), 'sunflower'); assert.equal(on(9, 21), 'sunflower');
    assert.equal(on(9, 22), 'autumn');    assert.equal(on(12, 20), 'autumn');
    assert.equal(on(12, 21), 'default');  assert.equal(on(3, 19), 'default');
  });

  test('the day either side of each boundary differs', () => {
    for (const [m, d] of [[3, 20], [6, 20], [9, 22], [12, 21], [6, 28], [7, 7], [10, 15], [11, 2]]) {
      const day = new Date(2026, m - 1, d), before = new Date(2026, m - 1, d - 1);
      assert.notEqual(
        run(`seasonKey(new Date(${day.getFullYear()},${day.getMonth()},${day.getDate()}))`),
        run(`seasonKey(new Date(${before.getFullYear()},${before.getMonth()},${before.getDate()}))`),
        'nothing changes on ' + m + '/' + d
      );
    }
  });

  test('the holidays win over the season they sit inside', () => {
    assert.equal(on(6, 27), 'sunflower');
    assert.equal(on(6, 28), 'fireworks');   // the week around the 4th
    assert.equal(on(7, 4), 'fireworks');
    assert.equal(on(7, 6), 'fireworks');
    assert.equal(on(7, 7), 'sunflower');
    assert.equal(on(10, 14), 'autumn');
    assert.equal(on(10, 15), 'halloween');
    assert.equal(on(10, 31), 'halloween');
    assert.equal(on(11, 1), 'halloween');   // the Sunday-after crowd
    assert.equal(on(11, 2), 'autumn');
  });

  test('every day of the year resolves to a key the app knows', () => {
    // The key list comes out of the shipped LOGOS map, not a copy of it here:
    // a hardcoded list cannot notice a key being ADDED, which is the way this
    // goes wrong — a variant nobody can ever see, precached all year.
    const block = /var LOGOS = \{[\s\S]*?\n  \};/.exec(SRC);
    assert.ok(block, 'LOGOS is gone from the shell');
    const keys = new Set([...block[0].matchAll(/^\s*'?([a-zA-Z]+)'?:\s/gm)].map((m) => m[1]));
    assert.ok(keys.has('default') && keys.size >= 5, [...keys].join(','));
    const hit = new Set();
    for (const y of [2026, 2028]) {                       // 2028 is a leap year
      const d = new Date(y, 0, 1);
      while (d.getFullYear() === y) {
        const k = run(`seasonKey(new Date(${y}, ${d.getMonth()}, ${d.getDate()}))`);
        assert.ok(keys.has(k), y + '-' + (d.getMonth() + 1) + '-' + d.getDate() + ' → ' + k);
        hit.add(k);
        d.setDate(d.getDate() + 1);
      }
    }
    // Every key in LOGOS must be reachable: a variant the calendar can never
    // select is dead weight in the offline cache.
    assert.deepEqual([...hit].sort(), [...keys].sort());
  });
});

describe('the shell wires it all up', () => {
  test('the hardware back button calls goBack(), not history.back()', () => {
    assert.match(SRC, /addListener\('backButton',\s*function\s*\(\)\s*\{\s*goBack\(\);\s*\}\)/,
      'the back listener is not calling goBack() — the history tape is back');
    assert.ok(!/canGoBack/.test(SRC), 'e.canGoBack is the old tape-walking listener');
  });

  test('goBack() replaces rather than pushes', () => {
    // assign() would grow a second history that disagrees with the hierarchy.
    const m = /function goBack\(\)[\s\S]*?\n  \}/.exec(SRC);
    assert.ok(m && /location\.replace\(t\)/.test(m[0]), 'goBack must use location.replace');
  });

  test('the confirm sheet is a real element, not window.confirm', () => {
    const m = /function confirmDialog\(o\)[\s\S]*?\n  \}/.exec(SRC);
    assert.ok(m, 'confirmDialog is gone');
    assert.ok(!/\bwindow\.confirm\(|[^.\w]confirm\s*\(['"]/.test(codeOnly(SRC)), 'a blocking window.confirm() is back in the shell');
  });

  test('the turn tracker no longer blocks on window.confirm either', () => {
    // A system dialog freezes the WebView and cannot be dismissed by back —
    // the exact combination that stranded people in the rotation.
    const tt = fs.readFileSync(path.join(APP, 'companion', 'turn-tracker.html'), 'utf8');
    const bare = codeOnly(tt).match(/(^|[^.\w])confirm\s*\(/g) || [];
    assert.deepEqual(bare, [], 'window.confirm() call sites left in the turn tracker');
    assert.ok(tt.includes('NGH.confirm('), 'the turn tracker should be using the shell sheet');
  });

  test('the crest swap targets the src every page actually writes', () => {
    const m = /function applyLogo\(\)[\s\S]*?\n  \}/.exec(SRC);
    assert.ok(m, 'applyLogo is gone');
    assert.match(m[0], /img\[src\$="\/brand\/crest\.png"\]/);
    // …and the pages really do write it that way, or the selector matches nothing
    let found = 0;
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.html') && /src="\/brand\/crest\.png"/.test(fs.readFileSync(p, 'utf8'))) found++;
      }
    })(APP);
    assert.ok(found >= 10, 'only ' + found + ' pages use the crest — has the markup changed?');
  });
});
