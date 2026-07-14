// apply-deconflict-tweaks.mjs
// Two refinements to the De-conflict audit in site/booking.html:
//   1. The "📅 Day view" button now scrolls the viewer down to the actual
//      day grid after switching (it used to leave you parked at the audit list).
//   2. The audit ignores past dates — only today and future items are scanned,
//      so historical overlaps no longer clutter the list or the calendar outlines.
//
// Run from the repo ROOT:  node apply-deconflict-tweaks.mjs
// Requires the conflicts patch to already be applied (it is, in your deploy).
// Verifies every anchor appears exactly once BEFORE writing; aborts with zero
// writes on any missing/ambiguous anchor or if already applied.

import fs from 'fs';

const FILE = 'site/booking.html';
let src;
try { src = fs.readFileSync(FILE, 'utf8'); }
catch (e) { console.error('ABORTED: cannot read ' + FILE + ' -- run this from the repo root.'); process.exit(1); }

if (src.includes('calGotoScroll')) {
  console.error('ABORTED: de-conflict tweaks already applied. Nothing written.');
  process.exit(1);
}
if (!src.includes('deconflictHTML')) {
  console.error('ABORTED: conflicts feature not found in ' + FILE + ' -- apply apply-conflicts-patch.mjs first. Nothing written.');
  process.exit(1);
}

// All anchors are single-line, so CRLF/LF line endings cannot affect matching.
const EDITS = [
  [
    // 1a. New goto-and-scroll helper, added beside calGoto
    `function calGoto(dateStr, mode){ calRef=new Date(dateStr+"T12:00:00"); calMode=mode; renderCalendar(); }`,
    `function calGoto(dateStr, mode){ calRef=new Date(dateStr+"T12:00:00"); calMode=mode; renderCalendar(); }
function calGotoScroll(dateStr, mode){ calGoto(dateStr, mode); setTimeout(function(){ var g=$("cal-grid-anchor"); if(g) g.scrollIntoView({behavior:"smooth", block:"start"}); }, 30); }`,
    'calGotoScroll helper added'
  ],
  [
    // 1b. Scroll anchor placed right where the month/week/day grid begins
    `  html += (calMode==="month") ? monthHTML() : weekDayHTML(calMode==="day");`,
    `  html += '<div id="cal-grid-anchor"></div>';
  html += (calMode==="month") ? monthHTML() : weekDayHTML(calMode==="day");`,
    'grid scroll anchor inserted in renderCalendar'
  ],
  [
    // 1c. Audit's Day view button uses the scrolling version
    `onclick="calGoto(\\''+c.date+'\\',\\'day\\')">\uD83D\uDCC5 Day view`,
    `onclick="calGotoScroll(\\''+c.date+'\\',\\'day\\')">\uD83D\uDCC5 Day view`,
    'audit Day view button scrolls to the grid'
  ],
  [
    // 2. Audit skips anything before today
    `  var items=_auditItems(), groups={}, out=[];`,
    `  var items=_auditItems(), groups={}, out=[];
  var _todayStr=ymd(new Date());
  items=items.filter(function(it){ return it.date>=_todayStr; });   // past dates: not our problem anymore`,
    'audit filters out past dates'
  ],
];

let bad = false;
for (const [anchor, , note] of EDITS) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) { console.error('\u2717 anchor not unique (' + n + ' matches): ' + note); bad = true; }
}
if (bad) { console.error('ABORTED: nothing was written. Paste this output back to Claude.'); process.exit(1); }

for (const [anchor, replacement, note] of EDITS) {
  src = src.replace(anchor, () => replacement);
  console.log('\u2713 ' + note);
}
fs.writeFileSync(FILE, src);
console.log('\u2713 patched ' + FILE + ' (de-conflict tweaks: scroll-to-day + future-only audit)');
