# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12t

Eight files, already in your repo. **This one fixes every delete endpoint in
the app**, not just shifts.

---

## Summary (the one-line box)

```
Fix 204 responses (every delete in the app was broken); stop duplicate shifts (12t)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12t

1. EVERY DELETE ENDPOINT IN THE CODEBASE WAS BROKEN
   Reported as "Couldn't delete: Server error: Response constructor: Invalid
   response status code 204" when deleting a duplicate store shift. It is not
   a shift problem. netlify/functions/_shared/db.mjs had:

       export function noContent() { return new Response('', { status: 204 }) }
       export function preflight() { return new Response('', { status: 204 }) }

   204, 205 and 304 are "null body status" codes in the fetch spec, and the
   Response constructor throws a TypeError if handed ANY body — an empty
   string counts. So both of those threw on every single call.

   noContent() is used by bookings, events, gurus, interest-events, karaoke,
   mtg, registrations, specials and speedgaming. preflight() is used by 20
   functions. Meaning: nothing in the app could be deleted, and every CORS
   preflight failed.

   It hid because each function's top-level catch turns the throw into a
   generic "Server error", and because same-origin fetches never preflight.

   Fix: new Response(null, ...) in both.

2. WHY NO TEST CAUGHT IT — AND WHAT NOW DOES
   tests/_mock-hooks.mjs replaces db.mjs wholesale with an in-memory copy that
   carried a byte-identical copy of the bug. The real db.mjs was executed by
   nothing, ever. Reverting the fix turned zero tests red.

   A mock that shadows the module it stands in for cannot protect it. So:
     * tests/_neon-stub.mjs stubs ONLY the '@netlify/neon' driver, letting the
       REAL db.mjs load
     * tests/db-responses.test.mjs (15 tests) exercises it — the null-body
       statuses, json()/bad(), and the admin token issue/verify/tamper paths
   Re-introducing either 204 bug now fails two tests.

3. THE AUDIT WAS CREATING DUPLICATE SHIFTS
   Clicking "Roster Chad on the floor" twice — or coming back to a gap the
   list had not caught up with — posted a second identical shift. Result: Chad
   on the floor 4PM-10PM twice on Friday, 10AM-10PM twice on Saturday, and a
   week tally reading 52 hours.

   Fixed at the server, not just the button, because any caller can post
   twice. save-shift now absorbs a CREATE that overlaps or abuts an existing
   shift for the same Guru on the same day into that shift, to a FIXPOINT —
   10-14 plus 13-18 plus a new 17-22 is one continuous stretch, and a
   single-pass merge would have left two overlapping shifts behind. It keeps
   the oldest record (ordered by created_at, so the survivor is deterministic)
   and widens it to the union.

   Deliberately NOT merged: an edit (anything carrying an id — that is
   somebody changing a record on purpose, and widening it would silently undo
   them), a recurring shift (it spans dates this check knows nothing about),
   a different Guru, a different day, and a genuinely separate shift later the
   same day.

   Client side: clicking a fix in Review & fix now greys out and disables that
   whole row immediately. The busy flag guarded the network call but left the
   buttons live and inviting.

4. TIDYING THE ONES ALREADY IN THERE
   New "⧉ Tidy duplicate shifts" button under the Floor cover tally, and a
   merge-shifts action behind it: same rule, applied to what is already in the
   table. It reports how many it merged, and leaves a clean rota untouched.

TESTS
  node --test tests/*.test.mjs        462 pass  (was 431)
  node tests/guru-master.e2e.mjs      110 browser checks
  31 new tests. Notable ones: that the platform really does reject a body on a
  204 (so the guard keeps meaning something), that deleting a shift returns
  204 rather than a server error, that a double-click cannot post two shifts,
  and that three overlapping shifts collapse to one.
  Mutations: both 204 bugs and both halves of the merge each turn tests red.
```

---

## Files

| File | Change |
|---|---|
| `netlify/functions/_shared/db.mjs` | **The fix** — null body on 204 |
| `netlify/functions/gurus.mjs` | Overlapping shifts merge; new `merge-shifts` action |
| `site/guru-master.html` | Row locks on click; "Tidy duplicate shifts" button |
| `tests/_neon-stub.mjs` | **New** — lets the real db.mjs be tested |
| `tests/db-responses.test.mjs` | **New** — 15 tests against the real db.mjs |
| `tests/_mock-hooks.mjs` | Mock now mirrors the fixed helper |
| `tests/schedule-api.test.mjs` | 16 new tests |
| `tests/guru-master.e2e.mjs` | 6 new browser checks |

## After it deploys

1. **Floor cover** → **⧉ Tidy duplicate shifts**. That collapses Chad's
   doubled Friday and Saturday in one go. Chad's 52h should drop to something
   believable.
2. Delete works everywhere now — worth knowing, since it never has.
