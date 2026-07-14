// apply-skip-conflicts-patch.mjs
// Recurring events: when a save red-conflicts on only SOME dates of the
// series, offer to skip those dates (they become series exceptions,
// restorable from the 🔁 Review instances panel) and save the rest —
// instead of hard-blocking the whole series. One-time events and series
// where EVERY date conflicts still get the hard block.
//
// Also fixes a trap in the deployed guard: it scanned the full series while
// ignoring the event's EXISTING exceptions, so dates you had already
// canceled via Review instances kept blocking the save. The scan now
// respects them.
//
// Back-to-back (yellow) warnings for skipped dates are suppressed too — a
// date you're skipping can't be back-to-back with anything.
//
// Run from the repo ROOT:  node apply-skip-conflicts-patch.mjs
// CRLF-safe (anchors are normalized to the file's own line endings).
// Verifies every anchor BEFORE writing; aborts with zero writes on any problem.

import fs from 'fs';

const FILE = 'site/booking.html';
let src;
try { src = fs.readFileSync(FILE, 'utf8'); }
catch (e) { console.error('ABORTED: cannot read ' + FILE + ' -- run this from the repo root.'); process.exit(1); }

if (src.includes('_skipDates')) {
  console.error('ABORTED: skip-conflicts patch already applied. Nothing written.');
  process.exit(1);
}
if (!src.includes('room-conflict guard')) {
  console.error('ABORTED: conflict guard not found -- apply-conflicts-patch.mjs must be applied first. Nothing written.');
  process.exit(1);
}

