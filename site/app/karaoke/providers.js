/* =====================================================================
   NGH Karaoke — content provider adapters (client side)
   NGH-BUILD 2026-09-11a

   The engine is provider-agnostic. A provider answers two questions:
     search(q)     -> [{ id, title, artist, durationMs, provider, hasLyrics }]
     resolve(id)   -> { media:{audio, cdg, video}, lyrics: TimedLyrics|null, durationMs }
   `local` is the shipped provider: songs imported into karaoke_songs by
   the rack-PC importer (MP3+G / MP3+LRC) and served by /api/karaoke.
   `karafun` and `stingray` are stubs with the integration contract spelled
   out so they can be filled in once API access exists (see docs).
   ===================================================================== */
(function () {
  'use strict';
  var API = (window.NGH ? NGH.API : '/api') + '/karaoke';

  var local = {
    id: 'local', name: 'Haven library',
    search: function (q) { return NGH.fetchJSON(API + '/songs?q=' + encodeURIComponent(q || '')).then(function (j) { return (j.songs || []).map(function (s) { s.provider = 'local'; return s; }); }); },
    resolve: function (id) { return NGH.fetchJSON(API + '/songs/' + encodeURIComponent(id)).then(function (m) { return NGH.fetchJSON(API + '/songs/' + encodeURIComponent(id) + '/lyrics').then(function (l) { return { media: m.media, lyrics: l.lyrics, durationMs: m.durationMs }; }); }); },
    licensingNote: 'Files you own (MP3+G / MP3+LRC). Venue PRO licences (ASCAP/BMI/SESAC) cover public performance.'
  };

  // KaraFun OEM / API partnership (contact-sales). Expected shape once granted:
  //   GET  {base}/v1/songs?query=…            -> catalog search (title, artist, duration, id)
  //   GET  {base}/v1/songs/{id}/stream        -> audio/video stream URL (short-lived)
  //   GET  {base}/v1/songs/{id}/lyrics        -> syllable-synced lyrics -> KLyrics.fromKaraFun()
  // Requests must be proxied by a Netlify function (never expose the partner key to browsers):
  //   /api/karaoke/providers/karafun/search?q=   and   /api/karaoke/providers/karafun/resolve/:id
  var karafun = {
    id: 'karafun', name: 'KaraFun (OEM API)', enabled: false,
    search: function () { return Promise.resolve([]); },
    resolve: function () { return Promise.reject(new Error('KaraFun OEM API not connected — see docs/NGH-APP-SETUP.md')); },
    licensingNote: 'KaraFun handles licensing and royalties for content delivered through the OEM API.'
  };

  // Stingray Karaoke REST API (developer ToS). Similar proxy pattern; note their
  // design guidelines (Stingray logo, prescribed navigation, no offline caching).
  var stingray = {
    id: 'stingray', name: 'Stingray Karaoke API', enabled: false,
    search: function () { return Promise.resolve([]); },
    resolve: function () { return Promise.reject(new Error('Stingray API not connected')); },
    licensingNote: 'Licensed streaming; UI constraints apply — evaluate before committing.'
  };

  var providers = { local: local, karafun: karafun, stingray: stingray };
  function enabled() { return Object.keys(providers).map(function (k) { return providers[k]; }).filter(function (p) { return p.enabled !== false; }); }
  function search(q) { return Promise.all(enabled().map(function (p) { return p.search(q).catch(function () { return []; }); })).then(function (lists) { return [].concat.apply([], lists); }); }

  window.KProviders = { providers: providers, enabled: enabled, search: search };
})();
