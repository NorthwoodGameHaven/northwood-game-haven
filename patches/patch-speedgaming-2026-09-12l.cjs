// patches/patch-speedgaming-2026-09-12l.cjs — NGH-BUILD 2026-09-12l
//
// Wires the Speed Gaming Meet-up into netlify.toml and tests/index.js.
// The new FILES are copied in by APPLY-SpeedGaming.cmd; this script only makes
// the small in-place edits to files that already exist, so it is idempotent and
// safe to run twice.
//
// Run from the repo root:  node patches/patch-speedgaming-2026-09-12l.cjs
const fs = require('fs');
const path = require('path');

const MARK = 'NGH-BUILD 2026-09-12l';
let changed = 0, skipped = 0;

function edit(file, { anchor, insert, label, optional }) {
  if (!fs.existsSync(file)) {
    console.log((optional ? '[-] ' : '[X] ') + file + ' not found' + (optional ? ' — skipping' : ''));
    if (!optional) process.exit(1);
    skipped++; return;
  }
  let src = fs.readFileSync(file, 'utf8');
  const crlf = src.indexOf('\r\n') !== -1;
  if (crlf) src = src.replace(/\r\n/g, '\n');
  if (src.includes(MARK)) { console.log('[=] ' + label + ' already wired'); skipped++; return; }
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    console.log('[X] ' + label + ': anchor ' + (n === 0 ? 'not found' : 'matched ' + n + ' times'));
    if (!optional) process.exit(1);
    skipped++; return;
  }
  src = src.replace(anchor, insert);
  fs.writeFileSync(file, crlf ? src.replace(/\n/g, '\r\n') : src);
  console.log('[ok] ' + label);
  changed++;
}

// ---- 1. netlify.toml: API alias + the three short links --------------------
edit(path.join('netlify.toml'), {
  label: 'netlify.toml redirects',
  anchor: `[[redirects]]
  from = "/api/companion/*"`,
  insert: `# ${MARK} — Speed Gaming Meet-up (EVT-PITPB5-103): 2v2 pairing engine,
# TV pairings board and the Guru run-the-night console.
[[redirects]]
  from = "/api/speedgaming/*"
  to   = "/.netlify/functions/speedgaming/:splat"
  status = 200
[[redirects]]
  from = "/api/speedgaming"
  to   = "/.netlify/functions/speedgaming"
  status = 200
# Short links: the QR on the TV, the tablet behind the desk, and the screen itself.
[[redirects]]
  from = "/speedgaming"
  to   = "/app/speedgaming/index.html"
  status = 200
[[redirects]]
  from = "/speedgaming-tv"
  to   = "/speedgaming-tv.html"
  status = 200
[[redirects]]
  from = "/speedgaming-guru"
  to   = "/speedgaming-guru.html"
  status = 200

[[redirects]]
  from = "/api/companion/*"`
});

// ---- 2. (nothing to do for tests/index.js) ---------------------------------
// The suites are NOT merged into tests/index.js. Suites that install module
// hooks — lightspeed via _mock-hooks.mjs, speedgaming via _speedgaming-hooks.mjs
// — must not share a process: the loader chains every registered hook and the
// two sets of mocks fight over the same imports. The test runner gives each
// FILE its own process, so the whole suite runs with:
//     node --test tests/*.test.mjs

// ---- 3. Housekeeping: drop the published staff code ------------------------
// `stash2026` is inert in live server mode (the real code lives in a Netlify
// env var) but it is sitting in a public JS file, and a published staff code is
// a bad look in an app-store review. Flagged in the 2026-09-12 findings doc.
(function () {
  const f = path.join('site', 'ngh-config.js');
  if (!fs.existsSync(f)) { console.log('[-] site/ngh-config.js not found — skipping'); return; }
  let src = fs.readFileSync(f, 'utf8');
  if (!/stash2026/.test(src)) { console.log('[=] staff code already removed'); return; }
  const crlf = src.indexOf('\r\n') !== -1;
  if (crlf) src = src.replace(/\r\n/g, '\n');
  src = src.replace(/window\.NGH_ADMIN_CODE\s*=\s*"stash2026";/,
    'window.NGH_ADMIN_CODE = "";   /* ' + MARK + ': removed — the live code lives in ADMIN_SECRET */');
  fs.writeFileSync(f, crlf ? src.replace(/\n/g, '\r\n') : src);
  console.log('[ok] removed the published staff code from ngh-config.js');
  changed++;
})();

console.log('\n' + changed + ' change(s) applied, ' + skipped + ' already done or skipped.');
