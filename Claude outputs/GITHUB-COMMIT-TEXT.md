# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12u

Four files, already in your repo.

---

## Summary (the one-line box)

```
Distinct kind colours; tidy now finds recurring duplicates (12u)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12u

1. THREE OF THE SEVEN KINDS WERE THE SAME DARK GREEN
   In the Who's on rail an NGH event bar and a store-shift bar sit directly on
   top of each other in the same cell. Measured in RGB distance they were 51
   apart. An event against an off-site booking was 43 — worse, and not even
   the one that got reported.

     was   event #2e5d3b · shift #5b6f4a · off-site #134b57
     now   event #2e5d3b · shift #5f3391 · off-site #1f7a99

   Shifts are violet, matching the purple the Guru Schedule has always drawn
   store bands in. Off-site is a proper teal. Every solid pair is now at least
   91 apart. Closures also gained a hatch, because the two greys (Unavailable,
   Closures) carry meaning by pattern and no two greys can be far apart by hue.

   tests/guru-master.e2e.mjs now reads the RENDERED colours out of the browser
   and fails if any two solid kinds come within 85 of each other, naming the
   offending pair. Putting the old palette back fails it with
   "closest pair NGH events / Off-site = 43".

2. "TIDY DUPLICATE SHIFTS" COULD NOT SEE THE DUPLICATE IT WAS ASKED ABOUT
   Reported: two "Chad 4PM-10PM" chips on the same Friday, and the button
   answering "Nothing to merge — no overlapping shifts."

   The first line of the merge loop was:

       if (!r.data || r.data.recurrence) continue;

   Every recurring shift was skipped outright. The doubled Friday repeated
   across weeks, which is the tell: one of the pair was a weekly series, so
   the pass that was supposed to find it never looked at it.

   Rewritten as three passes, in order of confidence:
     1. EXACT duplicates — same Guru, day, times AND repeat pattern. Safe to
        collapse whether or not it recurs.
     2. A one-off that a series already covers on that date — including on a
        LATER occurrence, not just the anchor date, which is where the shop's
        actual duplicate was.
     3. Overlapping one-offs, merged to their union (as before).
   A one-off that only PARTLY overlaps a series is reported, never rewritten:
   widening a weekly pattern to swallow one long evening would change every
   other week too. The button now says so instead of silently doing nothing.

3. AND IT STOPS HAPPENING AT THE SOURCE
   save-shift now refuses to create a one-off that a recurring shift already
   covers, and hands back the series instead. That is how the doubled Fridays
   appeared in the first place — rostering a floor gap by hand on a day a
   weekly shift already spoke for.

4. The tidy button rendered as "\\u29c9 Tidy duplicate shifts" — a raw escape
   written into the HTML instead of the character. There is now a check that
   no raw \\uXXXX escape appears in that panel's text.

TESTS
  node --test tests/*.test.mjs        471 pass  (was 462)
  node tests/guru-master.e2e.mjs      115 browser checks
  9 new API tests and 6 new browser checks. Mutations: restoring the
  skip-recurring line, removing the series-covers-one-off pass, and removing
  the save-shift guard each turn tests red.
```

---

## Files

| File | Change |
|---|---|
| `site/guru-master.html` | New kind palette; hatched closures; tidy reports all outcomes; escape fixed |
| `netlify/functions/gurus.mjs` | merge-shifts handles recurring; save-shift won't duplicate a series |
| `tests/schedule-api.test.mjs` | 9 new tests |
| `tests/guru-master.e2e.mjs` | 6 new browser checks incl. the measured palette |

## After it deploys

Hit **⧉ Tidy duplicate shifts** again — it should actually find Chad's Friday
this time. Chad's 40h will drop by whatever the duplicate was worth.
