// tools/make-icons.mjs — NGH-BUILD 2026-09-13c
// Builds every launcher/app icon, and the in-app crests, from brand artwork —
// each one fitted to the shape that will actually be cut out of it.
//
//   node tools/make-icons.mjs            # write them
//   node tools/make-icons.mjs --check    # report, write nothing
//   node tools/make-icons.mjs --preview  # + tools/store-assets/icon-preview.png
//
// THE ONE IDEA IN THIS FILE
// Every one of these images ends up inside a CIRCLE — a launcher's mask, the
// PWA maskable safe zone, the gold ring on the app's hero, the 36px header
// crest. Fitting artwork to a square canvas and then cutting a circle out of it
// clips the corners, which is what put the wordmark's ends and the row of game
// components outside the hero's ring, and what made the launcher icon look
// wrong in three different ways across 13a and 13b.
//
// So the artwork is placed by its MINIMUM ENCLOSING CIRCLE, not its bounding
// box: the smallest circle containing every opaque pixel, centred on the canvas
// and scaled to the target's safe radius. That is the largest the art can be
// with nothing clipped, and it is automatically optically centred — the bust in
// stash-bust.png sits 337px above the middle of its own canvas, and a bbox fit
// would have inherited that.
//
// Needs python3 + Pillow + numpy, which do the work; this file is here so the
// recipe lives in the repo rather than in a chat log.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = new Set(process.argv.slice(2));

