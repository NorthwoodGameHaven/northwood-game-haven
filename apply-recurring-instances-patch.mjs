// apply-recurring-instances-patch.mjs
// Per-instance management for recurring events:
//   1. "🔁 Review instances" button on every recurring event card (admin console)
//      opens an inline panel listing every date in the series.
//   2. Cancel a single date without touching the rest (uses the series'
//      exceptions list; restorable with one click).
//   3. Change start/end time for a single date without touching the rest
//      (that date becomes its own detached event, conflict-checked server-side;
//      the series keeps its normal time).
//   4. Optional per-occurrence note ("📌 This date: ...") — e.g. which game
//      Wednesday Board Game Night is playing that week. Shown in the admin
//      panel AND on the public calendar popup for that date only.
//
// Files touched: site/booking.html, site/events.html, site/index.html,
// site/ngh.html (index + ngh get the identical edit — mirror rule).
//
// Run from the repo ROOT:  node apply-recurring-instances-patch.mjs
// All anchors are single-line (CRLF-proof). Every anchor in every file is
// verified BEFORE anything is written; aborts with zero writes on any problem.

import fs from 'fs';

/* ------------------------------------------------------------------ */
/* Injected admin functions (booking.html)                             */
/* ------------------------------------------------------------------ */
const INSTANCE_FUNCS =
`/* ---- Recurring event instance management ---- */
function _evById(id){ var e=null; cache.events.forEach(function(x){ if(x.id===id) e=x; }); return e; }
function occRefreshPanel(id){ var box=$("instwrap-"+id); if(box) box.innerHTML=instancesHTML(id); }
async function _refreshInstances(id){ await refreshCache(); evFilterChange(); occRefreshPanel(id); }
function reviewInstances(id){
  var box=$("instwrap-"+id); if(!box) return;
  if(box.innerHTML){ box.innerHTML=""; return; }
  box.innerHTML=instancesHTML(id);
}
function instancesHTML(id){
  var e=_evById(id); if(!e||!e.recurrence) return "";
  var raw=recurrenceDates(e.date, e.recurrence.freq, e.recurrence.count);
  var exc=e.exceptions||[]; var notes=e.occNotes||{};
  var det={}; cache.events.forEach(function(x){ if(x.detachedFrom===id) det[x.date]=x; });
  var today=ymd(new Date());
  var h='<div style="margin-top:10px;border-top:1px dashed #d8e0d4;padding-top:10px;">'+
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">'+
    '<b style="font-family:\\'Cinzel\\',serif;color:var(--forest);font-size:0.85rem;">🔁 All instances ('+raw.length+')</b>'+
    '<button class="btn btn-sm btn-ghost" onclick="reviewInstances(\\''+id+'\\')">Close</button></div>';
  raw.forEach(function(ds){
    var isPast=ds<today, d=det[ds], canceled=exc.indexOf(ds)>=0 && !d;
    var timeLbl = e.allDay?"All day":(fmtTime(timeToMins(e.start))+" \\u2013 "+fmtTime(timeToMins(e.end)));
    h+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 10px;margin-top:6px;border:1px solid '+(canceled?'#f0c5be':(d?'#d9c9f2':'#d8e0d4'))+';border-radius:9px;'+(isPast?'opacity:0.55;':'')+(canceled?'background:#fdf3f2;':'')+'">'+
      '<b style="min-width:92px;">'+ds+'</b>';
    if(canceled){
      h+='<span style="color:#9a3b2e;font-size:0.8rem;">✖ Canceled</span><span style="flex:1;"></span>'+
        '<button class="btn btn-sm btn-ghost" onclick="restoreOccurrence(\\''+id+'\\',\\''+ds+'\\')">↩ Restore</button>';
    } else if(d){
      var dt=d.allDay?"All day":(fmtTime(timeToMins(d.start))+" \\u2013 "+fmtTime(timeToMins(d.end)));
      h+='<span style="font-size:0.8rem;color:#5b3a8a;">✎ Modified · '+dt+'</span>'+
        ((d.occNotes&&d.occNotes[ds])?'<span style="font-size:0.78rem;color:#7a5a14;">📌 '+esc(d.occNotes[ds])+'</span>':'')+
        '<span style="flex:1;"></span>'+
        '<button class="btn btn-sm btn-ghost" onclick="occNoteEdit(\\''+d.id+'\\',\\''+ds+'\\',\\''+id+'\\')">📌 Note</button>'+
        '<button class="btn btn-sm btn-ghost" onclick="editEvent(\\''+d.id+'\\')">✎ Edit</button>';
    } else {
      h+='<span style="font-size:0.8rem;color:#4a4a35;">'+timeLbl+'</span>'+
        (notes[ds]?'<span style="font-size:0.78rem;color:#7a5a14;">📌 '+esc(notes[ds])+'</span>':'')+
        '<span style="flex:1;"></span>'+
        '<span id="occtw-'+id+'-'+ds+'" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">'+
        '<button class="btn btn-sm btn-ghost" onclick="occNoteEdit(\\''+id+'\\',\\''+ds+'\\',\\''+id+'\\')">📌 Note</button>'+
        (e.allDay?'':'<button class="btn btn-sm btn-ghost" onclick="occTimeForm(\\''+id+'\\',\\''+ds+'\\')">⏱ Time</button>')+
        '<button class="btn btn-sm btn-ghost" style="color:#9a3b2e;" onclick="cancelOccurrence(\\''+id+'\\',\\''+ds+'\\')">✖ Cancel date</button>'+
        '</span>';
    }
    h+='</div>';
  });
  h+='<p class="hint" style="margin:8px 0 0;">Canceling or changing a single date never touches the rest of the series. No automatic emails are sent — if people registered for a changed or canceled date, handle them from 👥 View registrants.</p></div>';
  return h;
}
async function cancelOccurrence(id, ds){
  var e=_evById(id); if(!e) return;
  if(!confirm("Cancel ONLY "+ds+" of \\""+(e.title||"this event")+"\\"?\\n\\nThe rest of the series is untouched. No automatic email is sent — if anyone registered for this date, contact or refund them via View registrants.")) return;
  var upd=Object.assign({}, e); upd.exceptions=(e.exceptions||[]).slice();
  if(upd.exceptions.indexOf(ds)<0) upd.exceptions.push(ds);
  try{ await Store.saveEvent(upd); }catch(err){ alert("Couldn't cancel: "+((err&&err.message)||err)); return; }
  _refreshInstances(id);
}
async function restoreOccurrence(id, ds){
  var e=_evById(id); if(!e) return;
  var clash=null; cache.events.forEach(function(x){ if(x.detachedFrom===id && x.date===ds) clash=x; });
  if(clash){ alert("This date was modified into its own event ("+clash.id+"). Delete that event first if you want the original series slot back."); return; }
  var upd=Object.assign({}, e); upd.exceptions=(e.exceptions||[]).filter(function(x){ return x!==ds; });
  try{ await Store.saveEvent(upd); }catch(err){ alert("Couldn't restore: "+((err&&err.message)||err)); return; }
  _refreshInstances(id);
}
async function occNoteEdit(id, ds, parentId){
  var e=_evById(id); if(!e) return;
  var cur=(e.occNotes||{})[ds]||"";
  var v=prompt("Note just for "+ds+" (shown on the public calendar for that date only; leave blank to clear):", cur);
  if(v===null) return;
  var upd=Object.assign({}, e); upd.occNotes=Object.assign({}, e.occNotes||{});
  v=v.trim(); if(v) upd.occNotes[ds]=v; else delete upd.occNotes[ds];
  try{ await Store.saveEvent(upd); }catch(err){ alert("Couldn't save the note: "+((err&&err.message)||err)); return; }
  _refreshInstances(parentId||id);
}
function occTimeForm(id, ds){
  var e=_evById(id); if(!e) return;
  var span=$("occtw-"+id+"-"+ds); if(!span) return;
  span.innerHTML='<input type="time" id="occts-'+id+'-'+ds+'" value="'+(e.start||"")+'" step="900" style="padding:6px 8px;border:1.5px solid #d8e0d4;border-radius:8px;">'+
    ' \\u2013 <input type="time" id="occte-'+id+'-'+ds+'" value="'+(e.end||"")+'" step="900" style="padding:6px 8px;border:1.5px solid #d8e0d4;border-radius:8px;">'+
    ' <button class="btn btn-sm" onclick="occTimeApply(\\''+id+'\\',\\''+ds+'\\')">Apply</button>'+
    ' <button class="btn btn-sm btn-ghost" onclick="occRefreshPanel(\\''+id+'\\')">Cancel</button>';
}
async function occTimeApply(id, ds){
  var e=_evById(id); if(!e) return;
  var si=$("occts-"+id+"-"+ds), ei=$("occte-"+id+"-"+ds);
  var ns=si?si.value:"", ne=ei?ei.value:"";
  if(!ns||!ne){ alert("Set both a start and end time."); return; }
  if(!confirm("Change ONLY "+ds+" to "+fmtTime(timeToMins(ns))+" \\u2013 "+fmtTime(timeToMins(ne))+"?\\n\\nThis date becomes its own event; the series keeps its normal time. If people already registered for this date, their registrations stay under the original event — check View registrants on both.")) return;
  var note=(e.occNotes||{})[ds];
  var parent=Object.assign({}, e);
  parent.exceptions=(e.exceptions||[]).slice();
  if(parent.exceptions.indexOf(ds)<0) parent.exceptions.push(ds);
  if(note){ parent.occNotes=Object.assign({}, e.occNotes); delete parent.occNotes[ds]; }
  var solo=Object.assign({}, e, { id:undefined, date:ds, start:ns, end:ne, recurrence:null, groupId:null, exceptions:[], detachedFrom:e.id });
  delete solo.occNotes;
  if(note){ solo.occNotes={}; solo.occNotes[ds]=note; }
  try{
    await Store.saveEvent(parent);
    try{ await Store.saveEvent(solo); }
    catch(err2){
      var m=(err2&&err2.message)||String(err2);
      if(/changeover|tight|15\\s*min/i.test(m) && confirm("⚠️ "+m+"\\n\\nProceed anyway?")){ solo.allowTight=true; await Store.saveEvent(solo); }
      else { await Store.saveEvent(Object.assign({}, e)); alert("Couldn't change the time — the series was left unchanged.\\n\\n"+m); return; }
    }
  }catch(err){ alert("Couldn't change the time: "+((err&&err.message)||err)); return; }
  _refreshInstances(id);
}
`;

