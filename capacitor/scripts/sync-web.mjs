// capacitor/scripts/sync-web.mjs — NGH-BUILD 2026-09-11a
// Builds capacitor/www from the website sources so the store apps bundle the
// /app/ shell locally (fast start, works offline) and talk to gamehaven.guru
// for live data. Run automatically by `npm run sync` / `add:*`.
//   www/index.html   → redirect to /app/index.html
//   www/app/**       ← site/app/**
//   www/brand/**     ← site/brand/**
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAP = path.resolve(HERE, '..');
const SITE = path.resolve(CAP, '..', 'site');
const WWW = path.join(CAP, 'www');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    const st = fs.statSync(s);                                   // follows symlinks
    if (st.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
fs.rmSync(WWW, { recursive: true, force: true });
copyDir(path.join(SITE, 'app'), path.join(WWW, 'app'));
copyDir(path.join(SITE, 'brand'), path.join(WWW, 'brand'));
// the service worker is for the website PWA only — the native shell never registers it
fs.rmSync(path.join(WWW, 'app', 'sw.js'), { force: true });
fs.writeFileSync(path.join(WWW, 'index.html'),
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<meta http-equiv="refresh" content="0;url=/app/index.html"><body style="background:#132a1d"><script>location.replace("/app/index.html")</script>');
let n = 0; (function count(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) count(path.join(d, e.name)); else n++; } })(WWW);
console.log('www ready —', n, 'files from', SITE);
