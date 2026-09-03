// patch-trivia-host-09i.cjs — NGH-BUILD 09i · 2026-09-03a
// Run from repo root:  node patch-trivia-host-09i.cjs
//
// What it does to site/trivia-host.html:
//  1. FIX: goLiveDirect() read #runAnswer (doesn't exist) -> TypeError -> every
//     "Show question" path silently died. Now reads #runSecs. THIS is why no
//     questions would show.
//  2. Adds a big one-tap "⏭ Next" button: shows question -> reveals -> advances.
//  3. Adds 🚦 Auto-run: auto-reveal when the answer clock expires, hold the
//     reveal N sec, auto-advance to the next question; auto-intermission at
//     round end; auto-resume next round when the break clock expires.
//  4. Wheel end-of-round now pre-points selectors at next round Q1 (and goes
//     to scoreboard instead of intermission after the final round).

const fs = require('fs');
const path = 'site/trivia-host.html';
let src = fs.readFileSync(path, 'utf8');
let applied = 0;

function crlf(s) { return s.replace(/\n/g, '\r\n'); }
function rep(name, from, to) {
  let f = from, t = to;
  if (src.indexOf(f) === -1 && src.indexOf(crlf(f)) !== -1) { f = crlf(f); t = crlf(t); }
  const n = src.split(f).length - 1;
  if (n !== 1) { console.error('FAIL [' + name + '] anchor count=' + n + ' (need exactly 1). Aborting, file untouched.'); process.exit(1); }
  src = src.replace(f, t);
  applied++;
  console.log('ok  [' + name + ']');
}

// ---- 1. build marker ----
rep('marker',
'<!-- NGH-BUILD 09h -->',
'<!-- NGH-BUILD 09i · 2026-09-03a — fix Show-question crash (runAnswer→runSecs); one-tap ⏭ Next; 🚦 Auto-run loop -->');

// ---- 2. THE BUG FIX ----
rep('goLiveDirect fix',
`function goLiveDirect() {
  setPhase("live", {
    leadMs: 1500,
    answerSecs: Number(document.getElementById("runAnswer").value) || 45
  });
}`,
`function goLiveDirect() {
  // 09i: was "runAnswer" (id doesn't exist) — threw TypeError, so Show question / Next / advance all silently failed.
  var secsEl = document.getElementById("runSecs");
  setPhase("live", {
    leadMs: 1500,
    answerSecs: Number(secsEl && secsEl.value) || 45
  });
}`);

// ---- 3. UI: one-tap button + auto-run controls (after the wheel hint) ----
rep('ui row',
`<div class="muted" id="wheelHint" style="margin:-4px 0 6px"></div>`,
`<div class="muted" id="wheelHint" style="margin:-4px 0 6px"></div>
        <!-- 09i: one-tap flow + auto-run -->
        <div class="row" style="align-items:center;margin:2px 0 8px">
          <div style="flex:0"><button onclick="oneTapNext()" style="font-size:18px;padding:12px 22px">⏭ Next</button></div>
          <div style="flex:0;white-space:nowrap;align-self:center"><label style="display:inline;cursor:pointer"><input type="checkbox" id="autoRun" onchange="autoRunToggle()"> 🚦 Auto-run</label></div>
          <div style="flex:0">
            <label>Reveal hold (sec)</label>
            <input id="autoRevealSecs" type="number" value="8" min="3" max="120" style="width:80px">
          </div>
          <div class="muted grow" id="autoRunStatus" style="align-self:center"></div>
        </div>`);

// ---- 4. wheel end-of-round: pre-advance selectors; scoreboard after final round ----
rep('wheelNext advance',
`  // reveal → advance
  if (lastQOfRound()) { startIntermission(); return; }
  advanceQ(1);`,
`  // reveal → advance
  if (lastQOfRound()) { // 09i: point selectors at next round Q1 so intermission previews & resumes correctly
    if (advSelectorsToNextRound()) startIntermission(); else setPhase("scoreboard");
    return;
  }
  advanceQ(1);`);

// ---- 5. capture server clock offset from setPhase responses ----
rep('clock offset',
`.then(function (j) {
      run.state = j.state;`,
`.then(function (j) {
      if (j && j.serverNow) autoClockOff = j.serverNow - Date.now(); // 09i
      run.state = j.state;`);

