# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-13c

New launcher icon — Stash and GAME HAVEN on sky blue — and the in-app crest
stops being clipped by its own gold ring.

**Nothing in this drop is in a protected path. Every file is already in your
repo — open GitHub Desktop, check the diff, paste the two boxes, push.**

---

## Summary (the one-line box)

```
Launcher icon, crests fitted to the ring, new hero tagline (13c)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-13c

THE ONE IDEA
Every one of these images ends up inside a CIRCLE — a launcher's mask, the PWA
maskable safe zone, the gold ring on the app's hero, the 36px header crest.
Fitting artwork to a square and then cutting a circle out of it clips the
corners. That is one root cause behind all three icon problems across 13a, 13b
and 13c, and behind the crest the hero was slicing.

So everything is now placed by its MINIMUM ENCLOSING CIRCLE — the smallest
circle containing every visible pixel — centred and scaled to the target's safe
radius. Largest possible with nothing clipped, and centred for free.

1. THE LAUNCHER ICON
Stash (site/brand/stash-bust.png) with GAME HAVEN under him on a sky-blue
gradient, sampled from the sky already painted behind him in logo-forest.png:
#c5e0fc down to #6aacef.

The lettering is lifted from the real wordmark rather than set in a substitute
font — Cinzel is not installable here and a near-miss serif would have looked
off. site/brand/wordmark-lockup.png is separated by connected-component height
(GAME HAVEN's caps are 89-121px, NORTHWOOD's are 168-347), keyed off luminance
so the antialiased edges survive, and given the dark keyline the brand already
draws around that lettering so cream reads on blue. Committed as
site/brand/wordmark-gamehaven.png.

Stash and the wordmark are composed into ONE image before fitting — at 82% of
his width, with a 7% gap. Fitting them separately would let the type drift into
the mask's edge at one size and not another.

Two traps found on the way:
  * getbbox() crops at alpha > 0, and stash-bust.png has a drop shadow that
    fades to nothing: alpha>0 reports 1422px wide where the visible art is 1135.
    Fitting that box put the artwork at 80% of the size asked for. Both the tool
    and the test now threshold at alpha > 24.
  * The enclosing circle is solved on the silhouette (leftmost and rightmost
    opaque pixel of each row), which contains every point that can define it —
    2,500 points instead of 200,000, and a 59-second run becomes 5.

Straight answer on one thing: at 48dp the type is about four pixels tall and
reads as a shape rather than as words. That is why Android's guidance is a mark,
not a lockup. From 72dp up — the app drawer, widgets, the Play listing — it
reads properly. The preview draws both so it can be judged rather than argued
about: node tools/make-icons.mjs --preview

2. THE CREST INSIDE THE APP
Reported as "the icon isn't centered properly in the app either", and it was
worse than off-centre — it was being cut. Both places the app shows a crest
apply border-radius:50%: the 36px header crest, and the 150px hero inside its
gold ring. 13a fitted the seasonal set to a SQUARE, 440 of 480, which reaches
1.25 of the radius. The ring was slicing the ends off the wordmark and the whole
row of game components underneath it.

All six are now circle-fit to 0.92 — 69px of the 75px radius. The ring is drawn
INSIDE the image (box-sizing: border-box) and leaves 72px clear.

crest.png itself measures 0.99: fine in the header, 2.5px under the ring in the
hero. It is a website asset the TV screens also use, so this drop does not touch
it — the app swaps it for the circle-fit copy on load, which it already did for
five months of the year. Winter now has a file too
(site/brand/seasonal/default.png) instead of falling through to the raw crest.

3. THE HERO TAGLINE
"Board game café · TCG & retro shop · Event rooms · Overnight suites" was a
feature list saying what the place contains — and the four tiles immediately
below it already say that, with buttons. The hero's two slots now carry a hook
and an offer instead:

    Meet People, Make Memories                      (the gold display line)
    The Valley's first board game café ·            (the grey tag line)
    event rooms · overnight party suites · retro arcade

"first" rather than "best" — a fact instead of a superlative — and the ·
separators keep it attached to the café instead of appearing to claim the lot.
They are also the separator the rest of the app already uses ("The Holt ·
Stash's Den · The Depths").

The retro arcade is named the way the TV idle screen and venue.mjs already name
it ("Retro arcade", "retro cabinets"), so the app is not inventing a third
phrasing for the same room. It is already surfaced as a tile too — Video Game
Library, consoles, CRTs and 700+ titles — so this is the copy catching up with
what the app already offers.

4. A 6% FLAKE IN THE LIGHTSPEED TESTS, FOUND ON THE WAY
The full suite went red once in six runs, on "state round-trips, rejects tamper
and > 10 min age". Not timing, despite the name: the test tampered with a signed
OAuth state by forcing its last character to 'f' —

    core.verifyState(SECRET, s.slice(0, -1) + 'f', ...)

and signState ends in 'f' 1 time in 16, which makes the "tampered" string
byte-identical to the original. verifyState then correctly returned true and the
assertion failed. Measured over 5,000 states: 6.6%.

So for 6.6% of runs that line tested nothing and then failed anyway. It now
flips the digit to one it is NOT, and asserts the tampered string actually
differs. 25 consecutive runs of that file, and three of the full suite, clean.
Pre-existing, unrelated to this drop, and exactly the kind of red run that
teaches a team to re-run CI instead of reading it.

Both lines fit without overflow at 390/360/320px. Nothing asserted the old copy,
so nothing broke; the meta description, the manifest description and the share
text are separate surfaces with their own jobs and are untouched.

TESTS  (+2)
  tests/app-icons.test.mjs   the ink detector now reconstructs the background
                             from the top and bottom rows, which is why the sky
                             gradient is VERTICAL — a radial one gives it no row
                             to sample. New: GAME HAVEN sits under Stash with a
                             measurable band of empty rows between them, and the
                             band below that gap is the right shape for a line
                             of type. Crests must clear 72/75 of the radius.

  node --test tests/*.test.mjs      607 pass  (was 606) — and now deterministic
  node tests/app-nav.e2e.mjs         47 pass
  e2e-pages 123 · store-shots 120 · companion 135 · guru-master 134
  karaoke 37 · specials 46

  Mutations: 6 reverts, 6 caught — a crest going back to box-fit, the launcher
  art shrinking into a ring, winter losing its file, the invisible-halo crop
  returning, the wordmark touching Stash, and the wordmark disappearing.
```