const EDITS = [
  [
    // 1. Track skipped dates alongside the tight flag
    `  var _evTight=false;`,
    `  var _evTight=false, _skipDates=[];`,
    'skip-dates tracker added'
  ],
  [
    // 2. Scan respects the series' EXISTING exceptions when editing
    `      ? eventDates({ date:date, recurrence:{ freq:$("ev-rec-freq").value, count:Math.max(2,Math.min(52,parseInt($("ev-rec-count").value,10)||2)) } })`,
    `      ? eventDates({ date:date, recurrence:{ freq:$("ev-rec-freq").value, count:Math.max(2,Math.min(52,parseInt($("ev-rec-count").value,10)||2)) }, exceptions:(editingEventId?(((cache.events.filter(function(x){return x.id===editingEventId;})[0])||{}).exceptions||[]):[]) })`,
    'scan honors existing exceptions'
  ],
  [
    // 3. Red block becomes skip-and-save when only some dates conflict
    `    if(_chk.red.length){
      alert("\uD83D\uDD34 Can't save \u2014 this event's room(s) overlap something already scheduled:\\n\\n"+_chk.red.map(function(c){ return "\u2022 "+c.date+" \u00B7 "+roomName(c.room)+": "+c.label+" ("+c.win+")"; }).join("\\n")+"\\n\\nChange the time, date, or rooms \u2014 or open \uD83E\uDDF9 De-conflict in the calendar to resolve it.");
      return;
    }`,
    `    if(_chk.red.length){
      var _redMsg=_chk.red.map(function(c){ return "\u2022 "+c.date+" \u00B7 "+roomName(c.room)+": "+c.label+" ("+c.win+")"; }).join("\\n");
      var _redDates=[]; _chk.red.forEach(function(c){ if(_redDates.indexOf(c.date)<0) _redDates.push(c.date); });
      if($("ev-recurring").checked && _redDates.length < _occ.length){
        if(confirm("\uD83D\uDD34 Some dates of this series overlap something already scheduled:\\n\\n"+_redMsg+"\\n\\nSkip the "+_redDates.length+" conflicting date"+(_redDates.length===1?"":"s")+" and save the rest of the series?\\n\\nSkipped dates become canceled instances of the series \u2014 review or restore them anytime via \uD83D\uDD01 Review instances on this event's card.\\n\\nOK = skip those dates & save \u00B7 Cancel = don't save")){
          _skipDates=_redDates;
        } else { return; }
      } else {
        alert("\uD83D\uDD34 Can't save \u2014 this event's room(s) overlap something already scheduled:\\n\\n"+_redMsg+"\\n\\nChange the time, date, or rooms \u2014 or open \uD83E\uDDF9 De-conflict in the calendar to resolve it.");
        return;
      }
    }`,
    'red block offers skip-and-save for partial series conflicts'
  ],
  [
    // 4. Yellow warnings ignore dates being skipped
    `    if(_chk.tight.length){
      if(!confirm("\u26A0\uFE0F Back-to-back warning \u2014 less than "+MIN_GAP+" minutes of changeover with:\\n\\n"+_chk.tight.map(function(c){ return "\u2022 "+c.date+" \u00B7 "+roomName(c.room)+": "+c.label+" ("+c.win+")"; }).join("\\n")+"\\n\\nSave anyway?")) return;
      _evTight=true;
    }`,
    `    var _tightLeft=_chk.tight.filter(function(c){ return _skipDates.indexOf(c.date)<0; });
    if(_tightLeft.length){
      if(!confirm("\u26A0\uFE0F Back-to-back warning \u2014 less than "+MIN_GAP+" minutes of changeover with:\\n\\n"+_tightLeft.map(function(c){ return "\u2022 "+c.date+" \u00B7 "+roomName(c.room)+": "+c.label+" ("+c.win+")"; }).join("\\n")+"\\n\\nSave anyway?")) return;
      _evTight=true;
    }`,
    'yellow warnings skip the skipped dates'
  ],
  [
    // 5. Apply skips to the event being saved (new events + non-scoped edits)
    `  if(_evTight) ev.allowTight=true;`,
    `  if(_evTight) ev.allowTight=true;
  if(_skipDates.length && ev.recurrence){ ev.exceptions=(ev.exceptions||[]).concat(_skipDates.filter(function(d){ return (ev.exceptions||[]).indexOf(d)<0; })); }`,
    'skipped dates saved as exceptions'
  ],
  [
    // 6a. "Whole series" edit merges skips with the original exceptions
    //     (the old line overwrote ev.exceptions and would drop the skips)
    `        ev.exceptions = orig.exceptions||[];`,
    `        ev.exceptions = (orig.exceptions||[]).concat((ev.exceptions||[]).filter(function(d){ return (orig.exceptions||[]).indexOf(d)<0; }));`,
    'whole-series edit merges skips with existing exceptions'
  ],
  [
    // 6b. "This + following" split: the new series keeps the skipped dates
    `        ev.recurrence = { freq:(ev.recurrence?ev.recurrence.freq:orig.recurrence.freq), count:Math.max(2,remaining) };
        ev.exceptions=[];`,
    `        ev.recurrence = { freq:(ev.recurrence?ev.recurrence.freq:orig.recurrence.freq), count:Math.max(2,remaining) };
        ev.exceptions=_skipDates.slice();`,
    'split series keeps skipped dates as exceptions'
  ],
];

const EOL = src.includes('\r\n') ? '\r\n' : '\n';   // CRLF-safe
const norm = (t) => t.replace(/\r?\n/g, EOL);

let bad = false;
for (const [anchor, , note] of EDITS) {
  const n = src.split(norm(anchor)).length - 1;
  if (n !== 1) { console.error('\u2717 anchor not unique (' + n + ' matches): ' + note); bad = true; }
}
if (bad) { console.error('ABORTED: nothing was written. Paste this output back to Claude.'); process.exit(1); }

for (const [anchor, replacement, note] of EDITS) {
  src = src.replace(norm(anchor), () => norm(replacement));
  console.log('\u2713 ' + note);
}
fs.writeFileSync(FILE, src);
console.log('\u2713 patched ' + FILE + ' (recurring saves can skip conflicting dates)');
