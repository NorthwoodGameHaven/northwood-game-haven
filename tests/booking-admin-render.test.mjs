// NGH-BUILD 2026-09-12p
// tests/booking-admin-render.test.mjs — the Guru console request list, and the
// proof that opening it can no longer cancel a customer's booking.
//
// Reported from the shop: the Rejected tab highlighted, the tab itself saying
// "Rejected (20)", and the panel underneath saying "No pending requests." —
// twenty bookings the Guru could see the count of and not reach.
//
// The cause was `el.innerHTML = list.map(reqCardHtml).join("")`. One booking
// that throws takes the exception out of renderAdmin BEFORE innerHTML is
// assigned, so the panel silently keeps whatever the previous tab rendered.
// On a fresh console that is the default Pending tab's empty state — hence a
// pending message under a rejected tab.
//
// These tests pull the REAL function text out of site/booking.html and run it,
// so they test the shipped code rather than a copy of it that can drift.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'site', 'booking.html'), 'utf8');

// Pull one top-level `function name(...){...}` out of the page by brace
// counting. Naive brace counting would trip over braces inside strings, so
// this walks the source tracking quotes, template literals and comments.
function extractFunction(src, name) {
  let start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'could not find function ' + name + ' in booking.html');
  // Keep an `async` prefix. Slicing from `function` alone strips it, and the
  // extracted body then fails to parse the moment it contains `await` — which
  // silently looks like "the page is broken" rather than "the test is".
  const before = src.slice(Math.max(0, start - 10), start);
  const m = /(async\s+)$/.exec(before);
  if (m) start -= m[1].length;
  let i = src.indexOf('{', start), depth = 0;
  let str = null, esc = false, line = false, block = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i++; } continue; }
    if (str) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const renderAdminSrc = extractFunction(HTML, 'renderAdmin');
const autoCancelSrc = extractFunction(HTML, 'autoCancelUnpaid');
const approveSrc = extractFunction(HTML, 'approve');

// ---- a sandbox with just enough of the page to run those two --------------
function makeSandbox(bookings, opts = {}) {
  const el = { innerHTML: '' };
  const tabsEl = { innerHTML: '' };
  const logged = { errors: [], warns: [] };
  const sb = {
    cache: { bookings },
    adminFilter: 'pending',
    $: (id) => (id === 'requests-list' ? el : id === 'admin-tabs' ? tabsEl : null),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    reqCardHtml: opts.reqCardHtml || ((r) => '<div class="card" data-id="' + r.id + '">' + r.id + '</div>'),
    renderAdminTabs: function () {
      const counts = { all: 0, pending: 0, approved: 0, hold: 0, rejected: 0 };
      sb.cache.bookings.forEach(r => { counts.all++; counts[r.status] = (counts[r.status] || 0) + 1; });
      tabsEl.innerHTML = JSON.stringify(counts);
    },
    console: {
      error: (...a) => logged.errors.push(a.join(' ')),
      warn: (...a) => logged.warns.push(a.join(' ')),
      log: () => { }
    },
    // autoCancelUnpaid dependencies
    feeIsPaid: (r) => !!r.feePaid,
    depIsPaid: (r) => !!r.depositPaid,
    refreshCache: async () => { },
    // approve() dependencies. The conflict scan is stubbed clean so the
    // confirm() gauntlet never fires — this test is about what approve WRITES.
    getReq: (id) => bookings.find(b => b.id === id) || null,
    bookingConflictScan: () => ({ red: [], tight: [] }),
    roomName: (x) => String(x),
    _evById: () => null,
    confirm: () => true,
    resendApproval: async () => { },
    renderAdmin: () => { },
    Store: {
      updated: [],
      async updateBooking(id, patch) { sb.Store.updated.push({ id, patch }); Object.assign(bookings.find(b => b.id === id), patch); },
      async sendEmail(to, subj) { sb.Store.sent.push({ to, subj }); },
      sent: []
    }
  };
  sb.Store.sent = [];
  vm.createContext(sb);
  vm.runInContext(renderAdminSrc + '\n' + autoCancelSrc + '\n' + approveSrc, sb);
  return { sb, el, tabsEl, logged };
}