---

## Files

| File | Change |
|---|---|
| `site/brand/stash-bust.png` | **new** — the launcher artwork |
| `site/brand/wordmark-lockup.png` | **new** — the clean wordmark, the source for the type |
| `site/brand/wordmark-gamehaven.png` | **new** — the extracted GAME HAVEN letterforms |
| `site/brand/seasonal/*.png` | all six rebuilt circle-fit; `default.png` is new |
| `capacitor/assets/icon-{foreground,background,only}.png` | Stash + GAME HAVEN on sky blue |
| `site/app/icons/*.png` | same, for the PWA and apple-touch |
| `tools/make-icons.mjs` | enclosing-circle fitting, the composition, the sky |
| `tools/store-assets/icon-preview.png` | regenerated |
| `site/app/index.html` | new hero tagline |
| `site/app/ngh-app.js` | winter points at a file |
| `site/app/sw.js` | precache the sixth crest · **VERSION → `ngh-app-2026-09-13c`** |
| `tests/app-icons.test.mjs` | +2, and the detector reworked for the sky background |
| `tests/lightspeed.test.mjs` | the 6% tamper flake |
| `docs/NGH-APP-SHELL.md` | §2 and §3 rewritten |

## After it merges

The push starts the workflow on its own.

1. Green run → download **`game-haven-debug-apk`**
2. **Uninstall Game Haven first** — fresh debug keystore every run
3. Check: the launcher icon is Stash on blue with GAME HAVEN under him, filling
   the tile; on the app home the crest sits fully inside its gold ring with the
   game components no longer cut off; and the hero reads
   "Meet People, Make Memories"

## Still on your list (unchanged)

- [ ] Public address on the Play developer page = the shop, not the house
- [ ] Bump `capacitor/package.json` version before the SECOND Play upload
- [ ] `assetlinks.json` needs the real Play signing SHA-256 (post-upload)
- [ ] Re-shoot the store screenshots somewhere Cinzel can load
