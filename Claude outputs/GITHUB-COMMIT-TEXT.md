# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12v

Four files, already in your repo.

---

## Summary (the one-line box)

```
Staff off-site events; edit events from the calendar; blocks sized by duration (12v)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12v

1. OFF-SITE COMMITMENTS NOW NEED A GURU
   Eau Claire Comic Con, committed, vendor booth + attending as NGH, nobody
   rostered. Nothing anywhere said so. New conflict "external-unstaffed":
   raised for any COMMITTED Radar event whose support types include Vendor
   booth, Host an event there, or Attend as NGH.

   Donation / prize support, Sponsor and Cross-promote are deliberately NOT
   flagged — those cost nobody a Saturday.

   The fix sits in Review & fix: pick a name, "Send them". Assignments already
   supported externalId as of 12q, so a Guru sent to a con shows in their rail
   lane, their ICS feed and the week's hours like anything else.

2. YOU CANNOT BE IN TWO PLACES
   New conflict "offsite-vs-shift": a Guru rostered on the shop floor who is
   also committed off-site at the same time. This is ranked ABOVE every other
   conflict, because it is not a preference — it cannot happen.

   Running the till during an in-house event stays explicitly allowed and is
   still never flagged. The difference is the building.

3. EDIT EVENTS FROM THE CALENDAR
   The item pop-up now edits the thing itself, not just who staffs it:
     * NGH events — start, end, all-day, and rooms as chips (none = whole
       venue). Writes the full record back to PUT /events/:id.
     * Radar events — start, end, all-day and location. PUT /interest-events/:id.
   Both endpoints are full-replace PUTs, so the raw record is fetched on demand
   and every untouched field is preserved.

   /events refuses a change that would double-book a room and separately warns
   about pending-booking overlaps and tight changeovers. Those are the booking
   console's rules and this page does not quietly bypass them: a hard room
   overlap is refused outright, and the two soft ones are surfaced and only
   retried with the override you actually agreed to.

   A repeating event says so before you save — the change hits every occurrence.

4. THE GRID IS A CALENDAR NOW
   A 10AM-5PM comic con and a 5PM-9PM game night were drawn exactly the same
   height, because every item was dropped whole into its start-hour cell. That
   is a list wearing a grid's clothes, and it is why the Comic Con box looked
   wrong.

   Blocks are now absolutely positioned and sized by real duration, in lanes so
   two things at the same time sit side by side instead of on top of each
   other. The hour rows stay as a background layer, so the closed shading and
   the uncovered-floor pink still line up with the clock. All-day items and
   overnight carry-over keep their own bands above the grid.

5. THE ALERT IS HARD TO MISS
   A 38px circular sign — maroon and gently pulsing when something hard is
   wrong, gold otherwise — instead of an emoji inside a sentence. Respects
   prefers-reduced-motion.

TESTS
  node --test tests/*.test.mjs        480 pass  (was 471)
  node tests/guru-master.e2e.mjs      134 browser checks
  9 new core tests, 19 new browser checks. The browser ones measure rendered
  geometry: a 4-hour event must be drawn taller than a 2-hour one, a 6-hour
  booking taller again, nothing may collapse below 26px, and no two blocks may
  overlap in the same column.
  Mutations: flagging donation-only commitments, letting on-site events clash
  with shifts, and counting somebody else's shift as your clash each turn a
  test red.
```

---

## Files

| File | Change |
|---|---|
| `netlify/functions/_shared/schedule-core.mjs` | Two new conflicts; `needsPresence` on Radar items |
| `site/guru-master.html` | Duration-sized grid; event/Radar editing; new fixes; bigger alert |
| `tests/schedule-core.test.mjs` | 9 new tests |
| `tests/guru-master.e2e.mjs` | 19 new browser checks |

## After it deploys

**Review & fix** should now show Eau Claire Comic Con as unstaffed. Send
somebody — and if that person is also on the floor that day, the next thing
you'll see is the "can't be in two places" flag at the top of the list.
