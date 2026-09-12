/* =====================================================================
   NGH App shell runtime — NGH-BUILD 2026-09-11a
   Shared by every page under /app/ (PWA on gamehaven.guru and the
   Capacitor iOS/Android builds). Vanilla JS, no build step.

   window.NGH = {
     SITE, API, IS_NATIVE, DEVICE_ID,
     $, esc, fetchJSON, toast, haptic, share, qrUrl,
     clock: { sync, now, offset },
     poll(url, opts) -> handle,            versioned polling (house pattern)
     admin: { token, login, logout, fetch, isLoggedIn },
     store(key) -> { get, set, del },      localStorage JSON helpers
     wakeLock(), uid(), roomsMeta
   }
   ===================================================================== */
(function () {
  'use strict';
  var SITE_HOSTS = ['gamehaven.guru', 'www.gamehaven.guru'];
  var onSite = SITE_HOSTS.indexOf(location.hostname) >= 0 ||
               /netlify\.app$/.test(location.hostname) ||
               location.hostname === 'localhost' && location.port === '8888' /* netlify dev */;
  var SITE = onSite ? location.origin : (window.NGH_SITE_URL || 'https://gamehaven.guru');
  var API  = SITE + '/api';
  var IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  function $(id) { return typeof id === 'string' ? document.getElementById(id) : id; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid(n) {
    n = n || 12;
    var out = '', a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (var i = 0; i < n; i++) out += (a[i] % 36).toString(36);
    return out;
  }
  function store(key) {
    return {
      get: function (dflt) { try { var v = localStorage.getItem(key); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; } },
      set: function (v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} },
      del: function () { try { localStorage.removeItem(key); } catch (e) {} }
    };
  }
  var devStore = store('ngh_device_id');
  var DEVICE_ID = devStore.get(null);
  if (!DEVICE_ID) { DEVICE_ID = uid(16); devStore.set(DEVICE_ID); }

  // ---- fetch ----
  function fetchJSON(url, opts) {
    opts = opts || {};
    var h = Object.assign({}, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); h['Content-Type'] = 'application/json'; }
    opts.headers = h;
    if (url.charAt(0) === '/') url = SITE + url;
    return fetch(url, opts).then(function (r) {
      if (r.status === 204) return null;
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { raw: t }; }
        if (!r.ok) { var err = new Error((j && j.error) || ('HTTP ' + r.status)); err.status = r.status; err.body = j; throw err; }
        return j;
      });
    });
  }

  // ---- toast ----
  var toastEl, toastT;
  function toast(msg, ms) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('show'); }, ms || 2200);
  }

  // ---- haptics (Capacitor Haptics when native, else Vibration API) ----
  function haptic(kind) {
    try {
      var H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (H) {
        if (kind === 'heavy') return H.impact({ style: 'HEAVY' });
        if (kind === 'success') return H.notification({ type: 'SUCCESS' });
        if (kind === 'warn') return H.notification({ type: 'WARNING' });
        if (kind === 'turn') return H.vibrate({ duration: 400 });
        return H.impact({ style: 'MEDIUM' });
      }
      if (navigator.vibrate) {
        var pat = { heavy: [60], success: [30, 40, 30], warn: [80, 40, 80], turn: [200, 80, 200, 80, 300], light: [15] }[kind] || [25];
        navigator.vibrate(pat);
      }
    } catch (e) {}
  }

  // ---- share ----
  function share(data) {
    if (navigator.share) return navigator.share(data).catch(function () {});
    var txt = (data.text ? data.text + ' ' : '') + (data.url || '');
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast('Copied to clipboard'); });
    return Promise.resolve();
  }

  // ---- QR image URL (server-rendered PNG via the TV network endpoint) ----
  function qrUrl(data, size) {
    return API + '/tv/qr.png?data=' + encodeURIComponent(data) + '&s=' + (size || 420);
  }

  // ---- server clock ----
  var clock = { offset: 0, synced: false };
  clock.now = function () { return Date.now() + clock.offset; };
  clock.sync = function (url, n) {
    url = url || (API + '/tv/time'); n = n || 3;
    var samples = [];
    function one() {
      var t0 = Date.now();
      return fetchJSON(url).then(function (j) {
        var t1 = Date.now();
        var sn = j.serverNow || j.now || j.serverTime;
        if (sn) samples.push(sn + (t1 - t0) / 2 - t1);
      }).catch(function () {});
    }
    var p = Promise.resolve();
    for (var i = 0; i < n; i++) p = p.then(one);
    return p.then(function () {
      if (samples.length) { samples.sort(function (a, b) { return a - b; }); clock.offset = samples[Math.floor(samples.length / 2)]; clock.synced = true; }
      return clock.offset;
    });
  };

  // ---- versioned polling (house pattern: GET url?v=N -> {unchanged:true} | full state) ----
  // opts: { onState(state, meta), onError(err), interval(): ms | number, immediate: true, hidden: ms }
  function poll(url, opts) {
    opts = opts || {};
    var v = 0, timer = null, stopped = false, misses = 0, inflight = false;
    var handle = { version: function () { return v; }, misses: function () { return misses; } };
    function interval() {
      if (document.hidden) return opts.hidden || 15000;
      return typeof opts.interval === 'function' ? opts.interval() : (opts.interval || 2000);
    }
    function schedule(ms) { if (stopped) return; clearTimeout(timer); timer = setTimeout(tick, ms == null ? interval() : ms); }
    function tick() {
      if (stopped || inflight) { schedule(); return; }
      inflight = true;
      var sep = url.indexOf('?') >= 0 ? '&' : '?';
      fetchJSON(url + sep + 'v=' + v).then(function (j) {
        inflight = false; misses = 0;
        if (j && typeof j.serverNow === 'number' && !clock.synced) clock.offset = j.serverNow - Date.now();
        if (j && j.unchanged) { schedule(); return; }
        if (j && typeof j.version === 'number') v = j.version;
        else if (j && j.state && typeof j.state.version === 'number') v = j.state.version;
        if (opts.onState) opts.onState(j, { serverNow: j && j.serverNow });
        schedule();
      }).catch(function (e) {
        inflight = false; misses++;
        if (opts.onError) opts.onError(e, misses);
        schedule(Math.min(15000, interval() * (1 + misses)));
      });
    }
    handle.stop = function () { stopped = true; clearTimeout(timer); };
    handle.kick = function () { if (!stopped) { clearTimeout(timer); tick(); } };
    handle.reset = function () { v = 0; handle.kick(); };
    document.addEventListener('visibilitychange', function () { if (!document.hidden) handle.kick(); });
    if (opts.immediate !== false) tick(); else schedule();
    return handle;
  }

  // ---- admin (Guru) auth — same token the Guru pages use ----
  var tokStore = store('ngh_admin_token');
  var admin = {
    token: function () { var t = tokStore.get(null); if (!t) return null; var exp = Number(String(t).split('.')[0]); if (exp && Date.now() > exp) { tokStore.del(); return null; } return t; },
    isLoggedIn: function () { return !!admin.token(); },
    login: function (code) {
      return fetchJSON('/api/admin-login', { method: 'POST', body: { code: code } }).then(function (j) {
        if (!j || !j.token) throw new Error('Login failed');
        tokStore.set(j.token); return j.token;
      });
    },
    logout: function () { tokStore.del(); },
    fetch: function (url, opts) {
      opts = opts || {}; opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + (admin.token() || '') });
      return fetchJSON(url, opts);
    }
  };

  // ---- keep screen on ----
  var wl = null;
  function wakeLock() {
    if (!(navigator.wakeLock && navigator.wakeLock.request)) return;
    navigator.wakeLock.request('screen').then(function (l) { wl = l; }).catch(function () {});
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !wl) navigator.wakeLock.request('screen').then(function (l) { wl = l; }).catch(function () {}); });
  }

  // ---- venue metadata (rooms & colors used by karaoke + companion) ----
  var roomsMeta = {
    commons: { name: 'The Commons', short: 'Commons', color: '#c9973a', text: '#26211a' },
    holt:    { name: 'The Holt',    short: 'Holt',    color: '#1488a6', text: '#fff' },
    depths:  { name: 'The Depths',  short: 'Depths',  color: '#7a2431', text: '#fff' },
    den:     { name: "Stash's Den", short: 'Den',     color: '#3d7a54', text: '#fff' }
  };

  // ---- PWA install prompt + service worker ----
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; document.dispatchEvent(new CustomEvent('ngh:caninstall')); });
  function promptInstall() { if (!deferredInstall) return Promise.resolve(false); var p = deferredInstall; deferredInstall = null; p.prompt(); return p.userChoice.then(function (c) { return c.outcome === 'accepted'; }); }
  if ('serviceWorker' in navigator && onSite && !IS_NATIVE) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(function () {}); });
  }

  // ---- bundled-native (Capacitor) link handling ----
  // In the store apps the /app/ shell is bundled locally (https://localhost or
  // capacitor://localhost). Everything else lives on gamehaven.guru:
  //   /app/...            -> stays in the bundled shell
  //   other site pages    -> in-app browser sheet (SFSafariViewController / Custom Tab)
  //   external sites      -> in-app browser sheet too (Stripe, VRBO, TCGplayer…)
  //   tel:/mailto:/maps   -> the OS
  function openExternal(url) {
    try {
      var P = window.Capacitor && window.Capacitor.Plugins;
      if (P && P.Browser) return P.Browser.open({ url: url, presentationStyle: 'popover', toolbarColor: '#132a1d' });
    } catch (e) {}
    window.open(url, '_blank', 'noopener');
  }
  function siteUrl(path) { return /^https?:/i.test(path) ? path : SITE + (path.charAt(0) === '/' ? '' : '/') + path; }
  // Navigate to any site path from script (used instead of location.href = '/events.html…')
  function go(path) {
    if (!path) return;
    if (onSite) { location.href = path; return; }
    if (path.indexOf('/app/') === 0) { location.href = path; return; }
    openExternal(siteUrl(path));
  }
  if (!onSite) {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || e.defaultPrevented) return;
      var h = a.getAttribute('href') || '';
      if (!h || h.charAt(0) === '#' || /^(tel|mailto|sms|geo|maps):/i.test(h) || /^javascript:/i.test(h)) return;
      if (h.indexOf('/app/') === 0) return;                          // bundled shell page
      if (h.charAt(0) === '/' || /^https?:/i.test(h)) {
        if (/^https?:\/\/(localhost|capacitor)/i.test(h)) return;
        e.preventDefault(); openExternal(siteUrl(h));
      }
    }, true);
  }

  // ---- deep links: https://gamehaven.guru/app/... opens the matching bundled page ----
  if (IS_NATIVE) {
    try {
      var App = window.Capacitor.Plugins.App;
      if (App) App.addListener('appUrlOpen', function (ev) {
        try {
          var u = new URL(ev.url);
          if (u.pathname.indexOf('/app/') === 0) location.href = u.pathname + u.search + u.hash;
          else if (/gamehaven\.guru$/.test(u.hostname)) openExternal(ev.url);
        } catch (e) {}
      });
    } catch (e) {}
  }

  // ---- native status bar / back button niceties ----
  if (IS_NATIVE) {
    try {
      var P = window.Capacitor.Plugins;
      if (P.StatusBar) { P.StatusBar.setBackgroundColor({ color: '#132a1d' }).catch(function () {}); P.StatusBar.setStyle({ style: 'DARK' }).catch(function () {}); }
      if (P.App) P.App.addListener('backButton', function (e) { if (e.canGoBack) history.back(); else P.App.exitApp(); });
      if (P.SplashScreen) setTimeout(function () { P.SplashScreen.hide().catch(function () {}); }, 300);
    } catch (e) {}
  }

  window.NGH = {
    SITE: SITE, API: API, IS_NATIVE: IS_NATIVE, DEVICE_ID: DEVICE_ID, ON_SITE: onSite,
    $: $, esc: esc, uid: uid, store: store, fetchJSON: fetchJSON, toast: toast, haptic: haptic, share: share,
    qrUrl: qrUrl, clock: clock, poll: poll, admin: admin, wakeLock: wakeLock, roomsMeta: roomsMeta,
    promptInstall: promptInstall, canInstall: function () { return !!deferredInstall; },
    open: openExternal, go: go, siteUrl: siteUrl
  };
})();
