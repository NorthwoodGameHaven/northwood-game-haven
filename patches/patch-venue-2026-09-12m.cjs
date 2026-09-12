// patches/patch-venue-2026-09-12m.cjs — NGH-BUILD 2026-09-12m
// Adds the venue-mode routes to netlify.toml. Idempotent.
//   node patches/patch-venue-2026-09-12m.cjs
const fs = require('fs');
const MARK = 'NGH-BUILD 2026-09-12m';
const F = 'netlify.toml';
if (!fs.existsSync(F)) { console.error('[X] run this from the repo root'); process.exit(1); }
let src = fs.readFileSync(F, 'utf8');
const crlf = src.indexOf('\r\n') !== -1;
if (crlf) src = src.replace(/\r\n/g, '\n');
if (src.includes('/api/venue')) { console.log('[=] venue routes already wired'); process.exit(0); }
// Anchor on the companion redirect, which has been stable across every build.
const anchor = '[[redirects]]\n  from = "/api/companion/*"';
const n = src.split(anchor).length - 1;
if (n !== 1) { console.error('[X] anchor ' + (n === 0 ? 'not found' : 'matched ' + n + ' times')); process.exit(1); }
src = src.replace(anchor, `# ${MARK} — Venue mode: one source of truth for what the room is doing.
# Stream Deck / Bitfocus Companion sets it with a bare GET; the TVs, the PA and
# the app all follow it.
[[redirects]]
  from = "/api/venue/*"
  to   = "/.netlify/functions/venue/:splat"
  status = 200
[[redirects]]
  from = "/api/venue"
  to   = "/.netlify/functions/venue"
  status = 200
# THE one URL a screen ever needs. Point the Google TV Streamers here once.
[[redirects]]
  from = "/tv-auto"
  to   = "/tv-auto.html"
  status = 200
[[redirects]]
  from = "/tv-idle"
  to   = "/tv-idle.html"
  status = 200

` + anchor);
fs.writeFileSync(F, crlf ? src.replace(/\n/g, '\r\n') : src);
console.log('[ok] venue routes added to netlify.toml');
console.log('\nNEXT: set VENUE_KEY in Netlify (Site configuration -> Environment');
console.log('variables) to a long random string, then Trigger deploy.');
