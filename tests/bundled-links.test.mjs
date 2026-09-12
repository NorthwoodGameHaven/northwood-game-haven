// tests/bundled-links.test.mjs — NGH-BUILD 2026-09-12ah
// Run:  node --test tests/bundled-links.test.mjs
//
// Found on a real phone, first time the app was ever installed: tapping
// "Game Companion" bounced back to the top of the app home page and did
// nothing else.
//
// Capacitor's Android WebViewLocalServer:
//
//     if (path.equals("/") || (!request.getUrl().getLastPathSegment().contains(".") && html5mode))
//         String startPath = this.basePath + "/index.html";
//
// Any request whose last path segment has no dot gets the ROOT index.html —
// not the index.html of that directory. Our root www/index.html is the stub
// that redirects to /app/index.html, so "/app/companion/" silently served the
// home page. Exactly the reported symptom.
//
// It worked on gamehaven.guru the whole time, because Netlify resolves a
// directory to its own index.html. That is why nothing caught it until the app
// ran on hardware — and why a browser test against our mock server cannot
// catch it either: the mock emulates Netlify, correctly.
//
// So the check has to be static, on the source: no link inside the bundled
// shell may end in a directory.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'site', 'app');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|js)$/i.test(e.name)) out.push(p);
  }
  return out;
}
const FILES = walk(APP);

describe('bundled shell links', () => {
  test('no /app/ link points at a directory', () => {
    const bad = [];
    for (const f of FILES) {
      if (path.basename(f) === 'sw.js') continue;              // cache list, not navigation
      const src = fs.readFileSync(f, 'utf8');
      // href="/app/…/" or a scripted navigation to the same shape
      for (const re of [/href\s*=\s*"(\/app\/[^"]*\/)"/g, /href\s*=\s*'(\/app\/[^']*\/)'/g,
                        /(?:location\.href|NGH\.go|go)\s*[=(]\s*["'](\/app\/[^"']*\/)["']/g]) {
        let m;
        while ((m = re.exec(src))) bad.push(path.relative(ROOT, f) + ' → ' + m[1]);
      }
    }
    assert.deepEqual(bad, [],
      'Capacitor serves the ROOT index.html for these, so they land on the app home page. Write them as .../index.html');
  });

  test('every /app/ link resolves to a file that exists in the bundle', () => {
    // sync-web copies site/app → www/app verbatim, so a link that is broken
    // here is broken in the app. A 404 in the packaged shell is a dead end:
    // there is no server to fall back to.
    const missing = [];
    for (const f of FILES) {
      if (path.basename(f) === 'sw.js') continue;
      const src = fs.readFileSync(f, 'utf8');
      const re = /href\s*=\s*["'](\/app\/[^"'#?]+)["']/g;
      let m;
      while ((m = re.exec(src))) {
        const rel = m[1].replace(/^\/app\//, '');
        if (!fs.existsSync(path.join(APP, rel))) missing.push(path.relative(ROOT, f) + ' → ' + m[1]);
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });

  test('the companion and karaoke indexes are actually reachable from home', () => {
    const home = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
    assert.match(home, /href="\/app\/companion\/index\.html"/, 'the Game Companion tile');
    assert.match(home, /href="\/app\/karaoke\/index\.html"/, 'the Karaoke tile');
  });
});

describe('withIndex() — the runtime guard', () => {
  // Pulled out of the shipped ngh-app.js so it cannot drift from what runs.
  const SRC = fs.readFileSync(path.join(APP, 'ngh-app.js'), 'utf8');
  const m = /function withIndex\(path\) \{[\s\S]*?\n  \}/.exec(SRC);
  const ctx = { result: null };
  vm.createContext(ctx);
  vm.runInContext(m ? m[0] : 'function withIndex(p){return p;}', ctx);
  const withIndex = (p) => { ctx.p = p; return vm.runInContext('withIndex(p)', ctx); };

  test('it was found in the shipped file', () => {
    assert.ok(m, 'withIndex has been renamed or removed — this guard is gone');
  });

  test('a directory path gains index.html', () => {
    assert.equal(withIndex('/app/companion/'), '/app/companion/index.html');
    assert.equal(withIndex('/app/karaoke/'), '/app/karaoke/index.html');
    assert.equal(withIndex('/app/speedgaming/'), '/app/speedgaming/index.html');
  });

  test('a real file is left alone', () => {
    for (const p of ['/app/index.html', '/app/shop.html', '/app/companion/rpg.html', '/app/specials.html']) {
      assert.equal(withIndex(p), p);
    }
  });

  test('query strings and fragments survive', () => {
    assert.equal(withIndex('/app/karaoke/?s=HAVN'), '/app/karaoke/index.html?s=HAVN');
    assert.equal(withIndex('/app/companion/#tools'), '/app/companion/index.html#tools');
    assert.equal(withIndex('/app/karaoke/?s=HAVN#top'), '/app/karaoke/index.html?s=HAVN#top');
    assert.equal(withIndex('/app/specials.html?cat=food'), '/app/specials.html?cat=food');
  });

  test('a query string that itself contains a slash is not mistaken for a directory', () => {
    assert.equal(withIndex('/app/shop.html?next=/app/account.html'), '/app/shop.html?next=/app/account.html');
  });
});
