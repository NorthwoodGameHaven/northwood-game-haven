# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12ab

Three files. Wording on two public pages, plus the tests that keep them
agreeing with each other.

---

## Summary (the one-line box)

```
Name the publishing company on the privacy and deletion pages (12ab)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12ab

The Play listing will be published by Northwood Experiences LLC. The privacy
page speaks for Northwood Game Haven, throughout, and never mentions the other
company. A reviewer comparing the listing to the policy would fairly ask which
company actually holds the data — and so would a customer.

Both pages now say. Three short paragraphs on the privacy page, one line in the
deletion page footer:

  * Northwood Game Haven is ECCentric LLC, trading as Northwood Game Haven. It
    runs the cafe, the shop, the rooms and the rewards account. Everything on
    the privacy page describes what IT does with your information, and it is
    who to contact.
  * Northwood Experiences LLC publishes the app on Google Play on its behalf,
    from the same building, and does NOT receive that information.
  * Overnight stays are booked on VRBO, not here. The suite buttons hand you
    over to vrbo.com, where their policy applies and we never see what you
    enter.

That last one was a real gap rather than a formality. The app has a "Book an
Overnight Stay" tile that links straight out to vrbo.com, and the privacy page
named Stripe, Lightspeed, Netlify and Neon but not that hand-off — which reads
as though we handle lodging data. We do not.

WORDING
This describes how two of your companies relate to each other, so read it
before it ships. If the arrangement is not quite what it says, change the page
rather than leaving it — it is now cross-checked against the Data safety form.

TESTS  (8 new + 2 browser checks)
  The failure this guards against is the two pages drifting apart later. A
  privacy page that disagrees with the Data safety form is the most common
  cause of a rejected Play update, and this is that failure one step earlier.

  - both pages name both companies
  - the privacy page states the publisher does not receive the data
  - it names VRBO and says their policy applies on the hand-off
  - both pages disclose the tax retention exception
  - both give the same contact address
  - the privacy page still links to /account-delete
  - the privacy page names no processor the app does not actually use
    (Google Analytics, Facebook, ad partners, Mixpanel — there are none)

  node --test tests/*.test.mjs      523 pass  (was 515)
  node tests/e2e-pages.mjs          123 pass  (was 121)
  node tests/guru-master.e2e.mjs    134 pass
  node tests/app-store-shots.mjs    120 pass
  specials 46

  Mutations, each of which turns a test red:
    - softening "does not receive the information" to "handles it jointly"
    - dropping "their privacy policy applies" from the VRBO hand-off
    - not naming VRBO at all
```

---

## Files

| File | Change |
|---|---|
| `site/privacy.html` | new "Who 'we' means" section; the VRBO hand-off |
| `site/account-delete.html` | footer line naming both companies |
| `tests/booking-admin-render.test.mjs` | 8 new cross-document tests |
| `tests/e2e-pages.mjs` | 2 new browser checks on the live deletion page |

## After it deploys

Read `https://gamehaven.guru/privacy` — specifically the new "Who 'we' means"
section — and tell me if the description of the two companies is wrong. It is
the one thing in this commit I could not verify for you.
