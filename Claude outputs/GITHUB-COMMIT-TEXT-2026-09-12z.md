# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12z

Six files. Changes production behaviour **only if you set two environment
variables** — without them this is inert.

---

## Summary (the one-line box)

```
Play review account: fixed-code sign-in showing invented Rewards data (12z)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12z

WHY
Sign-in is a six-digit code emailed to the customer. Google's reviewer has no
access to any of our inboxes, so every account-gated screen was unreachable to
them — and "App access" is a required section of the listing, so we could not
simply declare there is no login. A reviewer who hits a login wall that was
not declared can reject on that alone.

WHAT
One address with a fixed code, both read from the environment:

  PLAY_REVIEW_EMAIL   play-review@gamehaven.guru   (not a real mailbox —
                                                    nothing is ever sent to it)
  PLAY_REVIEW_CODE    six digits, set in Netlify, never in the repo

Set neither and the whole thing is inert: every path behaves exactly as it did
before. Set only one and it is still off — half-configured is the dangerous
state, so it resolves to off. Env is read per call rather than at import, so
switching it off in the Netlify UI takes effect on the next invocation and
sessions already issued stop working. All four of those are tested.

It shows a fully populated Rewards screen: $8.75 balance, customer code
NGH-0000, the QR, two purchases, an upcoming Holt booking and a Commander
Night registration. Every bit of that is invented in
netlify/functions/_shared/review-account.mjs and NONE of it comes from
Lightspeed. There is no real customer behind the address, so guessing the code
wins you a page of fiction — and wrong guesses are counted in login_codes
against the same five-attempt ceiling as any other sign-in.

FOUR PLACES IT HAD TO BE INTERCEPTED
  /start   answer ok without generating or emailing a code
  /verify  compare against the fixed code with safeEq, issue a session
  /me      return the invented bundle BEFORE anything reaches the POS
  /signup  guard it — the review session is not "pseudo", so without this it
           would fall past the getCustomer() miss and create a REAL Lightspeed
           customer record. The reviewer should never get there, but a stray
           call must not write to the POS.
  PUT /me  succeed and change nothing; an error here reads as a broken app

WHY IT IS A SEPARATE MODULE
review-account.mjs is pure — no db, no Lightspeed, no network — so
tests/e2e-pages.mjs can import it and push the REAL objects through the REAL
Rewards page. The risk with invented data is not that it is wrong but that it
is shaped wrong: one renamed field and the reviewer opens Rewards to a blank
card. Now that fails a test instead of a review.

TESTS
  node --test tests/*.test.mjs      509 pass  (was 494 — 15 new)
  node tests/e2e-pages.mjs          121 pass  (was 107 — 14 new)
  node tests/guru-master.e2e.mjs    134 pass
  node tests/app-store-shots.mjs    120 pass
  karaoke 37 · specials 46 · companion 135

  Mutations, each of which turns a test red:
    - treating a half-configured account as ON          -> 2 fail
    - not counting wrong codes (unrated 6-digit oracle) -> 1 fail
    - removing the /signup guard                        -> 1 fail
    - letting /me fall through to Lightspeed            -> 2 fail
```

---

## Files

| File | Change |
|---|---|
| `netlify/functions/_shared/review-account.mjs` | **new** — pure module: the account's data and its on/off logic |
| `netlify/functions/account.mjs` | five interception points; imports the above |
| `tests/review-account.test.mjs` | **new** — 15 tests |
| `tests/e2e-pages.mjs` | 14 new browser checks driving the real Rewards page |
| `docs/NGH-PLAY-LISTING-PACK.md` | §0.2 exact setup steps; §0.3 the publisher-entity question; §0.4 what's cleared |
| `docs/NGH-ANDROID-DEPLOY.md` | Part 3 and Part 8 rewritten for a verified organization account — no closed-testing wait |

## After it deploys

1. Netlify → Site configuration → Environment variables → add
   `PLAY_REVIEW_EMAIL` and `PLAY_REVIEW_CODE`.
2. **Trigger deploy** — env vars do not reach the functions until one runs.
3. Sign in at `gamehaven.guru/app/account.html` with the address and your six
   digits. You should see **$8.75** and **NGH-0000**. If it offers you a
   sign-up form instead, step 2 did not happen.
