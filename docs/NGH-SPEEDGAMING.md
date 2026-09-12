# Speed Gaming Meet-up — how it works and how to run it
*NGH-BUILD 2026-09-12l · event `EVT-PITPB5-103` · first run 2026-09-17*

Players arrive alone or in pairs, get matched into 2v2 teams, and **swap partners every round** so they meet as many people as possible. Three rounds: 10 min teach, 40 min play, 10 min break. Prizes each round.

Unlike Magic (where EventLink owns pairings), this is ours end to end — we do the matchmaking.

---

## 1. Running the night

**Before doors:** open **`gamehaven.guru/speedgaming-guru`** on a tablet, sign in with the Guru code, tap **Start a new meet-up**. Point a TV at **`gamehaven.guru/speedgaming-tv`** — it finds the live meet-up on its own.

**As people arrive:** they scan the QR on the TV (or go to `gamehaven.guru/speedgaming`) and type their name. If they came with someone, they say so, and the engine puts them on **opposite** teams. Anyone without a phone: **Add** them on the tablet.

**Each round:**

1. **↻ Pair round N** — builds a seating. The room can't see it yet.
2. Look it over. **🎲 Reshuffle** for a different draw, or tap two names to swap them.
3. **✅ Publish** — now the TV and every phone show it.
4. **▶︎ Start the clock** — every screen counts down together.
5. Tap the winning team on each table as games finish.
6. Tables done early? **End round early** (under *More*) → straight to pairing the next round.

**At the end:** **🏁 Finish the night** locks the standings.

The console only ever shows **one** big gold button: the next thing to do.

---

## 2. What the pairing engine guarantees

Ranked, because they conflict:

1. **Never partner the same two people twice.** Hard rule.
2. **Avoid facing anyone you've already faced.**
3. **Split up people who arrived together.**
4. **Byes go to whoever has sat out least.**

Measured over 576 simulated 3-round nights (4–60 players, with and without couples):

| | Result |
|---|---|
| Repeated partnerships | **0** out of 15,336 teams formed |
| 15+ players | **zero** repeats of anything — even when the whole room arrived in pairs |
| 4–9 players | A few repeats, **forced by the maths** — four people can't avoid each other for three rounds |
| Bye spread | Never worse than 1 |
| Players lost or double-seated | **0**, at every headcount from 0 to 60 |
| Speed | 48 players re-pairs in ~15 ms |

The engine finds the **provably optimal** seating: `tests/speedgaming.test.mjs` brute-forces every legal seating for a set of scenarios and requires the engine to match it exactly.

**It will sometimes do something that looks wrong and isn't.** With four people who've already played each other, it will partner two past opponents rather than sit them across the table again — being on the same side is a new interaction, facing them again isn't. It also won't always pair you with the one stranger in the room, if taking that stranger as your *partner* would force you to face two old faces instead of one. It optimises the whole room, not one person.

### Two design decisions worth knowing

**Pairing is a draft until published.** Once published the seating is *frozen in the database* — never recomputed. A phone refresh or a server cold start can never re-shuffle a room that has already sat down.

**Partner history is derived, never stored.** It's recomputed from the published rounds on every read. A stored running tally would drift the moment you pull a round back, and a drifted history silently re-pairs people who already played together — the exact thing the engine exists to prevent.

That's why **Pull back round N** is safe: it genuinely un-does that round, and the next draw is computed as if it never happened.

---

## 3. Odd situations

| Situation | What happens |
|---|---|
| Not a multiple of 4 | 1–3 people sit out; the engine picks whoever has sat out least, and their phone says "first back in next round" |
| Fewer than 4 checked in | Pairing is refused with a clear message |
| Someone arrives mid-round | Checked in immediately, seated in the next round; their phone says so |
| Someone leaves | Mark them **Out** — they keep their results and standings, and drop out of future pairings |
| Same phone re-joins | Same person, not a duplicate. Updates their name |
| Two Gurus tap at once | Optimistic concurrency retries; neither change is lost |
| A TV loses wifi | Backs off and reconnects; if the session ends it goes looking for the next one |
| Partner pool runs dry (small room, many rounds) | Repeats a partnership rather than benching anyone, and **says so** in the round warnings |

---

## 4. Where the code lives

| File | What it is |
|---|---|
| `netlify/functions/_shared/speedgaming-core.mjs` | Pure pairing engine + round clock. No db, no network, deterministic per seed |
| `netlify/functions/speedgaming.mjs` | Sessions, check-in, draft/publish, clock, results |
| `site/app/speedgaming/index.html` | Player phone view — served at `/speedgaming` and in the app |
| `site/speedgaming-tv.html` | The big screen |
| `site/speedgaming-guru.html` | Run-the-night console |
| `tests/speedgaming.test.mjs` | 66 engine tests incl. brute-force optimality |
| `tests/speedgaming-api.test.mjs` | 38 end-to-end session tests on a real in-memory table |

Run the tests: `node --test tests/*.test.mjs`
(Not via `tests/index.js` — suites that install module hooks must not share a process.)

Same realtime model as trivia / karaoke / tv: no WebSockets on Netlify Functions, so clients poll with the last version they saw and get `{unchanged:true}` until something moves. The clock is scheduled in **server epoch ms**, so the TV, the tablet and every phone count down together and a dropped poll never stalls the countdown.

---

## 5. Verified how

- **103 unit tests** on the engine, **14 mutations** applied to confirm the tests actually catch a broken rule.
- **38 end-to-end tests** against the real handler on a real in-memory table — optimistic concurrency, draft/publish, derived history all exercised, not stubbed.
- **26 browser checks** driving the three real screens in Chromium: five phones checking in with separate browser contexts, the Guru pairing and publishing, clocks agreeing across phone/TV/console, results propagating, round 2 differing from round 1.

Five bugs the tests caught before anyone saw them: byes taken from the wrong end of the sorted list (one person sat out all three rounds), the couples rule reading a field off a string so it never fired, players silently vanishing when the partner pool ran dry, a crash on a history missing a field, and greedy-twice pairing producing repeat match-ups.

One real UX gap the browser run caught: ending a round early left the console offering "Start the clock" again, with no way to move to round 2. Tables finishing before the timer is the *normal* case, so **End round early** now closes the round and offers the next pairing.

---

## 6. Not built, on purpose

- **No scoring or voting from the phone.** The Guru enters results at the table. Informative-only was the call, and it means the phone is never something anyone has to fight with mid-game.
- **No auto-advance between rounds.** A Guru decides when the room is ready. Timers don't know that table 3 is still arguing about the rules.
- **Not merged into `guru.html`.** This is a live-ops screen for one night and it wants the whole tablet.
