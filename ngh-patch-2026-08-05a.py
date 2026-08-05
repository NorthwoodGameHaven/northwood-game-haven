#!/usr/bin/env python3
# NGH-BUILD 2026-08-05a
#  1. events.html  — preserve line breaks / blank lines in public event descriptions (white-space:pre-line)
#  2. booking.html — remove Web Promotions admin view (button, wrap div, setAdminView refs, full code block)
#  3. guru-addon.js — re-anchor "🦦 Guru Schedule" toolbar link to view-events-btn (promos btn is gone)
#  4. guru.html    — add Web Promotions tile + section + JS (registry, entries table, CSV export)
#
# Run from repo root AFTER: git pull origin main --no-rebase
#   python3 ngh-patch-2026-08-05a.py
import sys, os

MARK = "NGH-BUILD 2026-08-05a"

def load(p):
    with open(p, "rb") as f:
        raw = f.read()
    crlf = b"\r\n" in raw
    return raw.decode("utf-8").replace("\r\n", "\n"), crlf

def save(p, src, crlf):
    if crlf:
        src = src.replace("\n", "\r\n")
    with open(p, "wb") as f:
        f.write(src.encode("utf-8"))

def sub(src, old, new, label):
    n = src.count(old)
    assert n == 1, f"ABORT [{label}]: anchor found {n}x (expected 1)"
    return src.replace(old, new)

def cut_between(src, start, end, label):
    i = src.find(start)
    j = src.find(end)
    assert i != -1 and j != -1 and i < j, f"ABORT [{label}]: block anchors not found in order"
    assert src.count(start) == 1 and src.count(end) == 1, f"ABORT [{label}]: block anchors not unique"
    return src[:i] + src[j:]

def mark_end(src, comment):
    i = src.rfind("</body>")
    assert i != -1, "ABORT: </body> not found"
    return src[:i] + comment + "\n" + src[i:]

# ---------------------------------------------------------------- events.html
p = "site/events.html" if os.path.exists("site/events.html") else "events.html"
src, crlf = load(p)
if MARK in src:
    print(f"skip {p} (already patched)")
else:
    src = sub(src,
        "'<p style=\"font-size:0.92rem;color:#4a4a35;line-height:1.7;margin-bottom:16px;\">'+esc(e.notes)",
        "'<p style=\"font-size:0.92rem;color:#4a4a35;line-height:1.7;margin-bottom:16px;white-space:pre-line;\">'+esc(e.notes)",
        "events pre-line")
    src = mark_end(src, f"<!-- {MARK} · event descriptions keep line breaks -->")
    save(p, src, crlf)
    print(f"patched {p}")

# ---------------------------------------------------------------- booking.html
p = "site/booking.html" if os.path.exists("site/booking.html") else "booking.html"
src, crlf = load(p)
if MARK in src:
    print(f"skip {p} (already patched)")
else:
    src = sub(src,
        "        <button class=\"btn btn-sm btn-ghost\" id=\"view-promos-btn\" onclick=\"setAdminView('promos')\">\U0001F381 Web Promotions</button>\n",
        "", "booking promos button")
    src = sub(src,
        "      <!-- WEB PROMOTIONS VIEW -->\n      <div id=\"promos-view-wrap\" style=\"display:none;\"></div>\n",
        "", "booking promos wrap")
    src = sub(src,
        "  $(\"promos-view-wrap\").style.display = v===\"promos\" ? \"block\" : \"none\";\n",
        "", "booking setAdminView display")
    src = sub(src,
        "  $(\"view-promos-btn\").className = \"btn btn-sm\"+(v===\"promos\"?\"\":\" btn-ghost\");\n",
        "", "booking setAdminView class")
    src = sub(src,
        "  else if(v===\"promos\") renderPromosAdmin();\n",
        "", "booking setAdminView route")
    src = cut_between(src,
        "/* ================= WEB PROMOTIONS (admin) =================",
        "function showGroup(groupId){",
        "booking promos block")
    src = mark_end(src, f"<!-- {MARK} · Web Promotions moved to Guru Hub (guru.html) -->")
    save(p, src, crlf)
    print(f"patched {p}")

