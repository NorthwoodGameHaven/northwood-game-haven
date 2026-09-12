# patches/patch-guru-tonight-bookings-2026-09-12q.py — NGH-BUILD 2026-09-12q
#
# "Tonight" showed events and nothing else, so a Guru could read the page,
# see an empty evening, and be met at the door by a party of fourteen with a
# private room booked in the Depths.
#
# Bookings go in as their OWN section rather than being threaded through the
# event card renderers. An event and a room booking are different objects with
# different fields — forcing a booking through todayCard() would mean faking a
# registration block and a run-sheet link it does not have, and every future
# change to either would have to keep the pretence up. A separate section is
# additive, obvious on screen, and cannot break the event cards.
#
#   python3 patches/patch-guru-tonight-bookings-2026-09-12q.py
import os, re, sys, subprocess, tempfile

P = os.path.join('site', 'guru-tonight.html')
MARK = 'NGH-BUILD 2026-09-12q'
if not os.path.exists(P):
    print('[X] run this from the repo root — ' + P + ' not found'); sys.exit(1)

src = open(P, newline='').read()
if MARK in src:
    print('[=] guru-tonight.html already patched (' + MARK + ')'); sys.exit(0)
crlf = '\r\n' in src
if crlf: src = src.replace('\r\n', '\n')

