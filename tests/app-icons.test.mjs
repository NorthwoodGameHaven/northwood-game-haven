// tests/app-icons.test.mjs — NGH-BUILD 2026-09-13a
// Run:  node --test tests/app-icons.test.mjs
//
// "Make the logo fill out the icon space better" was a real defect with an
// exact number behind it: the launcher icon's artwork reached only 60% of the
// way to the edge of the circle Android actually shows, so the otter sat in
// the middle of a dark ring.
//
// Nothing could have caught that, because nothing knew what the target was.
// These tests write the three safe zones down:
//
//   * Android adaptive icon — the two 108dp layers are cropped to the central
//     72dp before the launcher's mask is applied, so a circular mask reveals a
//     circle 66.7% as wide as the canvas. Art must reach it, and must not
//     cross it.
//   * PWA maskable icon — the spec's safe zone is a circle 80% as wide.
//   * Plain square tiles (iOS, apple-touch, the Play listing) — no mask beyond
//     rounded corners, so the art should very nearly fill the width.
//
// The measurement is on the shipped PNGs, decoded here rather than trusting
// the generator, so re-running tools/make-icons.mjs is not what is being
// tested — the bytes in the repo are.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- a small PNG decoder (8-bit, non-interlaced: RGB, RGBA or palette) ----
// Enough for our own assets, and nothing to install in CI.
function decodePNG(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32BE(0), 0x89504e47, file + ' is not a PNG');
  let off = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  assert.ok(ihdr, 'no IHDR in ' + file);
  assert.equal(ihdr.depth, 8, file + ': expected 8-bit');
  assert.equal(ihdr.interlace, 0, file + ': expected non-interlaced');
  assert.ok([2, 3, 6].includes(ihdr.color), file + ': unsupported colour type ' + ihdr.color);

  const bpp = ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : 1;   // bytes per stored pixel
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * bpp;
  const px = Buffer.alloc(ihdr.h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  if (ihdr.color !== 3) return { ...ihdr, ch: bpp, px };

  // expand the palette so callers only ever see RGB(A)
  assert.ok(plte, file + ': palette image with no PLTE');
  const ch = trns ? 4 : 3;
  const out = Buffer.alloc(ihdr.w * ihdr.h * ch);
  for (let i = 0; i < ihdr.w * ihdr.h; i++) {
    const n = px[i];
    out[i * ch] = plte[n * 3]; out[i * ch + 1] = plte[n * 3 + 1]; out[i * ch + 2] = plte[n * 3 + 2];
    if (ch === 4) out[i * ch + 3] = n < trns.length ? trns[n] : 255;
  }
  return { ...ihdr, ch, px: out };
}

