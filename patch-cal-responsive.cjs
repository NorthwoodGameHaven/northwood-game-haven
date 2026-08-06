#!/usr/bin/env node
/* NGH patch — NGH-BUILD 2026-08-06c · responsive calendar labels + homepage tiled images
 *
 * site/events.html (requires 2026-08-06b):
 *   - Week-view labels: horizontal on wide screens; vertical (top-to-bottom) on phones
 *     (max-width:760px) and whenever a block shares its time slot with another (lane-split),
 *     at any width. Short blocks (<48px) always stay horizontal. Title-only either way.
 *   - Share export: forced horizontal via .share-export override (html2canvas cannot
 *     render vertical writing-mode — this is what garbled the earlier export).
 *
 * site/index.html + site/ngh.html (mirrors — both patched, parity verified):
 *   - Homepage embed fill images: whole image fits column width, repeats vertically
 *     (same fix events.html got in 08-06a).
 *   - Same responsive label behavior (vertical on phones / lane-split, title-only).
 *
 * Run from repo root:  node patch-cal-responsive.cjs
 */
const fs = require("fs");
const path = require("path");

const MARK = "NGH-BUILD 2026-08-06c";
let failures = 0;

function load(p) {
  const raw = fs.readFileSync(p);
  const crlf = raw.includes(Buffer.from("\r\n"));
  let src = raw.toString("utf8");
  if (crlf) src = src.replace(/\r\n/g, "\n");
  return { src, crlf };
}
function save(p, src, crlf) {
  fs.writeFileSync(p, crlf ? src.replace(/\n/g, "\r\n") : src);
}
function mkRep(state, file) {
  return function rep(anchor, replacement, label) {
    const n = state.src.split(anchor).length - 1;
    if (n !== 1) { console.error("ABORT [" + file + "]: anchor for [" + label + "] found " + n + " times (need exactly 1)."); process.exit(1); }
    state.src = state.src.replace(anchor, replacement);
    console.log(file + " patched: " + label);
  };
}
function resolve(rel) {
  const a = path.join("site", rel);
  return fs.existsSync(a) ? a : rel;
}

