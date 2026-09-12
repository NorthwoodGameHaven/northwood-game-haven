# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12x

Six files. **No production code changes** — this is the test harness, the
screenshots and the Play paperwork. Nothing in `site/` or `netlify/` moves, so
the deploy is a no-op and it cannot break the site.

---

## Summary (the one-line box)

```
Play listing pack, live-screen mocks, and 15 verified phone screenshots (12x)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12x

1. THE APP HAD NEVER BEEN RENDERED WITH DATA IN IT
   tests/app-store-shots.mjs walks all 15 app screens at 360x640 / DPR 3
   (= 1080x1920, 24-bit, no alpha — exactly what Play wants) and asserts each
   one loads, renders, throws nothing and doesn't scroll sideways.

   Its first run "passed" 97 of 105 checks, and that number was a lie. The
   mock server implements no /specials, /karaoke, /trivia, /speedgaming or
   /mtg routes, so six screens were rendering their "nothing on right now"
   empty state — and the must-match patterns were loose enough (/karaoke|
   sing|join/) that the empty state satisfied them just as well as the live
   one. Six screens were being tested, and photographed, with no data.

   tests/mock-live.mjs adds the missing endpoints, with shapes taken from the
   real Netlify functions rather than invented — /api/specials returns a bare
   array, /api/speedgaming/active nests under `active`, /api/mtg/board needs
   live:true, and the poller tracks `version`, not `v`. The assertions now
   match content that only exists when the API answered: "Two-Slice Tuesday",
   "FNM7K2", "Commander Night".

   120/120 checks. All 15 screens render live data.

2. A FALSE PASS IN THE FONT CHECK
   The run reported "Cinzel loaded" on a run where the stylesheet had died at
   the egress proxy. document.fonts.check() returns TRUE when no matching
   @font-face rule exists at all, on the assumption the family is a system
   font. Replaced with a canvas width measurement against a family that
   cannot exist. It now correctly reports the fallback.

   This matters because it decides whether the screenshots carry the shipping
   typography. They currently do not — the build sandbox has no route to
   fonts.googleapis.com, so headings fall back from Cinzel to Georgia. Layout
   and content are right; re-shoot on the phone before they go on the listing.

3. TWO THINGS WILL STOP THE LISTING, AND NEITHER WAS WRITTEN DOWN
   Audited the app against the Play policies rather than against our own docs:

   * No account deletion. Play requires BOTH an in-app path and a public web
     URL where deletion can be requested, and the Data safety form has a
     required field for the URL. account.html can sign in, show a balance and
     sign out. There is no delete. This is a form you cannot submit.
   * A reviewer cannot sign in. Sign-in is an emailed 6-digit code; Google's
     reviewer has no access to the inbox, so every account-gated screen is
     unreachable and "App access" is a required section.

   Both are written up with the decision each needs in the new listing pack.

4. THE ACCOUNT-TYPE ADVICE IN NGH-ANDROID-DEPLOY WAS WRONG
   It said: personal account if you want to move fast. The opposite is true.
   Personal accounts created after 13 Nov 2023 cannot publish to production
   until they have run a CLOSED test with 12 testers opted in continuously
   for 14 days, then applied for production access (up to 7 more days).

   Personal is faster to sign up and roughly a month slower to publish, and
   it means finding twelve people who keep the app installed for a fortnight.
   Part 3 now recommends Organization and says why; Part 8 documents both
   paths. The D-U-N-S application is now the first instruction in the file,
   because it is the longest lead time and nothing else waits on it.

5. THE LISTING PACK
   docs/NGH-PLAY-LISTING-PACK.md — app name, short and full descriptions with
   verified character counts, category, every Data safety row (audited against
   the source: no analytics SDK, no ad SDK, no geolocation call, no
   advertising ID anywhere under site/app/), the content-rating answers
   including the user-generated-content question that has teeth, App access
   text, and which eight screenshots to use in which order.

TESTS
  node --test tests/*.test.mjs      480 pass
  node tests/e2e-pages.mjs           82 pass
  node tests/guru-master.e2e.mjs    134 pass
  node tests/app-store-shots.mjs    120 pass   (was 97/105 with six screens empty)
```

---

## Files

| File | Change |
|---|---|
| `tests/mock-live.mjs` | **new** — the six live-screen endpoints, shapes taken from the real functions |
| `tests/mock-api.mjs` | wires in `liveApi()`; `/api/events` now returns events instead of `[]` |
| `tests/app-store-shots.mjs` | content-specific assertions, per-request failure capture, speed-gaming identity seed, real font probe |
| `docs/NGH-PLAY-LISTING-PACK.md` | **new** — the whole Play listing |
| `docs/NGH-ANDROID-DEPLOY.md` | account-type correction, closed-testing path, the two blockers, D-U-N-S first |
| `tools/store-assets/screenshots-draft/` | **new** — 15 verified 1080×1920 screenshots |

## After it merges

Nothing changes on the site. To regenerate the screenshots:

```
node tests/app-store-shots.mjs
```

It prints, at the end, whether the run got the real Cinzel or the fallback —
believe that line rather than the images.
