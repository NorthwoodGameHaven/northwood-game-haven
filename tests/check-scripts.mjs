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

let failed = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    n++;
    try { new vm.Script(m[1], { filename: `${path.basename(file)}#script${n}` }); }
    catch (e) { failed++; console.error(`FAIL ${path.relative(root, file)} script #${n}: ${e.message}`); }
  }
  console.log(`${failed ? '' : 'ok  '}${path.relative(root, file)}: ${n} inline script block${n === 1 ? '' : 's'} parsed`);
}
if (failed) { console.error(`${failed} script block(s) failed to parse`); process.exit(1); }
