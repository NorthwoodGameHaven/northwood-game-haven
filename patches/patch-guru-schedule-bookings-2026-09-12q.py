# patches/patch-guru-schedule-bookings-2026-09-12q.py — NGH-BUILD 2026-09-12q
#
# The Guru Schedule has never loaded a booking.
#
# reload() fetched /events and /gurus and nothing else, so every private room
# booking — approved or pending — was invisible on the page the shop plans the
# week from. A Guru could look at Wednesday, see an empty Depths, and book a
# second party into a room that already had one in it.
#
# This adds bookings to the page, formatted so they cannot be mistaken for an
# NGH event: maroon, keyed, and hatched while they are still only a request.
#
#   python3 patches/patch-guru-schedule-bookings-2026-09-12q.py
import os, re, sys, subprocess, tempfile

P = os.path.join('site', 'guru-schedule.html')
MARK = 'NGH-BUILD 2026-09-12q'
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

# ---- 1. Styling that says "this is somebody's private booking" --------------
rep("""  .blk.ev b { display:block; font-size:0.66rem; }""",
"""  .blk.ev b { display:block; font-size:0.66rem; }
  /* """ + MARK + """: room bookings are not events and must never read as
     one. Maroon, a doubled left edge, and a hatch while still a request. */
  .blk.ev.booking { background:#6e1f2b !important; border-left:5px double rgba(255,255,255,0.85); }
  .blk.ev.booking.pending { background-image:repeating-linear-gradient(45deg, rgba(255,255,255,0.30) 0, rgba(255,255,255,0.30) 4px, transparent 4px, transparent 9px); }
  .blk.ev.booking.unassigned { background:#8b4a52 !important; color:#fff; font-style:normal; }""",
 'booking styling, distinct from events')

# ---- 2. Actually load them --------------------------------------------------
rep("""async function reload(){
  var ev=await api("/events");
  var gd=await api("/gurus");
  cache.events=ev||[];
  cache.assignments=(gd&&gd.assignments)||[];
  cache.shifts=(gd&&gd.shifts)||[];
  cache.unavail=(gd&&gd.unavail)||[];
  setView(curView);
}""",
"""async function reload(){
  /* """ + MARK + """: /bookings joins the fetch. This page has planned the
     week from events alone since it was written, which meant a room could be
     booked solid and still look free here. Approved AND pending — a request
     nobody has answered yet is exactly the thing you need to see before you
     promise the room to somebody else. */
  var ev, gd, bk;
  try { ev = await api("/events"); } catch(e){ ev = []; }
  try { gd = await api("/gurus"); } catch(e){ gd = null; }
  try { bk = await api("/bookings"); } catch(e){ bk = []; }
  cache.events=ev||[];
  cache.assignments=(gd&&gd.assignments)||[];
  cache.shifts=(gd&&gd.shifts)||[];
  cache.unavail=(gd&&gd.unavail)||[];
  cache.bookings=((bk&&bk.bookings)||bk||[]).filter(function(b){
    return b && b.date && (b.status==="approved" || b.status==="pending" || b.status==="hold");
  });
  setView(curView);
}""",
 'load bookings alongside events')

# ---- 3. Resolve assignments for any reference type, then build the items ----
rep("""/* ---- occurrence collection ---- */""",
"""/* """ + MARK + """: assignments can now point at a booking, not just an
   event, so resolution takes the field name. Same override rule as always:
   a dated record beats the undated one. */
function asgForRef(field, id, date){
  var ov=null, base=null;
  cache.assignments.forEach(function(a){
    if(!a || a[field]!==id) return;
    if(a.date===date) ov=a;
    else if(a.date==null) base=a;
  });
  return ov||base;
}
function bookingGurus(id, date){
  var a=asgForRef("bookingId", id, date);
  if(!a) return { state:"unassigned", gurus:[] };
  if(a.none) return { state:"none", gurus:[], rec:a };
  return { state:"assigned", gurus:a.gurus||[], rec:a };
}

/* ---- occurrence collection ---- */""",
 'assignment resolution for bookings')