// ---- 6. one-tap + auto-run engine (inserted before endGameConfirm) ----
rep('engine',
`function endGameConfirm() {`,
`/* ---------- 09i: one-tap flow + auto-run ---------- */
var autoClockOff = 0, autoTimer = null, autoFired = "", autoRevealAt = 0;
function autoNow() { return Date.now() + autoClockOff; }
function syncSelectorsToState() {
  if (!run) return;
  document.getElementById("runRound").value = String(run.state.roundIdx | 0);
  fillRunQ();
  document.getElementById("runQ").value = String(run.state.qIdx | 0);
}
function advSelectorsToNextRound() {
  var ri = (Number(document.getElementById("runRound").value) || 0) + 1;
  if (ri >= (run.game.rounds || []).length) return false;
  document.getElementById("runRound").value = String(ri);
  fillRunQ();
  document.getElementById("runQ").value = "0";
  return true;
}
function oneTapNext() {
  if (!run) return;
  var ph = (run.state || {}).phase;
  if (ph === "reveal") {
    syncSelectorsToState();
    if (lastQOfRound()) {
      if (advSelectorsToNextRound()) startIntermission(); else setPhase("scoreboard");
    } else { advanceQ(1); }
    return;
  }
  if (ph === "live" || ph === "answering" || ph === "locked") { setPhase("reveal"); return; }
  // lobby / preload / intermission / scoreboard → show the question the selectors point at
  goLiveDirect();
}
function setAutoStatus(t) { var el = document.getElementById("autoRunStatus"); if (el) el.textContent = t; }
function autoRunToggle() {
  var on = document.getElementById("autoRun").checked;
  autoFired = ""; autoRevealAt = 0;
  if (on && !autoTimer) autoTimer = setInterval(autoTick, 1000);
  if (!on && autoTimer) { clearInterval(autoTimer); autoTimer = null; setAutoStatus(""); }
  if (on) setAutoStatus("Auto-run armed — reveals at 0:00, holds, then advances.");
}
function autoKey() {
  var st = (run && run.state) || {};
  return st.phase + "|" + (st.roundIdx | 0) + "." + (st.qIdx | 0) + "|" + (st.deadline || 0);
}
function autoTick() {
  if (!run) return;
  if ((run.game.kind || "trivia") === "timer") return;
  var st = run.state || {}, ph = st.phase, now = autoNow(), key = autoKey();
  if (ph === "live" || ph === "answering") {
    autoRevealAt = 0;
    if (!st.deadline) { setAutoStatus("No answer clock on this question — tap ⏭ Next to reveal."); return; }
    if (now > Number(st.deadline) + 1200) {
      if (autoFired === key) return;
      autoFired = key;
      setAutoStatus("⏱ Time! Revealing…");
      syncSelectorsToState();
      setPhase("reveal");
    } else {
      setAutoStatus("Answers close in " + Math.max(0, Math.ceil((Number(st.deadline) - now) / 1000)) + "s…");
    }
    return;
  }
  if (ph === "reveal") {
    if (!autoRevealAt) autoRevealAt = now;
    var hold = Math.min(120, Math.max(3, Number(document.getElementById("autoRevealSecs").value) || 8));
    var left = Math.ceil((autoRevealAt + hold * 1000 - now) / 1000);
    if (left > 0) { setAutoStatus("💡 Revealed — advancing in " + left + "s…"); return; }
    if (autoFired === "adv|" + key) return;
    autoFired = "adv|" + key;
    autoRevealAt = 0;
    syncSelectorsToState();
    if (lastQOfRound()) {
      if (advSelectorsToNextRound()) { setAutoStatus("☕ Round done — intermission."); startIntermission(); }
      else { setAutoStatus("🏆 Final question done — scoreboard."); setPhase("scoreboard"); }
    } else {
      setAutoStatus("⏭ Next question…");
      advanceQ(1);
    }
    return;
  }
  if (ph === "intermission") {
    autoRevealAt = 0;
    if (st.deadline && now > Number(st.deadline) + 1200) {
      if (autoFired === key) return;
      autoFired = key;
      setAutoStatus("▶ Break over — next round.");
      goLiveDirect(); // selectors already point at next round Q1
    } else if (st.deadline) {
      setAutoStatus("☕ Intermission — next round in " + Math.max(0, Math.ceil((Number(st.deadline) - now) / 1000)) + "s…");
    }
    return;
  }
  if (ph === "scoreboard" || ph === "ended") { setAutoStatus(""); return; }
}
function endGameConfirm() {`);

fs.writeFileSync(path, src);
console.log('\\nDone — ' + applied + '/6 edits applied to ' + path);
console.log('Verify: findstr /M /C:"NGH-BUILD 09i" site\\\\trivia-host.html');
