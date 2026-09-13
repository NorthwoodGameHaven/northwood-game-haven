# NGH App shell — navigation, the seasonal crest, the icon pipeline

NGH-BUILD 2026-09-13b · covers `site/app/ngh-app.js`, `site/brand/seasonal/`,
`capacitor/assets/`, `tools/make-icons.mjs`

Three shell-level things that every page under `/app/` inherits. All three came
out of the first real install on a phone.

---

## 1. Back is a hierarchy now, not a tape

### What was wrong

The Android hardware back button ran `history.back()`. Every move inside the
bundled shell is a full page load, so an ordinary trip through the Game
Companion records this in the WebView's session history:

```
home → companion → life counter → companion → turn tracker
```

Press back twice from the turn tracker and you land in the **life counter** —
a tool you had already finished with and closed. That is the "back toggles
backwards from one app to the other, opposite my navigation history" report.
It is not a bug in any one page: a linear tape and a screen hierarchy are two
different things, and the tape is the one nobody can see.

Keep pressing and you eventually fall out of the app with no warning at all.

### What it does now

`NGH.goBack()` walks the hierarchy the app already draws on screen.

**The `‹` link in the header is the parent.** There is no second place to
declare it, no map to keep in sync — the arrow the user can see and the button
on the phone go to the same place, because they read the same `href`.

```
a companion tool   →  the companion index   →  the app home  →  ask, then exit
```

Three rules cover everything:

| Situation | What back does |
|---|---|
| A guard is registered (`NGH.onBack`) and returns `true` | the guard handled it — nothing else happens |
| The header `‹` points inside `/app/` | go there (`location.replace`, so the tape never grows a second opinion) |
| The header `‹` points at a website page (`/guru.html`) or there is none | go to `/app/index.html` — back must never leave the shell |
| Already on `/app/index.html` | ask before closing the app |

### Intercepting it

```js
var off = NGH.onBack(function () {
  if (!sheetIsOpen) return false;     // not mine — fall through
  closeSheet();
  return true;                        // consumed
});
off();                                // unregister
```

Guards run **newest first**, so a sheet opened on top of a screen closes before
the screen's own guard sees the press. `NGH.confirm()` registers one of its own,
which is why back dismisses a confirmation instead of firing it.

### `NGH.confirm(opts)` → `Promise<boolean>`

```js
NGH.confirm({
  title: 'Leave this table for good?',
  body: "You'll be taken out of the rotation.",
  ok: 'Leave for good', cancel: 'Stay', danger: true
}).then(function (yes) { … });
```

A real element in the house style, not `window.confirm()`. The system dialog
freezes the WebView, looks nothing like the app, and — the reason it had to go —
**cannot be dismissed by the back button**, which is exactly how someone gets
stuck. Every `confirm()` in the turn tracker is now this, and
`tests/app-nav.test.mjs` fails if a bare one comes back.

### Why the turn tracker is a special case

Backing out of a live table is **soft**. It does not call `leave`; the seat stays
in the rotation, the saved session is kept, and two Rejoin routes appear:

* the **Rejoin your last table** card on the turn tracker's own landing screen
* a **You're at a table** card on the Game Companion index

Both last 12 hours. "Leave table" is still the hard exit that gives up the seat,
and its wording now says so, because the two are one tap apart and only one of
them is reversible.

---

## 2. The seasonal crest

The otter changes coat with the calendar. Every page already renders
`/brand/crest.png`, so the shell swaps that one `src` on load and no page needs
touching four times a year.

| Window | Key | File |
|---|---|---|
| 20 Mar – 19 Jun | `blossom` | `/brand/seasonal/blossom.png` |
| 20 Jun – 21 Sep | `sunflower` | `/brand/seasonal/sunflower.png` |
| 22 Sep – 20 Dec | `autumn` | `/brand/seasonal/autumn.png` |
| 21 Dec – 19 Mar | `default` | *(no swap — `/brand/crest.png` stays)* |
| **28 Jun – 6 Jul** | `fireworks` | `/brand/seasonal/fireworks.png` |
| **15 Oct – 1 Nov** | `halloween` | `/brand/seasonal/halloween.png` |

The two holiday windows win over the season they sit inside.