rep("""function shiftItemsInRange(from,to){""",
"""/* """ + MARK + """ */
function bookingItemsInRange(from,to){
  var out=[];
  (cache.bookings||[]).forEach(function(b){
    if(!b.date || b.date<from || b.date>to) return;
    var sMin=timeToMins(b.start);
    var rawEnd=sMin+Math.round((Number(b.hours)||1)*60);
    var overnight=rawEnd>1440;
    var addon=(b.addons||[]).filter(function(a){ return a && a.id==="guru"; })[0];
    var g=bookingGurus(b.id,b.date);
    out.push({ type:"booking", date:b.date, allDay:false, overnight:overnight,
      start:sMin, end:overnight?1440:rawEnd,
      startLbl:fmtTime(sMin), endLbl:fmtTime(overnight?1440:rawEnd)+(overnight?" (+1 day)":""),
      title:"\\ud83d\\udd11 "+(b.name||"Private booking")+(b.status!=="approved"?(" ("+b.status+")"):""),
      eventId:null, bookingId:b.id, bk:b, status:b.status,
      guruNeed: addon ? Math.max(1, parseInt(addon.qty,10)||1) : 0,
      gurus:g.gurus, gstate:g.state });
  });
  return out;
}
function shiftItemsInRange(from,to){""",
 'bookingItemsInRange')

# ---- 4. Put them on the grid ------------------------------------------------
rep("""  var evs=eventItemsInRange(from,to);
  var shifts=shiftItemsInRange(from,to);
  var unav=unavailItemsInRange(from,to);""",
"""  var evs=eventItemsInRange(from,to).concat(bookingItemsInRange(from,to)); /* """ + MARK + """ */
  var shifts=shiftItemsInRange(from,to);
  var unav=unavailItemsInRange(from,to);""",
 'bookings on the schedule grid')

# A booking with nobody assigned must NOT be hidden by a guru filter chip.
# Unstaffed work is the work most likely to go wrong, so filtering it away is
# the worst possible default.
rep("""    var dayEvs=evs.filter(function(e){
      if(e.date!==d) return false;
      if(e.gstate==="assigned") return e.gurus.some(guruVisible);
      return sched.showUnassigned && !sched.filter;
    }).sort(function(a,b){ return a.start-b.start || b.end-a.end; });""",
"""    var dayEvs=evs.filter(function(e){
      if(e.date!==d) return false;
      if(e.gstate==="assigned") return e.gurus.some(guruVisible);
      /* """ + MARK + """: a room booking with no Guru assigned still occupies
         the room, so a Guru filter must not make it disappear — that is how a
         double-booking gets promised. */
      if(e.type==="booking") return true;
      return sched.showUnassigned && !sched.filter;
    }).sort(function(a,b){ return a.start-b.start || b.end-a.end; });""",
 'a guru filter never hides an unstaffed booking')

rep("""      var col = e.gstate==="assigned" ? guruColor(e.gurus[0]) : "#a8a288";
      var conf=confKeys[e.eventId+"|"+d];
      var cls="blk ev"+(e.gstate!=="assigned"?" unassigned":"")+(isDraftEvent(e.ev)?" draft":"")+(e.overnight?" overnight":"")+(conf==="red"?" conf-red":conf==="yel"?" conf-yel":"");
      var label = e.gstate==="assigned" ? e.gurus.join(" + ") : (e.gstate==="none"?"No Guru needed":"UNASSIGNED");
      h+='<div class="'+cls+'" style="top:'+top(e.start)+'px;height:'+Math.max(22,top(e.end)-top(e.start))+'px;left:'+l+'%;width:'+(w-1)+'%;background:'+col+';" onclick="openDetails(\\''+esc(e.eventId)+'\\',\\''+d+'\\')">'+
         '<b>'+esc(label)+'</b>'+esc(e.title)+'<br>'+e.startLbl+(e.endLbl?("–"+e.endLbl):"")+
         (e.overnight?'<span class="contnote">⤵ continues past midnight</span>':'')+'</div>';""",
"""      var isBk = e.type==="booking";                                   /* """ + MARK + """ */
      var col = isBk ? "" : (e.gstate==="assigned" ? guruColor(e.gurus[0]) : "#a8a288");
      var conf=confKeys[(e.eventId||e.bookingId)+"|"+d];
      var cls="blk ev"+(isBk?" booking":"")+(isBk&&e.status!=="approved"?" pending":"")+
              (e.gstate!=="assigned"?" unassigned":"")+((!isBk&&isDraftEvent(e.ev))?" draft":"")+
              (e.overnight?" overnight":"")+(conf==="red"?" conf-red":conf==="yel"?" conf-yel":"");
      var label = e.gstate==="assigned" ? e.gurus.join(" + ")
                : (e.gstate==="none" ? "No Guru needed"
                : (isBk ? (e.guruNeed ? ("NEEDS "+e.guruNeed+" GURU"+(e.guruNeed>1?"S":"")) : "Room booking") : "UNASSIGNED"));
      var go = isBk ? ('openBookingDetails(\\''+esc(e.bookingId)+'\\')')
                    : ('openDetails(\\''+esc(e.eventId)+'\\',\\''+d+'\\')');
      h+='<div class="'+cls+'" style="top:'+top(e.start)+'px;height:'+Math.max(22,top(e.end)-top(e.start))+'px;left:'+l+'%;width:'+(w-1)+'%;'+(col?('background:'+col+';'):'')+'" onclick="'+go+'">'+
         '<b>'+esc(label)+'</b>'+esc(e.title)+'<br>'+e.startLbl+(e.endLbl?("–"+e.endLbl):"")+
         (isBk&&e.bk&&e.bk.rooms&&e.bk.rooms.length?('<br>'+esc(e.bk.rooms.map(roomName).join(", "))):'')+
         (e.overnight?'<span class="contnote">⤵ continues past midnight</span>':'')+'</div>';""",
 'draw bookings distinctly and link them to the console')

