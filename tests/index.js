// NGH-BUILD 2026-09-12l
// tests/index.js — lets `node --test tests/` work on Node 21+ (where --test arguments
// are glob patterns, so a bare directory is executed as a module). A bare dynamic
// import works whether this file is treated as CommonJS or ESM (the repo root
// package.json is "type": "module").
//
// It deliberately loads ONE suite. Suites that install module hooks (lightspeed
// via _mock-hooks.mjs, speedgaming via _speedgaming-hooks.mjs) must not share a
// process: the loader chains every registered hook, so two sets of mocks fight
// over the same imports. The test runner already gives each FILE its own
// process, so run the whole suite with the glob instead:
//
//     node --test tests/*.test.mjs
//
import('./lightspeed.test.mjs');