/* ================= events.html ================= */
(function () {
  const p = resolve("events.html");
  const st = load(p);
  if (st.src.includes(MARK)) { console.log(p + ": already patched — skipping."); return; }
  if (!st.src.includes("NGH-BUILD 2026-08-06b")) { console.error("ABORT: " + p + " missing 2026-08-06b — run patch-events-weekview-2.cjs first."); process.exit(1); }
  const rep = mkRep(st, p);

  rep(
    "  .tg-ev-cont { display:block; margin-top:1px; font-size:0.52rem; font-weight:700; opacity:0.95; letter-spacing:0.2px; }",
`  .tg-ev-cont { display:block; margin-top:1px; font-size:0.52rem; font-weight:700; opacity:0.95; letter-spacing:0.2px; }
  /* Responsive week-view labels: horizontal when there's room; vertical on narrow screens
     (media query) or when the block shares its slot with another (.split). Title-only both ways.
     Share export forces horizontal — html2canvas can't render vertical writing-mode. */
  .tg-ev .vtxt { display:inline; }
  .tg-ev.split { display:flex; justify-content:center; align-items:flex-start; padding:5px 1px; }
  .tg-ev.split .vtxt { writing-mode:vertical-rl; -webkit-writing-mode:vertical-rl; font-size:0.7rem; line-height:1.2; max-height:100%; overflow:hidden; }
  @media (max-width:760px){
    .tg-ev.wk { display:flex; justify-content:center; align-items:flex-start; padding:5px 1px; }
    .tg-ev.wk .vtxt { writing-mode:vertical-rl; -webkit-writing-mode:vertical-rl; font-size:0.7rem; line-height:1.2; max-height:100%; overflow:hidden; }
  }
  .share-export .tg-ev { display:block !important; padding:2px 5px !important; }
  .share-export .tg-ev .vtxt { writing-mode:horizontal-tb !important; -webkit-writing-mode:horizontal-tb !important; font-size:0.6rem !important; }`,
    "responsive label CSS"
  );

  rep(
`        // Week view: horizontal title-only — times are implied by block position and stay
        // in the title attr, hover card, and modal. Day view keeps title+time (wide columns).
        var inner = isDay
          ? '<span class="tt">'+esc(e.title)+'</span><br>'+tm+(overnight?'<span class="tg-ev-cont" title="Continues past midnight">▾ til '+fmtTime(trueEnd)+'</span>':'')
          : '<span class="tt">'+esc(e.title)+'</span>'+(overnight?'<span class="tg-ev-cont" title="Continues past midnight">▾ til '+fmtTime(trueEnd)+'</span>':'');
        h+='<div class="tg-ev'+(overnight?" overnight":"")+'" data-id="'+esc(e.id)+'" data-ds="'+ds+'" '+`,
`        // Week view: title-only. Horizontal by default; goes vertical on narrow viewports
        // (.wk + media query) or when lane-split with another event (.split), if tall enough.
        // Times stay in the title attr, hover card, and modal. Day view keeps title+time.
        var tall = height>=48;
        var cls = isDay ? "" : ((tall?" wk":"")+((tall&&(e._lanes||1)>1)?" split":""));
        var inner = isDay
          ? '<span class="tt">'+esc(e.title)+'</span><br>'+tm+(overnight?'<span class="tg-ev-cont" title="Continues past midnight">▾ til '+fmtTime(trueEnd)+'</span>':'')
          : '<span class="vtxt"><span class="tt">'+esc(e.title)+'</span>'+(overnight?'<span class="tg-ev-cont" title="Continues past midnight">▾ til '+fmtTime(trueEnd)+'</span>':'')+'</span>';
        h+='<div class="tg-ev'+(overnight?" overnight":"")+cls+'" data-id="'+esc(e.id)+'" data-ds="'+ds+'" '+`,
    "responsive label rendering"
  );

  rep(
`    var node=document.createElement('div');
    node.style.cssText="position:fixed;left:-10000px;top:0;width:760px;background:#fff;font-family:'Lato',sans-serif;";`,
`    var node=document.createElement('div');
    node.className="share-export";   // forces horizontal labels — html2canvas can't render vertical text
    node.style.cssText="position:fixed;left:-10000px;top:0;width:760px;background:#fff;font-family:'Lato',sans-serif;";`,
    "share-export horizontal override"
  );

  rep(
    "<!-- NGH-BUILD 2026-08-06b · horizontal title-only week labels + export footer fix -->",
    "<!-- NGH-BUILD 2026-08-06b · horizontal title-only week labels + export footer fix -->\n<!-- " + MARK + " · responsive vertical labels + export override -->",
    "build marker"
  );

  save(p, st.src, st.crlf);
  console.log("DONE → " + p);
})();

/* ============ index.html + ngh.html (mirrors) ============ */
const HOME_STYLE_INJECT =
`  // Responsive embed labels: vertical on phones or when lane-split; horizontal otherwise.
  (function(){ if(document.getElementById('nghc-style')) return; var st=document.createElement('style'); st.id='nghc-style';
    st.textContent='.nghc-ev .nghc-vtxt{display:inline;}'+
    '.nghc-ev.nghc-split{display:flex;justify-content:center;align-items:flex-start;}'+
    '.nghc-ev.nghc-split .nghc-vtxt{writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;font-size:0.62rem;line-height:1.2;max-height:100%;overflow:hidden;}'+
    '@media (max-width:760px){.nghc-ev.nghc-wk{display:flex;justify-content:center;align-items:flex-start;}'+
    '.nghc-ev.nghc-wk .nghc-vtxt{writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;font-size:0.62rem;line-height:1.2;max-height:100%;overflow:hidden;}}';
    document.head.appendChild(st); })();
  `;