// Furthest "ink" pixel from the centre, as a fraction of the canvas HALF-width.
// For a transparent layer, ink = opaque. For an opaque tile the background is a
// VERTICAL sky gradient, so it can be reconstructed exactly from the top and
// bottom rows — both of which are always background — and anything far from it
// is artwork. That is why tools/make-icons.mjs makes the gradient vertical
// rather than radial: a radial one has no row this test could sample.
function inkExtent(file) {
  const im = decodePNG(path.join(ROOT, file));
  const { w, h, ch, px } = im;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const at = (x, y) => { const i = (y * w + x) * ch; return [px[i], px[i + 1], px[i + 2]]; };
  const top = at(1, 0), bot = at(1, h - 1);
  let maxR = 0, minX = w, maxX = -1, minY = h, maxY = -1, ink = 0;
  for (let y = 0; y < h; y++) {
    const t = h > 1 ? y / (h - 1) : 0;
    const eR = top[0] + (bot[0] - top[0]) * t,
          eG = top[1] + (bot[1] - top[1]) * t,
          eB = top[2] + (bot[2] - top[2]) * t;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch;
      let isInk;
      if (ch === 4) isInk = px[i + 3] > 24;
      else isInk = Math.abs(px[i] - eR) + Math.abs(px[i + 1] - eG) + Math.abs(px[i + 2] - eB) > 24;
      if (!isInk) continue;
      ink++;
      const d = Math.hypot(x - cx, y - cy);
      if (d > maxR) maxR = d;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  assert.ok(ink > 1000, file + ': found almost no artwork — is it blank?');
  return { size: w, radiusFrac: maxR / (w / 2), boxFrac: Math.max(maxX - minX, maxY - minY) / w, ink };
}

const ADAPTIVE = 72 / 108;   // 0.6667 — the circle an Android launcher reveals
const MASKABLE = 0.80;       // the PWA maskable safe zone

describe('android adaptive launcher icon', () => {
  test('the artwork reaches the circle the launcher actually shows', () => {
    const { radiusFrac } = inkExtent('capacitor/assets/icon-foreground.png');
    // This is the regression that started it: 12ah shipped 0.60 and the logo
    // looked lost. Anything under 0.62 is the old bug coming back.
    assert.ok(radiusFrac > 0.62,
      'foreground art reaches only ' + radiusFrac.toFixed(3) + ' of the half-width; the launcher shows ' + ADAPTIVE.toFixed(3));
  });

  test('and does not cross it — nothing gets clipped', () => {
    const { radiusFrac } = inkExtent('capacitor/assets/icon-foreground.png');
    assert.ok(radiusFrac <= ADAPTIVE,
      'foreground art reaches ' + radiusFrac.toFixed(3) + '; past ' + ADAPTIVE.toFixed(3) + ' a circular mask cuts it');
  });

  test('the layers are the 1024 square @capacitor/assets expects', () => {
    for (const f of ['capacitor/assets/icon-foreground.png', 'capacitor/assets/icon-background.png']) {
      const im = decodePNG(path.join(ROOT, f));
      assert.equal(im.w, 1024, f); assert.equal(im.h, 1024, f);
    }
  });

  test('the background layer is opaque', () => {
    // A transparent background layer renders as a black disc on some launchers.
    const im = decodePNG(path.join(ROOT, 'capacitor/assets/icon-background.png'));
    assert.equal(im.ch, 3, 'icon-background.png must have no alpha channel');
  });

  test('the foreground layer keeps its alpha', () => {
    const im = decodePNG(path.join(ROOT, 'capacitor/assets/icon-foreground.png'));
    assert.equal(im.ch, 4, 'icon-foreground.png must be RGBA — it is a layer, not a tile');
  });

  test('GAME HAVEN sits under Stash with clear air between them', () => {
    // The ask was "no overlapping icon or edge". Both halves are measurable on
    // the shipped layer: a band of completely empty rows separating two bands
    // that have artwork in them.
    const im = decodePNG(path.join(ROOT, 'capacitor/assets/icon-foreground.png'));
    const { w, h, ch, px } = im;
    const filled = [];
    for (let y = 0; y < h; y++) {
      let n = 0;
      for (let x = 0; x < w; x++) if (px[(y * w + x) * ch + 3] > 24) n++;
      filled.push(n > 0);
    }
    const first = filled.indexOf(true), last = filled.lastIndexOf(true);
    // every empty run strictly inside the artwork
    const gaps = [];
    let run = 0;
    for (let y = first; y <= last; y++) {
      if (!filled[y]) run++;
      else { if (run) gaps.push(run); run = 0; }
    }
    assert.ok(gaps.length >= 1, 'no empty band — the wordmark is touching Stash, or is missing entirely');
    const gap = Math.max(...gaps);
    assert.ok(gap >= h * 0.02, 'only ' + gap + 'px of clear air between Stash and the wordmark');

    // and the band below the gap has to be the wordmark: wide, and short
    const gapEnd = filled.lastIndexOf(false, last);
    const band = last - gapEnd;
    assert.ok(band > h * 0.03 && band < h * 0.20,
      'the band under the gap is ' + band + 'px of ' + h + ' — that is not a line of type');
  });
});

describe('PWA maskable icon', () => {
  test('the artwork fills the 80% safe-zone circle without crossing it', () => {
    const { radiusFrac } = inkExtent('site/app/icons/maskable-512.png');
    assert.ok(radiusFrac > 0.70, 'maskable art reaches only ' + radiusFrac.toFixed(3) + ' of the half-width');
    assert.ok(radiusFrac <= MASKABLE, 'maskable art reaches ' + radiusFrac.toFixed(3) + ', past the ' + MASKABLE + ' safe zone');
  });
});

describe('plain square tiles', () => {
  const TILES = [
    ['site/app/icons/icon-512.png', 512],
    ['site/app/icons/icon-192.png', 192],
    ['site/app/icons/icon-1024.png', 1024],
    ['site/app/icons/apple-touch-icon.png', 180],
    ['capacitor/assets/icon-only.png', 1024]
  ];

  test('each is the size its name and the manifest promise', () => {
    for (const [f, size] of TILES) {
      const im = decodePNG(path.join(ROOT, f));
      assert.equal(im.w, size, f); assert.equal(im.h, size, f);
    }
  });

  test('none has an alpha channel', () => {
    // Play rejects a store icon with alpha, and iOS renders one with a black
    // fringe. Every tile here is composited onto the forest background.
    for (const [f] of TILES) {
      assert.equal(decodePNG(path.join(ROOT, f)).ch, 3, f + ' must be RGB, not RGBA');
    }
  });

  test('the artwork nearly fills the tile', () => {
    for (const [f] of TILES) {
      const { boxFrac } = inkExtent(f);
      assert.ok(boxFrac > 0.80, f + ': art spans only ' + boxFrac.toFixed(3) + ' of the width');
      assert.ok(boxFrac <= 0.96, f + ': art spans ' + boxFrac.toFixed(3) + ' — no breathing room at all');
    }
  });
});

describe('seasonal crest artwork', () => {
  const KEYS = ['default', 'blossom', 'sunflower', 'autumn', 'halloween', 'fireworks'];

  test('every key the shell can pick has a file behind it', () => {
    // NGH.LOGOS is the map the app reads; a missing file is a broken <img> on
    // the home screen for whichever week of the year points at it.
    const shell = fs.readFileSync(path.join(ROOT, 'site/app/ngh-app.js'), 'utf8');
    const block = /var LOGOS = \{[\s\S]*?\n  \};/.exec(shell);
    assert.ok(block, 'LOGOS has been renamed — the seasonal swap is gone');
    const paths = [...block[0].matchAll(/'(\/brand\/[^']+)'/g)].map((m) => m[1]);
    assert.equal(paths.length, KEYS.length, 'expected one file per season key');
    for (const p of paths) {
      assert.ok(fs.existsSync(path.join(ROOT, 'site', p)), 'missing ' + p);
    }
  });

  test('they are all the same square as the crest they replace', () => {
    // A different aspect ratio would shove the header around four times a year.
    const crest = decodePNG(path.join(ROOT, 'site/brand/crest.png'));
    for (const k of KEYS) {
      const im = decodePNG(path.join(ROOT, 'site/brand/seasonal/' + k + '.png'));
      assert.equal(im.w, crest.w, k + ' width'); assert.equal(im.h, crest.h, k + ' height');
    }
  });

  // The hero draws the crest at 150px with border-radius:50% and a 3px gold
  // ring. box-sizing is border-box, so the ring is drawn INSIDE the image:
  // 72 of the 75px radius is actually clear.
  const HERO_CLEAR = 72 / 75;      // 0.96

  test('and fit inside the ring the hero draws over them', () => {
    // 13a box-fitted these to 440 of 480, which reaches 1.25 — that is what
    // sliced the ends off the wordmark and the whole row of game components.
    for (const k of KEYS) {
      const { radiusFrac } = inkExtent('site/brand/seasonal/' + k + '.png');
      assert.ok(radiusFrac <= HERO_CLEAR,
        k + ': art reaches ' + radiusFrac.toFixed(3) + ' of the half-width, past the ' + HERO_CLEAR.toFixed(3) + ' the gold ring leaves clear');
      assert.ok(radiusFrac > 0.88, k + ': art reaches only ' + radiusFrac.toFixed(3) + ' — needlessly small inside the ring');
    }
  });

  test('crest.png is left alone, and is the reason the app swaps it', () => {
    // It measures ~0.99: it fits a plain circle, so the 36px header was fine,
    // but the hero's ring overlaps its outer 2.5px. It is a WEBSITE asset (the
    // TV screens use it) so this drop does not touch it — every page in the app
    // swaps it for the circle-fit copy on load instead.
    const { radiusFrac } = inkExtent('site/brand/crest.png');
    assert.ok(radiusFrac > HERO_CLEAR,
      'crest.png now clears the ring on its own (' + radiusFrac.toFixed(3) + ') — if that was deliberate, the swap could go');
    assert.ok(radiusFrac <= 1.0, 'crest.png reaches ' + radiusFrac.toFixed(3) + ' — even a plain circle would clip it');
  });

  test('and small enough to sit in the offline cache', () => {
    // These load on the app home screen. The 1400px masters they came from are
    // over a megabyte each; shipping those would be the whole shell six times.
    for (const k of KEYS) {
      const kb = fs.statSync(path.join(ROOT, 'site/brand/seasonal/' + k + '.png')).size / 1024;
      assert.ok(kb < 90, k + '.png is ' + kb.toFixed(0) + ' KB');
    }
  });
});
