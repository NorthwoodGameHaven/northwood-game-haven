#!/usr/bin/env node
// NGH-BUILD 2026-08-05a
//  1. events.html   — preserve line breaks / blank lines in public event descriptions
//  2. booking.html  — remove Web Promotions admin view (button, wrap div, setAdminView refs, full code block)
//  3. guru-addon.js — re-anchor toolbar link to view-events-btn (promos btn is gone)
//  4. guru.html     — add Web Promotions tile + section + JS (registry, entries table, CSV export)
//
// Node port of ngh-patch-2026-08-05a.py — same logic, same anchors, same guards.
// Run from repo root AFTER: git pull origin main --no-rebase
//   node ngh-patch-2026-08-05a.cjs
'use strict';
const fs = require('fs');

const MARK = "NGH-BUILD 2026-08-05a";

function load(p) {
  const raw = fs.readFileSync(p);
  const crlf = raw.includes(Buffer.from('\r\n'));
  return [raw.toString('utf8').replace(/\r\n/g, '\n'), crlf];
}
function save(p, src, crlf) {
  if (crlf) src = src.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, Buffer.from(src, 'utf8'));
}
function sub(src, oldStr, newStr, label) {
  const n = src.split(oldStr).length - 1;
  if (n !== 1) throw new Error('ABORT [' + label + ']: anchor found ' + n + 'x (expected 1)');
  return src.split(oldStr).join(newStr);
}
function cutBetween(src, start, end, label) {
  const i = src.indexOf(start);
  const j = src.indexOf(end);
  if (i === -1 || j === -1 || i >= j) throw new Error('ABORT [' + label + ']: block anchors not found in order');
  if (src.split(start).length - 1 !== 1 || src.split(end).length - 1 !== 1)
    throw new Error('ABORT [' + label + ']: block anchors not unique');
  return src.slice(0, i) + src.slice(j);
}
function markEnd(src, comment) {
  const i = src.lastIndexOf('</body>');
  if (i === -1) throw new Error('ABORT: </body> not found');
  return src.slice(0, i) + comment + '\n' + src.slice(i);
}
function resolvePath() {
  for (const n of arguments) if (fs.existsSync(n)) return n;
  return arguments[arguments.length - 1];
}

// ---------------------------------------------------------------- events.html
(function () {
  const p = resolvePath('site/events.html', 'events.html');
  let [src, crlf] = load(p);
  if (src.includes(MARK)) { console.log('skip ' + p + ' (already patched)'); return; }
  src = sub(src, "'<p style=\"font-size:0.92rem;color:#4a4a35;line-height:1.7;margin-bottom:16px;\">'+esc(e.notes)", "'<p style=\"font-size:0.92rem;color:#4a4a35;line-height:1.7;margin-bottom:16px;white-space:pre-line;\">'+esc(e.notes)", 'events pre-line');
  src = markEnd(src, '<!-- ' + MARK + ' · event descriptions keep line breaks -->');
  save(p, src, crlf);
  console.log('patched ' + p);
})();

// ---------------------------------------------------------------- booking.html
(function () {
  const p = resolvePath('site/booking.html', 'booking.html');
  let [src, crlf] = load(p);
  if (src.includes(MARK)) { console.log('skip ' + p + ' (already patched)'); return; }
  src = sub(src, "        <button class=\"btn btn-sm btn-ghost\" id=\"view-promos-btn\" onclick=\"setAdminView('promos')\">🎁 Web Promotions</button>\n", '', 'booking promos button');
  src = sub(src, "      <!-- WEB PROMOTIONS VIEW -->\n      <div id=\"promos-view-wrap\" style=\"display:none;\"></div>\n", '', 'booking promos wrap');
  src = sub(src, "  $(\"promos-view-wrap\").style.display = v===\"promos\" ? \"block\" : \"none\";\n", '', 'booking setAdminView display');
  src = sub(src, "  $(\"view-promos-btn\").className = \"btn btn-sm\"+(v===\"promos\"?\"\":\" btn-ghost\");\n", '', 'booking setAdminView class');
  src = sub(src, "  else if(v===\"promos\") renderPromosAdmin();\n", '', 'booking setAdminView route');
  src = cutBetween(src, "/* ================= WEB PROMOTIONS (admin) =================", "function showGroup(groupId){", 'booking promos block');
  src = markEnd(src, '<!-- ' + MARK + ' · Web Promotions moved to Guru Hub (guru.html) -->');
  save(p, src, crlf);
  console.log('patched ' + p);
})();