**Winter has no art yet.** It falls through to the crest already in the markup,
which is the same drawing as `logo-forest.png`. To add one: drop
`logo-winter.png` in `site/brand/`, run the resize (below), add
`winter: '/brand/seasonal/winter.png'` to `LOGOS` in `ngh-app.js`, and return
`'winter'` instead of `'default'` from `seasonKey()`. `tests/app-nav.test.mjs`
fails if a key is added that the calendar can never reach.

### Previewing without waiting for the season

```
gamehaven.guru/app/?logo=halloween     pin it for this device
gamehaven.guru/app/?logo=auto          hand it back to the calendar
```

Works in the app too. Handy for deciding whether you like one before it is due.

### Making the files

The masters are 1400×1400 and over a megabyte each — far too heavy for a 36px
header. The shipped copies are 480×480 (matching `crest.png`, so nothing shifts
when they swap) and 33–49 KB, small enough that all five sit in the offline
cache:

```bash
python3 - <<'PY'
from PIL import Image
im = Image.open('site/brand/logo-winter.png').convert('RGBA')
im = im.crop(im.split()[-1].getbbox()); im.thumbnail((440, 440), Image.LANCZOS)
out = Image.new('RGBA', (480, 480), (0, 0, 0, 0))
out.alpha_composite(im, ((480 - im.width) // 2, (480 - im.height) // 2))
out.quantize(colors=200, method=Image.FASTOCTREE, dither=Image.FLOYDSTEINBERG).save(
    'site/brand/seasonal/winter.png', optimize=True)
PY
```

Then add it to `SHELL` in `site/app/sw.js` and bump `VERSION` there.

### The launcher icon does **not** change with the season

Worth being clear about, because it is the obvious next question.

Android has no API for it. The only way is `<activity-alias>` entries toggled
with `PackageManager.setComponentEnabledSetting`, and the cost lands on your
customers, not on you:

* switching the alias **kills the app process**, and
* it **removes the icon from the home screen** for anyone who put a shortcut
  there. From their side the app has vanished, and the fix is to go and find it
  in the drawer again.

For a shop app people keep on their home screen, that is a support call four
times a year. The two ways to get a seasonal launcher icon without it:

1. **Ship it with a release.** Swap `capacitor/assets/icon-*.png`, bump the
   version, upload. Free, no risk, ~2 days of Play review — fine for something
   scheduled a season ahead.
2. **iOS only**, later: `setAlternateIconName` is a supported API with none of
   the above problems. When the iOS build happens, the icon can rotate there.

---

## 3. The app icons

### What was wrong

The logo sat in the middle of a dark disc with a wide empty ring around it. Not
a mistake in any single file — three different safe zones, all guessed at:

* **Android adaptive icon.** The two 108dp layers are cropped to the central
  72dp *before* the launcher's mask is applied, so a circular mask reveals a
  circle **66.7%** as wide as the canvas. Art drawn to fit the square canvas
  lands about 30% too small. The shipped foreground reached 60%.
* **PWA maskable icon.** The spec's safe zone is a circle **80%** as wide.
* **Plain square tiles** (iOS, apple-touch, the Play listing). No mask beyond
  rounded corners — the art should very nearly fill the width.

### What 13a missed — and how the phone proved it

13a resized the artwork and the icon still looked lost. Measuring the tile in a
home-screen screenshot gave **53%**, against the **82%** the arithmetic
predicted. The ratio, 0.66, is exactly 72/108 — one whole safe-zone inset too
many. Unzipping the shipped APK and decoding
`res/mipmap-anydpi-v26/ic_launcher.xml` found it:

```xml
<adaptive-icon>
  <background><inset android:drawable="@mipmap/ic_launcher_background" android:inset="16.7%" /></background>
  <foreground><inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" /></foreground>
</adaptive-icon>
```

`@capacitor/assets` writes that inset because it assumes your source art bleeds
to the edge of the canvas and needs insetting into the safe zone. Ours is
already cut to that safe zone, so it was applied twice:

| step | factor | art, as a share of the visible tile |
|---|---|---|
| art in the source layer | — | 52.6% of the layer |
| `<inset 16.7%>` | ×0.666 | 35.0% of the 108dp canvas |
| launcher shows 72dp of 108dp | ÷0.667 | **52.6%** |

