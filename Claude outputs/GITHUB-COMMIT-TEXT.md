# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12s

Two files, already in your repo.

---

## Summary (the one-line box)

```
Master Calendar: Floor cover and Rooms week views (12s)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12s — two more week views on the Master Guru Calendar.

The rail answers "what is Chad doing". The time grid answers "what is
happening at 7pm". Neither answers the two questions the shop actually runs
on: "is the floor covered on Thursday" and "is the Depths free on Saturday".
Both were answerable only by reading the whole week and holding it in your
head.

FLOOR COVER  (tab: 🏪 Floor cover)
One bar per day, each scaled to that day's OWN opening hours, so a 12–8
Tuesday and a 10–10 Saturday are directly comparable.
  * green segments name who is on
  * red hatched segments are open hours with nobody rostered — CLICK ONE and
    the shift editor opens prefilled with exactly that hole, so the fix is one
    click and a name
  * closed days read "Closed", not "0% covered"
  * a "Covered" column per day: 100% covered, or 63% with 3h open
  * the existing shifts sit under each bar as editable chips, plus "+ add shift"
Below it, hours on the floor per Guru for the week as a bar chart. A rota
nobody totals is a rota that quietly lands on the same two people.

ROOMS  (tab: 🚪 Rooms)
Every room down the side — including the Lodge and the Adventurer's Rest,
which the server conflict engine still cannot see — every day across the top,
plus an Off-site row. Each cell shows what is in that room with its times,
coloured by kind and hatched while a booking is only pending. An empty cell
reads "free", because an empty room is a room you can sell rather than a blank.
Clicking any chip opens the same detail and Guru assignment as elsewhere.
The kind and Guru filter chips apply here too.

TWO NUMBERS MADE HONEST
  * A room's weekly total excluded nothing, so a 24-hour "Deep clean" blackout
    made the Holt read "31h booked". A closure is not revenue. Blackouts are
    out of the total, and an all-day item counts the hours the shop is actually
    open that day rather than 24 — that total is exactly the number you would
    use to judge whether a room earns its floor space, so it has to be right.
    A room held but not booked now says "held, not booked".
  * Off-site is counted as occasions ("3 this week"), not room-hours. It
    occupies no room.
  * A closed day read "Closed · Closed", because the weekly template's own
    label for a closed day is the word "Closed".

TESTS
  node --test tests/*.test.mjs        431 pass
  node tests/guru-master.e2e.mjs      103 browser checks
  21 new checks, including that clicking a red gap opens a shift prefilled
  with that gap's own times, that a closure is not counted as booked hours,
  and that the filters reach the new views.
```

---

## Files

| File | Change |
|---|---|
| `site/guru-master.html` | Floor cover and Rooms week views; two totals corrected |
| `tests/guru-master.e2e.mjs` | 21 new browser checks |

## Where to look first

**🏪 Floor cover** on the current week. Your Tuesday and Sunday bars will be
solid red — those are the hours the shop is open with nobody written down.
Click a red stretch, pick a name, done.
