# patches/patch-guru-schedule-shift-edit-2026-09-12r.py — NGH-BUILD 2026-09-12r
#
# Store shifts were only editable on a separate tab. You would spot a hole in
# the floor cover while looking at the calendar, then have to leave the
# calendar, find the right row in a table, and edit it there.
#
# The shift bands ARE the thing you want to click. Now they are:
#   * click a store-shift band  -> opens that shift in the Shifts form
#   * click "no shift set" in a day header -> adds a shift, date prefilled
#
# It routes to the existing form rather than duplicating it. A second shift
# editor would be a second place for the rules to drift.
#
#   python3 patches/patch-guru-schedule-shift-edit-2026-09-12r.py
import os, re, sys, subprocess, tempfile

P = os.path.join('site', 'guru-schedule.html')
MARK = 'NGH-BUILD 2026-09-12r'
if not os.path.exists(P):
    print('[X] run this from the repo root — ' + P + ' not found'); sys.exit(1)

src = open(P, newline='').read()
if MARK in src:
    print('[=] guru-schedule.html already patched (' + MARK + ')'); sys.exit(0)
crlf = '\r\n' in src
if crlf: src = src.replace('\r\n', '\n')

edits = []
def rep(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        print('[X] anchor ' + ('not found' if n == 0 else 'matched %d times' % n) + ': ' + label); sys.exit(1)
    src = src.replace(old, new, 1); edits.append(label)

# ---- 1. the band has to look clickable ------------------------------------
rep("""color:#5a2b7a; cursor:default; }""",
    """color:#5a2b7a; cursor:pointer; }   /* """ + MARK + """: click to edit */
  .blk.shift:hover { outline:2px solid rgba(90,43,122,0.5); }
  .storeline.addable { cursor:pointer; text-decoration:underline dotted; }
  .storeline.addable:hover { color:var(--forest); }""",
 'shift bands look and behave clickable')

# ---- 2. click the band -----------------------------------------------------
rep("""      h+='<div class="blk shift" style="top:'+top(s.start)+'px;height:'+Math.max(16,top(s.end)-top(s.start))+'px;left:0;right:0;" title="Retail store: '+esc(s.guru)+'">🏪 '+esc(s.guru)+' '+s.startLbl+'–'+s.endLbl+'</div>';""",
    """      /* """ + MARK + """: the band is the affordance. */
      h+='<div class="blk shift" style="top:'+top(s.start)+'px;height:'+Math.max(16,top(s.end)-top(s.start))+'px;left:0;right:0;" title="Retail store: '+esc(s.guru)+' — click to edit" onclick="jumpToShift(\\''+esc(s.shift.id)+'\\')">🏪 '+esc(s.guru)+' '+s.startLbl+'–'+s.endLbl+'</div>';""",
 'clicking a shift band opens it for editing')

# ---- 3. a day with no cover is where you add one ---------------------------
rep("""    h+='<div class="sched-dayhead"><b>'+fmtDate(d)+'</b><div class="storeline">🏪 '+hdStore+'</div>'+hdUnLine+'</div>';""",
    """    /* """ + MARK + """: an empty store line is the obvious place to add cover. */
    var hdCls = hdShifts.length ? "storeline" : "storeline addable";
    var hdClick = hdShifts.length ? "" : ' onclick="newShiftOn(\\''+d+'\\')" title="Add a store shift for this day"';
    h+='<div class="sched-dayhead"><b>'+fmtDate(d)+'</b><div class="'+hdCls+'"'+hdClick+'>🏪 '+hdStore+(hdShifts.length?'':' — add')+'</div>'+hdUnLine+'</div>';""",
 'add a shift from a day with no cover')

# ---- 4. the routing --------------------------------------------------------
rep("""var editShiftId=null;""",
    """var editShiftId=null;
/* """ + MARK + """: jump from the calendar into the shift form, rather than
   growing a second editor that could drift from this one. */
var newShiftDate=null;
function jumpToShift(id){ editShiftId=id; newShiftDate=null; setView("shifts"); focusShiftForm(); }
function newShiftOn(date){ editShiftId=null; newShiftDate=date; setView("shifts"); focusShiftForm(); }
function focusShiftForm(){
  setTimeout(function(){
    var el=$("view-shifts");
    if(el && el.scrollIntoView) el.scrollIntoView({behavior:"smooth", block:"start"});
    var g=$("sh-guru"); if(g && g.focus) g.focus();
  }, 60);
}""",
 'jumpToShift / newShiftOn')

# ---- 5. honour the prefilled date -----------------------------------------
rep("""'<div class="field"><label>Date</label><input type="date" id="sh-date" value="'+(s?s.date:todayStr())+'"></div>'+""",
    """'<div class="field"><label>Date</label><input type="date" id="sh-date" value="'+(s?s.date:(newShiftDate||todayStr()))+'"></div>'+ /* """ + MARK + """ */""",
 'prefill the date when adding from a day header')

# ---- validate + write -------------------------------------------------------
tags   = re.findall(r'<script\b[^>]*>', src, re.I)
bodies = re.findall(r'<script\b[^>]*>([\s\S]*?)</script>', src, re.I)
checked = 0
for tag, body in zip(tags, bodies):
    m = re.search(r'type\s*=\s*["\']([^"\']+)["\']', tag, re.I)
    t = (m.group(1).strip().lower() if m else '')
    if t and t not in ('module', 'text/javascript', 'application/javascript'): continue
    if not body.strip(): continue
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write(body); tmp = f.name
    r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
    os.unlink(tmp)
    if r.returncode != 0:
        print('[X] patched JS does not parse:\n' + r.stderr[:900]); sys.exit(1)
    checked += 1

if crlf: src = src.replace('\n', '\r\n')
open(P, 'w', newline='').write(src)
print('[ok] %d edits applied to %s (%d script blocks parse)' % (len(edits), P, checked))
for e in edits: print('     - ' + e)
