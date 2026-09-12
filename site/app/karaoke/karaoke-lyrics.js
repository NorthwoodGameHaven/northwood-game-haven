/* =====================================================================
   NGH Karaoke — timed-lyrics model + LRC parser + word-highlight renderer
   NGH-BUILD 2026-09-11a. Vanilla JS, no deps.

   TimedLyrics = { lines:[ { t, end, words:[ { t, end, text } ] } ], meta:{title,artist,offset} }   (ms)

   window.KLyrics = {
     parseLRC(text)                 -> TimedLyrics  (plain [mm:ss.xx] and enhanced <mm:ss.xx> word timings)
     normalize(obj)                 -> TimedLyrics  (fills ends, distributes words, sorts)
     fromKaraFun(obj)               -> TimedLyrics  (adapter stub for the KaraFun OEM syllable format)
     Renderer(el, opts)             -> { setLyrics(l), setPosition(ms), destroy() }
   }
   ===================================================================== */
(function () {
  'use strict';

  function ts(str) { // "mm:ss.xx" | "mm:ss" | "h:mm:ss.xxx" -> ms
    var p = str.split(':').map(Number);
    if (p.some(isNaN)) return null;
    if (p.length === 3) return Math.round(((p[0] * 60 + p[1]) * 60 + p[2]) * 1000);
    if (p.length === 2) return Math.round((p[0] * 60 + p[1]) * 1000);
    return Math.round(p[0] * 1000);
  }

  // ---- LRC ----
  function parseLRC(text) {
    var meta = {}, lines = [];
    var offset = 0;
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim(); if (!line) return;
      var m = line.match(/^\[([a-zA-Z]+):(.*)\]$/);
      if (m) { meta[m[1].toLowerCase()] = m[2].trim(); if (m[1].toLowerCase() === 'offset') offset = Number(m[2]) || 0; return; }
      var times = [], rest = line;
      var tm;
      while ((tm = rest.match(/^\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/))) { times.push(ts(tm[1].replace(/:(\d{1,3})$/, '.$1'))); rest = rest.slice(tm[0].length); }
      if (!times.length) return;
      // enhanced words: <mm:ss.xx>word
      var words = [];
      var re = /<(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)>([^<]*)/g, wm, any = false;
      while ((wm = re.exec(rest))) { any = true; var txt = wm[2]; if (txt.trim() === '') continue; words.push({ t: ts(wm[1].replace(/:(\d{1,3})$/, '.$1')), text: txt }); }
      var plain = any ? rest.replace(/<[^>]*>/g, '') : rest;
      times.forEach(function (t) {
        var l = { t: t, text: plain.trim() };
        if (any) l.words = words.map(function (w) { return { t: w.t, text: w.text }; });
        lines.push(l);
      });
    });
    return normalize({ lines: lines, meta: { title: meta.ti, artist: meta.ar, album: meta.al, offset: offset } });
  }

  // ---- normalize: sort, fill ends, split words when only line timing exists ----
  function normalize(obj, opts) {
    opts = opts || {};
    var lines = (obj && obj.lines || []).map(function (l) { return Object.assign({}, l); }).filter(function (l) { return typeof l.t === 'number' && !isNaN(l.t); });
    lines.sort(function (a, b) { return a.t - b.t; });
    var off = (obj && obj.meta && Number(obj.meta.offset)) || 0;
    lines.forEach(function (l, i) {
      l.t = l.t - off;
      var next = lines[i + 1];
      if (typeof l.end !== 'number') l.end = next ? Math.min(next.t, l.t + 12000) : l.t + 6000;
      if (l.end <= l.t) l.end = l.t + 1500;
      if (!l.words || !l.words.length) {
        var toks = String(l.text || '').split(/(\s+)/).filter(function (x) { return x.length; });
        var wordsOnly = toks.filter(function (x) { return !/^\s+$/.test(x); });
        var totalChars = wordsOnly.reduce(function (a, w) { return a + w.length; }, 0) || 1;
        var cur = l.t, dur = l.end - l.t, words = [];
        toks.forEach(function (tok) {
          if (/^\s+$/.test(tok)) { if (words.length) words[words.length - 1].text += ' '; return; }
          var d = dur * (tok.length / totalChars);
          words.push({ t: Math.round(cur), end: Math.round(cur + d), text: tok }); cur += d;
        });
        l.words = words;
      } else {
        l.words = l.words.map(function (w) { return { t: (w.t - off), end: typeof w.end === 'number' ? (w.end - off) : undefined, text: String(w.text || '') }; });
        l.words.forEach(function (w, j) { var nw = l.words[j + 1]; if (typeof w.end !== 'number') w.end = nw ? nw.t : l.end; if (w.end <= w.t) w.end = w.t + 200; });
        // make sure words carry trailing spaces so joining reads naturally
        // (syllable-timed sources such as KaraFun split words into pieces — keep those joined)
        if (!opts.syllables && !(obj && obj.meta && obj.meta.syllables)) l.words.forEach(function (w, j) { if (j < l.words.length - 1 && !/\s$/.test(w.text) && !/^\s/.test(l.words[j + 1].text)) w.text += ' '; });
      }
      if (!l.text) l.text = l.words.map(function (w) { return w.text; }).join('').trim();
    });
    return { lines: lines, meta: Object.assign({}, obj && obj.meta || {}, { offset: 0 }) };
  }

  // ---- KaraFun OEM adapter (stub: their syllable-sync payload -> TimedLyrics) ----
  // Expected input (per KaraFun OEM docs, adjust when you have the real schema):
  //   { lines:[ { start, end, syllables:[ { start, end, text } ] } ] }  (seconds)
  function fromKaraFun(obj) {
    var lines = ((obj && obj.lines) || []).map(function (l) {
      return { t: Math.round((l.start || 0) * 1000), end: Math.round((l.end || 0) * 1000),
               words: (l.syllables || []).map(function (s) { return { t: Math.round(s.start * 1000), end: Math.round(s.end * 1000), text: s.text }; }) };
    });
    return normalize({ lines: lines, meta: { title: obj && obj.title, artist: obj && obj.artist, syllables: true } }, { syllables: true });
  }

  // ---- Renderer ----
  // Shows the current line big with a gold fill sweeping across words, the next
  // two lines below, and a countdown (dots) when the next line is > 4 s away.
  function Renderer(el, opts) {
    opts = opts || {};
    var lyrics = null, lastIdx = -2, raf = null, pos = 0, built = [];
    el.classList.add('klyrics');
    var style = document.createElement('style');
    style.textContent =
      '.klyrics{position:relative;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;overflow:hidden;font-family:"Nunito","Segoe UI",system-ui,sans-serif;font-weight:800;line-height:1.15;--k-size:1em}' +
      '.klyrics .kl{position:relative;width:96%;margin:0 auto;white-space:pre-wrap;word-break:break-word;transition:opacity .25s,transform .25s}' +
      '.klyrics .kl.cur{font-size:calc(var(--k-size)*1);color:rgba(246,239,221,.35);text-shadow:0 3px 0 rgba(0,0,0,.35)}' +
      '.klyrics .kl.next{font-size:calc(var(--k-size)*.62);color:rgba(246,239,221,.55);margin-top:.5em}' +
      '.klyrics .kl.next2{font-size:calc(var(--k-size)*.52);color:rgba(246,239,221,.32);margin-top:.35em}' +
      '.klyrics .kw{position:relative;display:inline;color:inherit}' +
      '.klyrics .kw>i{position:absolute;left:0;top:0;height:100%;overflow:hidden;white-space:pre;font-style:normal;color:#e8b84b;width:0;text-shadow:0 0 18px rgba(232,184,75,.45),0 3px 0 rgba(0,0,0,.35)}' +
      '.klyrics .kw.done{color:#e8b84b}' +
      '.klyrics .kcount{position:absolute;top:8%;left:50%;transform:translateX(-50%);display:flex;gap:14px}' +
      '.klyrics .kcount i{width:.55em;height:.55em;border-radius:50%;background:rgba(246,239,221,.25);display:block}' +
      '.klyrics .kcount i.on{background:#e8b84b;box-shadow:0 0 14px #e8b84b}' +
      '.klyrics .kidle{color:rgba(246,239,221,.6);font-size:calc(var(--k-size)*.6);font-weight:700}';
    el.appendChild(style);
    var wrap = document.createElement('div'); wrap.style.cssText = 'width:100%;position:relative'; el.appendChild(wrap);
    var count = document.createElement('div'); count.className = 'kcount'; count.innerHTML = '<i></i><i></i><i></i><i></i>'; count.style.display = 'none'; el.appendChild(count);

    function lineEl(cls, line) {
      var d = document.createElement('div'); d.className = 'kl ' + cls;
      if (!line) return d;
      if (cls === 'cur') {
        line.words.forEach(function (w) {
          var s = document.createElement('span'); s.className = 'kw';
          s.textContent = w.text; var i = document.createElement('i'); i.textContent = w.text; s.appendChild(i);
          s._w = w; d.appendChild(s);
        });
      } else d.textContent = line.text;
      return d;
    }
    function build(idx) {
      wrap.innerHTML = ''; built = [];
      if (!lyrics) { wrap.innerHTML = '<div class="kidle">' + (opts.idleText || '♪') + '</div>'; return; }
      var L = lyrics.lines;
      if (idx < 0) { // before first line
        var pre = lineEl('next', L[0]); pre.classList.remove('next'); pre.classList.add('cur'); wrap.appendChild(pre); built.push(pre);
        if (L[1]) wrap.appendChild(lineEl('next', L[1]));
        return;
      }
      var cur = lineEl('cur', L[idx]); wrap.appendChild(cur); built.push(cur);
      if (L[idx + 1]) wrap.appendChild(lineEl('next', L[idx + 1]));
      if (L[idx + 2]) wrap.appendChild(lineEl('next2', L[idx + 2]));
    }
    function paint() {
      if (!lyrics) return;
      var L = lyrics.lines, idx = -1;
      for (var i = 0; i < L.length; i++) { if (pos >= L[i].t) idx = i; else break; }
      // keep showing a finished line briefly before jumping (max 1.2 s of gap)
      if (idx >= 0 && pos > L[idx].end + 1200 && L[idx + 1] && pos < L[idx + 1].t) { /* in a gap: show upcoming */ idx = idx; }
      if (idx !== lastIdx) { lastIdx = idx; build(idx); }
      // word fill
      var cur = built[0];
      if (cur && idx >= 0) {
        Array.prototype.forEach.call(cur.children, function (s) {
          var w = s._w; if (!w) return;
          var f = (pos - w.t) / Math.max(1, w.end - w.t);
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          s.classList.toggle('done', f >= 1);
          s.firstElementChild && (s.firstElementChild.style.width = (f * 100).toFixed(1) + '%');
        });
      }
      // countdown before the next line (intros / instrumental breaks)
      var nextT = idx + 1 < L.length ? L[idx + 1].t : null; var lineEnd = idx >= 0 ? L[idx].end : 0;
      var gap = nextT != null ? (nextT - Math.max(pos, lineEnd)) : 0;
      var showCount = nextT != null && (nextT - lineEnd > 4000) && pos > lineEnd && (nextT - pos) < 4200 && (nextT - pos) > 0;
      if (idx < 0 && L[0] && L[0].t - pos < 4200 && L[0].t - pos > 0) showCount = true;
      if (showCount) {
        count.style.display = 'flex';
        var remain = nextT != null && idx >= 0 ? nextT - pos : (L[0].t - pos);
        var on = Math.max(0, Math.min(4, Math.ceil(remain / 1000)));
        Array.prototype.forEach.call(count.children, function (dot, k) { dot.classList.toggle('on', k < on); });
      } else count.style.display = 'none';
      void gap;
    }
    function loop() { paint(); raf = requestAnimationFrame(loop); }
    return {
      setLyrics: function (l) { lyrics = l && l.lines && l.lines.length ? l : null; lastIdx = -2; pos = 0; build(-1); if (!raf) loop(); },
      setPosition: function (ms) { pos = ms; },
      clear: function () { lyrics = null; lastIdx = -2; build(-1); },
      destroy: function () { if (raf) cancelAnimationFrame(raf); raf = null; el.innerHTML = ''; }
    };
  }

  window.KLyrics = { parseLRC: parseLRC, normalize: normalize, fromKaraFun: fromKaraFun, Renderer: Renderer, _ts: ts };
})();
