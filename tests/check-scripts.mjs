#!/usr/bin/env node
// NGH-BUILD 2026-09-11a
// Parses every inline <script> block in the given HTML files (default: the app pages
// built for the Lightspeed integration) with vm.Script so a syntax error fails fast.
//   node tests/check-scripts.mjs [file.html ...]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2).length ? process.argv.slice(2) : [
  'site/app/account.html', 'site/app/shop.html', 'site/app/shop-orders.html', 'site/app/guru-lightspeed.html', 'site/app/index.html'
].map((f) => path.join(root, f));

// NGH-BUILD 2026-09-12q: skip blocks that are not JavaScript. booking.html
// carries a <script type="application/ld+json"> block of structured data,
// which is JSON and has never been parseable as JS — so this checker reported
// a failure on every single run against that file. A validator that always
// fails is a validator everybody learns to ignore, which is worse than not
// having one. check-scripts-all.mjs and every patch script already skip these.
const JS_TYPES = ['', 'module', 'text/javascript', 'application/javascript'];
let failed = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, n = 0, skipped = 0;
  while ((m = re.exec(html))) {
    const t = (/type\s*=\s*["']([^"']+)["']/i.exec(m[1] || '') || [, ''])[1].trim().toLowerCase();
    if (JS_TYPES.indexOf(t) < 0) { skipped++; continue; }
    if (!m[2].trim()) continue;
    n++;
    try { new vm.Script(m[2], { filename: `${path.basename(file)}#script${n}` }); }
    catch (e) { failed++; console.error(`FAIL ${path.relative(root, file)} script #${n}: ${e.message}`); }
  }
  console.log(`${failed ? '' : 'ok  '}${path.relative(root, file)}: ${n} inline script block${n === 1 ? '' : 's'} parsed${skipped ? ` (${skipped} non-JS block${skipped === 1 ? '' : 's'} skipped)` : ''}`);
}
if (failed) { console.error(`${failed} script block(s) failed to parse`); process.exit(1); }
