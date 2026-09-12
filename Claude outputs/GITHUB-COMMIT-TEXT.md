# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12q

All 15 files are already written into your repo. Commit and push.

---

## Summary (the one-line box)

```
Master Guru Calendar; every Guru calendar now shows pending bookings (12q)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12q — Master Guru Calendar, and bookings on every internal
Guru calendar.

THE BUG UNDERNEATH ALL OF THIS
guru-schedule.html — the page the shop plans the week from — has never loaded
/bookings. reload() fetched /events and /gurus and nothing else. So every
private room booking, approved or pending, was invisible on it. A Guru could
look at Wednesday, see an empty Depths, and promise the room to somebody else.

Three other things turned out to be missing rather than broken:
  * NOTHING RECORDED WHICH GURU SUPPORTS A BOOKING. The Guru add-on stored a
    quantity (addons[].qty) and that was the entire trace. guru_data
    assignments had an eventId and no bookingId. Birthday parties had no guru
    field at all.
  * THERE WAS NO DEFINITION OF STORE HOURS anywhere in the codebase. Shifts
    have an open and close time but nothing to check them against, so an
    uncovered Thursday afternoon and a Thursday you are shut looked identical.
  * OFF-SITE COMMITMENTS were recorded (event.offsite, and the Radar's
    interest_events) but no calendar drew them next to on-site work, so a card
    show that tied up two Gurus appeared on nothing.

NEW: MASTER GURU CALENDAR  (site/guru-master.html, /master)
Weekly view: a per-Guru coverage rail over a 7-day time grid. Daily view: room
lanes and Guru lanes. Both integrate events, bookings (approved AND pending),
birthday requests, blackouts, retail shifts, unavailability and committed
off-site events. Shaded columns are hours the store is closed; pink is open
with nobody on the floor. Click anything to see detail and assign Gurus.
Includes a store-hours editor (weekly template + dated exceptions).

NEW: /api/schedule  (netlify/functions/schedule.mjs + _shared/schedule-core.mjs)
One admin GET returns the whole merged, normalized week — per-day Guru lanes,
room lanes, coverage gaps and conflicts. The merge is server-side ON PURPOSE:
the guru-* pages are plain ES5 with no module loader, and every previous
attempt to share scheduling logic with them ended in a copy-paste. The repo
already carried FIVE divergent reimplementations of recurrence expansion,
which is exactly how these calendars drifted into disagreeing. schedule-core
reuses expandOccurrences from conflicts.mjs rather than adding a sixth.

Conflicts it surfaces: a Guru in two places at once; a Guru assigned while
marked unavailable; two things in one room; a booking that bought Gurus and
hasn't been given any; the store open with nobody on the floor.

CHANGED: /gurus
  * Assignments accept bookingId, birthdayId and externalId alongside eventId
    (exactly one required). The server-side "unavailable Guru" hard block now
    covers all four — it only ever applied to events, because nothing else
    could be assigned.
  * New save-hours action: the store-hours template. Validated — a closing
    time before its opening time is refused, because an inverted window reads
    as permanently uncovered.
  * ICS feed: booking, party and off-site assignments now reach a Guru's
    Google Calendar. And it stopped hardcoding 115 W Spring St on offsite
    entries, which was sending subscribers to the wrong town.

CHANGED: guru-schedule.html
Loads /bookings. Approved and pending both draw, in maroon with a doubled left
edge and a hatch while still a request — deliberately unlike an event. A Guru
filter chip never hides an unstaffed booking; the room is occupied either way,
and hiding it is how a double-booking gets promised. A booking that bought
Gurus reads "NEEDS 2 GURUS" until somebody is assigned.

CHANGED: guru-tonight.html
A "Room bookings" section for today and the next 7 days. Kept as its own
section rather than threaded through the event card renderers — an event and a
booking are different objects, and forcing one through the other's renderer
means faking fields it does not have, forever.

CHANGED: booking.html
Room bookings in the admin calendar carry a key icon, so the kind is readable
without relying on colour alone now that the same booking appears on four
calendars with different palettes. Existing colours unchanged.

CHANGED: tests/check-scripts.mjs
Skips non-JS <script> blocks. booking.html carries a application/ld+json block
of structured data, so this checker reported a failure on EVERY run against
that file — a validator that always fails is one everyone learns to ignore.

TESTS
  node --test tests/*.test.mjs        426 pass
  node tests/guru-master.e2e.mjs      51 browser checks, 4 screenshots
  * tests/schedule-core.test.mjs (80) — the merge engine
  * tests/schedule-api.test.mjs (32) — /api/schedule and the new /gurus actions
    against an in-memory database
  * tests/guru-master.e2e.mjs — drives the real page in Chromium, including
    that a pending booking is actually ON SCREEN and that a booking does not
    look like an event (computed styles compared, not just class names)
  13 mutations checked. Two of them exposed real gaps: one mutation left every
  conflict test green because each had the unavailable Guru assigned to the
  item being checked, so nothing proved that one person's day off doesn't flag
  someone else's work. Test added.

NO NETLIFY CONFIGURATION NEEDED. Store hours start unset, and while unset the
calendar deliberately raises no coverage warnings at all rather than
pretending every day is a nine-to-five.
```

---

## Files in this commit

| File | Change |
|---|---|
| `site/guru-master.html` | **New** — the Master Guru Calendar |
| `netlify/functions/schedule.mjs` | **New** — `/api/schedule` aggregator |
| `netlify/functions/_shared/schedule-core.mjs` | **New** — the merge engine (pure, testable) |
| `netlify/functions/gurus.mjs` | Booking/party/off-site assignments, store hours, ICS fixes |
| `site/guru-schedule.html` | Loads bookings at last; distinct formatting |
| `site/guru-tonight.html` | Room-bookings section |
| `site/guru-common.js` | Nav link + staff-page whitelist |
| `site/booking.html` | Key icon on calendar bookings |
| `netlify.toml` | `/api/schedule` + `/master` redirects |
| `tests/schedule-core.test.mjs` | **New** — 80 tests |
| `tests/schedule-api.test.mjs` | **New** — 32 tests |
| `tests/guru-master.e2e.mjs` | **New** — 51 browser checks |
| `tests/check-scripts.mjs` | Stops crying wolf on JSON-LD |
| `patches/patch-guru-schedule-bookings-2026-09-12q.py` | Record of the surgical edits |
| `patches/patch-guru-tonight-bookings-2026-09-12q.py` | Record of the surgical edits |

## First five minutes after it deploys

1. Open **🗓️ Master Cal** in the Guru nav (or `gamehaven.guru/master`).
2. Go to **Store hours** and fill in the week. Nothing else works off it until
   you do, and until then the coverage warnings stay silent by design.
3. Back on **Week** — check the "Who's on" rail against what you know is true
   for this week. That rail is the thing that has never existed before.
4. Click a booking → assign a Guru. That's the data that never had a home.
5. Open **🦦 Schedule** and confirm bookings now appear there too, in maroon.

## Known gaps, deliberately left

- **Recurring unavailability can't be expressed.** Shifts recur; unavailability
  is a date span only. "Every Tuesday off" needs a data-model change.
- **A blank cell in the rail means "nothing scheduled", not "available."**
  The page says so out loud rather than implying otherwise.
- **`lodge` and `rest` are still invisible to the server conflict engine**
  (`conflicts.mjs` ROOM_IDS has three rooms; the front end knows five). The
  master calendar shows all five, but a VRBO-space double-booking still won't
  be caught at request time. Worth fixing separately — it changes what the
  booking form will accept.
