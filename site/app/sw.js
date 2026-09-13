/* NGH App service worker — NGH-BUILD 2026-09-11a
   Strategy: precache the app shell; network-first for HTML and /api/ (never cache API);
   stale-while-revalidate for static assets (css/js/png/fonts). Bump VERSION on every deploy
   that changes shell files so installed PWAs pick them up. */
var VERSION = 'ngh-app-2026-09-13c';
var SHELL = [
  '/app/', '/app/index.html', '/app/app.css', '/app/ngh-app.js', '/app/manifest.webmanifest',
  '/app/icons/icon-192.png', '/app/icons/icon-512.png',
  '/app/companion/index.html', '/app/companion/first-player.html', '/app/companion/turn-tracker.html',
  '/app/companion/life-counter.html', '/app/companion/rpg.html',
  '/app/karaoke/index.html', '/app/karaoke/join.html', '/app/karaoke/karaoke-lyrics.js', '/app/karaoke/cdg.js',
  '/app/karaoke/karaoke-client.js', '/app/karaoke/providers.js',
  '/app/specials.html', '/app/account.html', '/app/shop.html', '/app/trivia/play.html',
  '/brand/crest.png', '/brand/stash-fullbody.png',
  // The seasonal crests. Small on purpose (33-49 KB each, against 247 KB for
  // crest.png) so the whole year fits offline and the swap never shows a gap.
  '/brand/seasonal/default.png', '/brand/seasonal/blossom.png', '/brand/seasonal/sunflower.png',
  '/brand/seasonal/autumn.png', '/brand/seasonal/halloween.png', '/brand/seasonal/fireworks.png'
];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/.netlify/') === 0) return; // live data: never cached
  var isHTML = req.mode === 'navigate' || /\.html$/.test(url.pathname) || url.pathname.slice(-1) === '/';
  if (isHTML) {
    e.respondWith(fetch(req).then(function (r) {
      var copy = r.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); return r;
    }).catch(function () { return caches.match(req).then(function (m) { return m || caches.match('/app/index.html'); }); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (m) {
    var net = fetch(req).then(function (r) { if (r && r.ok) { var copy = r.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); } return r; }).catch(function () { return m; });
    return m || net;
  }));
});
self.addEventListener('message', function (e) { if (e.data === 'skipWaiting') self.skipWaiting(); });
