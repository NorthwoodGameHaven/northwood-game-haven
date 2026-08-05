#!/usr/bin/env node
// NGH-BUILD 2026-08-05b
//  booking.html — enlarge the admin "Public description" textarea (ev-notes)
//  so there's real room to compose multi-paragraph event copy.
//  Safe to run whether or not 2026-08-05a (Web Promotions removal) has been
//  applied yet — this patch only touches the ev-notes textarea and is
//  independent of that change.
//
// Node port of ngh-patch-2026-08-05b.py — same logic, same anchors, same guards.
// Run from repo root AFTER: git pull origin main --no-rebase
//   node ngh-patch-2026-08-05b.cjs
'use strict';
const fs = require('fs');

const MARK = "NGH-BUILD 2026-08-05b";

function load(p) {
  const raw = fs.readFileSync(p);
  const crlf = raw.includes(Buffer.from('\r\n'));
  return [raw.toString('utf8').replace(/\r\n/g, '\n'), crlf];
}
function save(p, src, crlf) {
  if (crlf) src = src.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, Buffer.from(src, 'utf8'));
}
function sub(src, oldStr, newStr, label) {
  const n = src.split(oldStr).length - 1;
  if (n !== 1) throw new Error('ABORT [' + label + ']: anchor found ' + n + 'x (expected 1)');
  return src.split(oldStr).join(newStr);
}
function markEnd(src, comment) {
  const i = src.lastIndexOf('</body>');
  if (i === -1) throw new Error('ABORT: </body> not found');
  return src.slice(0, i) + comment + '\n' + src.slice(i);
}
function resolvePath() {
  for (const n of arguments) if (fs.existsSync(n)) return n;
  return arguments[arguments.length - 1];
}

(function () {
  const p = resolvePath('site/booking.html', 'booking.html');
  let [src, crlf] = load(p);
  if (src.includes(MARK)) { console.log('skip ' + p + ' (already patched)'); return; }
  src = sub(src, "<label class=\"fld\">Public description</label><textarea id=\"ev-notes\" placeholder=\"What is this event? Who is it for? Format, theme, etc.\">", "<label class=\"fld\">Public description</label><textarea id=\"ev-notes\" style=\"min-height:220px;\" placeholder=\"What is this event? Who is it for? Format, theme, etc. Use blank lines for paragraph breaks — they now display exactly as typed.\">", 'ev-notes textarea height');
  src = markEnd(src, '<!-- ' + MARK + ' · taller Public Description textarea (min-height:220px) -->');
  save(p, src, crlf);
  console.log('patched ' + p);
})();

console.log('done');