edits = []
def rep(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        print('[X] anchor ' + ('not found' if n == 0 else 'matched %d times' % n) + ': ' + label); sys.exit(1)
    src = src.replace(old, new, 1); edits.append(label)

# ---- 1. styling: a booking is not an event ---------------------------------
rep("""  .ev.offsite{ border-left-color:var(--teal); }""",
"""  .ev.offsite{ border-left-color:var(--teal); }
  /* """ + MARK + """: room bookings, deliberately unlike the event cards. */
  .bk{ border-left:5px double #6e1f2b; }
  .bk.pending{ background-image:repeating-linear-gradient(45deg, rgba(110,31,43,0.07) 0, rgba(110,31,43,0.07) 6px, transparent 6px, transparent 13px); }
  .bk-title{ font-weight:bold; color:#6e1f2b; font-size:17px; }
  .bk-tag{ display:inline-block; background:#6e1f2b; color:#fff; border-radius:20px; padding:1px 9px; font-size:12px; margin-left:6px; }
  .bk-tag.warn{ background:#b8862d; color:#241c07; }""",
 'booking card styling')

# ---- 2. a section to put them in -------------------------------------------
rep("""    <h2 class="sec">🗓️ The week ahead <span class="cnt">(next 7 days)</span></h2>""",
"""    <!-- """ + MARK + """ -->
    <h2 class="sec">🔑 Room bookings <span class="cnt" id="bk-label">(today &amp; the next 7 days)</span></h2>
    <div id="bookings-list"><p class="empty">Loading…</p></div>

    <h2 class="sec">🗓️ The week ahead <span class="cnt">(next 7 days)</span></h2>""",
 'a room-bookings section')

# ---- 3. load them ----------------------------------------------------------
rep("""    Promise.all([
      fetch(API+"/events",{headers:hdrs()}).then(function(r){ if(r.status===401) throw new Error("auth"); return r.json(); }),
      fetch(API+"/gurus",{headers:hdrs()}).then(function(r){ return r.ok?r.json():{}; }).catch(function(){ return {}; })
    ]).then(function(res){
      var ev=res[0]; S.events=(ev&&ev.events)||ev||[];
      S.guru={ assignments:(res[1]&&res[1].assignments)||[], shifts:(res[1]&&res[1].shifts)||[], unavail:(res[1]&&res[1].unavail)||[] };
      render();""",
"""    Promise.all([
      fetch(API+"/events",{headers:hdrs()}).then(function(r){ if(r.status===401) throw new Error("auth"); return r.json(); }),
      fetch(API+"/gurus",{headers:hdrs()}).then(function(r){ return r.ok?r.json():{}; }).catch(function(){ return {}; }),
      /* """ + MARK + """: bookings. A booking failing to load must not take
         the whole page down with it — the events are still worth showing. */
      fetch(API+"/bookings",{headers:hdrs()}).then(function(r){ return r.ok?r.json():[]; }).catch(function(){ return []; })
    ]).then(function(res){
      var ev=res[0]; S.events=(ev&&ev.events)||ev||[];
      S.guru={ assignments:(res[1]&&res[1].assignments)||[], shifts:(res[1]&&res[1].shifts)||[], unavail:(res[1]&&res[1].unavail)||[] };
      var bk=res[2]; S.bookings=((bk&&bk.bookings)||bk||[]).filter(function(b){
        return b && b.date && (b.status==="approved" || b.status==="pending" || b.status==="hold");
      });
      render();""",
 'fetch bookings')

# ---- 4. render them --------------------------------------------------------
rep("""  function render(){
    $("today-label").textContent = "("+human(TODAY)+")";""",
"""  /* """ + MARK + """ */
  var BK_ROOMS = { holt:"The Holt", den:"Stash's Den", depths:"The Depths", lodge:"Lakeview Lodge (VRBO)", rest:"Otter's Rest (VRBO)" };
  function bkRooms(b){ return (b.rooms||[]).map(function(r){ return BK_ROOMS[r]||r; }).join(", ") || "room TBD"; }
  function bkGurus(b){
    var ov=null, base=null;
    (S.guru.assignments||[]).forEach(function(a){
      if(!a || a.bookingId!==b.id) return;
      if(a.date===b.date) ov=a; else if(a.date==null) base=a;
    });
    var a=ov||base;
    if(!a) return null;
    return a.none ? [] : (a.gurus||[]);
  }
  function bkCard(b){
    var need=(b.addons||[]).filter(function(a){ return a && a.id==="guru"; })[0];
    var qty=need ? Math.max(1, parseInt(need.qty,10)||1) : 0;
    var g=bkGurus(b);
    var mins=t2m(b.start)||0, endM=mins+Math.round((Number(b.hours)||1)*60);
    var when=(b.date===TODAY ? "Today" : human(b.date)) + " · " + m2t(mins) + "–" + m2t(Math.min(1440,endM));
    var tags="";
    if(b.status!=="approved") tags+='<span class="bk-tag warn">'+esc(b.status)+'</span>';
    if(qty) tags+='<span class="bk-tag'+((g&&g.length>=qty)?"":" warn")+'">'+((g&&g.length)||0)+'/'+qty+' Guru'+(qty>1?"s":"")+'</span>';
    if(b.birthdayParty) tags+='<span class="bk-tag">\\ud83c\\udf82 birthday</span>';
    return '<div class="card ev bk'+(b.status!=="approved"?" pending":"")+'">'+
      '<div class="bk-title">\\ud83d\\udd11 '+esc(b.name||"Private booking")+tags+'</div>'+
      '<div class="ev-time">'+esc(when)+'</div>'+
      '<div>'+esc(bkRooms(b))+(b.guests?(" · "+esc(b.guests)+" guests"):"")+'</div>'+
      (g && g.length ? '<div>\\ud83d\\udc64 '+esc(g.join(", "))+'</div>'
                     : (qty ? '<div style="color:#8a5a12;">\\u26a0\\ufe0f No Guru assigned yet</div>' : ''))+
      (b.phone?('<div class="empty" style="margin:4px 0 0;">'+esc(b.phone)+'</div>'):'')+
      '<div style="margin-top:8px;">'+
        '<a class="btn ghost small" href="guru-master.html?date='+encodeURIComponent(b.date)+'&view=day">Master Calendar</a> '+
        '<a class="btn ghost small" href="booking.html?admin=1&view=list#'+encodeURIComponent(b.id)+'">Open request</a>'+
      '</div></div>';
  }
  function m2t(m){ var h=Math.floor(m/60), mm=m%60, ap=h>=12?"PM":"AM"; h=h%12; if(h===0)h=12; return h+(mm?(":"+(mm<10?"0":"")+mm):"")+ap; }
  function renderBookings(){
    var horizon=addDays(TODAY,7);
    var list=(S.bookings||[]).filter(function(b){ return b.date>=TODAY && b.date<=horizon; })
      .sort(function(a,b){ return a.date<b.date?-1:a.date>b.date?1:((t2m(a.start)||0)-(t2m(b.start)||0)); });
    var todayN=list.filter(function(b){ return b.date===TODAY; }).length;
    $("bk-label").textContent = "(" + (todayN ? (todayN + " today, ") : "") + list.length + " in the next 7 days)";
    $("bookings-list").innerHTML = list.length ? list.map(bkCard).join("")
      : '<div class="card"><p class="empty">\\ud83d\\udd11 No room bookings in the next week.</p></div>';
  }

  function render(){
    $("today-label").textContent = "("+human(TODAY)+")";
    renderBookings();""",
 'render the bookings section')

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