/* index.html uses a literal '·' in this line; ngh.html uses the '\\u00b7' escape.
   MID is substituted per-file; the replacement always uses the literal '·', which
   normalizes the mirrors to byte-identical embed code going forward. */
function homeBlockOld(mid) {
  return `        h+='<div onclick="NGHCAL.open(\\''+esc(e.id)+'\\',\\''+ds+'\\')" title="'+esc(e.title)+' ${mid} '+tm+(overnight?' (continues past midnight)':'')+'" style="position:absolute;top:'+top+'px;height:'+height+'px;left:calc('+lf+'% + 1px);width:calc('+w+'% - 2px);background:'+TEAL+';color:#fff;border-radius:3px;padding:1px 3px;font-size:0.5rem;line-height:1.15;overflow:hidden;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.18);'+(overnight?'border-bottom:2px dashed rgba(255,255,255,0.85);':'')+'">'+esc(e.title)+'</div>';`;
}

const HOME_BLOCK_NEW =
`        var tall=height>=40, cls='nghc-ev'+(tall?' nghc-wk':'')+((tall&&(e._n||1)>1)?' nghc-split':'');
        h+='<div class="'+cls+'" onclick="NGHCAL.open(\\''+esc(e.id)+'\\',\\''+ds+'\\')" title="'+esc(e.title)+' · '+tm+(overnight?' (continues past midnight)':'')+'" style="position:absolute;top:'+top+'px;height:'+height+'px;left:calc('+lf+'% + 1px);width:calc('+w+'% - 2px);background:'+TEAL+';color:#fff;border-radius:3px;padding:1px 3px;font-size:0.5rem;line-height:1.15;overflow:hidden;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.18);'+(overnight?'border-bottom:2px dashed rgba(255,255,255,0.85);':'')+'"><span class="nghc-vtxt">'+esc(e.title)+'</span></div>';`;

const homeResults = {};
["index.html", "ngh.html"].forEach(function (name) {
  const p = resolve(name);
  const st = load(p);
  if (st.src.includes(MARK)) { console.log(p + ": already patched — skipping."); homeResults[name] = null; return; }
  const rep = mkRep(st, p);

  rep(
    "background-size:cover;background-position:center;",
    "background-size:100% auto;background-repeat:repeat-y;background-position:top center;",
    "embed tiled fill images"
  );

  const litOld = homeBlockOld("·"), escOld = homeBlockOld("\\u00b7");
  if (st.src.includes(litOld)) rep(litOld, HOME_BLOCK_NEW, "embed responsive labels");
  else rep(escOld, HOME_BLOCK_NEW, "embed responsive labels (\\u00b7 variant, normalized to ·)");

  rep(
    "  function fillBlankImages(dayEvents, timed, adBottom, gridH, h0, ROW, ds){",
    HOME_STYLE_INJECT + "\n  function fillBlankImages(dayEvents, timed, adBottom, gridH, h0, ROW, ds){",
    "embed label stylesheet"
  );

  if (!/<\/html>\s*$/.test(st.src)) { console.error("ABORT [" + p + "]: no trailing </html> for build marker."); process.exit(1); }
  st.src = st.src.replace(/<\/html>\s*$/, "<!-- " + MARK + " · embed tiled images + responsive labels -->\n</html>\n");
  console.log(p + " patched: build marker");

  save(p, st.src, st.crlf);
  homeResults[name] = st.src;
  console.log("DONE → " + p);
});

/* mirror parity: the patched embed code must be identical in both files */
if (homeResults["index.html"] && homeResults["ngh.html"]) {
  [HOME_BLOCK_NEW, HOME_STYLE_INJECT, "background-size:100% auto;background-repeat:repeat-y;background-position:top center;"].forEach(function (s, i) {
    const a = homeResults["index.html"].includes(s), b = homeResults["ngh.html"].includes(s);
    if (!a || !b) { console.error("MIRROR PARITY FAIL on segment " + i); failures++; }
  });
  console.log(failures ? "MIRROR PARITY: FAILED" : "mirror parity: OK");
}
process.exit(failures ? 1 : 0);