// ---------------------------------------------------------------- guru-addon.js
(function () {
  const p = resolvePath('site/guru-addon.js', 'guru-addon.js');
  let [src, crlf] = load(p);
  if (src.includes(MARK)) { console.log('skip ' + p + ' (already patched)'); return; }
  src = sub(src, "var promoBtn = gid(\"view-promos-btn\");", "var promoBtn = gid(\"view-events-btn\");", 'addon anchor 1');
  src = sub(src, "var pb = gid(\"view-promos-btn\");", "var pb = gid(\"view-events-btn\");", 'addon anchor 2');
  src = "/* NGH-BUILD 2026-08-05a · sched-link anchored to view-events-btn (promos btn removed) */\n" + src;
  save(p, src, crlf);
  console.log('patched ' + p);
})();

// ---------------------------------------------------------------- guru.html
(function () {
  const p = resolvePath('site/guru.html', 'guru.html');
  let [src, crlf] = load(p);
  if (src.includes(MARK)) { console.log('skip ' + p + ' (already patched)'); return; }
  const TILE = "      <a class=\"tile\" href=\"#promos\" onclick=\"document.getElementById('promos').scrollIntoView({behavior:'smooth'});return false;\">\n        <div class=\"t\">🎁 Web Promotions</div>\n        <div class=\"d\">Landing-page giveaways &amp; sign-ups — entry counts, lists, CSV export</div>\n      </a>\n";
  src = sub(src, "      <a class=\"tile\" href=\"checkin.html\">", TILE + "      <a class=\"tile\" href=\"checkin.html\">", 'guru tile');

  const SECTION = "\n    <!-- ============ WEB PROMOTIONS ============ -->\n    <h2 class=\"sec\" id=\"promos\">🎁 Web Promotions</h2>\n    <p class=\"muted\">Landing-page giveaways and sign-up promotions. Entry lists are admin-only; pages are unlisted (not linked from the site, not indexed).</p>\n    <div id=\"promo-list\"><p class=\"muted\">Loading…</p></div>\n";
  src = sub(src, "    <div id=\"bd-list\"><p class=\"muted\">Loading…</p></div>\n  </div>", "    <div id=\"bd-list\"><p class=\"muted\">Loading…</p></div>\n" + SECTION + "  </div>", 'guru section');

  const JSBLOCK = "/* ---------- web promotions ---------- */\nvar WEB_PROMOTIONS = [\n  { id:\"usa250\", title:\"USA 250 — $5 Store Cash Giveaway\", emoji:\"🎆\",\n    page:\"/USA250\", endpoint:\"/usa250\", cap:50,\n    desc:\"July 4th weekend giveaway. First 50 entrants receive $5 store credit (Lightspeed). Launched via Facebook Live.\" }\n];\nvar promoData = {};   /* id -> {cap,count,entries} */\nvar promoShow = {};   /* id -> entries table expanded */\nfunction renderPromos(){\n  var el = $(\"promo-list\"); if(!el) return;\n  var h = \"\";\n  WEB_PROMOTIONS.forEach(function(p){\n    var d = promoData[p.id];\n    h += '<div class=\"card\" style=\"margin-bottom:14px;\">' +\n      '<div style=\"display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;\">' +\n        '<div><b style=\"color:var(--forest);\">' + p.emoji + ' ' + esc(p.title) + '</b>' +\n        '<div class=\"muted\" style=\"margin-top:3px;\">' + esc(p.desc) + '</div></div>' +\n        '<span class=\"badge\" style=\"white-space:nowrap;\">' + (d ? (d.count + ' / ' + d.cap + ' entries') : '—') + '</span>' +\n      '</div>' +\n      '<div style=\"display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center;\">' +\n        '<a class=\"btn ghost small\" href=\"' + p.page + '\" target=\"_blank\" rel=\"noopener\">🔗 Open page</a>' +\n        '<button class=\"btn small\" onclick=\"loadPromo(\\'' + p.id + '\\',true)\">👥 ' + (promoShow[p.id] ? 'Refresh entries' : 'View entries') + '</button>' +\n        '<button class=\"btn ghost small\" onclick=\"exportPromoCSV(\\'' + p.id + '\\')\"' + (d && d.entries.length ? '' : ' disabled') + '>📥 Download CSV</button>' +\n      '</div>' +\n      '<div style=\"margin-top:10px;overflow-x:auto;\">' + (promoShow[p.id] && d ? promoTableHTML(p, d) : '') + '</div>' +\n    '</div>';\n  });\n  el.innerHTML = h || '<p class=\"muted\">No promotions configured.</p>';\n}\nfunction promoTableHTML(p, d){\n  if(!d.entries.length) return '<p class=\"muted\" style=\"margin:6px 0 0;\">No entries yet.</p>';\n  var th = 'style=\"text-align:left;padding:6px 8px;border-bottom:2px solid var(--forest);\"';\n  var td = 'style=\"padding:5px 8px;border-bottom:1px solid #eef0ec;\"';\n  var h = '<table style=\"width:100%;border-collapse:collapse;font-size:13px;\">' +\n    '<tr><th ' + th + '>#</th><th ' + th + '>Name</th><th ' + th + '>Phone</th><th ' + th + '>Email</th><th ' + th + '>Agreed</th><th ' + th + '>Submitted</th></tr>';\n  d.entries.forEach(function(e){\n    var over = e.seq > d.cap;\n    h += '<tr' + (over ? ' style=\"opacity:.55;\"' : '') + '>' +\n      '<td ' + td + '>' + e.seq + (over ? ' <span class=\"muted\">(past cap)</span>' : '') + '</td>' +\n      '<td ' + td + '>' + esc(e.name) + '</td>' +\n      '<td ' + td + '>' + esc(promoPhone(e.phone)) + '</td>' +\n      '<td ' + td + '>' + esc(e.email) + '</td>' +\n      '<td ' + td + '>' + (e.agreed ? '✓ Yes' : '✗ NO') + '</td>' +\n      '<td ' + td.slice(0,-1) + 'white-space:nowrap;\"' + '>' + new Date(e.submitted).toLocaleString() + '</td></tr>';\n  });\n  return h + '</table>';\n}\nfunction promoPhone(p){ p = String(p||\"\"); return p.length===10 ? \"(\"+p.slice(0,3)+\") \"+p.slice(3,6)+\"-\"+p.slice(6) : p; }\nasync function loadPromo(id, show){\n  var p = WEB_PROMOTIONS.filter(function(x){ return x.id===id; })[0]; if(!p) return;\n  if(show) promoShow[id] = true;\n  try{\n    promoData[id] = await api(p.endpoint);\n    renderPromos();\n  }catch(e){ if(show) toast(\"Couldn't load entries: \" + ((e && e.message) || e)); }\n}\nfunction exportPromoCSV(id){\n  var p = WEB_PROMOTIONS.filter(function(x){ return x.id===id; })[0], d = promoData[id];\n  if(!p || !d || !d.entries.length) return;\n  var rows = [[\"Entry #\",\"Name\",\"Phone\",\"Email\",\"Agreed to Terms\",\"Submitted (local)\",\"Submitted (ISO)\"]];\n  d.entries.forEach(function(e){\n    rows.push([e.seq, e.name, promoPhone(e.phone), e.email, (e.agreed ? \"Yes\" : \"No\"), new Date(e.submitted).toLocaleString(), e.submitted]);\n  });\n  var csv = rows.map(function(r){ return r.map(function(v){ v = String(v==null?\"\":v); return /[\",\\n]/.test(v) ? '\"'+v.replace(/\"/g,'\"\"')+'\"' : v; }).join(\",\"); }).join(\"\\r\\n\");\n  var blob = new Blob([csv], {type:\"text/csv\"});\n  var a = document.createElement(\"a\"); a.href = URL.createObjectURL(blob); a.download = p.id + \"-entries.csv\"; a.click();\n}\n\n";
  src = sub(src, "/* ---------- boot ---------- */", JSBLOCK + "/* ---------- boot ---------- */", 'guru js block');
  src = sub(src, "  showApp();\n  loadStats();", "  showApp();\n  loadStats();\n  renderPromos();\n  WEB_PROMOTIONS.forEach(function(p){ loadPromo(p.id, false); });", 'guru boot');
  src = markEnd(src, '<!-- ' + MARK + ' · Web Promotions console (moved from booking admin) -->');
  save(p, src, crlf);
  console.log('patched ' + p);
})();

console.log('done — all files patched or already current');
