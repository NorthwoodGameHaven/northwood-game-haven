# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12n + 2026-09-12p

Both builds go in **one commit** so the 12n work can't get buried.

---

## Summary (the one-line box)

```
Stop auto-canceling bookings; deposit can never cancel anyone (12n+12p)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12n + 2026-09-12p — bundled.

WHY
Robyn's Depths booking was canceled even though she paid. She owed only the
refundable deposit, which is payable on the day. Re-approving it did not stick:
the next console refresh canceled it again and emailed her another notice.

Two separate cancellers were doing this, plus a third copy that shadowed a fix.

1. THE BROWSER NO LONGER CANCELS ANYBODY (site/booking.html)
   autoCancelUnpaid() ran in a Guru's browser tab on EVERY console load. It
   canceled approved bookings and emailed the guest directly from the browser.
   Before 09-10c it required BOTH the fee and the deposit to be settled, which
   is exactly how Robyn was canceled.
   It is deleted. The function returns false and carries a comment saying why it
   must not come back. Opening the console is not a decision to cancel a
   customer. Unpaid bookings are still surfaced as "Fee: Due" / "Deposit: Due"
   badges on the card - surfacing is the page's job, deciding is the Guru's.
   The autoCancelExempt flag is gone too; there is nothing left to be exempt
   from, and approve() now writes exactly {status:"approved"}.

2. THE NIGHTLY SWEEP HAD ITS RULES REWRITTEN (netlify/functions/auto-cancel.mjs)
   * THE DEPOSIT NEVER CANCELS ANYBODY, EVER. It is payable on the day and it is
     refundable. It now appears in that file only as something that can SPARE a
     booking. Only the booking fee is ever a reason.
   * NOTHING IS CANCELED UNTIL THE BOOKING IS OVER - after start + hours, in
     America/Chicago. Not the night before, and not the start time: this cron
     runs @daily = midnight UTC = 7 PM Central, so canceling at the start time
     would release a 6 PM room with the guests still sitting in it.
   * Guests are emailed only within 48h of the booking ending. Older no-shows
     are closed out quietly and listed in the ops digest - nobody needs a
     cancellation notice for a party three weeks ago.
   * The guest email no longer blames "the deposit hold", names the booking fee
     as the reason, and invites a reply if it was wrong.
   * Kill switch: set AUTO_CANCEL_ENABLED=0 in Netlify and trigger a deploy to
     make the sweep report-only. It is read at module load, so the redeploy is
     required.
   * Timezone is derived from the runtime tz database, so CST/CDT is handled
     without a code edit.

3. A THIRD COPY WAS SHADOWING THE FIX (netlify/functions/_shared/auto-cancel.mjs)
   This was a full duplicate of the scheduled function. Netlify only schedules
   functions in netlify/functions/, not in _shared/, so it never ran - but it
   DID receive the 09-10c "don't cancel partially-paid bookings" fix that the
   live function never got. For a day the fix looked deployed while bookings
   kept being canceled. Replaced with a tombstone that throws if imported. Safe
   to `git rm` whenever.

ALSO IN THIS COMMIT (2026-09-12n, previously unpushed)
   The Rejected tab rendered nothing while the tab header said "Rejected (20)".
   renderAdmin built the list as `el.innerHTML = list.map(reqCardHtml).join("")`,
   so one booking that throws took the exception out of the function BEFORE
   innerHTML was assigned - leaving the previous tab's empty state on screen.
   Cards now render one at a time; a bad record costs you that one card, shown
   with its id, name, date and the actual error, and the id goes to the console.

TESTS
   314 pass, one command: node --test tests/*.test.mjs
   - tests/auto-cancel.test.mjs (new, 26): the two promises above, run end to
     end against an in-memory database with the clock pinned.
   - tests/booking-admin-render.test.mjs (29): every combination of date,
     payment state and flag now asserts the browser writes nothing and sends
     nothing. Source-level assertions prove the function cannot reach
     updateBooking or sendEmail, and that nothing on the page calls it.
   11 mutations checked - each fix reverted individually, each turned a test red.

NO ACTION NEEDED IN NETLIFY. AUTO_CANCEL_ENABLED is only for turning cancelling
off entirely; leaving it unset gives the new rules above.
```

---

## Files in this commit

| File | Change |
|---|---|
| `site/booking.html` | Rejected-tab render fix (12n) + browser auto-cancel deleted (12p) |
| `netlify/functions/auto-cancel.mjs` | Deposit can never cancel; nothing cancels until the booking is over |
| `netlify/functions/_shared/auto-cancel.mjs` | Tombstone — was a duplicate that shadowed a fix |
| `netlify.toml` | Comment on the cron block describing the new rules |
| `tests/auto-cancel.test.mjs` | **New** — 26 tests |
| `tests/booking-admin-render.test.mjs` | 29 tests, rewritten around "never cancels" |
| `patches/patch-kill-client-autocancel-2026-09-12p.py` | Record of the surgical edit |
| `docs/START-HERE-2026-09-12.md` | Morning brief corrected — the old text described the wrong fix |

## After pushing

Netlify deploys on its own. To check it worked:

1. Open the Guru console. It must **not** flip anything to rejected on load.
2. Re-approve Robyn's Depths booking. Refresh. It stays approved.
3. Tomorrow morning's ops digest is the only place unpaid bookings get raised.
