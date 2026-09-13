# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-13a

Everything from the first real install: the back button, the turn tracker, the
seasonal crest and the launcher icon.

**Nothing in this drop is in a protected path — every file is already written
into your repo. You do not need to download anything from the chat.** Open
GitHub Desktop, check the diff, paste the two boxes below, commit, push.

---

## Summary (the one-line box)

```
Hierarchical back, turn-tracker QR badge, seasonal crest, icons that fill (13a)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-13a

Four things off the first install on a real phone.

1. BACK WAS WALKING A TAPE, NOT THE APP
The Android back button ran history.back(). Every move in the bundled shell is
a full page load, so a normal trip through the Game Companion records:

    home -> companion -> life counter -> companion -> turn tracker

Two presses of back from the turn tracker landed you in the LIFE COUNTER — a
tool you had already closed. That is the reported "back toggles from one app to
the other, opposite my navigation history". Enough presses and you fell out of
the app entirely, with no warning.

Back now walks the hierarchy the app already draws, and the header's < link IS
the parent — one source of truth, so the arrow on screen and the button on the
phone can never disagree:

    a companion tool -> the companion index -> the app home -> ask, then exit

Pages intercept with NGH.onBack(fn) (return true to consume; newest guard runs
first), and goBack() uses location.replace so the tape can never grow a second
opinion. A < that points at a website page (/guru.html) sends hardware back to
the app home instead — back must never leave the shell.

2. YOU COULD FALL OUT OF A LIVE ROTATION
Back inside a table now asks first, and leaving that way is SOFT: no leave call,
the seat stays in the rotation, and Rejoin appears in two places — the turn
tracker's landing screen and the Game Companion index, for 12 hours. "Leave
table" is still the hard exit that gives up the seat, and now says so, because
the two are one tap apart and only one is reversible.

Every window.confirm() in the turn tracker is gone. The system dialog freezes
the WebView, looks nothing like the app, and cannot be dismissed by the back
button — which is precisely how someone gets stranded. NGH.confirm() is a real
sheet in the house style that returns a Promise and closes on back.

3. THE TABLE CODE NOW GOES WHERE THE PHONE GOES
The code and its QR only existed on the lobby screen, so the moment the game
went live the phone could not be handed down the table. There is now a badge
pinned bottom-right of every screen — above the full-screen live view — with
the code and a QR thumbnail. Tapping it opens a QR big enough for the next
player's camera to actually read, with the code spelled out and a Share link.

4. THE LAUNCHER ICON SAT IN AN EMPTY RING
Not a mistake in one file — three different safe zones, all guessed at:
  * Android adaptive: the 108dp layers are cropped to the central 72dp BEFORE
    the mask, so a circular mask shows a circle 66.7% as wide as the canvas.
    Art fitted to the square canvas lands ~30% small. Ours reached 60%.
  * PWA maskable: the safe zone is a circle 80% as wide.
  * Plain tiles (iOS, apple-touch, the Play listing): no mask, fill the width.

tools/make-icons.mjs now builds all eight from one master, each scaled to the
zone it actually gets, by MEASURED RADIUS rather than bounding box — the lockup
is a rounded badge with transparent corners, and a box fit leaves the same ring.
The flat #132a1d background became a soft radial gradient; flat made the logo
read as a hole punched in the app's own background.
`node tools/make-icons.mjs --preview` writes the before/after under both mask
shapes at 48/72/128dp.

SEASONAL CREST
The otter changes coat with the calendar. Every page already renders
/brand/crest.png, so the shell swaps that one src and no page is touched:

    20 Mar-19 Jun blossom · 20 Jun-21 Sep sunflower · 22 Sep-20 Dec autumn
    28 Jun-6 Jul fireworks · 15 Oct-1 Nov halloween   (holidays win)
    21 Dec-19 Mar: no swap — winter has no art yet, so the plain crest stands

Preview any of them now with ?logo=halloween ; ?logo=auto gives it back to the
calendar. The five shipped files are 480x480 and 33-49 KB (the masters are
1400px and over a megabyte), so the whole year fits in the offline cache.

The LAUNCHER icon deliberately does NOT rotate. Android's only mechanism is an
activity-alias swap, which kills the app process and REMOVES the icon from the
home screen of anyone who put a shortcut there — from their side the app has
vanished. Shipping a seasonal icon with a release costs nothing and breaks
nobody. Written up in docs/NGH-APP-SHELL.md.

ALSO
href="/app/" was still in eight files. Those are directory links too, and 12ah's
test could not see them: its pattern required a segment after /app/, so the
bare form slipped through. They only ever worked by accident — Capacitor served
the root index.html, whose stub happens to redirect to /app/index.html, which is
where they were going anyway. Written out, the pattern fixed, and the two
manifest shortcuts (/app/karaoke/, /app/companion/) with them.

TESTS  (+46 node, +43 e2e)
  tests/app-nav.test.mjs      15  backTarget() against every real page's <,
                                  including a cycle check and a does-it-exist
                                  check; the crest calendar, every day of two
                                  years, both ends of every window; the wiring
  tests/app-icons.test.mjs    12  the three safe zones, measured on the shipped
                                  PNGs with a PNG decoder written into the test
                                  so CI needs nothing installed
  tests/mock-companion.test.mjs 18 the new Turn Tracker mock, plus a drift check
                                  that reads the action list and the public
                                  field list out of the REAL function
  tests/app-nav.e2e.mjs       43  the bug itself reproduced in a browser, the
                                  exit guard, the badge over the live screen,
                                  the big QR, Rejoin, and the seat still being
                                  on the server afterwards
  tests/mock-companion.mjs        the Turn Tracker's shared tables, in memory.
                                  Past "Host a table" had never been reachable
                                  by any test — the same blind spot that had six
                                  screens being photographed empty in 12x.

  node --test tests/*.test.mjs      594 pass  (was 548)
  node tests/app-nav.e2e.mjs         43 pass  (new)
  e2e-pages 123 · store-shots 120 · companion 135 · guru-master 134
  karaoke 37 · specials 46

  Mutations: 16 reverts, 16 caught. Two were silent on the first pass and both
  were real holes — the seasonal-key test hardcoded the key list so it could not
  notice a key being ADDED, and the mock's version test only covered a join, so
  removing the bump from every action went unseen (that one wedges NGH.poll on
  {unchanged:true} and freezes every phone at the table). Both fixed, both bite.
```