# ---------------------------------------------------------------- guru-addon.js
p = "site/guru-addon.js" if os.path.exists("site/guru-addon.js") else "guru-addon.js"
src, crlf = load(p)
if MARK in src:
    print(f"skip {p} (already patched)")
else:
    src = sub(src, 'var promoBtn = gid("view-promos-btn");', 'var promoBtn = gid("view-events-btn");', "addon anchor 1")
    src = sub(src, 'var pb = gid("view-promos-btn");', 'var pb = gid("view-events-btn");', "addon anchor 2")
    src = "/* " + MARK + " · sched-link anchored to view-events-btn (promos btn removed) */\n" + src
    save(p, src, crlf)
    print(f"patched {p}")

# ---------------------------------------------------------------- guru.html
p = "site/guru.html" if os.path.exists("site/guru.html") else "guru.html"
src, crlf = load(p)
if MARK in src:
    print(f"skip {p} (already patched)")
else:
    TILE = """      <a class="tile" href="#promos" onclick="document.getElementById('promos').scrollIntoView({behavior:'smooth'});return false;">
        <div class="t">\U0001F381 Web Promotions</div>
        <div class="d">Landing-page giveaways &amp; sign-ups \u2014 entry counts, lists, CSV export</div>
      </a>
"""
    src = sub(src,
        "      <a class=\"tile\" href=\"checkin.html\">",
        TILE + "      <a class=\"tile\" href=\"checkin.html\">",
        "guru tile")

    SECTION = """
    <!-- ============ WEB PROMOTIONS ============ -->
    <h2 class="sec" id="promos">\U0001F381 Web Promotions</h2>
    <p class="muted">Landing-page giveaways and sign-up promotions. Entry lists are admin-only; pages are unlisted (not linked from the site, not indexed).</p>
    <div id="promo-list"><p class="muted">Loading\u2026</p></div>
"""
    src = sub(src,
        "    <div id=\"bd-list\"><p class=\"muted\">Loading\u2026</p></div>\n  </div>",
        "    <div id=\"bd-list\"><p class=\"muted\">Loading\u2026</p></div>\n" + SECTION + "  </div>",
        "guru section")

    JSBLOCK = """/* ---------- web promotions ---------- */
var WEB_PROMOTIONS = [
  { id:"usa250", title:"USA 250 \u2014 $5 Store Cash Giveaway", emoji:"\U0001F386",
    page:"/USA250", endpoint:"/usa250", cap:50,
    desc:"July 4th weekend giveaway. First 50 entrants receive $5 store credit (Lightspeed). Launched via Facebook Live." }
];
var promoData = {};   /* id -> {cap,count,entries} */
var promoShow = {};   /* id -> entries table expanded */
function renderPromos(){
  var el = $("promo-list"); if(!el) return;
  var h = "";
  WEB_PROMOTIONS.forEach(function(p){
    var d = promoData[p.id];
    h += '<div class="card" style="margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
        '<div><b style="color:var(--forest);">' + p.emoji + ' ' + esc(p.title) + '</b>' +
        '<div class="muted" style="margin-top:3px;">' + esc(p.desc) + '</div></div>' +
        '<span class="badge" style="white-space:nowrap;">' + (d ? (d.count + ' / ' + d.cap + ' entries') : '\u2014') + '</span>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center;">' +
        '<a class="btn ghost small" href="' + p.page + '" target="_blank" rel="noopener">\U0001F517 Open page</a>' +
        '<button class="btn small" onclick="loadPromo(\\'' + p.id + '\\',true)">\U0001F465 ' + (promoShow[p.id] ? 'Refresh entries' : 'View entries') + '</button>' +
        '<button class="btn ghost small" onclick="exportPromoCSV(\\'' + p.id + '\\')"' + (d && d.entries.length ? '' : ' disabled') + '>\U0001F4E5 Download CSV</button>' +
      '</div>' +
      '<div style="margin-top:10px;overflow-x:auto;">' + (promoShow[p.id] && d ? promoTableHTML(p, d) : '') + '</div>' +
    '</div>';
  });
  el.innerHTML = h || '<p class="muted">No promotions configured.</p>';
}
function promoTableHTML(p, d){
  if(!d.entries.length) return '<p class="muted" style="margin:6px 0 0;">No entries yet.</p>';
  var th = 'style="text-align:left;padding:6px 8px;border-bottom:2px solid var(--forest);"';
  var td = 'style="padding:5px 8px;border-bottom:1px solid #eef0ec;"';
  var h = '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
    '<tr><th ' + th + '>#</th><th ' + th + '>Name</th><th ' + th + '>Phone</th><th ' + th + '>Email</th><th ' + th + '>Agreed</th><th ' + th + '>Submitted</th></tr>';
  d.entries.forEach(function(e){
    var over = e.seq > d.cap;
    h += '<tr' + (over ? ' style="opacity:.55;"' : '') + '>' +
      '<td ' + td + '>' + e.seq + (over ? ' <span class="muted">(past cap)</span>' : '') + '</td>' +
      '<td ' + td + '>' + esc(e.name) + '</td>' +
      '<td ' + td + '>' + esc(promoPhone(e.phone)) + '</td>' +
      '<td ' + td + '>' + esc(e.email) + '</td>' +
      '<td ' + td + '>' + (e.agreed ? '\u2713 Yes' : '\u2717 NO') + '</td>' +
      '<td ' + td.slice(0,-1) + 'white-space:nowrap;"' + '>' + new Date(e.submitted).toLocaleString() + '</td></tr>';
  });
  return h + '</table>';
}
function promoPhone(p){ p = String(p||""); return p.length===10 ? "("+p.slice(0,3)+") "+p.slice(3,6)+"-"+p.slice(6) : p; }
async function loadPromo(id, show){
  var p = WEB_PROMOTIONS.filter(function(x){ return x.id===id; })[0]; if(!p) return;
  if(show) promoShow[id] = true;
  try{
    promoData[id] = await api(p.endpoint);
    renderPromos();
  }catch(e){ if(show) toast("Couldn't load entries: " + ((e && e.message) || e)); }
}
function exportPromoCSV(id){
  var p = WEB_PROMOTIONS.filter(function(x){ return x.id===id; })[0], d = promoData[id];
  if(!p || !d || !d.entries.length) return;
  var rows = [["Entry #","Name","Phone","Email","Agreed to Terms","Submitted (local)","Submitted (ISO)"]];
  d.entries.forEach(function(e){
    rows.push([e.seq, e.name, promoPhone(e.phone), e.email, (e.agreed ? "Yes" : "No"), new Date(e.submitted).toLocaleString(), e.submitted]);
  });
  var csv = rows.map(function(r){ return r.map(function(v){ v = String(v==null?"":v); return /[",\\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }).join(","); }).join("\\r\\n");
  var blob = new Blob([csv], {type:"text/csv"});
  var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = p.id + "-entries.csv"; a.click();
}

"""
    src = sub(src,
        "/* ---------- boot ---------- */",
        JSBLOCK + "/* ---------- boot ---------- */",
        "guru js block")
    src = sub(src,
        "  showApp();\n  loadStats();",
        "  showApp();\n  loadStats();\n  renderPromos();\n  WEB_PROMOTIONS.forEach(function(p){ loadPromo(p.id, false); });",
        "guru boot")
    src = mark_end(src, f"<!-- {MARK} \u00b7 Web Promotions console (moved from booking admin) -->")
    save(p, src, crlf)
    print(f"patched {p}")

print("done — all files patched or already current")
