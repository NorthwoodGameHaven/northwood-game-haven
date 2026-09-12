// patches/patch-2026-09-12l.cjs — NGH-BUILD 2026-09-12l
//
// Wires everything in this drop into netlify.toml and tidies one loose end.
// The FILES are copied in by APPLY-NGH-2026-09-12l.cmd; this only makes the
// small in-place edits to files that already exist. Idempotent — safe to run
// twice, it says "already wired" instead of duplicating.
//
// Run from the repo root:  node patches/patch-2026-09-12l.cjs
const fs = require('fs');
const path = require('path');

const MARK = 'NGH-BUILD 2026-09-12l';
let changed = 0, skipped = 0;

function block(label, file, anchor, insert, { optional = false } = {}) {
  if (!fs.existsSync(file)) {
    console.log((optional ? '[-] ' : '[X] ') + file + ' not found' + (optional ? ' — skipping' : ''));
    if (!optional) process.exit(1);
    skipped++; return;
  }
  let src = fs.readFileSync(file, 'utf8');
  const crlf = src.indexOf('\r\n') !== -1;
  if (crlf) src = src.replace(/\r\n/g, '\n');
  if (src.includes(insert.trim().split('\n')[0])) { console.log('[=] ' + label + ' already wired'); skipped++; return; }
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    console.log('[X] ' + label + ': anchor ' + (n === 0 ? 'not found' : 'matched ' + n + ' times'));
    if (!optional) process.exit(1);
    skipped++; return;
  }
  src = src.replace(anchor, insert + anchor);
  fs.writeFileSync(file, crlf ? src.replace(/\n/g, '\r\n') : src);
  console.log('[ok] ' + label);
  changed++;
}

const TOML = 'netlify.toml';
const COMPANION_ANCHOR = `[[redirects]]
  from = "/api/companion/*"`;

// ---- 1. Speed Gaming Meet-up ----------------------------------------------
block('netlify.toml · Speed Gaming routes', TOML, COMPANION_ANCHOR,
`# ${MARK} — Speed Gaming Meet-up (EVT-PITPB5-103): 2v2 pairing engine,
# TV pairings board and the Guru run-the-night console.
[[redirects]]
  from = "/api/speedgaming/*"
  to   = "/.netlify/functions/speedgaming/:splat"
  status = 200
[[redirects]]
  from = "/api/speedgaming"
  to   = "/.netlify/functions/speedgaming"
  status = 200
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

`);

// ---- 2. Magic night board --------------------------------------------------
block('netlify.toml · Magic night routes', TOML, COMPANION_ANCHOR,
`# ${MARK} — Magic night board (sits beside EventLink Mirror).
[[redirects]]
  from = "/api/mtg/*"
  to   = "/.netlify/functions/mtg/:splat"
  status = 200
[[redirects]]
  from = "/api/mtg"
  to   = "/.netlify/functions/mtg"
  status = 200
[[redirects]]
  from = "/mtg"
  to   = "/app/mtg/index.html"
  status = 200
[[redirects]]
  from = "/mtg-tv"
  to   = "/mtg-tv.html"
  status = 200

`);

// ---- 3. Housekeeping: drop the published staff code ------------------------
// `stash2026` is inert in live server mode (the real code is the ADMIN_SECRET
// env var) but it was sitting in a public JS file, and a published staff code
// is a bad look in an app-store review.
(function () {
  const f = path.join('site', 'ngh-config.js');
  if (!fs.existsSync(f)) { console.log('[-] site/ngh-config.js not found — skipping'); return; }
  let src = fs.readFileSync(f, 'utf8');
  if (!/stash2026/.test(src)) { console.log('[=] staff code already removed'); skipped++; return; }
  const crlf = src.indexOf('\r\n') !== -1;
  if (crlf) src = src.replace(/\r\n/g, '\n');
  src = src.replace(/window\.NGH_ADMIN_CODE\s*=\s*"stash2026";/,
    'window.NGH_ADMIN_CODE = "";   /* ' + MARK + ': removed — the live code lives in ADMIN_SECRET */');
  fs.writeFileSync(f, crlf ? src.replace(/\n/g, '\r\n') : src);
  console.log('[ok] removed the published staff code from ngh-config.js');
  changed++;
})();

console.log('\n' + changed + ' change(s) applied, ' + skipped + ' already done or skipped.');
console.log('\nNothing else needs editing — every other file in this drop is new,');
console.log('except site/trivia-play.html and the two karaoke app pages, which the');
console.log('copy step replaces with their already-patched versions.');