const bk = (id, status, over = {}) => ({ id, status, name: 'Guest ' + id, date: '2026-09-01', ...over });

// ---------------------------------------------------------------------------
describe('the Rejected tab actually shows rejected bookings', () => {
  test('twenty rejected bookings render twenty cards', () => {
    const list = Array.from({ length: 20 }, (_, i) => bk('BK-' + i, 'rejected'));
    const { sb, el } = makeSandbox(list.concat([bk('A1', 'approved'), bk('A2', 'approved')]));
    sb.renderAdmin('rejected');
    assert.equal((el.innerHTML.match(/data-id=/g) || []).length, 20);
    assert.ok(!/No pending requests/.test(el.innerHTML));
  });

  test('the empty state names the tab you are actually on', () => {
    const { sb, el } = makeSandbox([bk('A1', 'approved')]);
    sb.renderAdmin('rejected');
    assert.match(el.innerHTML, /No rejected requests/);
    sb.renderAdmin('hold');
    assert.match(el.innerHTML, /No hold requests/);
  });
});

describe('one malformed booking cannot blank the tab', () => {
  // This is the regression. Before the fix, a single throwing record meant
  // innerHTML was never assigned and the panel kept the PREVIOUS tab's content.
  const throwOn = (badId) => (r) => {
    if (r.id === badId) throw new TypeError("Cannot read properties of undefined (reading 'map')");
    return '<div class="card" data-id="' + r.id + '">' + r.id + '</div>';
  };

  test('the other nineteen still render', () => {
    const list = Array.from({ length: 20 }, (_, i) => bk('BK-' + i, 'rejected'));
    const { sb, el } = makeSandbox(list, { reqCardHtml: throwOn('BK-7') });
    sb.renderAdmin('rejected');
    assert.equal((el.innerHTML.match(/data-id=/g) || []).length, 19);
  });

  test('the broken one is shown by id, not silently dropped', () => {
    const list = [bk('BK-1', 'rejected'), bk('BK-2', 'rejected', { name: 'Robyn' })];
    const { sb, el } = makeSandbox(list, { reqCardHtml: throwOn('BK-2') });
    sb.renderAdmin('rejected');
    assert.match(el.innerHTML, /BK-2/, 'the Guru must still be able to see which booking is broken');
    assert.match(el.innerHTML, /Robyn/, 'and who it belongs to');
    assert.match(el.innerHTML, /could not be displayed/);
  });

  test('the stale message from the previous tab is gone', () => {
    const list = [bk('BK-1', 'rejected')];
    const { sb, el } = makeSandbox(list, { reqCardHtml: throwOn('BK-1') });
    sb.renderAdmin('pending');                       // no pending -> empty state
    assert.match(el.innerHTML, /No pending requests/);
    sb.renderAdmin('rejected');                      // the reported situation
    assert.ok(!/No pending requests/.test(el.innerHTML),
      'the rejected tab must never still be showing the pending empty state');
  });

  test('the failure is reported to the console rather than swallowed', () => {
    const { sb, logged } = makeSandbox([bk('BK-1', 'rejected')], { reqCardHtml: throwOn('BK-1') });
    sb.renderAdmin('rejected');
    assert.ok(logged.errors.some(e => /BK-1/.test(e)), 'the failing id belongs in the console');
    assert.ok(logged.warns.some(w => /1 of 1/.test(w)));
  });

  test('every record throwing still leaves a usable page', () => {
    const list = Array.from({ length: 3 }, (_, i) => bk('BK-' + i, 'rejected'));
    const { sb, el } = makeSandbox(list, { reqCardHtml: () => { throw new Error('boom'); } });
    sb.renderAdmin('rejected');
    assert.equal((el.innerHTML.match(/could not be displayed/g) || []).length, 3);
  });
});

