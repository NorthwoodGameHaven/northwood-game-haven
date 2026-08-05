#!/usr/bin/env python3
# NGH-BUILD 2026-08-05b
#  booking.html — enlarge the admin "Public description" textarea (ev-notes)
#  so there's real room to compose multi-paragraph event copy.
#  Safe to run whether or not 2026-08-05a (Web Promotions removal) has been
#  applied yet — this patch only touches the ev-notes textarea and is
#  independent of that change.
#
# Run from repo root AFTER: git pull origin main --no-rebase
#   python3 ngh-patch-2026-08-05b.py
import os

MARK = "NGH-BUILD 2026-08-05b"

def load(p):
    with open(p, "rb") as f:
        raw = f.read()
    crlf = b"\r\n" in raw
    return raw.decode("utf-8").replace("\r\n", "\n"), crlf

def save(p, src, crlf):
    if crlf:
        src = src.replace("\n", "\r\n")
    with open(p, "wb") as f:
        f.write(src.encode("utf-8"))

def sub(src, old, new, label):
    n = src.count(old)
    assert n == 1, f"ABORT [{label}]: anchor found {n}x (expected 1)"
    return src.replace(old, new)

def mark_end(src, comment):
    i = src.rfind("</body>")
    assert i != -1, "ABORT: </body> not found"
    return src[:i] + comment + "\n" + src[i:]

p = "site/booking.html" if os.path.exists("site/booking.html") else "booking.html"
src, crlf = load(p)
if MARK in src:
    print(f"skip {p} (already patched)")
else:
    src = sub(src,
        '<label class="fld">Public description</label><textarea id="ev-notes" placeholder="What is this event? Who is it for? Format, theme, etc.">',
        '<label class="fld">Public description</label><textarea id="ev-notes" style="min-height:220px;" placeholder="What is this event? Who is it for? Format, theme, etc. Use blank lines for paragraph breaks \u2014 they now display exactly as typed.">',
        "ev-notes textarea height")
    src = mark_end(src, f"<!-- {MARK} \u00b7 taller Public Description textarea (min-height:220px) -->")
    save(p, src, crlf)
    print(f"patched {p}")

print("done")
