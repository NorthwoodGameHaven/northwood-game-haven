/* =====================================================================
   NGH Karaoke — CD+G (MP3+G) decoder + canvas renderer
   NGH-BUILD 2026-09-11a. Vanilla JS, no deps.

   window.CDG = { Player(canvas) -> { load(arrayBuffer), setPosition(ms), clear(), destroy() } }

   Format: 24-byte packets at 300 packets/second. command & 0x3F == 9 marks a
   CD+G packet; instruction = byte1 & 0x3F; 16 data bytes at [4..19] (6 bits each).
   Screen 300×216 indexed color (16-entry palette); tiles are 6×12.
   ===================================================================== */
(function () {
  'use strict';
  var W = 300, H = 216, TW = 6, TH = 12;

  function Player(canvas) {
    var ctx = canvas.getContext('2d', { alpha: false });
    var off = document.createElement('canvas'); off.width = W; off.height = H;
    var octx = off.getContext('2d'); var img = octx.createImageData(W, H);
    var pix = new Uint8Array(W * H), pal = new Uint32Array(16), palRGB = [];
    var packets = null, npk = 0, cursor = 0, lastPos = -1, hOff = 0, vOff = 0, border = 0, dirty = true;
    for (var i = 0; i < 16; i++) { pal[i] = 0; palRGB[i] = [0, 0, 0]; }

    function reset() { pix.fill(0); for (var i = 0; i < 16; i++) { palRGB[i] = [0, 0, 0]; } cursor = 0; hOff = 0; vOff = 0; border = 0; dirty = true; }

    function memPreset(d) { var color = d[0] & 0x0F, repeat = d[1] & 0x0F; if (repeat === 0) pix.fill(color); dirty = true; }
    function borderPreset(d) {
      var color = d[0] & 0x0F; border = color;
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) if (x < 6 || x >= W - 6 || y < 12 || y >= H - 12) pix[y * W + x] = color;
      dirty = true;
    }
    function tile(d, xor) {
      var c0 = d[0] & 0x0F, c1 = d[1] & 0x0F, row = d[2] & 0x1F, col = d[3] & 0x3F;
      var x0 = col * TW, y0 = row * TH;
      if (x0 + TW > W || y0 + TH > H) return;
      for (var r = 0; r < TH; r++) {
        var bits = d[4 + r] & 0x3F, base = (y0 + r) * W + x0;
        for (var c = 0; c < TW; c++) {
          var b = (bits >> (5 - c)) & 1, color = b ? c1 : c0, i = base + c;
          pix[i] = xor ? (pix[i] ^ color) : color;
        }
      }
      dirty = true;
    }
    function scroll(d, copy) {
      var color = d[0] & 0x0F, hs = d[1] & 0x3F, vs = d[2] & 0x3F;
      var hCmd = (hs & 0x30) >> 4, vCmd = (vs & 0x30) >> 4;
      hOff = hs & 0x07; vOff = vs & 0x0F;
      var dx = hCmd === 1 ? 6 : hCmd === 2 ? -6 : 0, dy = vCmd === 1 ? 12 : vCmd === 2 ? -12 : 0;
      if (!dx && !dy) { dirty = true; return; }
      var src = pix.slice();
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        var sx = x - dx, sy = y - dy, v;
        if (sx >= 0 && sx < W && sy >= 0 && sy < H) v = src[sy * W + sx];
        else if (copy) v = src[((sy + H) % H) * W + ((sx + W) % W)];
        else v = color;
        pix[y * W + x] = v;
      }
      dirty = true;
    }
    function loadCLUT(d, hi) {
      for (var i = 0; i < 8; i++) {
        var b0 = d[2 * i] & 0x3F, b1 = d[2 * i + 1] & 0x3F;
        var r = (b0 & 0x3C) >> 2, g = ((b0 & 0x03) << 2) | ((b1 & 0x30) >> 4), b = b1 & 0x0F;
        palRGB[(hi ? 8 : 0) + i] = [r * 17, g * 17, b * 17];
      }
      dirty = true;
    }
    function exec(p) {
      var cmd = packets[p] & 0x3F; if (cmd !== 9) return;
      var ins = packets[p + 1] & 0x3F; var d = packets.subarray(p + 4, p + 20);
      switch (ins) {
        case 1: memPreset(d); break;
        case 2: borderPreset(d); break;
        case 6: tile(d, false); break;
        case 38: tile(d, true); break;
        case 20: scroll(d, false); break;
        case 24: scroll(d, true); break;
        case 30: loadCLUT(d, false); break;
        case 31: loadCLUT(d, true); break;
        default: break; // 28 transparent color: ignored
      }
    }
    function blit() {
      var data = img.data, n = W * H;
      for (var i = 0, j = 0; i < n; i++, j += 4) { var c = palRGB[pix[i]]; data[j] = c[0]; data[j + 1] = c[1]; data[j + 2] = c[2]; data[j + 3] = 255; }
      octx.putImageData(img, 0, 0);
      var cw = canvas.width, ch = canvas.height;
      ctx.imageSmoothingEnabled = false;
      // draw the visible 288×192 area (6 px side / 12 px top-bottom border skipped) with fine scroll offsets, keeping aspect
      var sx = 6 + hOff, sy = 12 + vOff, sw = W - 12, sh = H - 24;
      var scale = Math.min(cw / sw, ch / sh), dw = sw * scale, dh = sh * scale, dx = (cw - dw) / 2, dy = (ch - dh) / 2;
      var bc = palRGB[border]; ctx.fillStyle = 'rgb(' + bc[0] + ',' + bc[1] + ',' + bc[2] + ')'; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(off, sx, sy, sw, sh, dx, dy, dw, dh);
      dirty = false;
    }
    return {
      load: function (buf) { packets = new Uint8Array(buf); npk = Math.floor(packets.length / 24); reset(); lastPos = -1; blit(); },
      setPosition: function (ms) {
        if (!packets) return;
        var target = Math.min(npk, Math.max(0, Math.floor(ms * 0.3))); // 300 packets / s
        if (target < cursor) { reset(); }
        while (cursor < target) { exec(cursor * 24); cursor++; }
        if (dirty || ms !== lastPos) { if (dirty) blit(); }
        lastPos = ms;
      },
      clear: function () { packets = null; reset(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); },
      destroy: function () { packets = null; }
    };
  }
  window.CDG = { Player: Player };
})();