# ---- 5. A detail view for bookings -----------------------------------------
rep("""/* ---------------- DETAILS MODAL ---------------- */""",
"""/* """ + MARK + """: bookings get their own detail, and a way through to the
   Master Guru Calendar where a Guru can actually be assigned to one. */
function openBookingDetails(id){
  var b=(cache.bookings||[]).filter(function(x){ return x.id===id; })[0];
  if(!b) return;
  var g=bookingGurus(b.id,b.date);
  var addon=(b.addons||[]).filter(function(a){ return a && a.id==="guru"; })[0];
  var paidFee = (b.feePaid===true || b.payment==="paid");
  var paidDep = (b.depositPaid===true || b.payment==="paid");
  var rows=[
    ["Status", b.status],
    ["When", b.date+" · "+fmtTime(timeToMins(b.start))+" for "+(b.hours||1)+"h"],
    ["Rooms", (b.rooms||[]).map(roomName).join(", ")||"—"],
    ["Guests", b.guests||"—"],
    ["Contact", (b.name||"—")+(b.phone?(" · "+b.phone):"")+(b.email?(" · "+b.email):"")],
    ["Payment", b.payment==="onaccount" ? "On account"
       : ((paidFee?"Fee paid":"Fee due")+" · "+(paidDep?"Deposit paid":"Deposit due (payable on the day)"))],
    ["Gurus", g.gurus.length ? g.gurus.join(", ") : (g.state==="none" ? "None needed" : "Not assigned")],
    ["Guru add-on", addon ? (addon.qty||1)+" purchased" : "none"]
  ];
  if(b.comments) rows.push(["Comments", b.comments]);
  var html='<h2 style="margin:0 0 2px;">\\ud83d\\udd11 '+esc(b.name||"Private booking")+'</h2>'+
    '<p class="hint" style="margin:0 0 12px;">Private room booking</p>'+
    rows.map(function(r){ return '<div class="kv"><b>'+esc(r[0])+'</b> '+esc(String(r[1]))+'</div>'; }).join("")+
    '<p class="hint" style="margin-top:12px;">Guru assignment for bookings lives on the Master Guru Calendar.</p>'+
    '<div style="margin-top:14px;text-align:right;">'+
      '<a class="btn btn-sm btn-ghost" href="guru-master.html?date='+encodeURIComponent(b.date)+'&view=day">Open Master Calendar</a> '+
      '<a class="btn btn-sm btn-ghost" href="booking.html?admin=1&view=list#'+encodeURIComponent(b.id)+'">Open in Requests</a> '+
      '<button class="btn btn-sm btn-ghost" onclick="closeModal()">Close</button>'+
    '</div>';
  $("modal-box").innerHTML=html;
  $("modal-bg").style.display="block";
}

/* ---------------- DETAILS MODAL ---------------- */""",
 'booking detail modal')

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
