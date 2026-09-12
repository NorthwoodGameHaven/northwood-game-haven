// NGH-BUILD 2026-09-11a
// tests/index.js — lets `node --test tests/` work on Node 21+ (where --test arguments
// are glob patterns, so a bare directory is executed as a module). A bare dynamic
// import works whether this file is treated as CommonJS or ESM (the repo root
// package.json is "type": "module"). `node --test tests/*.test.mjs` also works.
import('./lightspeed.test.mjs');