// ---------------------------------------------------------------------------
// NGH-BUILD 2026-09-12p — THE BROWSER DOES NOT CANCEL BOOKINGS. AT ALL.
//
// These tests used to check that auto-cancel fired in the right circumstances.
// That was the wrong question. Robyn PAID her booking fee, owed only the
// day-of deposit, and a background function running in a Guru's browser tab
// cancelled her party and emailed her about it — repeatedly, because
// re-approving her booking just handed it back to the same function.
//
// There is no set of circumstances in which a web page should cancel a paying
// customer. So the tests below do not describe a policy with exceptions. They
// assert an absolute: under every combination of date, payment state and flag,
// autoCancelUnpaid() writes nothing and sends nothing.
//
// If you are here because a test failed after you re-added the feature: that
// is the test working. Whatever the requirement is, it belongs in
// netlify/functions/auto-cancel.mjs where one nightly run is reviewable and a
// human sees the ops digest — not in a function that fires whenever somebody
// opens the console on their phone.
describe('the browser can no longer cancel anybody', () => {
  const past = '2026-09-01';                 // deadline long gone
  const today = new Date().toISOString().slice(0, 10);
  const future = '2099-01-01';

  // Every shape the old code branched on, and several it did not.
  const cases = [
    ['past, nothing paid', { date: past }],
    ['today, nothing paid — the old cancel window', { date: today }],
    ['future, nothing paid', { date: future }],
    ["Robyn: fee paid, deposit due on the day", { date: today, feePaid: true }],
    ['deposit paid, fee due', { date: today, depositPaid: true }],
    ['both paid', { date: today, feePaid: true, depositPaid: true }],
    ['payment: paid', { date: today, payment: 'paid' }],
    ['on account in Lightspeed', { date: today, payment: 'onaccount' }],
    ['fee on account', { date: today, feeOnAccount: true }],
    ['previously auto-cancelled and re-approved', { date: today, autoCanceled: true }],
    ['carrying the old exemption flag', { date: today, autoCancelExempt: true }],
    ['carrying no exemption flag', { date: today, autoCancelExempt: false }],
    ['recurring occurrence', { date: today, groupId: 'G1', recIndex: 2, recTotal: 8 }],
    ['birthday party', { date: today, birthdayParty: true }],
    ['no date at all', {}],
    ['no email address', { date: today, email: undefined }]
  ];

  for (const [label, over] of cases) {
    test(`leaves it alone: ${label}`, async () => {
      const b = bk('BK-X', 'approved', { email: 'robyn@example.com', ...over });
      const { sb } = makeSandbox([b]);
      const changed = await sb.autoCancelUnpaid();
      assert.equal(changed, false, 'must report no change');
      assert.equal(b.status, 'approved', 'the booking must still be approved');
      assert.equal(sb.Store.updated.length, 0, 'nothing may be written');
      assert.equal(sb.Store.sent.length, 0, 'and no customer may be emailed');
    });
  }

  test('a whole console-load worth of bookings, nothing touched', async () => {
    // The real call site ran over the entire cache on every console load.
    const list = [];
    for (let i = 0; i < 60; i++) {
      list.push(bk('BK-' + i, ['approved', 'pending', 'rejected', 'hold'][i % 4], {
        date: [past, today, future][i % 3],
        feePaid: i % 5 === 0,
        depositPaid: i % 7 === 0,
        email: 'guest' + i + '@example.com'
      }));
    }
    const before = list.map(b => b.status).join(',');
    const { sb } = makeSandbox(list);
    assert.equal(await sb.autoCancelUnpaid(), false);
    assert.equal(list.map(b => b.status).join(','), before, 'not one status may change');
    assert.equal(sb.Store.updated.length, 0);
    assert.equal(sb.Store.sent.length, 0);
  });

  test('it cannot reach the write or the mailer at all', () => {
    // Behaviour tests only prove the current branch is safe. This proves there
    // is no branch: the shipped function body does not mention the two calls
    // that could hurt a customer.
    assert.ok(!/updateBooking/.test(autoCancelSrc),
      'autoCancelUnpaid must not be able to write to a booking');
    assert.ok(!/sendEmail/.test(autoCancelSrc),
      'autoCancelUnpaid must not be able to email a customer');
    assert.ok(!/rejected/.test(autoCancelSrc),
      'autoCancelUnpaid must not be able to set a rejected status');
  });

  test('nothing on the page calls it any more', () => {
    // The call site was `autoCancelUnpaid().then(...)` in enterConsole. If it
    // ever comes back, this fails before anyone opens the console.
    const calls = HTML.match(/autoCancelUnpaid\s*\(/g) || [];
    assert.equal(calls.length, 1,
      'the only occurrence of autoCancelUnpaid( should be its own declaration — found ' + calls.length);
    assert.ok(/async function autoCancelUnpaid\s*\(/.test(HTML));
  });
});

describe('approving a booking approves it, and does nothing else', () => {
  test('re-approving a rejected booking writes only the status', async () => {
    // Robyn's booking. A Guru re-approving it must not need to set a flag to
    // defend it from the software — there is nothing to defend it from.
    const b = bk('BK-RE', 'rejected', { date: new Date().toISOString().slice(0, 10), autoCanceled: true, email: 'robyn@example.com' });
    const { sb } = makeSandbox([b]);
    await sb.approve('BK-RE');
    assert.equal(sb.Store.updated.length, 1);
    // Cross-realm object (built inside the vm), so compare shape, not identity.
    assert.deepEqual(Object.keys(sb.Store.updated[0].patch), ['status'],
      'approve() must write exactly {status:"approved"} and no vestigial flags');
    assert.equal(sb.Store.updated[0].patch.status, 'approved');
    assert.equal(b.status, 'approved');
  });

  test('and it stays approved afterwards', async () => {
    const b = bk('BK-RE2', 'rejected', { date: new Date().toISOString().slice(0, 10), autoCanceled: true, email: 'robyn@example.com' });
    const { sb } = makeSandbox([b]);
    await sb.approve('BK-RE2');
    sb.Store.updated.length = 0; sb.Store.sent.length = 0;
    assert.equal(await sb.autoCancelUnpaid(), false);
    assert.equal(b.status, 'approved', 'this is the loop that emailed Robyn over and over');
    assert.equal(sb.Store.sent.length, 0);
  });

  test('a fresh pending booking is approved the same way', async () => {
    const b = bk('BK-NEW', 'pending', { date: new Date().toISOString().slice(0, 10), email: 'x@example.com' });
    const { sb } = makeSandbox([b]);
    await sb.approve('BK-NEW');
    assert.deepEqual(Object.keys(sb.Store.updated[0].patch), ['status']);
    assert.equal(sb.Store.updated[0].patch.status, 'approved');
  });
});

// ---------------------------------------------------------------------------
// NGH-BUILD 2026-09-12aa — the staff gate.
//
// booking.html printed "Demo code: stash2026" on screen and carried the same
// string as the fallback for ADMIN_CODE. Live server mode has been on since
// ngh-config.js set NGH_API_BASE, so the demo gate was unreachable and the
// code was dead — but it still read to any visitor, and to a store reviewer,
// as a published staff password.
//
// Blanking it exposed a second problem: the check was `code === ADMIN_CODE`,
// so with no code configured an EMPTY input satisfied it. A gate with nothing
// set must refuse everything, not accept anything.
describe('staff access gate', () => {
  const CONFIG = fs.readFileSync(path.join(ROOT, 'site', 'ngh-config.js'), 'utf8');

  test('the demo code appears nowhere in the shipped site', () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(html|js|mjs|json|css)$/i.test(e.name)) continue;
        if (fs.readFileSync(p, 'utf8').includes('stash2026')) hits.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, 'site'));
    assert.deepEqual(hits, [], 'a staff code must not be committed to a public site');
  });

  test('the gate screen no longer prints a code to the visitor', () => {
    const gate = HTML.slice(HTML.indexOf('id="admin-gate"'), HTML.indexOf('id="admin-panel"'));
    assert.doesNotMatch(gate, /Demo code/i);
    assert.doesNotMatch(gate, /<code>[^<]{6,}<\/code>/, 'nothing that looks like a literal code');
  });

  test('live server mode is on, so the demo gate is unreachable', () => {
    assert.match(CONFIG, /window\.NGH_API_BASE\s*=\s*"\/\.netlify\/functions"/,
      'if this is ever commented out the demo gate becomes live again');
    assert.match(CONFIG, /window\.NGH_ADMIN_CODE\s*=\s*""/);
  });

  // Evaluate the REAL shipped demo-gate expression, pulled out of the page, so
  // this cannot drift from what booking.html actually does. `login` is an
  // object method rather than a top-level function, so extractFunction can't
  // reach it — the one line is what matters here anyway.
  const GATE = /if\(!this\.apiMode\(\)\)\{\s*return ([^;]+);\s*\}/.exec(HTML);
  function demoLogin(configuredCode, typed) {
    assert.ok(GATE, 'the demo-gate line has moved — update this test');
    const ctx = { ADMIN_CODE: configuredCode, code: typed, result: undefined };
    vm.createContext(ctx);
    vm.runInContext('result = (' + GATE[1] + ');', ctx);
    return ctx.result;
  }

  test('with no code configured the gate refuses an empty box', () => {
    assert.equal(demoLogin('', ''), false,
      'this was the fail-open: "" === "" unlocked the console');
  });

  test('with no code configured the gate refuses a guess', () => {
    assert.equal(demoLogin('', 'stash2026'), false);
    assert.equal(demoLogin('', 'anything'), false);
  });

  test('a configured demo code still works, and only it', () => {
    assert.equal(demoLogin('hunter2', 'hunter2'), true);
    assert.equal(demoLogin('hunter2', 'wrong'), false);
    assert.equal(demoLogin('hunter2', ''), false);
  });
});