52.6% predicted, ~54% measured on the phone. The same file also generates the
two layers at **legacy** sizes — 192px at xxxhdpi, where a 108dp adaptive layer
wants 432 — which only went unnoticed because the double inset was shrinking
them anyway.

`capacitor/scripts/patch-android.mjs` now owns the adaptive icon: it rewrites
both `ic_launcher.xml` and `ic_launcher_round.xml` with no inset, and installs
one full-resolution copy of each layer in `mipmap-xxxhdpi`, deleting the small
generated ones so no device can pick a soft copy. It runs last, after
`cap sync`, so nothing regenerates over it. Ten tests in
`tests/patch-android.test.mjs` cover it, including that the bytes which ship are
byte-identical to the file `tests/app-icons.test.mjs` measures — a guarantee
worth nothing while @capacitor/assets was resampling them first.

**The lesson worth keeping:** the safe-zone arithmetic was right and the icon
was still wrong, because a tool in the middle of the pipeline was applying its
own transform. Measuring the artefact that actually ships is what found it.

### What fixed it

`tools/make-icons.mjs` builds all eight files from one master
(`site/brand/logo-forest.png`, the highest-resolution copy), each scaled to the
zone that target actually uses. The scale is set by **measured radius** — the
furthest opaque pixel from centre — not by bounding box, because the lockup is a
rounded badge whose corners are transparent, and a box fit leaves the same empty
ring behind.

```bash
node tools/make-icons.mjs             # write them
node tools/make-icons.mjs --check     # report sizes, write nothing
node tools/make-icons.mjs --preview   # + tools/store-assets/icon-preview.png
```

The preview renders the icon under a circular and a squircle mask at 48/72/128dp
with the old one above it — the honest before-and-after, since that is what a
launcher actually draws.

The background layer also stopped being flat `#132a1d`, which made the logo read
as a hole punched in the app's own background. It is now a soft radial gradient
between `#20452e` and `#0d1e14`.

Outputs, and the rule each follows:

| File | Rule |
|---|---|
| `capacitor/assets/icon-foreground.png` | radius = 66% of half-width (the adaptive mask) |
| `capacitor/assets/icon-background.png` | the gradient, opaque |
| `capacitor/assets/icon-only.png` | box = 90% of width, opaque (iOS + legacy) |
| `site/app/icons/icon-1024 · 512 · 192.png` | box = 90%, opaque |
| `site/app/icons/apple-touch-icon.png` | box = 90%, opaque |
| `site/app/icons/maskable-512.png` | radius = 79% (the PWA safe zone) |

`tests/app-icons.test.mjs` measures the shipped PNGs — it decodes them itself
rather than trusting the generator — and fails if the art shrinks back under the
mask, grows past it and clips, or picks up an alpha channel (Play rejects a
store icon with alpha; iOS renders one with a black fringe).

Android picks the two adaptive layers up on the next CI build
(`npm run assets -- --android`). The PWA icons ship with the site.

---

---

## 4. Card spacing

`.card` carried `margin-bottom:14px`. `.grid` carried none. So a card placed
after a tile grid sat flush against it — zero gap, at every width — which put
the card's top border hard against the last line of a tile's description and
read as the text being clipped. It affected the app home and the Game Companion
index, and had been there since the grid was introduced.

`.grid` now keeps the same 14px rhythm (`:last-child` excepted, so a page ending
in a grid gains no trailing space).

`tests/app-nav.e2e.mjs` walks **every** page in the app at 390/360/320px and
fails if two blocks that paint at their edges come within 8px of each other.
Transparent blocks are skipped deliberately: a `.hero` is centred text, and its
box touching the grid below it is not a spacing bug.

---

## Tests

| File | What it holds |
|---|---|
| `tests/app-nav.test.mjs` | `backTarget()` against every real page's `‹`; the crest calendar day by day; the shell's wiring |
| `tests/app-icons.test.mjs` | the three safe zones, measured on the shipped PNGs |
| `tests/app-nav.e2e.mjs` | the whole thing in a browser: the reported bug reproduced, the exit guard, the pass-it-down badge, rejoin, and card spacing on every page |
| `tests/patch-android.test.mjs` | the Android build script, including the adaptive-icon inset |
| `tests/mock-companion.test.mjs` | the Turn Tracker mock, and a drift check against the real function |

`NGH.goBack()` is exported, so the entire back model is drivable from a desktop
browser — no phone required to test it.
