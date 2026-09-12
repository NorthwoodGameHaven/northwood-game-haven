# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12ah

Eight files. **This is a real bug, found on a real phone** — the first one the
device caught that no test could have.

---

## Summary (the one-line box)

```
Fix Game Companion and Karaoke doing nothing in the packaged app (12ah)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12ah

THE SYMPTOM
First install on a real phone: tapping "Game Companion" on the app home screen
bounced straight back to the top of the app home screen. Nothing else. Same for
the Karaoke tile.

THE CAUSE
Capacitor's Android WebViewLocalServer:

    if (path.equals("/") || (!request.getUrl().getLastPathSegment().contains(".") && html5mode))
        String startPath = this.basePath + "/index.html";

Any request whose last path segment has no dot is served the ROOT index.html —
not the index.html of that directory. Our root www/index.html is the stub
sync-web writes, which does location.replace("/app/index.html").

So "/app/companion/" served the home page, which redirected to the home page.
The tap looked like it did nothing because, from the user's side, it did.

WHY NOTHING CAUGHT IT
It works perfectly on gamehaven.guru — Netlify resolves a directory to its own
index.html, as does the mock server the browser tests run against. Both are
correct; Capacitor is the odd one out. This class of bug is only visible once
the app is packaged and installed, which had never happened until today.

Seven links were affected — every one written as a directory. Every link that
worked ended in .html. That is the whole difference.

THE FIX
1. All seven now point at .../index.html explicitly. Works identically on the
   website, so nothing regresses there.
     site/app/index.html                     -> companion + karaoke tiles
     site/app/karaoke/join.html              -> back to karaoke index
     site/app/companion/{first-player,life-counter,rpg,turn-tracker}.html
2. A withIndex() guard in ngh-app.js appends index.html to any /app/ path that
   ends in a slash, applied in three places: NGH.go(), the native link handler,
   and the appUrlOpen deep-link handler. A TV QR pointing at a directory would
   have hit exactly the same wall.

TESTS  (8 new, tests/bundled-links.test.mjs)
  A browser test cannot catch this — the mock emulates Netlify, correctly — so
  the check is static, against the source:
    - no /app/ link anywhere in the shell ends in a directory
    - every /app/ link resolves to a file that actually exists in the bundle
      (a 404 in a packaged shell is a dead end; there is no server behind it)
    - the two tiles specifically point at index.html
    - withIndex(), pulled out of the shipped file so it cannot drift:
      directories gain index.html, real files are untouched, query strings and
      fragments survive, and a query string containing a slash is not mistaken
      for a directory

  node --test tests/*.test.mjs      548 pass  (was 540)
  node tests/e2e-pages.mjs          123 pass
  node tests/app-store-shots.mjs    120 pass
  companion 135 · karaoke 37

  Mutations: restoring the directory link fails 2, neutering withIndex fails 2,
  and pointing a link at a file that does not exist fails 1.
```

---

## Files

| File | Change |
|---|---|
| `site/app/index.html` | Game Companion + Karaoke tiles → `index.html` |
| `site/app/karaoke/join.html` | back-link → `index.html` |
| `site/app/companion/first-player.html` · `life-counter.html` · `rpg.html` · `turn-tracker.html` | back-links → `index.html` |
| `site/app/ngh-app.js` | `withIndex()` guard in `go()`, the link handler and the deep-link handler |
| `tests/bundled-links.test.mjs` | **new** — 8 tests |

## After it merges

Run the workflow again (**Run workflow** on the workflow page, not Re-run),
download the new debug APK, uninstall the old build and install this one.
Game Companion and Karaoke should now open.

Worth re-testing after: the four companion tools, and the back-arrow from each
one returning to the companion index rather than the home page.
