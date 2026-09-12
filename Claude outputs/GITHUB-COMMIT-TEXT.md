# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12r

Six files, already written into your repo.

---

## Summary (the one-line box)

```
Review & fix queue, shift editing from the calendar, quieter floor alerts (12r)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12r — acting on the calendar instead of only reading it.

1. "NOBODY ON THE FLOOR" WAS CRYING WOLF
   Five identical banners fired for Mon/Tue/Wed/Thu evenings — nights when
   Chad was in the shop running Gundam and Pokémon Free Play and Dustin was
   running Trick-Taking Tuesday. The shop was not empty; the shift was just
   never written down. Conflating "unrostered" with "empty" buries the one
   alert that actually mattered (Dustin double-booked) in four that didn't.

   A coverage gap now carries who is on site during it:
     before  "Store open 5:00 PM–8:00 PM with no Guru on the floor"
     after   "Store open 5:00 PM–8:00 PM with no Guru rostered on the floor —
              Mike and Dustin are on site (Rausch party, Team Trivia)"
   Genuinely empty hours still read "with nobody in the building". Somebody
   off-site does not count as being in the building.

2. THE ALERTS COLLAPSE TO ONE LINE
   Six stacked banners pushed the calendar below the fold. Now:
     🛈 4 things to look at   1 unstaffed · 3 floor gaps      [Review & fix]
   Red when something hard is wrong (double-booked, assigned while off, room
   clash), amber otherwise.

3. REVIEW & FIX — every row carries the fix that clears it
   A list of problems you cannot act on is a nag. Each row does the work:
     * floor gap        -> "Roster Mike on the floor" as ONE CLICK when Mike
                           is already on site, or pick anyone and "Add shift
                           5:00 PM–8:00 PM". Writes a real store shift; there
                           is no separate "cover" concept, because two answers
                           to "who is working" is worse than none.
     * unstaffed booking-> Guru picker -> assigns them to the booking
     * double-booked    -> "Take Dustin off Crokinole" / "off Trick-Taking
                           Tuesday", whichever you meant
     * assigned while off-> take them off, or a link to clear the time off
     * room clash       -> not auto-fixable; links to the booking calendar
   Each fix saves, re-reads from the server and reopens the queue, so it
   empties as you work down it.

   Dropping a Guru off ONE night of a recurring event pins the change to that
   date rather than silently restaffing every future occurrence.

4. STORE SHIFTS ARE EDITED WHERE YOU SEE THEM
   Who is on the floor was only editable on a separate form on another page —
   so you would spot a hole on the calendar and then have to leave the
   calendar to fix it.
     Master Calendar: click a 🏪 bar in the rail to edit its Guru, times or
     delete it. An empty cell shows "+" to put that person on the floor that
     day, defaulted to the day's opening hours. New shifts can repeat weekly
     or fortnightly.
     Guru Schedule: click a store-shift band to open that shift in the Shifts
     form; click "store: no shift set — add" in a day header to add one with
     the date prefilled. It ROUTES to the existing form rather than growing a
     second editor that could drift from it.

TESTS
  node --test tests/*.test.mjs        431 pass
  node tests/guru-master.e2e.mjs      82 browser checks
  6 new core tests for the in-building logic; 20 new browser checks covering
  the Resolve queue and shift editing end to end (a rostering click is
  asserted to write a real save-shift with the gap's own times).
  3 mutations checked — off-site people counted as present, events outside
  the gap counted, and the gap losing the times a fix needs all turn a test
  red.
```

---

## Files

| File | Change |
|---|---|
| `netlify/functions/_shared/schedule-core.mjs` | Coverage gaps carry who is on site |
| `site/guru-master.html` | Alert bar, Review & fix modal, shift editing from the rail |
| `site/guru-schedule.html` | Shift bands and empty day headers route into the shift form |
| `tests/schedule-core.test.mjs` | 6 new tests |
| `tests/guru-master.e2e.mjs` | 20 new browser checks |
| `patches/patch-guru-schedule-shift-edit-2026-09-12r.py` | Record of the surgical edits |

## Worth doing once it's live

Open **Review & fix** and clear the four items from your screenshot. The three
Mon–Thu floor gaps are almost certainly just missing shifts for people who
were already there — one click each.