const py = `
import os
import numpy as np
from PIL import Image, ImageDraw

ROOT    = ${JSON.stringify(ROOT)}
CHECK   = ${args.has('--check') ? 'True' : 'False'}
PREVIEW = ${args.has('--preview') ? 'True' : 'False'}

# The launcher icon: Stash, with GAME HAVEN under him. The lettering is lifted
# from the real wordmark (site/brand/wordmark-lockup.png) rather than set in a
# substitute font — the nine cap-height glyphs of the second line, keyed off
# luminance so the antialiased edges survive, then given the dark keyline the
# brand already draws around them so cream reads on blue.
STASH    = os.path.join(ROOT, 'site', 'brand', 'stash-bust.png')
WORDMARK = os.path.join(ROOT, 'site', 'brand', 'wordmark-gamehaven.png')
WORDMARK_W = 0.82      # of Stash's width — a caption, and it has to stay inside
                       # the circle at a height where the circle is narrowing
WORDMARK_GAP = 0.07    # of Stash's height. Clear air, never a touch.

# Sky blue, sampled from the sky already painted behind Stash in the brand art
# (site/brand/logo-forest.png): light at the top, deeper at the bottom.
SKY_TOP = (197, 224, 252)
SKY_BOT = (106, 172, 239)

def icon_art():
    """Stash with GAME HAVEN beneath him, as one transparent image.

    Composed here rather than fitted separately so the enclosing-circle fit sees
    the whole lockup: fitting the two independently is what would let the text
    drift into the mask's edge at one size and not another."""
    stash = opaque(STASH)
    word = opaque(WORDMARK)
    w_w = int(round(stash.width * WORDMARK_W))
    w_h = max(1, round(word.height * w_w / word.width))
    word = word.resize((w_w, w_h), Image.LANCZOS)
    gap = int(round(stash.height * WORDMARK_GAP))
    W = max(stash.width, w_w)
    H = stash.height + gap + w_h
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out.alpha_composite(stash, ((W - stash.width) // 2, 0))
    out.alpha_composite(word, ((W - w_w) // 2, stash.height + gap))
    return out

def opaque(path):
    """Crop to the art you can actually SEE.

    getbbox() crops at alpha > 0, and stash-bust.png carries a drop shadow that
    fades to nothing: alpha>0 reports 1422px wide where the visible art is 1135.
    Fitting that box put the artwork at 80% of the size asked for. The threshold
    matches the one tests/app-icons.test.mjs measures with."""
    im = Image.open(path).convert('RGBA')
    a = np.array(im.split()[-1])
    ys, xs = np.nonzero(a > 24)
    return im.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))

def hull_points(im):
    """The silhouette: leftmost and rightmost opaque pixel of every row.

    That is a superset of the convex hull, so it contains every point that can
    define the enclosing circle — and it is ~2500 points instead of ~200000,
    which turns a 50-second run into under a second."""
    a = np.array(im.split()[-1]) > 24
    rows = np.nonzero(a.any(axis=1))[0]
    lo = a[rows].argmax(axis=1)
    hi = a.shape[1] - 1 - a[rows][:, ::-1].argmax(axis=1)
    return np.concatenate([np.stack([lo, rows], 1), np.stack([hi, rows], 1)]).astype(float)

def min_enclosing_circle(pts):
    """Smallest circle containing every point (iterative, converges tightly).

    A bounding box is the wrong tool when the cut-out is round: for the bust,
    box-fitting wastes 24% of the diameter compared with this."""
    c = pts.mean(axis=0)
    step = np.hypot(*(pts.max(axis=0) - pts.min(axis=0)))
    for _ in range(3000):
        d = np.hypot(*(pts - c).T)
        far = pts[np.argmax(d)]
        c = c + (far - c) * (step / (np.max(d) + 1e-9)) * 0.002
        step *= 0.999
    r = float(np.max(np.hypot(*(pts - c).T)))
    return c, r

def place_circle(src, canvas, safe, opaque_bg=True, bg=None):
    """Scale so the art's enclosing circle fills 'safe' of the canvas half-width,
       with that circle's centre on the canvas centre."""
    art = src if isinstance(src, Image.Image) else opaque(src)
    c, r = min_enclosing_circle(hull_points(art))
    f = ((canvas / 2) * safe) / r
    w, h = max(1, round(art.width * f)), max(1, round(art.height * f))
    art = art.resize((w, h), Image.LANCZOS)
    # keep the ENCLOSING CIRCLE centred, not the bounding box
    cx, cy = c[0] * f, c[1] * f
    base = (bg(canvas) if bg else Image.new('RGB', (canvas, canvas), SKY_BOT)).convert('RGBA') \\
           if opaque_bg else Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    base.alpha_composite(art, (int(round(canvas / 2 - cx)), int(round(canvas / 2 - cy))))
    return base.convert('RGB') if opaque_bg else base

def place_box(src, canvas, frac, bg=None):
    art = src if isinstance(src, Image.Image) else opaque(src)
    f = (canvas * frac) / max(art.width, art.height)
    w, h = max(1, round(art.width * f)), max(1, round(art.height * f))
    art = art.resize((w, h), Image.LANCZOS)
    base = (bg(canvas) if bg else Image.new('RGB', (canvas, canvas), SKY_BOT)).convert('RGBA')
    base.alpha_composite(art, ((canvas - w) // 2, (canvas - h) // 2))
    return base.convert('RGB')

def sky(size):
    """A vertical sky gradient. Vertical on purpose: the test that measures these
       tiles reconstructs the background from the top and bottom rows, which only
       works if it varies along one axis."""
    t = np.linspace(0, 1, size)[:, None]
    c0, c1 = np.array(SKY_TOP, float), np.array(SKY_BOT, float)
    row = (c0 + (c1 - c0) * t)
    return Image.fromarray(np.repeat(row[:, None, :], size, axis=1).astype('uint8'), 'RGB')

# ---- safe zones -----------------------------------------------------------
ADAPTIVE = 72 / 108 * 0.99   # 0.660 — the circle an Android launcher reveals of
                             #         the 108dp layer (patch-android.mjs strips
                             #         the extra <inset> @capacitor/assets adds)
MASKABLE = 0.80 * 0.99       # 0.792 — the PWA maskable safe-zone circle
SQUARE   = 0.92              # plain tiles: no mask but rounded corners

ICONS = [
    ('capacitor/assets/icon-foreground.png', 1024, 'circle', ADAPTIVE, False),
    ('capacitor/assets/icon-background.png', 1024, 'bg',     None,     True),
    ('capacitor/assets/icon-only.png',       1024, 'box',    SQUARE,   True),
    ('site/app/icons/icon-1024.png',         1024, 'box',    SQUARE,   True),
    ('site/app/icons/icon-512.png',           512, 'box',    SQUARE,   True),
    ('site/app/icons/icon-192.png',           192, 'box',    SQUARE,   True),
    ('site/app/icons/apple-touch-icon.png',   180, 'box',    SQUARE,   True),
    ('site/app/icons/maskable-512.png',       512, 'circle', MASKABLE, True),
]

ICON_ART = icon_art()
print('LAUNCHER / APP ICONS  — Stash + GAME HAVEN on sky blue  (%dx%d composed)' % ICON_ART.size)
for rel, size, kind, val, opaque_bg in ICONS:
    dst = os.path.join(ROOT, rel)
    was = os.path.getsize(dst) / 1024 if os.path.exists(dst) else 0
    if kind == 'bg':      im = sky(size)
    elif kind == 'circle': im = place_circle(ICON_ART, size, val, opaque_bg, sky)
    else:                  im = place_box(ICON_ART, size, val, sky)
    if not CHECK:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        im.save(dst, optimize=True)
    now = os.path.getsize(dst) / 1024 if os.path.exists(dst) else 0
    note = 'sky gradient' if kind == 'bg' else ('circle-fit %.0f%%' if kind == 'circle' else 'box-fit %.0f%%') % (val * 100)
    print('  %-40s %4d  %-18s %6.1f -> %6.1f KB' % (rel, size, note, was, now))

# ---- the in-app crests ----------------------------------------------------
# Both places the app shows these apply border-radius:50% — the 36px header
# crest and the 150px hero inside its gold ring. They were box-fitted, so the
# ring was slicing the ends off the wordmark and the whole row of game
# components underneath it. Circle-fit, same as the icons.
CRESTS = {
    'default':   'logo-forest.png',      # winter, and the fallback
    'blossom':   'logo-blossom.png',
    'sunflower': 'logo-sunflower.png',
    'autumn':    'logo-autumn.png',
    'halloween': 'logo-clock.png',
    'fireworks': 'logo-fireworks.png',
}
CREST_PX = 480          # matches crest.png, so nothing shifts when they swap
# The hero draws a 3px gold ring INSIDE the 150px box (box-sizing:border-box),
# so the usable circle is 96% of the radius. 92% leaves the art clear of it.
CREST_FIT = 0.92
print()
print('IN-APP CRESTS  — circle-fit, so the gold ring stops clipping them')
for key, src in CRESTS.items():
    s = os.path.join(ROOT, 'site', 'brand', src)
    if not os.path.exists(s):
        print('  %-40s MISSING %s' % (key, src)); continue
    dst = os.path.join(ROOT, 'site', 'brand', 'seasonal', key + '.png')
    was = os.path.getsize(dst) / 1024 if os.path.exists(dst) else 0
    im = place_circle(s, CREST_PX, CREST_FIT, opaque_bg=False)
    if not CHECK:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        im.quantize(colors=200, method=Image.FASTOCTREE, dither=Image.FLOYDSTEINBERG).save(dst, optimize=True)
    now = os.path.getsize(dst) / 1024 if os.path.exists(dst) else 0
    print('  %-40s %4d  %-18s %6.1f -> %6.1f KB' % ('site/brand/seasonal/' + key + '.png', CREST_PX, 'circle-fit %.0f%%' % (CREST_FIT * 100), was, now))

if PREVIEW:
    # What a launcher actually shows: the two adaptive layers under the crop it
    # keeps, then a circular and a squircle mask, at the sizes a phone draws.
    out = os.path.join(ROOT, 'tools', 'store-assets', 'icon-preview.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bg = Image.open(os.path.join(ROOT, 'capacitor/assets/icon-background.png')).convert('RGBA')
    fg = Image.open(os.path.join(ROOT, 'capacitor/assets/icon-foreground.png')).convert('RGBA')
    full = bg.copy(); full.alpha_composite(fg)

    def masked(px, shape):
        k = int(1024 * 72 / 108); o = (1024 - k) // 2
        tile = full.crop((o, o, o + k, o + k)).resize((px, px), Image.LANCZOS).convert('RGBA')
        m = Image.new('L', (px * 4, px * 4), 0); md = ImageDraw.Draw(m)
        if shape == 'circle': md.ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
        else:                 md.rounded_rectangle((0, 0, px * 4 - 1, px * 4 - 1), radius=int(px * 4 * .30), fill=255)
        tile.putalpha(m.resize((px, px), Image.LANCZOS))
        return tile

    SIZES = [('48dp', 96), ('72dp', 144), ('128dp', 200)]
    pad, gap = 26, 22
    W = pad * 2 + sum(px for _, px in SIZES) + gap * (len(SIZES) - 1)
    H = pad * 2 + 30 + max(px for _, px in SIZES) * 2 + 8
    sheet = Image.new('RGB', (W, H), (24, 24, 24)); d = ImageDraw.Draw(sheet)
    x = pad
    for label, px in SIZES:
        c, sq = masked(px, 'circle'), masked(px, 'squircle')
        d.text((x, pad + 6), label, fill=(150, 150, 150))
        sheet.paste(c.convert('RGB'), (x, pad + 30), c)
        sheet.paste(sq.convert('RGB'), (x, pad + 30 + px + 8), sq)
        x += px + gap
    sheet.save(out)
    print()
    print('preview -> ' + os.path.relpath(out, ROOT))
`;

try {
  process.stdout.write(execFileSync('python3', ['-c', py], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
} catch (e) {
  console.error('make-icons failed. Needs python3 with Pillow and numpy.');
  process.exit(1);
}

if (!args.has('--check')) {
  for (const f of ['capacitor/assets/icon-foreground.png', 'site/app/icons/maskable-512.png', 'site/brand/seasonal/default.png']) {
    if (!fs.existsSync(path.join(ROOT, f))) { console.error('MISSING ' + f); process.exit(1); }
  }
  console.log('\nAndroid picks the two adaptive layers up on the next CI build.');
  console.log('The PWA icons and the crests ship with the site as-is.');
}
