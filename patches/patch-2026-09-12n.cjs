// patches/patch-2026-09-12n.cjs — NGH-BUILD 2026-09-12n
// Adds the /privacy route. Everything else in this drop is a new or replaced
// file, so this is the only in-place edit. Idempotent.
//   node patches/patch-2026-09-12n.cjs
const fs = require('fs');
const F = 'netlify.toml';
if (!fs.existsSync(F)) { console.error('[X] run this from the repo root'); process.exit(1); }
let src = fs.readFileSync(F, 'utf8');
const crlf = src.indexOf('\r\n') !== -1;
if (crlf) src = src.replace(/\r\n/g, '\n');
if (/from = "\/privacy"/.test(src)) { console.log('[=] /privacy route already wired'); process.exit(0); }
const anchor = '[[redirects]]\n  from = "/api/companion/*"';
const n = src.split(anchor).length - 1;
if (n !== 1) { console.error('[X] anchor ' + (n === 0 ? 'not found' : 'matched ' + n + ' times')); process.exit(1); }
src = src.replace(anchor, `# NGH-BUILD 2026-09-12n — privacy policy. Google Play will not accept a
# listing without this URL, and the Data Safety form is checked against what
# the page says.
[[redirects]]
  from = "/privacy"
  to   = "/privacy.html"
  status = 200

` + anchor);
fs.writeFileSync(F, crlf ? src.replace(/\n/g, '\r\n') : src);
console.log('[ok] /privacy route added');