---

## Files

| File | Change |
|---|---|
| `site/app/ngh-app.js` | hierarchical back + `NGH.onBack` + `NGH.confirm` + the seasonal crest |
| `site/app/companion/turn-tracker.html` | corner code/QR badge, pass-it-down sheet, soft-exit guard, no `window.confirm` |
| `site/app/companion/index.html` | Rejoin card |
| `site/app/sw.js` | precache the five crests · **VERSION → `ngh-app-2026-09-13a`** |
| `site/app/manifest.webmanifest` | shortcut URLs → `index.html` |
| `site/app/{account,guru-specials,shop,specials,trivia/play,karaoke/index,mtg/index,speedgaming/index}.html` | `href="/app/"` → `/app/index.html` |
| `site/brand/seasonal/*.png` | **new** — blossom · sunflower · autumn · halloween · fireworks |
| `capacitor/assets/icon-{foreground,background,only}.png` | rebuilt to the adaptive safe zone |
| `site/app/icons/*.png` | rebuilt: 1024 · 512 · 192 · apple-touch · maskable |
| `tools/make-icons.mjs` | **new** — the icon pipeline, with the safe zones written down |
| `tools/store-assets/icon-preview.png` | **new** — before/after under both masks |
| `tests/{app-nav,app-icons,mock-companion}.test.mjs` · `tests/app-nav.e2e.mjs` · `tests/mock-companion.mjs` | **new** |
| `tests/bundled-links.test.mjs` | the `href="/app/"` hole, + manifest shortcuts |
| `tests/mock-api.mjs` | serves the companion tables |
| `docs/NGH-APP-SHELL.md` | **new** — back model, seasonal crest, icon pipeline |

## After it merges

1. Netlify redeploys the site on push. `gamehaven.guru/app/` should show the
   **sunflower** crest today, and `?logo=halloween` should show that one.
2. Run the Android workflow (**Run workflow**, not Re-run) for a new APK.
   **Uninstall the old build first** — CI signs each debug APK with a fresh
   keystore, so it will refuse to install over it.
3. On the phone, worth checking:
   - the launcher icon fills its circle
   - Game Companion → any tool → back → the companion index → back → home →
     back → "Close the app?"
   - turn tracker: host a table, start it, and confirm the code badge is
     bottom-right on the live screen; tap it; back closes the QR, not the game
   - back again → "Leave the turn tracker?" → Leave → Rejoin on the companion
     index puts you back in the same seat

## Still on your list (unchanged)

- [ ] Public address on the Play developer page = the shop, not the house
- [ ] Bump `capacitor/package.json` version before the SECOND Play upload
- [ ] `assetlinks.json` needs the real Play signing SHA-256 (post-upload)
- [ ] Re-shoot the store screenshots somewhere Cinzel can load
