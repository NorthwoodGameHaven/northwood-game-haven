# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-13b

The two things the 13a install got wrong on a real phone: the icon was still
small, and cards were touching.

**Nothing in this drop is in a protected path — every file is already in your
repo. Nothing to download.**

---

## Summary (the one-line box)

```
Launcher icon: drop the double safe-zone inset; gap under every tile grid (13b)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-13b

1. THE ICON WAS STILL SMALL, AND 13a's ARITHMETIC WAS NOT WRONG
13a resized the artwork and it barely moved. Measuring the tile in the
home-screen screenshot gave 53%, against the 82% the maths predicted. That
ratio — 0.66 — is exactly 72/108: one whole safe-zone inset too many.

Unzipping the APK that was actually installed and decoding
res/mipmap-anydpi-v26/ic_launcher.xml found it:

    <adaptive-icon>
      <background><inset android:drawable="@mipmap/ic_launcher_background"
                         android:inset="16.7%" /></background>
      <foreground><inset android:drawable="@mipmap/ic_launcher_foreground"
                         android:inset="16.7%" /></foreground>
    </adaptive-icon>

@capacitor/assets writes that inset because it assumes the source art bleeds to
the edge of the canvas and needs insetting into the safe zone. Ours is already
cut to that safe zone (tools/make-icons.mjs), so it landed twice:

    art in the source layer                        52.6% of the layer
    <inset 16.7%>                        x0.666    35.0% of the 108dp canvas
    launcher shows 72dp of 108dp         /0.667    52.6% of the visible tile

52.6% predicted. ~54% measured on the phone. The same generator also emits the
two layers at LEGACY sizes — 192px at xxxhdpi, where a 108dp adaptive layer
wants 432 — which only went unnoticed because the double inset was shrinking
them anyway; drawn 1.5x larger they would have gone soft.

capacitor/scripts/patch-android.mjs now owns the adaptive icon. It rewrites both
ic_launcher.xml and ic_launcher_round.xml with no inset, and installs one
full-resolution copy of each layer in mipmap-xxxhdpi, deleting the small
generated ones so no device can pick a soft copy. It already ran last, after
cap sync, so nothing regenerates over it. The artwork itself did not change.

Result: the logo goes from 53% of the tile to 82%, which is 98.7% of the way to
the edge of a circular mask — what the art was cut for in the first place.
`node tools/make-icons.mjs --preview` now models BOTH transforms, so the
before/after it draws is what a launcher really shows. 13a's preview modelled
only the crop, which is why it looked fixed when it was not.

The lesson worth keeping: the safe-zone arithmetic was right and the icon was
still wrong, because a tool in the middle of the pipeline applied its own
transform. Measuring the artefact that actually ships is what found it.

2. CARDS WITH NO GAP BETWEEN THEM
.card carried margin-bottom:14px. .grid carried none. So a card placed after a
tile grid sat flush against it — 0px, at every width — which put the card's top
border hard against the last line of a tile's description and read as the text
being cut off. Visible on the app home (gamehaven.guru card into Coming up) and
the Game Companion index (RPG Companion into Need a game?), and present since
the tile grid was introduced.

.grid now keeps the same 14px rhythm, with :last-child excepted so a page that
ends in a grid gains no trailing space. One line of CSS, every page fixed.

TESTS  (+10 node, +4 e2e)
  tests/patch-android.test.mjs   +10  the inset is gone from both icon variants;
                                      the XML still parses (aapt will not compile
                                      it otherwise); the layer that ships is
                                      BYTE-IDENTICAL to the file
                                      tests/app-icons.test.mjs measures — a
                                      guarantee worth nothing while
                                      @capacitor/assets was resampling it first;
                                      the low-resolution copies are removed; the
                                      LEGACY per-density icons are not; running
                                      twice changes nothing; a missing source
                                      layer fails the build instead of shipping a
                                      blank tile; and the versionCode stamp still
                                      runs after all of it
  tests/app-nav.e2e.mjs           +4  walks all 19 app pages at 390/360/320px and
                                      fails if two blocks that PAINT at their
                                      edges come within 8px. Transparent blocks
                                      are skipped on purpose: a .hero is centred
                                      text and its box touching the grid below is
                                      not a spacing bug.

  Also fixed the test harness itself: run() used execFileSync, which only hands
  back stderr when the script EXITS NON-ZERO, so a console.warn from a
  successful run was invisible and no test could assert on it. spawnSync now.

  node --test tests/*.test.mjs      604 pass  (was 594)
  node tests/app-nav.e2e.mjs         47 pass  (was 43)
  e2e-pages 123 · store-shots 120 · companion 135 · guru-master 134
  karaoke 37 · specials 46

  Mutations: 4 reverts, 4 caught — putting the inset back, skipping the
  full-resolution layer, letting the script eat the legacy per-density icons, and
  removing the .grid margin (which fails naming the exact two pages in the bug
  report).
```

---

## Files

| File | Change |
|---|---|
| `capacitor/scripts/patch-android.mjs` | owns the adaptive icon: no inset, full-resolution layers |
| `site/app/app.css` | `.grid` keeps the 14px rhythm |
| `tools/make-icons.mjs` | the preview models the inset too, so before/after is honest |
| `tools/store-assets/icon-preview.png` | regenerated |
| `tests/patch-android.test.mjs` | +10 tests, and `spawnSync` so stderr is visible on success |
| `tests/app-nav.e2e.mjs` | +4 — card spacing across every page |
| `docs/NGH-APP-SHELL.md` | §3 rewritten with what the APK actually contained; §4 added |

## After it merges

Same as last time — the push starts the workflow on its own.

1. Wait for the run to go green, download **`game-haven-debug-apk`**
2. **Uninstall Game Haven first** (fresh debug keystore every run)
3. Install, then check:
   - the logo now fills its circle in the app drawer, not a third of it
   - Game Companion: a clear gap between the tile grid and **Need a game?**
   - App home: a clear gap between **gamehaven.guru** and **Coming up**

## Still on your list (unchanged)

- [ ] Public address on the Play developer page = the shop, not the house
- [ ] Bump `capacitor/package.json` version before the SECOND Play upload
- [ ] `assetlinks.json` needs the real Play signing SHA-256 (post-upload)
- [ ] Re-shoot the store screenshots somewhere Cinzel can load