// ---------------------------------------------------------------------------
// NGH-BUILD 2026-09-12ab — the three documents Google cross-checks.
//
// The Play listing's publisher is Northwood Experiences LLC; the privacy page
// speaks for Northwood Game Haven (ECCentric LLC). A reviewer comparing them
// would fairly ask which company holds the data, so both pages now say. These
// tests exist so the two pages cannot drift apart later — a mismatch between
// the privacy page and the Data safety form is the most common cause of a
// rejected Play update, and this is the same failure one step earlier.
describe('privacy / deletion page consistency', () => {
  const PRIVACY = fs.readFileSync(path.join(ROOT, 'site', 'privacy.html'), 'utf8');
  const DELETE = fs.readFileSync(path.join(ROOT, 'site', 'account-delete.html'), 'utf8');
  const strip = (h) => h.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const P = strip(PRIVACY), D = strip(DELETE);

  test('the privacy page names both companies and their roles', () => {
    assert.match(P, /ECCentric LLC/);
    assert.match(P, /Northwood Experiences LLC/);
    assert.match(P, /built, hosted and published by/, 'says what the software company actually does');
  });

  test('it is unambiguous which company holds the data', () => {
    // Northwood Experiences owns the software; ECCentric/NGH holds the
    // customer data. A page that names two companies without saying which is
    // which is worse than one that names only the operator.
    assert.match(P, /does not use your information for anything of its own/i);
    assert.match(P, /on Northwood Game Haven's behalf/i);
  });

  test('it says overnight booking leaves the site', () => {
    // The app links out to vrbo.com; a privacy page that never mentions it
    // implies we handle lodging data, and we do not.
    assert.match(P, /VRBO/);
    assert.match(P, /their privacy policy applies/i);
  });

  test('the deletion page names the same two companies', () => {
    assert.match(D, /ECCentric LLC/);
    assert.match(D, /Northwood Experiences LLC/);
  });

  test('both pages agree on the retention exception', () => {
    for (const [name, t] of [['privacy', P], ['deletion', D]]) {
      assert.match(t, /tax/i, name + ' page must disclose the tax retention exception');
    }
  });

  test('both pages give the same contact address', () => {
    for (const [name, t] of [['privacy', P], ['deletion', D]]) {
      assert.match(t, /stash@northwoodgamehaven\.com/, name + ' page');
      assert.match(t, /115 W Spring St/, name + ' page');
    }
  });

  test('the privacy page still points at the deletion page', () => {
    assert.match(PRIVACY, /href="\/account-delete"/,
      'Play wants the deletion route discoverable from the policy');
  });

  test('neither page claims data goes somewhere the app does not send it', () => {
    // Named processors must match what the code actually uses. Anything else
    // here would be a promise we are not keeping.
    for (const bogus of ['Google Analytics', 'Facebook', 'advertising partners', 'Mixpanel']) {
      assert.doesNotMatch(P, new RegExp(bogus, 'i'), 'privacy page mentions ' + bogus);
    }
  });
});
