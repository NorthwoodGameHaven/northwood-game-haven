# patches/patch-booking-rejected-2026-09-12n.py — NGH-BUILD 2026-09-12n
#
# Two bugs, both seen on one screenshot: the Rejected tab showing "No pending
# requests." with 20 rejected bookings sitting in the count, and Robyn's Depths
# booking going back to rejected after being re-approved.
#
#   python3 patches/patch-booking-rejected-2026-09-12n.py
#
# Idempotent, CRLF-preserving, validates that the result still parses.
import re, sys, os

P = os.path.join('site', 'booking.html')
MARK = 'NGH-BUILD 2026-09-12n'
if not os.path.exists(P):
    print('[X] run this from the repo root — ' + P + ' not found'); sys.exit(1)

src = open(P, newline='').read()
if MARK in src:
    print('[=] booking.html already patched (' + MARK + ')'); sys.exit(0)
crlf = '\r\n' in src
if crlf: src = src.replace('\r\n', '\n')

edits = []
def rep(old, new, label):
    global src
    n = src.count(old)
    if n != 1:
        print('[X] anchor ' + ('not found' if n == 0 else 'matched %d times' % n) + ': ' + label); sys.exit(1)
    src = src.replace(old, new); edits.append(label)

# ---- 1. One bad record must not blank the whole list ------------------------
# renderAdmin did `list.map(reqCardHtml).join("")` in a single expression. If
# reqCardHtml throws on ANY one booking, the exception escapes before
# el.innerHTML is assigned, so the list keeps whatever was rendered last — which
# on a fresh console is the "No pending requests." card from the default tab.
# That is exactly the reported symptom: Rejected (20) highlighted, list still
# showing the pending empty-state, and no way to reach 20 real bookings.
#
# Rendering per-card means one malformed record costs you that one card, with
# its id and the actual error visible, instead of silently costing you the tab.
rep("""  var el=$("requests-list");
  if(!list.length){ el.innerHTML='<div class="card"><p class="hint" style="margin:0;">No '+filter+' requests.</p></div>'; return; }
  el.innerHTML=list.map(reqCardHtml).join("");""",
"""  var el=$("requests-list");
  if(!list.length){ el.innerHTML='<div class="card"><p class="hint" style="margin:0;">No '+filter+' requests.</p></div>'; return; }
  /* """ + MARK + """: render card by card. One booking that throws used to take
     the entire tab down — the exception escaped before innerHTML was assigned,
     so the list silently kept the previous tab's empty-state message while the
     count said there were 20 to look at. */
  var broken=0;
  el.innerHTML=list.map(function(r){
    try{ return reqCardHtml(r); }
    catch(e){
      broken++;
      console.error('[NGH] could not render booking '+(r&&r.id)+':', e);
      return '<div class="card" style="border-color:#f0c5be;background:#fdf3f2;">'+
        '<h2 style="color:#9a3b2e;margin-top:0;">\\u26a0\\ufe0f '+esc((r&&r.id)||'unknown booking')+'</h2>'+
        '<p class="hint" style="margin:0 0 8px;">This booking could not be displayed \\u2014 something in the record is malformed. '+
        'The details below are enough to find it; the full error is in the browser console.</p>'+
        '<div class="kv"><b>Name</b> '+esc((r&&r.name)||'\\u2014')+'</div>'+
        '<div class="kv"><b>Date</b> '+esc((r&&r.date)||'\\u2014')+'</div>'+
        '<div class="kv"><b>Status</b> '+esc((r&&r.status)||'\\u2014')+'</div>'+
        '<div class="kv" style="color:#9a3b2e;"><b>Error</b> '+esc(String(e&&e.message||e))+'</div>'+
        '</div>';
    }
  }).join("");
  if(broken) console.warn('[NGH] '+broken+' of '+list.length+' bookings failed to render in the "'+filter+'" tab');""",
 'render each card independently so one bad record cannot blank the tab')

