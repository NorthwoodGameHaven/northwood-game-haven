# patches/patch-kill-client-autocancel-2026-09-12p.py — NGH-BUILD 2026-09-12p
#
# DELETES the browser-side auto-cancel. Not tunes it — deletes it.
#
# WHY IT HAD TO GO ENTIRELY
#
# There were TWO auto-cancellers. The nightly server job (auto-cancel.mjs) is
# careful and has been hardened over months:
#   * spares anything with ANY payment: payment==='paid', feePaid, depositPaid,
#     payment==='onaccount', feeOnAccount, depositOnAccount
#   * SAME-DAY EXEMPTION (added 2026-08-01) — bookings dated today or earlier
#     are never cancelled, because it was "rejecting bookings while the guests
#     were in the room"
#   * a late-booking grace for requests submitted after their own deadline
#   * runs once nightly, and reports what it did in the ops digest
#
# The copy in booking.html had NONE of that:
#   * it only checked feePaid / depositPaid, so an ON-ACCOUNT booking looked
#     unpaid and got cancelled — the server would have spared it
#   * no same-day exemption, so it re-created the exact bug the server fixed
#   * no late-booking grace
#   * it ran on EVERY console load, not nightly
#   * it emailed the guest a cancellation straight from a Guru's browser
#   * before 2026-09-10c it required fullyPaid(), so a guest who paid the
#     booking fee and owed only the day-of deposit was cancelled anyway
#
# That last one is why Robyn was cancelled despite paying. The deposit must
# never be able to cancel anybody, and a browser tab must never email a
# customer that their booking is off.
#
# The nightly server job remains the single owner of this, and its rules were
# rewritten in the same build:
#   * the DEPOSIT never cancels anybody, ever — it can only spare a booking
#   * nothing is cancelled until the booking's END time has passed
#   * guests are only emailed within 48h of that
#   * AUTO_CANCEL_ENABLED=0 turns cancelling off entirely
# If the policy should change again, it changes there, once, where it can be
# reviewed — not in a function that fires whenever somebody opens the console
# on their phone.
#
#   python3 patches/patch-kill-client-autocancel-2026-09-12p.py
import os, re, sys, subprocess, tempfile

P = os.path.join('site', 'booking.html')
MARK = 'NGH-BUILD 2026-09-12p'
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

# ---- 1. Stop calling it ------------------------------------------------------
rep("""  autoCancelUnpaid().then(function(changed){ if(changed) setAdminView(adminView); }).catch(function(){});""",
    """  /* """ + MARK + """: the browser no longer cancels anybody's booking.
     Opening the Guru console is not a decision to cancel a customer. The
     nightly server job (netlify/functions/auto-cancel.mjs) owns this, and it
     is the one with the same-day exemption, the on-account handling and the
     ops-digest reporting. */""",
 'stop running auto-cancel on every console load')

# ---- 2. Gut the function ----------------------------------------------------
old_fn_start = src.index('async function autoCancelUnpaid(){')
# find its matching close brace
i = src.index('{', old_fn_start); depth = 0
strc = None; esc = False; line = False; block = False
while i < len(src):
    c = src[i]; n = src[i+1] if i + 1 < len(src) else ''
    if line:
        if c == '\n': line = False
        i += 1; continue
    if block:
        if c == '*' and n == '/': block = False; i += 1
        i += 1; continue
    if strc:
        if esc: esc = False
        elif c == '\\': esc = True
        elif c == strc: strc = None
        i += 1; continue
    if c == '/' and n == '/': line = True; i += 2; continue
    if c == '/' and n == '*': block = True; i += 2; continue
    if c in '"\'`': strc = c; i += 1; continue
    if c == '{': depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0: break
    i += 1
old_fn = src[old_fn_start:i+1]

new_fn = """async function autoCancelUnpaid(){
  /* ===== """ + MARK + """: DELETED ON PURPOSE. DO NOT BRING THIS BACK. =====

     This used to cancel a guest's approved booking and email them about it,
     from a Guru's browser, on every console load. It cancelled Robyn's Depths
     booking even though she had paid, because at the time it required BOTH the
     booking fee AND the deposit to be settled — and the deposit is payable on
     the day. It also treated on-account bookings as unpaid, and had no
     same-day exemption, so it could cancel a booking while the guests were
     sitting in the room.

     The nightly server job at netlify/functions/auto-cancel.mjs is the single
     owner of this policy. It spares anything with any payment recorded against
     it (paid, fee, deposit, or on-account), never touches a booking dated today
     or earlier, gives late bookings a grace period, and reports what it did in
     the daily ops digest so a human sees it.

     Unpaid bookings are still visible here: an approved booking shows
     "Fee: Due" and "Deposit: Due" badges on its card. Surfacing is this page's
     job. Deciding is the Guru's. */
  return false;
}"""
src = src.replace(old_fn, new_fn)
edits.append('gut autoCancelUnpaid — it can no longer cancel or email anyone')

# ---- 3. Drop the exemption flag; there is nothing left to be exempt from -----
rep("""  /* NGH-BUILD 2026-09-12n: a Guru re-approving a booking the robot cancelled is
     overruling the robot on purpose. Exempt it, or the next console refresh
     cancels it again and emails the guest a second time. */
  var _wasAuto = !!(_r && (_r.autoCanceled || _r.status === "rejected"));
  await Store.updateBooking(id, _wasAuto ? {status:"approved", autoCancelExempt:true} : {status:"approved"});
  await refreshCache(); await resendApproval(id, true); renderAdmin(adminFilter); }""",
    """  /* """ + MARK + """: no exemption flag needed — nothing in the browser
     cancels bookings any more, so there is nothing to be exempt from. */
  await Store.updateBooking(id,{status:"approved"}); await refreshCache(); await resendApproval(id, true); renderAdmin(adminFilter); }""",
 'remove the now-pointless autoCancelExempt flag')

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
        print('[X] patched JS does not parse:\n' + r.stderr[:800]); sys.exit(1)
    checked += 1

if crlf: src = src.replace('\n', '\r\n')
open(P, 'w', newline='').write(src)
print('[ok] %d edits applied to %s (%d script blocks parse)' % (len(edits), P, checked))
for e in edits: print('     - ' + e)
