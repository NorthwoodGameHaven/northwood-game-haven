// tools/make-icons.mjs — NGH-BUILD 2026-09-13a
// Rebuilds every app icon from one master piece of artwork, sized to the
// safe zone each target actually uses.
//
//   node tools/make-icons.mjs            # write the icons
//   node tools/make-icons.mjs --check    # report sizes, write nothing
//   node tools/make-icons.mjs --preview  # also write tools/store-assets/icon-preview.png
//
// WHY THIS EXISTS
// The launcher icon had the logo floating in the middle of a dark disc with a
// wide empty ring around it. That was not a bug in any one file — it was three
// different safe zones being guessed at by hand:
//
//   * Android adaptive icon: the two 108dp layers are cropped to the central
//     72dp before the launcher's mask is applied, so a circular mask shows a
//     circle 66.7% as wide as the canvas. Art drawn to fit the SQUARE canvas
//     therefore lands ~30% too small.
//   * PWA maskable icon: the spec's safe zone is a circle 80% as wide.
//   * Plain square icons (iOS, apple-touch, the Play listing tile): no mask
//     beyond rounded corners — the art should very nearly fill the tile.
//
// Each target below states its own rule, and the art is scaled by MEASURED
// radius (the furthest opaque pixel from centre), not by bounding box: the
// lockup is a rounded badge, so its corners are transparent and a bounding-box
// fit leaves the same empty ring behind.
//
// Needs python3 + Pillow, which is what does the work; this file is here so
// the recipe lives in the repo rather than in a chat log.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = new Set(process.argv.slice(2));