/* ------------------------------------------------------------------ */
/* Edits                                                               */
/* ------------------------------------------------------------------ */
const PUBLIC_NOTES_ANCHOR = `    if(e.notes) h+='<p style="font-size:0.92rem;color:#4a4a35;line-height:1.7;margin-bottom:16px;">'+esc(e.notes)+'</p>';`;
const PUBLIC_NOTES_NEW = PUBLIC_NOTES_ANCHOR + `
    var _on=(e.occNotes||{})[ds||e.date]; if(_on) h+='<div style="background:#fff7e8;border:1px solid #f0dcae;color:#7a5a14;border-radius:10px;padding:10px 14px;font-size:0.86rem;margin-bottom:16px;">📌 <b>This date:</b> '+esc(_on)+'</div>';`;

const FILES = {
  'site/booking.html': [
    [
      `      '<button class="btn btn-sm btn-danger" onclick="deleteEvent(\\''+e.id+'\\')">Delete</button></div>'+`,
      `      (e.recurrence?'<button class="btn btn-sm btn-ghost" onclick="reviewInstances(\\''+e.id+'\\')">🔁 Review instances</button>':'')+
      '<button class="btn btn-sm btn-danger" onclick="deleteEvent(\\''+e.id+'\\')">Delete</button></div>'+
      '<div id="instwrap-'+e.id+'"></div>'+`,
      'card: Review instances button + panel container'
    ],
    [
      `  var orig = editingEventId ? cache.events.filter(function(x){return x.id===editingEventId;})[0] : null;`,
      `  var orig = editingEventId ? cache.events.filter(function(x){return x.id===editingEventId;})[0] : null;
  if(orig && orig.occNotes && !ev.occNotes) ev.occNotes = orig.occNotes;   // editing an event must not wipe its per-date notes`,
      'saveEvent preserves occurrence notes on edit'
    ],
    [
      `function eventCardHTML(e){`,
      INSTANCE_FUNCS + `function eventCardHTML(e){`,
      'instance management functions injected'
    ],
  ],
  'site/events.html': [ [PUBLIC_NOTES_ANCHOR, PUBLIC_NOTES_NEW, 'public popup shows occurrence note (events.html)'] ],
  'site/index.html':  [ [PUBLIC_NOTES_ANCHOR, PUBLIC_NOTES_NEW, 'public popup shows occurrence note (index.html)'] ],
  'site/ngh.html':    [ [PUBLIC_NOTES_ANCHOR, PUBLIC_NOTES_NEW, 'public popup shows occurrence note (ngh.html — mirror)'] ],
};

