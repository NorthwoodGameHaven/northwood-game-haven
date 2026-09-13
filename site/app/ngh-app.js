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

  // ---- seasonal crest — NGH-BUILD 2026-09-13a --------------------------
  // The otter changes coat with the calendar. Every page in the app already
  // shows /brand/crest.png, so the swap happens here once instead of in
  // twenty files four times a year.
  //
  // Preview any of them without waiting for October:  ?logo=halloween
  // It sticks for the session; ?logo=auto hands it back to the calendar.
  var LOGOS = {
    blossom:   '/brand/seasonal/blossom.png',
    sunflower: '/brand/seasonal/sunflower.png',
    autumn:    '/brand/seasonal/autumn.png',
    halloween: '/brand/seasonal/halloween.png',
    fireworks: '/brand/seasonal/fireworks.png',
    // Winter has no art of its own yet, so it uses the plain crest — but the
    // CIRCLE-FIT copy, not the crest.png sitting in the markup. Both places the
    // app shows one apply border-radius:50% (the 36px header crest, the 150px
    // hero in its gold ring) and a box-fitted square loses its corners to that:
    // the ends of the wordmark and the whole row of game components under it.
    // Drop a logo-winter.png in site/brand/, add it to CRESTS in
    // tools/make-icons.mjs, and give it a key here.
    'default': '/brand/seasonal/default.png'
  };
  // month*100+day, so the windows read like a calendar and can be tested
  // without faking a clock. Holidays win over the season they sit inside.
  function seasonKey(d) {
    var md = (d.getMonth() + 1) * 100 + d.getDate();
    if (md >= 628 && md <= 706) return 'fireworks';    // Independence Day week
    if (md >= 1015 && md <= 1101) return 'halloween';
    if (md >= 320 && md <= 619) return 'blossom';      // spring
    if (md >= 620 && md <= 921) return 'sunflower';    // summer
    if (md >= 922 && md <= 1220) return 'autumn';      // fall
    return 'default';        // winter — no snow art yet, so the plain crest
  }
  var logoPin = store('ngh_logo');
  function logoKey() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('logo'); } catch (e) {}
    if (q === 'auto') logoPin.del();
    else if (q && LOGOS.hasOwnProperty(q)) logoPin.set(q);
    var pinned = logoPin.get(null);
    if (pinned && LOGOS.hasOwnProperty(pinned)) return pinned;
    return seasonKey(new Date());
  }
  function logoSrc() { return LOGOS[logoKey()] || '/brand/crest.png'; }
  function applyLogo() {
    var src = LOGOS[logoKey()];
    if (!src) return;
    var imgs = document.querySelectorAll('img[src$="/brand/crest.png"],img[data-crest]');
    for (var i = 0; i < imgs.length; i++) imgs[i].src = src;
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
  // NGH-BUILD 2026-09-12ah — make a directory path explicit before navigating.
  //
  // Capacitor's Android WebViewLocalServer serves the ROOT index.html for any
  // request whose last path segment contains no dot. So in the packaged app
  // "/app/companion/" did not open the companion index — it served www/index.html,
  // the stub that redirects to /app/index.html, and the tap silently bounced you
  // back to the top of the app home page. It worked perfectly on the website,
  // where Netlify resolves the directory, which is why it survived to a device.
  //
  // Every link is now written as .../index.html, and this catches anything that
  // slips through later — a new page, or a TV QR pointing at a directory.
  function withIndex(path) {
    var m = /^([^?#]*)([?#][\s\S]*)?$/.exec(path);
    var p = m[1], rest = m[2] || '';
    if (p.charAt(p.length - 1) === '/') p += 'index.html';
    return p + rest;
  }
  // Navigate to any site path from script (used instead of location.href = '/events.html…')
  function go(path) {
    if (!path) return;
    if (onSite) { location.href = path; return; }
    if (path.indexOf('/app/') === 0) { location.href = withIndex(path); return; }
    openExternal(siteUrl(path));
  }
  if (!onSite) {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || e.defaultPrevented) return;
      var h = a.getAttribute('href') || '';
      if (!h || h.charAt(0) === '#' || /^(tel|mailto|sms|geo|maps):/i.test(h) || /^javascript:/i.test(h)) return;
      if (h.indexOf('/app/') === 0) {                                // bundled shell page
        // A directory href would hit the root-index fallback described above.
        var fixed = withIndex(h);
        if (fixed !== h) { e.preventDefault(); location.href = fixed; }
        return;
      }
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
          if (u.pathname.indexOf('/app/') === 0) location.href = withIndex(u.pathname + u.search + u.hash);
          else if (/gamehaven\.guru$/.test(u.hostname)) openExternal(ev.url);
        } catch (e) {}
      });
    } catch (e) {}
  }

  // ---- confirm sheet — NGH-BUILD 2026-09-13a ---------------------------
  // A real element rather than window.confirm(): the system dialog freezes the
  // WebView, looks nothing like the app, and cannot be dismissed by the back
  // button. Returns a Promise<boolean>. Back closes it, which is why it
  // registers a guard of its own.
  function confirmDialog(o) {
    o = o || {};
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.className = 'sheet';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML = '<div><h2 class="cf-t"></h2><p class="small muted cf-b"></p>' +
        '<div class="btn-row"><button class="btn ghost cf-n"></button><button class="btn cf-y"></button></div></div>';
      wrap.querySelector('.cf-t').textContent = o.title || 'Are you sure?';
      var body = wrap.querySelector('.cf-b');
      if (o.body) body.textContent = o.body; else body.parentNode.removeChild(body);
      var no = wrap.querySelector('.cf-n'), yes = wrap.querySelector('.cf-y');
      no.textContent = o.cancel || 'Cancel';
      yes.textContent = o.ok || 'OK';
      if (o.danger) yes.className = 'btn danger cf-y';
      function done(v) {
        off();
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        document.removeEventListener('keydown', key, true);
        resolve(v);
      }
      function key(e) { if (e.key === 'Escape') { e.preventDefault(); done(false); } }
      var off = onBack(function () { done(false); return true; });
      no.onclick = function () { done(false); };
      yes.onclick = function () { done(true); };
      wrap.addEventListener('click', function (e) { if (e.target === wrap) done(false); });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(wrap);
      setTimeout(function () { try { no.focus(); } catch (e) {} }, 0);
    });
  }

  // ---- back: a hierarchy, not a tape — NGH-BUILD 2026-09-13a -----------
  // Android's hardware back used to call history.back(), which walks the
  // WebView's session history. Every move inside the bundled shell is a full
  // page load, so an ordinary trip through the companion tools records
  //
  //     home -> companion -> life counter -> companion -> turn tracker
  //
  // and two presses of back from the turn tracker land you in the LIFE
  // COUNTER — a tool you had already finished with. That is the reported
  // "back flips between the tools" behaviour: the tape remembers a path the
  // screen has forgotten, and a few more presses drop you out of the app
  // entirely with no warning.
  //
  // Back now walks the hierarchy the app already draws. The header's ‹ link IS
  // the parent, so there is exactly one source of truth and no page declares
  // its place twice. Pages intercept with NGH.onBack(fn) — return true if the
  // press was consumed — and the app never closes without asking first.
  var backGuards = [];
  function onBack(fn) {
    backGuards.push(fn);
    return function () { var i = backGuards.indexOf(fn); if (i >= 0) backGuards.splice(i, 1); };
  }
  function headerBack() {
    var a = document.querySelector('.app-header .back[href]');
    return a ? a.getAttribute('href') : null;
  }
  // Pure, so the whole map can be tested: where does one back press go?
  // null means nowhere left — ask before leaving the app.
  function backTarget(here, href) {
    var p = String(here || '').split('?')[0].split('#')[0];
    if (/^\/app\/(index\.html)?$/.test(p)) return null;            // the app home screen
    if (href && href.indexOf('/app/') === 0) return withIndex(href);
    return '/app/index.html';   // no ‹ at all, or one pointing off the shell (/guru.html)
  }
  function goBack() {
    for (var i = backGuards.length - 1; i >= 0; i--) {             // newest guard first
      try { if (backGuards[i]() === true) return; } catch (e) {}
    }
    var t = backTarget(location.pathname, headerBack());
    // replace(), not assign(): the tape must never grow a second opinion.
    if (t) { location.replace(t); return; }
    confirmDialog({
      title: 'Close the app?',
      body: "You're on the home screen — one more back closes Game Haven.",
      ok: 'Close app', cancel: 'Stay', danger: true
    }).then(function (yes) {
      if (!yes) return;
      try { window.Capacitor.Plugins.App.exitApp(); } catch (e) {}
    });
  }

  // ---- native status bar / back button niceties ----
  if (IS_NATIVE) {
    try {
      var P = window.Capacitor.Plugins;
      if (P.StatusBar) { P.StatusBar.setBackgroundColor({ color: '#132a1d' }).catch(function () {}); P.StatusBar.setStyle({ style: 'DARK' }).catch(function () {}); }
      if (P.App) P.App.addListener('backButton', function () { goBack(); });
      if (P.SplashScreen) setTimeout(function () { P.SplashScreen.hide().catch(function () {}); }, 300);
    } catch (e) {}
  }

  window.NGH = {
    SITE: SITE, API: API, IS_NATIVE: IS_NATIVE, DEVICE_ID: DEVICE_ID, ON_SITE: onSite,
    $: $, esc: esc, uid: uid, store: store, fetchJSON: fetchJSON, toast: toast, haptic: haptic, share: share,
    qrUrl: qrUrl, clock: clock, poll: poll, admin: admin, wakeLock: wakeLock, roomsMeta: roomsMeta,
    promptInstall: promptInstall, canInstall: function () { return !!deferredInstall; },
    open: openExternal, go: go, siteUrl: siteUrl,
    confirm: confirmDialog, onBack: onBack, goBack: goBack, backTarget: backTarget,
    LOGOS: LOGOS, seasonKey: seasonKey, logoKey: logoKey, logoSrc: logoSrc
  };

  applyLogo();
  document.addEventListener('DOMContentLoaded', applyLogo);
})();
