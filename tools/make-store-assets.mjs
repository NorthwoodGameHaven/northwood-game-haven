// tools/make-store-assets.mjs — NGH-BUILD 2026-09-12m
// Builds the two Google Play listing graphics from brand assets already in the
// repo, so the store listing is not blocked on a design session.
//
//   node tools/make-store-assets.mjs
//   -> tools/store-assets/play-icon-512.png       (512x512, no alpha — Play rejects alpha)
//   -> tools/store-assets/play-feature-1024x500.png
//
// Needs python3 + Pillow, which is what actually does the work; this file is
// here so the recipe lives in the repo rather than in a chat log.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'store-assets');
fs.mkdirSync(OUT, { recursive: true });

const py = `
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = ${JSON.stringify(ROOT)}
OUT  = ${JSON.stringify(OUT)}

FOREST_DK = (19, 42, 29)
GOLD_LT   = (232, 184, 75)
CREAM     = (246, 239, 221)
GLOW      = (61, 122, 84)

def bg(w, h):
    """The site's background: forest green with a soft radial glow up top and a
    warmer one bottom-left. Drawn at quarter scale and upsampled — a smooth
    gradient costs nothing that way and per-pixel maths on 1024x500 is slow."""
    sw, sh = w // 4, h // 4
    img = Image.new('RGB', (sw, sh), FOREST_DK)
    px = img.load()
    for y in range(sh):
        for x in range(sw):
            nx, ny = x / sw, y / sh
            dx, dy = nx - 0.5, ny + 0.15
            d1 = (dx * dx * 1.6 + dy * dy) ** 0.5
            g1 = max(0.0, 1.0 - d1 / 0.95) ** 1.6 * 0.42
            dx2, dy2 = nx - 0.08, ny - 1.05
            d2 = (dx2 * dx2 + dy2 * dy2) ** 0.5
            g2 = max(0.0, 1.0 - d2 / 0.75) ** 2.0 * 0.16
            r = FOREST_DK[0] + (GLOW[0] - FOREST_DK[0]) * g1 + (GOLD_LT[0] - FOREST_DK[0]) * g2
            gg= FOREST_DK[1] + (GLOW[1] - FOREST_DK[1]) * g1 + (GOLD_LT[1] - FOREST_DK[1]) * g2
            b = FOREST_DK[2] + (GLOW[2] - FOREST_DK[2]) * g1 + (GOLD_LT[2] - FOREST_DK[2]) * g2
            px[x, y] = (int(r), int(gg), int(b))
    return img.resize((w, h), Image.LANCZOS)

def font(sz):
    # Lora is the closest thing installed to the brand's Cinzel: a warm serif
    # that survives being letterspaced into small caps.
    for p in ('/usr/share/fonts/truetype/google-fonts/Lora-Variable.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'):
        if os.path.exists(p):
            try: return ImageFont.truetype(p, sz)
            except Exception: pass
    return ImageFont.load_default()

def tracked(draw, xy, text, f, fill, track=0):
    """Letterspacing. Cinzel is an inscriptional face and reads wrong without
    it; PIL has no tracking, so step glyph by glyph."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + track
    return x

def tracked_w(draw, text, f, track=0):
    return sum(draw.textlength(c, font=f) + track for c in text) - (track if text else 0)

# ---------------------------------------------------------------- store icon
# capacitor/assets/icon-only.png is already the crest on the brand green at
# 1024. Play wants 512 and refuses alpha, so flatten and downscale.
src = Image.open(os.path.join(ROOT, 'capacitor', 'assets', 'icon-only.png'))
if src.mode in ('RGBA', 'LA', 'P'):
    src = src.convert('RGBA')
    flat = Image.new('RGB', src.size, FOREST_DK)
    flat.paste(src, (0, 0), src)
    src = flat
else:
    src = src.convert('RGB')
src.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'play-icon-512.png'), 'PNG')
print('play-icon-512.png            512x512 RGB (no alpha)')

# ----------------------------------------------------------- feature graphic
W, H = 1024, 500
img = bg(W, H)
d = ImageDraw.Draw(img)

crest = Image.open(os.path.join(ROOT, 'site', 'brand', 'crest.png')).convert('RGBA')
ch = 400
cw = int(crest.width * ch / crest.height)
crest = crest.resize((cw, ch), Image.LANCZOS)
img.paste(crest, (44, (H - ch) // 2), crest)

# Google scales this graphic down hard in listings, so: few words, large, and
# nothing near the edges. The crest already carries the name, so the type
# carries what the app is FOR.
tx = 44 + cw + 50
avail = W - tx - 56          # keep well clear of the right edge

lines = [
    ('YOUR TABLE.',   62, GOLD_LT, 6),
    ('YOUR TEAM.',    62, GOLD_LT, 6),
    ('YOUR REWARDS.', 62, CREAM,   6),
]

def fit(text, start_sz, track):
    """Shrink until the tracked line actually fits. The first version of this
    hardcoded 54pt and clipped the A off 'TRIVIA' at the right edge — a feature
    graphic with a cropped word is worse than no feature graphic."""
    sz = start_sz
    while sz > 16:
        f = font(sz)
        if tracked_w(d, text, f, track) <= avail:
            return f, sz
        sz -= 2
    return font(16), 16

# One size for all three, chosen by the longest line — three headings at
# subtly different sizes reads as a mistake rather than a hierarchy.
common = min(fit(t, sz, tr)[1] for t, sz, col, tr in lines)
sized = []
total = 0
for t, sz, col, tr in lines:
    f = font(common)
    bbox = d.textbbox((0, 0), 'Hg', font=f)
    lh = (bbox[3] - bbox[1]) + 26
    sized.append((t, f, col, tr, lh))
    total += lh

y = (H - total) // 2
for t, f, col, tr, lh in sized:
    tracked(d, (tx, y), t, f, col, tr)
    y += lh

# A thin rule under the block, in the same gold as the site's borders.
rule_y = y + 2
d.rectangle([tx, rule_y, tx + min(260, avail), rule_y + 3], fill=(201, 151, 58))

# Sanity check: nothing may touch the edges. Play crops the graphic on some
# surfaces, and a clipped word looks like a broken listing.
for t, f, col, tr, lh in sized:
    w = tracked_w(d, t, f, tr)
    assert tx + w <= W - 20, 'feature graphic text overflows: ' + t

img.save(os.path.join(OUT, 'play-feature-1024x500.png'), 'PNG')
print('play-feature-1024x500.png   1024x500 RGB')
`;

execFileSync('python3', ['-c', py], { stdio: 'inherit' });
console.log('\nwritten to ' + OUT);