const py = `
import os, sys, json
import numpy as np
from PIL import Image, ImageDraw

ROOT    = ${JSON.stringify(ROOT)}
CHECK   = ${args.has('--check') ? 'True' : 'False'}
PREVIEW = ${args.has('--preview') ? 'True' : 'False'}

# The master lockup: 1400x1400, transparent, the highest-resolution copy we
# have. The old icon-foreground.png was a 1024 rescale of this same art.
MASTER = os.path.join(ROOT, 'site', 'brand', 'logo-forest.png')

FOREST_MID = (32, 69, 46)     # gradient centre — a touch lighter than the app
FOREST_DK  = (13, 30, 20)     # gradient edge

def art():
    im = Image.open(MASTER).convert('RGBA')
    return im.crop(im.split()[-1].getbbox())

def max_radius(im):
    """Furthest opaque pixel from the image centre, in pixels."""
    a = np.array(im.split()[-1])
    ys, xs = np.nonzero(a > 24)
    cx, cy = (im.width - 1) / 2.0, (im.height - 1) / 2.0
    return float(np.hypot(xs - cx, ys - cy).max())

def background(size):
    """Radial forest gradient. Flat dark green made the logo look like a hole."""
    g = Image.new('RGB', (size, size), FOREST_DK)
    px = np.linspace(-1, 1, size)
    gx, gy = np.meshgrid(px, px)
    d = np.clip(np.hypot(gx, gy) / 1.30, 0, 1) ** 1.25      # 0 centre -> 1 corner
    c0, c1 = np.array(FOREST_MID, float), np.array(FOREST_DK, float)
    arr = (c0 + (c1 - c0) * d[..., None]).astype('uint8')
    return Image.fromarray(arr, 'RGB')

def place(canvas_size, scale_to_radius=None, scale_to_box=None, opaque=True):
    """Centre the art on a canvas, scaled so it fills the given safe zone."""
    a = art()
    if scale_to_radius is not None:
        f = scale_to_radius / max_radius(a)
    else:
        f = (canvas_size * scale_to_box) / max(a.width, a.height)
    w, h = max(1, round(a.width * f)), max(1, round(a.height * f))
    a = a.resize((w, h), Image.LANCZOS)
    base = background(canvas_size).convert('RGBA') if opaque else Image.new('RGBA', (canvas_size,) * 2, (0, 0, 0, 0))
    base.alpha_composite(a, ((canvas_size - w) // 2, (canvas_size - h) // 2))
    return base.convert('RGB') if opaque else base

# ---- the targets, each with the rule it follows ---------------------------
# radius = fraction of the canvas HALF-WIDTH the art's furthest pixel may reach.
ADAPTIVE = 72 / 108 * 0.99      # 0.660 — the 72dp circle a launcher mask shows
MASKABLE = 0.80 * 0.99          # 0.792 — the PWA maskable safe-zone circle
SQUARE   = 0.90                 # plain tiles: fill 90% of the width, box-fit

TARGETS = [
    # (path, size, kind, value, opaque)
    ('capacitor/assets/icon-foreground.png', 1024, 'radius', ADAPTIVE, False),
    ('capacitor/assets/icon-background.png', 1024, 'none',   None,     True),
    ('capacitor/assets/icon-only.png',       1024, 'box',    SQUARE,   True),
    ('site/app/icons/icon-1024.png',         1024, 'box',    SQUARE,   True),
    ('site/app/icons/icon-512.png',           512, 'box',    SQUARE,   True),
    ('site/app/icons/icon-192.png',           192, 'box',    SQUARE,   True),
    ('site/app/icons/apple-touch-icon.png',   180, 'box',    SQUARE,   True),
    ('site/app/icons/maskable-512.png',       512, 'radius', MASKABLE, True),
]

report = []
for rel, size, kind, val, opaque in TARGETS:
    dst = os.path.join(ROOT, rel)
    if kind == 'none':
        im = background(size)
    elif kind == 'radius':
        im = place(size, scale_to_radius=(size / 2) * val, opaque=opaque)
    else:
        im = place(size, scale_to_box=val, opaque=opaque)
    was = os.path.getsize(dst) / 1024 if os.path.exists(dst) else 0
    if not CHECK:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        im.save(dst, optimize=True)
    now = os.path.getsize(dst) / 1024 if os.path.exists(dst) else 0
    fill = ''
    if kind != 'none':
        probe = im.convert('RGBA')
        if not opaque:
            fill = 'art radius %.0f%% of half-width' % (200 * max_radius(probe) / size)
        else:
            fill = 'art %.0f%% of width' % (100 * val if kind == 'box' else 200 * val / 2)
    print('%-42s %4d  %-30s %6.1f -> %6.1f KB' % (rel, size, fill, was, now))

if PREVIEW:
    # What a launcher actually shows: the two adaptive layers, cropped to the
    # 72dp the launcher keeps, under a circular and a squircle mask — the new
    # icon beside the old one, at the sizes a phone draws them.
    out = os.path.join(ROOT, 'tools', 'store-assets', 'icon-preview.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)

    def masked(full, px, shape):
        k = int(1024 * 72 / 108); o = (1024 - k) // 2          # the launcher's crop
        tile = full.crop((o, o, o + k, o + k)).resize((px, px), Image.LANCZOS).convert('RGBA')
        m = Image.new('L', (px * 4, px * 4), 0); md = ImageDraw.Draw(m)
        if shape == 'circle': md.ellipse((0, 0, px * 4 - 1, px * 4 - 1), fill=255)
        else:                 md.rounded_rectangle((0, 0, px * 4 - 1, px * 4 - 1), radius=int(px * 4 * .30), fill=255)
        tile.putalpha(m.resize((px, px), Image.LANCZOS))
        return tile

    new = Image.open(os.path.join(ROOT, 'capacitor/assets/icon-background.png')).convert('RGBA')
    new.alpha_composite(Image.open(os.path.join(ROOT, 'capacitor/assets/icon-foreground.png')).convert('RGBA'))
    # the icon as it shipped in 12ah: art at radius 307.5/512 of the half-width,
    # flat #132a1d behind it. Reconstructed so the comparison is honest.
    old = Image.new('RGBA', (1024, 1024), (19, 42, 29, 255))
    old.alpha_composite(place(1024, scale_to_radius=307.5, opaque=False))

    SIZES = [('48dp', 96), ('72dp', 144), ('128dp', 200)]
    pad, gap, lab = 26, 22, 150
    tall = max(px for _, px in SIZES) * 2 + 8          # circle over squircle
    W = pad * 2 + lab + sum(px for _, px in SIZES) + gap * (len(SIZES) - 1)
    H = pad * 2 + 34 + (tall + 46) * 2
    sheet = Image.new('RGB', (W, H), (24, 24, 24)); d = ImageDraw.Draw(sheet)
    for row, (img, name) in enumerate([(old, 'BEFORE  (12ah)'), (new, 'AFTER  (13a)')]):
        y = pad + 34 + row * (tall + 46)
        d.text((pad, y - 20), name, fill=(232, 184, 75))
        x = pad + lab
        for label, px in SIZES:
            c, s = masked(img, px, 'circle'), masked(img, px, 'squircle')
            sheet.paste(c.convert('RGB'), (x, y), c)
            sheet.paste(s.convert('RGB'), (x, y + px + 8), s)
            if row == 0: d.text((x, y - 20), label, fill=(150, 150, 150))
            x += px + gap
    sheet.save(out)
    print('preview -> ' + os.path.relpath(out, ROOT))
`;

try {
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(out);
} catch (e) {
  console.error('make-icons failed. Needs python3 with Pillow and numpy.');
  process.exit(1);
}

if (!args.has('--check')) {
  console.log('\nAndroid picks these up on the next CI build (npm run assets -- --android).');
  console.log('The PWA icons under site/app/icons/ ship with the site as-is.');
  for (const f of ['capacitor/assets/icon-foreground.png', 'site/app/icons/maskable-512.png']) {
    if (!fs.existsSync(path.join(ROOT, f))) { console.error('MISSING ' + f); process.exit(1); }
  }
}
