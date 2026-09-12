/* =====================================================================
   NGH Karaoke — shared client helpers (TV, participant, host)
   NGH-BUILD 2026-09-11a. Requires ngh-app.js (window.NGH).

   window.KClient = {
     API, sessionUrl(code), poll(code, opts) -> handle,
     position(np, serverNow) -> ms since song start (negative during lead-in; null if nothing playing),
     LyricLoader() -> { load(np) -> Promise<{type:'lrc'|'cdg'|'none', lyrics, cdgBuf}> },
     AudioPlayer(audioEl) -> { sync(np, clock), stop() },   // optional in-browser backing track
     fmtTime(ms), roomMeta(id), roomBadge(id, s), stars(n)
   }
   ===================================================================== */
(function () {
  'use strict';
  var API = NGH.API + '/karaoke';
  function sessionUrl(code) { return API + '/sessions/' + encodeURIComponent(code); }

  function poll(code, opts) {
    opts = opts || {};
    return NGH.poll(sessionUrl(code) + '/state', {
      interval: opts.interval || 2000, hidden: opts.hidden || 12000,
      onState: function (st) { if (st && st.code) opts.onState && opts.onState(st); },
      onError: opts.onError
    });
  }

  function position(np, serverNow) {
    if (!np) return null;
    if (np.pausedAt) return np.pausedAt - np.startAt;
    return serverNow - np.startAt;
  }

  function LyricLoader() {
    var cache = {};
    return {
      load: function (np) {
        if (!np || !np.songId) return Promise.resolve({ type: 'none' });
        var key = np.songId;
        if (cache[key]) return cache[key];
        var p = NGH.fetchJSON(API + '/songs/' + encodeURIComponent(np.songId) + '/lyrics').then(function (j) {
          if (j && j.lyrics && j.lyrics.lines && j.lyrics.lines.length) return { type: 'lrc', lyrics: window.KLyrics ? KLyrics.normalize(j.lyrics) : j.lyrics, offsetMs: j.offsetMs || 0 };
          var cdg = j && j.cdg;                                       // hosted HTTPS copy (never the rack PC's LAN URL)
          if (cdg) {
            if (cdg.charAt(0) === '/') cdg = NGH.SITE + cdg;
            return fetch(cdg).then(function (r) { if (!r.ok) throw new Error('cdg ' + r.status); return r.arrayBuffer(); }).then(function (buf) { return { type: 'cdg', cdgBuf: buf, offsetMs: (j && j.offsetMs) || 0 }; });
          }
          if (j && j.cdgPending) { delete cache[key]; return { type: 'pending' }; }   // rack player is still uploading it
          return { type: 'none' };
        }).catch(function () { delete cache[key]; return { type: 'none' }; });
        cache[key] = p; return p;
      }
    };
  }

  // Plays np.media.audio in the browser, aligned to the shared server clock.
  function AudioPlayer(audio) {
    var seq = -1, timer = null, srcUrl = null, entryId = null;
    function clear() { clearTimeout(timer); timer = null; }
    function alignTo(np) {
      var pos = position(np, NGH.clock.now());
      if (np.pausedAt) { audio.pause(); return; }
      if (pos < 0) { audio.currentTime = 0; audio.pause(); clear(); timer = setTimeout(function () { audio.play().catch(function () {}); }, -pos); return; }
      var drift = Math.abs(audio.currentTime * 1000 - pos);
      if (drift > 350 || audio.paused) { try { audio.currentTime = pos / 1000; } catch (e) {} audio.play().catch(function () {}); }
    }
    return {
      sync: function (np) {
        if (!np || !np.media || !np.media.audio) { this.stop(); return; }
        if (np.entryId !== entryId || np.media.audio !== srcUrl) { entryId = np.entryId; srcUrl = np.media.audio; audio.src = srcUrl; audio.load(); seq = -1; }
        if (np.seq !== seq || np.pausedAt) { seq = np.seq; alignTo(np); }
      },
      tick: function (np) { if (np && np.media && np.media.audio && !np.pausedAt && !audio.paused) { var pos = position(np, NGH.clock.now()); if (pos > 0 && Math.abs(audio.currentTime * 1000 - pos) > 600) { try { audio.currentTime = pos / 1000; } catch (e) {} } } },
      stop: function () { clear(); entryId = null; srcUrl = null; seq = -1; try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (e) {} }
    };
  }

  function fmtTime(ms) { if (ms == null || isNaN(ms)) return '–:––'; var s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function roomMeta(id, s) { var m = (s && s.rooms && s.rooms[id]) || {}; var base = NGH.roomsMeta[id] || { name: id, color: '#888', text: '#fff' }; return { id: id, name: m.name || base.name, team: m.team || m.name || base.name, color: m.color || base.color, text: base.text || '#fff', score: m.score || 0, songs: m.songs || 0 }; }
  function roomBadge(id, s) { var r = roomMeta(id, s); return '<span class="pill room" style="background:' + r.color + ';color:' + r.text + '">' + NGH.esc(r.team) + '</span>'; }
  function stars(n) { n = Number(n) || 0; var out = ''; for (var i = 1; i <= 5; i++) out += i <= Math.round(n) ? '★' : '☆'; return out; }

  window.KClient = { API: API, sessionUrl: sessionUrl, poll: poll, position: position, LyricLoader: LyricLoader, AudioPlayer: AudioPlayer, fmtTime: fmtTime, roomMeta: roomMeta, roomBadge: roomBadge, stars: stars };
})();