# ---- 2. Stop auto-cancel fighting the Guru ----------------------------------
# The old condition re-cancelled ANY approved+unpaid booking whose deadline had
# passed — including bookings whose date is long gone. So re-approving a past
# unpaid booking flipped it straight back to rejected on the next console
# refresh AND emailed the customer "your booking was canceled" all over again.
# That is the "why is Robyn's booking rejected again" loop, and it is why she
# may have received the same cancellation notice more than once.
#
# Two guards:
#   * only cancel inside the window where cancelling still MEANS something —
#     after the payment deadline but before the booking date is over. Cancelling
#     a date that has already passed frees no room and only confuses the guest.
#   * never re-cancel something a Guru has deliberately re-approved.
rep("""    if(r.status==="approved" && !feeIsPaid(r) && !depIsPaid(r)){ /* NGH-BUILD 2026-09-10c: was !fullyPaid(r); now cancel only when NEITHER fee nor deposit is paid */
      var deadline=new Date(r.date+"T00:00:00"); deadline.setDate(deadline.getDate()-1); deadline.setHours(23,59,59);
      if(now>deadline){""",
"""    if(r.status==="approved" && !feeIsPaid(r) && !depIsPaid(r) && !r.autoCancelExempt){ /* NGH-BUILD 2026-09-10c: was !fullyPaid(r); now cancel only when NEITHER fee nor deposit is paid. """ + MARK + """: + autoCancelExempt */
      var deadline=new Date(r.date+"T00:00:00"); deadline.setDate(deadline.getDate()-1); deadline.setHours(23,59,59);
      /* """ + MARK + """: and a FLOOR. Without one, every approved-and-unpaid
         booking in the past is permanently eligible, so re-approving one sent
         it straight back to rejected on the next refresh and emailed the guest
         another cancellation. Once the date is gone there is no room to free
         and nothing useful to tell anyone. */
      var lastMoment=new Date(r.date+"T23:59:59");
      if(now>deadline && now<=lastMoment){""",
 'auto-cancel only inside the window where it still means something')

# ---- 3. Re-approving is a deliberate act; respect it ------------------------
rep("""  await Store.updateBooking(id,{status:"approved"}); await refreshCache(); await resendApproval(id, true); renderAdmin(adminFilter); }""",
"""  /* """ + MARK + """: a Guru re-approving a booking the robot cancelled is
     overruling the robot on purpose. Exempt it, or the next console refresh
     cancels it again and emails the guest a second time. */
  var _wasAuto = !!(_r && (_r.autoCanceled || _r.status === "rejected"));
  await Store.updateBooking(id, _wasAuto ? {status:"approved", autoCancelExempt:true} : {status:"approved"});
  await refreshCache(); await resendApproval(id, true); renderAdmin(adminFilter); }""",
 'a manual re-approval exempts the booking from auto-cancel')

# ---- validate + write -------------------------------------------------------
scripts = re.findall(r'<script\b[^>]*>([\s\S]*?)</script>', src, re.I)
blocks  = re.findall(r'<script\b[^>]*>', src, re.I)
checked = 0
import subprocess, tempfile
for tag, body in zip(blocks, scripts):
    m = re.search(r'type\s*=\s*["\']([^"\']+)["\']', tag, re.I)
    t = (m.group(1).strip().lower() if m else '')
    if t and t not in ('module', 'text/javascript', 'application/javascript'):
        continue                      # ld+json, importmap, templates: data, not code
    if not body.strip():
        continue
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write(body); tmp = f.name
    r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
    os.unlink(tmp)
    if r.returncode != 0:
        print('[X] patched JS does not parse:\n' + r.stderr[:800]); sys.exit(1)
    checked += 1

if crlf: src = src.replace('\n', '\r\n')
open(P, 'w', newline='').write(src)
print('[ok] %d edits applied to %s (%d script blocks parse)' % (len(edits), P, checked))
for e in edits: print('     - ' + e)
