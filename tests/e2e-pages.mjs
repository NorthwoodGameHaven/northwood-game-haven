#!/usr/bin/env node
// NGH-BUILD 2026-09-11a
// End-to-end walk of the account / shop / shop-orders / guru-lightspeed pages against
// tests/mock-api.mjs, using Playwright chromium at iPhone-ish 390×844.
//   node tests/e2e-pages.mjs            (screenshots → $SHOTS or tests/screenshots)
// Fails (exit 1) on any assertion or any console/page error other than Google Fonts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8888; // ngh-app.js treats localhost:8888 as on-site → relative /api hits the mock.
// Any other PORT works too: an init script points window.NGH_SITE_URL at the mock (the bundled-native code path).
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || path.join(root, 'tests', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const issues = [];
function ok(name, cond, detail) { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ' — ' + detail : ''}`); if (!cond) issues.push(name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IGNORE = /fonts\.googleapis\.com|fonts\.gstatic\.com|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY|ERR_TUNNEL/;

// ---- mock server ----
try { const r = await fetch(BASE + '/api/events'); console.error(`Port ${PORT} is already serving (HTTP ${r.status}, server=${r.headers.get('server')}) — stop it first.`); process.exit(2); } catch {}
const mock = spawn(process.execPath, [path.join(root, 'tests', 'mock-api.mjs')], { env: { ...process.env, PORT: String(PORT), QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let mockDied = false;
mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
mock.on('exit', (code) => { if (code) mockDied = true; });
for (let i = 0; i < 50; i++) { if (mockDied) { console.error(`mock server exited early — is something else on port ${PORT}?`); process.exit(2); } try { const r = await fetch(BASE + '/api/events'); if (r.ok) break; } catch {} await sleep(100); }

const browser = await chromium.launch();
const consoleErrors = [];
let expect401 = false; // set around deliberate bad-credential steps (Chromium logs a console error for any 401 response)
async function newPage(context, label) {
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text()) && !(expect401 && /status of 401/.test(m.text()))) consoleErrors.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { const t = `${r.url()} ${r.failure() && r.failure().errorText}`; if (!IGNORE.test(t)) consoleErrors.push(`[${label}] requestfailed: ${t}`); });
  page.on('dialog', (d) => d.accept());
  if (PORT !== 8888) await page.addInitScript(() => { window.NGH_SITE_URL = location.origin; });
  return page;
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(`layout: no horizontal overflow (${name})`, over <= 0, over + 'px wider than the viewport');
}
const vp = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en-US', timezoneId: 'America/Chicago' };

try {
  const ctx = await browser.newContext(vp);

  // ================================================================ home tiles
  {
    const page = await newPage(ctx, 'home');
    await page.goto(BASE + '/app/');
    const hrefs = await page.$$eval('.grid .tile', (els) => els.map((e) => e.getAttribute('href')));
    const iRetail = hrefs.indexOf('/app/specials.html?cat=retail');
    ok('home: Haven Rewards tile follows Retail Specials', hrefs[iRetail + 1] === '/app/account.html', hrefs.join(','));
    ok('home: Order Ahead tile follows Haven Rewards', hrefs[iRetail + 2] === '/app/shop.html');
    await shot(page, '00-home');
    await page.close();
  }

  // ================================================================ account
  {
    const page = await newPage(ctx, 'account');
    await page.goto(BASE + '/app/account.html');
    await page.waitForSelector('#vEmail:not([hidden])');
    await shot(page, '10-account-signed-out');
    await page.fill('#email', 'jordan@example.com');
    await page.click('#btnSend');
    await page.waitForSelector('#vCode:not([hidden])');
    ok('account: resend button cools down', (await page.textContent('#btnResend')).startsWith('Resend in'));
    await shot(page, '11-account-code');
    await page.type('#code', '123456');                 // auto-submits on the 6th digit
    await page.waitForSelector('#vDash:not([hidden])', { timeout: 8000 });
    ok('account: balance renders $12.50', (await page.textContent('#dBalance')).trim() === '$12.50');
    ok('account: earn rule from loyalty.ratio', (await page.textContent('#dRule')).includes('Earn 5¢ for every $1'));
    ok('account: customer group pill', (await page.textContent('#dGroup')).trim() === 'Haven Regulars');
    ok('account: customer code shown', (await page.textContent('#dCode')).trim() === 'NGH-4821');
    await page.waitForFunction(() => { const i = document.getElementById('dQr'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 }).catch(() => {});
    ok('account: QR image loaded', await page.$eval('#dQr', (i) => i.complete && i.naturalWidth > 0));
    ok('account: QR url uses NGH.qrUrl with the customer code', (await page.$eval('#dQr', (i) => i.src)).includes(encodeURIComponent('https://gamehaven.guru/app/account.html?c=NGH-4821')));
    ok('account: upcoming has booking + registration', (await page.$$('#dUp li')).length === 2);
    ok('account: recent purchases listed', (await page.$$('#dPurchases li')).length === 3);
    ok('account: order-ahead orders with status pill', (await page.$$('#dOrders li .pill')).length >= 1);
    ok('account: X-NGH-Session stored', await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('ngh_account') || '{}'); return !!s.session && s.email === 'jordan@example.com'; }));
    await shot(page, '12-account-dashboard');
    // profile save
    await page.fill('#pPhone', '(715) 555-0143');
    await page.click('#btnSave');
    // an earlier toast ("Signed in…") can still be on screen — wait for the save message itself
    await page.waitForFunction(() => { const t = document.querySelector('.toast.show'); return t && /Profile saved/.test(t.textContent); }, null, { timeout: 8000 }).catch(() => {});
    ok('account: profile save toast', ((await page.textContent('.toast')) || '').includes('Profile saved'));
    // 401 handling: poison the session and reload
    await page.evaluate(() => localStorage.setItem('ngh_account', JSON.stringify({ session: 'bogus.0.0', email: 'jordan@example.com' })));
    expect401 = true;
    await page.reload();
    await page.waitForSelector('#vEmail:not([hidden])', { timeout: 8000 });
    expect401 = false;
    ok('account: 401 clears the session and shows sign-in', await page.evaluate(() => localStorage.getItem('ngh_account') === null));
    // sign-up path for an unknown email
    await page.fill('#email', 'new@example.com');
    await page.click('#btnSend');
    await page.waitForSelector('#vCode:not([hidden])');
    await page.type('#code', '123456');
    await page.waitForSelector('#vSignup:not([hidden])', { timeout: 8000 });
    await shot(page, '13-account-signup');
    await page.fill('#suFirst', 'Riley'); await page.fill('#suLast', 'Chen'); await page.fill('#suPhone', '(715) 555-0100');
    await page.click('#btnSignup');
    await page.waitForSelector('#vDash:not([hidden])', { timeout: 8000 });
    ok('account: sign-up lands on dashboard with $0.00', (await page.textContent('#dBalance')).trim() === '$0.00');
    ok('account: sign-up name shown', (await page.textContent('#dName')).trim() === 'Riley Chen');
    // sign out, sign back in as Jordan so the shop test sees a rewards member
    await page.click('#btnSignOut');
    await page.waitForSelector('#vEmail:not([hidden])');
    await page.fill('#email', 'jordan@example.com'); await page.click('#btnSend');
    await page.waitForSelector('#vCode:not([hidden])'); await page.type('#code', '123456');
    await page.waitForSelector('#vDash:not([hidden])', { timeout: 8000 });
    // staff QR landing
    await page.goto(BASE + '/app/account.html?c=NGH-4821');
    await page.waitForSelector('#staffCode:not([hidden])');
    ok('account: ?c= shows the staff code banner', (await page.textContent('#staffCodeVal')).trim() === 'NGH-4821');
    await page.close();
  }

  // ================================================================ shop (signed in → pay at pickup)
  {
    const page = await newPage(ctx, 'shop');
    await page.goto(BASE + '/app/shop.html');
    await page.waitForSelector('.prod');
    ok('shop: in-stock filter hides the sold-out float', (await page.$$('.prod')).length === 4);
    await page.click('#inStock');
    ok('shop: all 5 products with filter off', (await page.$$('.prod')).length === 5);
    ok('shop: stock hint "2 left"', (await page.$$eval('.prod .stock', (els) => els.map((e) => e.textContent))).includes('2 left'));
    ok('shop: placeholder crest for missing image', await page.$eval('.prod[data-id="p_float"] img', (i) => i.classList.contains('ph') && i.getAttribute('src') === '/brand/crest.png'));
    await page.click('#inStock');
    await page.fill('#q', 'catan');
    ok('shop: search narrows to 1', (await page.$$('.prod')).length === 1);
    await page.fill('#q', '');
    await page.click('.chip[data-type="TCG"]');
    ok('shop: type chip filters', (await page.$$('.prod')).length === 2);
    await page.click('.chip[data-type=""]');
    await shot(page, '20-shop-catalog');
    // add Catan ×2
    await page.click('.prod[data-id="p_catan"]');
    await page.waitForSelector('#detail:not([hidden])');
    await page.click('#dPlus');
    ok('shop: detail button shows line total', (await page.textContent('#dAdd')).includes('$99.98'));
    await shot(page, '21-shop-detail');
    await page.click('#dAdd');
    await page.waitForSelector('#cartbar:not([hidden])');
    ok('shop: cart bar after Catan ×2', (await page.textContent('#cbTotal')) === '$99.98' && (await page.textContent('#cbCount')) === '2 items');
    // add NES controller ×1
    await page.click('.prod[data-id="p_nes_ctrl"]');
    await page.waitForSelector('#detail:not([hidden])');
    await page.click('#dAdd');
    await sleep(150);
    ok('shop: cart bar after 2 products', (await page.textContent('#cbTotal')) === '$119.97' && (await page.textContent('#cbCount')) === '3 items');
    // persistence
    await page.reload();
    await page.waitForSelector('#cartbar:not([hidden])');
    ok('shop: cart persists across reload (ngh_cart)', (await page.textContent('#cbTotal')) === '$119.97');
    ok('shop: in-cart badge on card', (await page.textContent('.prod[data-id="p_catan"] .incart')) === '×2 in cart');
    // cart sheet
    await page.click('#btnCart');
    await page.waitForSelector('#cart:not([hidden])');
    ok('shop: cart total correct', (await page.textContent('#cTotal')) === '$119.97');
    await page.click('.cl [data-a="-"]');       // Catan 2 → 1
    ok('shop: stepper updates total', (await page.textContent('#cTotal')) === '$69.98');
    ok('shop: pickup slots offered', (await page.$$('#slot option')).length > 0);
    ok('shop: signed-in contact prefilled', await page.$eval('#contactSum', (e) => !e.hidden) && (await page.textContent('#csName')).trim() === 'Jordan Rivers');
    await page.fill('#cNote', 'Bag it please');
    await shot(page, '22-shop-cart');
    await page.click('#btnPayPickup');
    await page.waitForSelector('#vDone:not([hidden])', { timeout: 8000 });
    const oid = (await page.textContent('#doneId')).trim();
    ok('shop: pay-at-pickup success shows ORD id', /^ORD-[A-Z0-9]{4,6}$/.test(oid), oid);
    ok('shop: cart cleared after order', await page.evaluate(() => JSON.parse(localStorage.getItem('ngh_cart')).items.length === 0));
    await shot(page, '23-shop-success');
    // the order appears on the account page
    await page.goto(BASE + '/app/account.html');
    await page.waitForSelector('#vDash:not([hidden])');
    ok('account: new order shows under order-ahead', (await page.textContent('#dOrders')).includes(oid));
    // tapping it opens the receipt (?order=…&t=<token>)
    await page.click('#dOrders li');
    await page.waitForURL(/shop\.html\?order=ORD-/, { timeout: 8000 });
    await page.waitForSelector('#rLines .rline');
    ok('shop: account order link opens the receipt with a pay-at-pickup pill', (await page.textContent('#rStatus')).includes('Pay at pickup') && (await page.textContent('#rId')).trim() === oid);
    await page.close();
  }

  // ================================================================ shop (guest → pay now → receipt)
  {
    const gctx = await browser.newContext(vp);
    const page = await newPage(gctx, 'shop-guest');
    await page.goto(BASE + '/app/shop.html');
    await page.waitForSelector('.prod');
    await page.click('.prod[data-id="p_mtg_cmdr"]');
    await page.waitForSelector('#detail:not([hidden])');
    await page.click('#dPlus');                                   // stock is 2 → + is now disabled
    ok('shop: qty capped at stock', (await page.textContent('#dQty')) === '2' && await page.$eval('#dPlus', (b) => b.disabled));
    await page.click('#dAdd');
    await page.click('#btnCart');
    await page.waitForSelector('#cart:not([hidden])');
    ok('shop: guest sees contact inputs', await page.$eval('#contactForm', (e) => !e.hidden));
    await page.click('#btnPayNow');
    await page.waitForSelector('#cErr:not(:empty)');
    ok('shop: validation blocks empty contact', (await page.textContent('#cErr')).length > 0);
    await page.fill('#cName', 'Sam Okafor'); await page.fill('#cEmail', 'sam@example.com'); await page.fill('#cPhone', '7155550199');
    await page.click('#btnPayNow');
    await page.waitForURL(/paid=1&order=ORD-/, { timeout: 8000 });   // mock "Stripe" bounces straight back (backend's success URL shape)
    await page.waitForSelector('#vReceipt:not([hidden])');
    await page.waitForSelector('#rLines .rline');
    ok('shop: receipt shows paid status', (await page.textContent('#rStatus')).includes('Paid'));
    ok('shop: receipt total', (await page.textContent('#rTotal')) === '$89.98');
    ok('shop: cart cleared after paid return', await page.evaluate(() => JSON.parse(localStorage.getItem('ngh_cart') || '{"items":[1]}').items.length === 0));
    await shot(page, '24-shop-receipt');
    await page.close(); await gctx.close();
  }

  // ================================================================ shop-orders (admin)
  {
    const page = await newPage(ctx, 'shop-orders');
    await page.goto(BASE + '/app/shop-orders.html');
    await page.waitForSelector('#gate:not([hidden])');
    await shot(page, '30-orders-gate');
    expect401 = true;
    await page.fill('#adminCode', 'wrong'); await page.click('#btnLogin');
    await page.waitForSelector('#gateErr:not(:empty)');
    expect401 = false;
    ok('orders: wrong code rejected', (await page.textContent('#gateErr')).includes("didn't match"));
    await page.fill('#adminCode', '1234'); await page.click('#btnLogin');
    await page.waitForSelector('#queue:not([hidden])');
    await page.waitForSelector('.order');
    const n = (await page.$$('.order')).length;
    ok('orders: queue lists orders', n >= 4, String(n));
    ok('orders: grouped — new/paid + parked populated', (await page.$$('#gNew .order')).length >= 2 && (await page.$$('#gParked .order')).length >= 2);
    await shot(page, '31-orders-queue');
    const parkedId = await page.$eval('#gParked .order', (e) => e.getAttribute('data-id'));
    await page.click(`#gParked .order[data-id="${parkedId}"] button[data-s="ready"]`);
    await page.waitForSelector(`#gReady .order[data-id="${parkedId}"]`, { timeout: 8000 });
    ok('orders: Mark ready moves the order to Ready', true);
    await page.click(`#gReady .order[data-id="${parkedId}"] button[data-s="picked_up"]`);
    await page.waitForSelector(`#gDone .order[data-id="${parkedId}"]`, { timeout: 8000 });
    ok('orders: Picked up moves it to today\'s done list', true);
    // new order arrives → toast (+ sound ping path)
    const r = await fetch(BASE + '/api/shop/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ping Test', email: 'ping@example.com', items: [{ id: 'p_sv_booster', qty: 4 }], pickupAt: new Date(Date.now() + 3600000).toISOString(), pay: 'pickup' }) });
    const pingOrder = (await r.json()).order.id;
    await page.click('#btnRefresh');
    await page.waitForSelector(`.order.fresh[data-id="${pingOrder}"]`, { timeout: 8000 });
    ok('orders: new order highlighted + toast', (await page.textContent('.toast')).includes('New order ' + pingOrder));
    ok('orders: AudioContext created for the ping', await page.evaluate(() => !!(window.AudioContext || window.webkitAudioContext)));
    await shot(page, '32-orders-new');
    await page.close();
  }

  // ================================================================ guru-lightspeed (admin, already logged in via shared token)
  {
    const page = await newPage(ctx, 'lightspeed');
    await page.goto(BASE + '/app/guru-lightspeed.html?connected=1');
    await page.waitForSelector('#content:not([hidden])');
    ok('lightspeed: ?connected=1 toast', (await page.textContent('.toast')).includes('connected'));
    ok('lightspeed: URL cleaned', !page.url().includes('connected='));
    ok('lightspeed: shows Connected', (await page.textContent('#cTitle')).trim() === 'Connected');
    ok('lightspeed: domain', (await page.textContent('#cDomain')).includes('northwoodgamehaven.retail.lightspeed.app'));
    ok('lightspeed: token expiry', (await page.textContent('#cExpires')).includes('expires in'));
    const tables = await page.$$eval('#refs .card', (cards) => cards.map((c) => ({ title: c.querySelector('h2').textContent, rows: c.querySelectorAll('table.ref tr').length, env: [...c.querySelectorAll('.envname')].map((e) => e.textContent) })));
    ok('lightspeed: 5 reference tables', tables.length === 5, JSON.stringify(tables));
    ok('lightspeed: every table has rows', tables.every((t) => t.rows > 0));
    ok('lightspeed: env var names on tables', tables.some((t) => t.env.includes('LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT')) && tables.some((t) => t.env.includes('LIGHTSPEED_TAX_ID')));
    ok('lightspeed: "in use" pill marks the 5 configured ids', (await page.$$('#refs .pill.cur')).length === 5, String((await page.$$('#refs .pill.cur')).length));
    ok('lightspeed: config card marks the unset on-account type optional', (await page.textContent('#cfgList')).includes('optional') && (await page.textContent('#cfgList')).includes('LIGHTSPEED_CLIENT_ID'));
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const firstId = await page.$eval('#refs .cp', (b) => b.getAttribute('data-copy'));
    await page.click('#refs .cp');
    await page.waitForFunction(() => document.querySelector('.toast').textContent.startsWith('Copied'), null, { timeout: 8000 });
    ok('lightspeed: copy id puts the id on the clipboard', (await page.evaluate(() => navigator.clipboard.readText())) === firstId, firstId);
    await page.click('#btnSync');
    await page.waitForFunction(() => document.querySelector('.toast').textContent.includes('synced'), null, { timeout: 8000 });
    ok('lightspeed: sync toast', (await page.textContent('.toast')).includes('5 products'));
    await page.selectOption('#rpKind', 'registration'); await page.fill('#rpId', 'reg_z9y8');
    await page.click('#btnReplay');
    await page.waitForFunction(() => document.querySelector('.toast').textContent.includes('Replayed'), null, { timeout: 8000 });
    ok('lightspeed: replay toast names the sale', /Replayed → sale ls_sale_\d+/.test(await page.textContent('.toast')), await page.textContent('.toast'));
    ok('lightspeed: unsynced list shows the remaining booking part', (await page.textContent('#unsynced')).includes('bk_20260905_holt:deposit'));
    await shot(page, '40-lightspeed');
    // connect button → admin-token query param → mock consent → back with ?connected=1
    await page.click('#btnConnect');
    await page.waitForURL(/guru-lightspeed\.html/, { timeout: 8000 });
    await page.waitForSelector('#content:not([hidden])');
    ok('lightspeed: Connect round-trip returns to the page', true);
    // ?error= path
    await page.goto(BASE + '/app/guru-lightspeed.html?error=access_denied');
    await page.waitForSelector('.toast.show');
    ok('lightspeed: ?error= toast', (await page.textContent('.toast')).includes('access_denied'));
    // disconnect → not connected state
    await page.click('#btnDisconnect');
    await page.waitForFunction(() => document.getElementById('cTitle').textContent === 'Not connected', null, { timeout: 8000 });
    ok('lightspeed: disconnect renders Not connected', true);
    await shot(page, '41-lightspeed-disconnected');
    await page.close();
  }
  await ctx.close();
} catch (e) {
  issues.push('exception: ' + e.message);
  console.error('EXCEPTION', e);
} finally {
  await browser.close();
  mock.kill();
}

console.log('\n---- console / page / network errors (Google Fonts ignored) ----');
if (consoleErrors.length) consoleErrors.forEach((e) => console.log('  ' + e)); else console.log('  none');
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed · screenshots in ${SHOTS}`);
if (issues.length || consoleErrors.length) { console.log('FAILED:', issues.join('; ') || 'console errors'); process.exit(1); }
