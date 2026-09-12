# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12ad

Three files. Corrects the wording shipped in 12ab, and fixes a test that was
passing on luck.

---

## Summary (the one-line box)

```
Correct who owns what on the privacy page; fix a racy QR assertion (12ad)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12ad

1. THE PRIVACY PAGE HAD THE TWO COMPANIES THE WRONG WAY ROUND
   12ab said Northwood Experiences LLC merely "publishes the app on Northwood
   Game Haven's behalf and does not receive the information". Dustin: the
   website and the app are OWNED by Northwood Experiences LLC. Northwood Game
   Haven (ECCentric LLC) is still the business the customer deals with and
   still holds their data.

   Now: Northwood Experiences builds, hosts and publishes the site and the app,
   is the developer shown on the Play listing, runs the software on Northwood
   Game Haven's behalf, and does not use your information for anything of its
   own. The deletion page footer says the same, and spells out that ECCentric
   is who holds your account.

2. A TEST THAT WAS PASSING ON LUCK
   "account: QR image loaded" read img.complete the instant the dashboard
   rendered. Instrumenting it showed complete === false at that moment; the
   image lands about 60ms later. It was a coin flip that happened to keep
   landing heads.

3. AND THE FLAKE UNDERNEATH IT
   The review-account walk failed the console-error gate on roughly half of
   runs with an aborted /api/tv/qr.png request. Two wrong guesses before the
   real cause: it was not the page close, and not a duplicate render (checked:
   one /me call, one QR request, so the app is clean).

   The browser context is shared between blocks, so the account block left a
   session in localStorage. The review block navigated, that session was
   restored, the dashboard rendered and started the QR request — and the
   reload that was supposed to sign us out aborted it mid-flight. A real
   requestfailed, correctly reported, caused by the test setup.

   Fixed by dropping the session in an init script BEFORE any page script
   runs, so the dashboard never renders and no request is ever started. An
   earlier attempt to ignore ERR_ABORTED during teardown has been taken back
   out — the gate stays strict now that the cause is gone.

   Five consecutive clean runs.

TESTS
  node --test tests/*.test.mjs      523 pass
  node tests/e2e-pages.mjs          123 pass  x5 consecutive, no console errors
  node tests/guru-master.e2e.mjs    134 pass
  node tests/app-store-shots.mjs    120 pass
```

---

## Files

| File | Change |
|---|---|
| `site/privacy.html` | who owns the software vs. who holds the data |
| `site/account-delete.html` | footer line matched to it |
| `tests/e2e-pages.mjs` | QR assertion now waits; review block starts genuinely signed out |
| `tests/booking-admin-render.test.mjs` | consistency assertions follow the new wording |

## After it deploys

Read the "Who 'we' means" section on `https://gamehaven.guru/privacy` once more
and confirm it is right this time.