/* Verify everything everywhere first — abort with zero writes on any problem. */
const sources = {};
let bad = false;
for (const [path, edits] of Object.entries(FILES)) {
  let src;
  try { src = fs.readFileSync(path, 'utf8'); }
  catch (e) { console.error('\u2717 cannot read ' + path + ' — run from the repo root.'); bad = true; continue; }
  if (path === 'site/booking.html' && src.includes('reviewInstances')) {
    console.error('ABORTED: recurring-instances patch already applied. Nothing written.');
    process.exit(1);
  }
  if (path !== 'site/booking.html' && src.includes('occNotes')) {
    console.error('ABORTED: ' + path + ' already has the occurrence-note display. Nothing written.');
    process.exit(1);
  }
  for (const [anchor, , note] of edits) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) { console.error('\u2717 anchor not unique (' + n + ' matches) in ' + path + ': ' + note); bad = true; }
  }
  sources[path] = src;
}
if (bad) { console.error('ABORTED: nothing was written. Paste this output back to Claude.'); process.exit(1); }

for (const [path, edits] of Object.entries(FILES)) {
  let src = sources[path];
  for (const [anchor, replacement, note] of edits) {
    src = src.replace(anchor, () => replacement);
    console.log('\u2713 ' + note);
  }
  fs.writeFileSync(path, src);
  console.log('\u2713 patched ' + path);
}
console.log('\u2713 done — remember: index.html and ngh.html were both patched (mirror rule).');
