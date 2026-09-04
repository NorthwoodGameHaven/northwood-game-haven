// patch-trivia-10a.cjs — NGH-BUILD 10a · 2026-09-04a
// Run from repo root:  node patch-trivia-10a.cjs
// Patches 4 files. Aborts (untouched) if any anchor doesn't match exactly once.
//
//  netlify/functions/trivia.mjs  (strictly additive)
//   1. New blind-wager phase 'wager' — category shown, question hidden, wagers open
//   2. POST /games/:id/wager public endpoint (+ wagersIn live count)
//   3. Answer handler preserves a blind wager when the answer arrives without one
//   4. Adjudication suggestions: per-answer tolerance — short answers (<=3 chars)
//      must match EXACTLY (fixes "every letter suggested ✓ for the Scrabble K")
//   5. POST /trivia/control — Companion / Stream Deck show-control API
//  site/trivia-display.html
//   6. Blind-wager TV screen (category + live "wagers in" count)
//   7. Media fail-safe: bad/cross-origin clue URL can no longer blank the question
//   8. "Stash is watching" bottom banner removed
//  site/trivia-play.html
//   9. Blind-wager phone screen (stake before the question shows; locked after)
//  10. Reveal colors follow the Guru's actual ruling: green ✓ / red ✗ /
//      BLUE "with the judges" while pending — and re-polls until ruled
//  site/trivia-host.html
//  11. 💰 Collect wagers button; Auto-run runs the wager window hands-free
//  12. Official answer (+ alternates) shown between team answers and the queue

const fs = require('fs');
let applied = 0, fileEdits = {};

function crlf(s) { return s.replace(/\n/g, '\r\n'); }
function patchFile(path, edits) {
  let src = fs.readFileSync(path, 'utf8');
  for (const [name, from, to] of edits) {
    let f = from, t = to;
    if (src.indexOf(f) === -1 && src.indexOf(crlf(f)) !== -1) { f = crlf(f); t = crlf(t); }
    const n = src.split(f).length - 1;
    if (n !== 1) {
      console.error('FAIL [' + path + ' :: ' + name + '] anchor count=' + n + ' (need 1). NOTHING written.');
      process.exit(1);
    }
    src = src.replace(f, t);
    applied++;
    console.log('ok  [' + name + ']');
  }
  fileEdits[path] = src;
}

/* ================= netlify/functions/trivia.mjs ================= */
patchFile('netlify/functions/trivia.mjs', [

['mjs marker',
"// NGH-BUILD 09e — Event Stream engine: + YouTube clue media (clip window, audio-only mode).",
"// NGH-BUILD 09e — Event Stream engine: + YouTube clue media (clip window, audio-only mode).\n// NGH-BUILD 10a — blind 'wager' phase, /wager + /control endpoints, per-entry adjudication tolerance."],

['mjs PHASES + wager',
"const PHASES = ['lobby', 'preload', 'live', 'answering', 'locked', 'reveal', 'intermission', 'scoreboard', 'ended', 'timer', 'timer-paused'];",
"const PHASES = ['lobby', 'preload', 'live', 'answering', 'locked', 'reveal', 'intermission', 'scoreboard', 'ended', 'timer', 'timer-paused', 'wager'];"],

['mjs suggestVerdict tolerance',
"  let best = Infinity;\n  for (const p of pool) best = Math.min(best, levenshtein(n, p));\n  const tol = Math.max(1, Math.round(Math.min(...pool.map(p => p.length), 99) / 5));\n  return best <= tol ? 'correct' : 'incorrect';",
"  // 10a: per-entry tolerance. A 1-3 char official answer must match EXACTLY —\n  // ('k' vs 'j' is one edit apart, which suggested ✓ for every wrong letter).\n  for (const p of pool) {\n    const tol = p.length <= 3 ? 0 : (p.length <= 6 ? 1 : Math.round(p.length / 5));\n    if (levenshtein(n, p) <= tol) return 'correct';\n  }\n  return 'incorrect';"],

['mjs publicState wager',
"  if (phase === 'scoreboard' || phase === 'ended') out.scoreboard = st.scoreboard || [];",
"  if (phase === 'wager') { // 10a: blind wager — category only, the prompt stays hidden\n    if (q) out.q = { key: q.key, points: Number(q.points) || 10 };\n    out.wagersIn = st.wagersIn | 0;\n  }\n  if (phase === 'scoreboard' || phase === 'ended') out.scoreboard = st.scoreboard || [];"],

['mjs state machine wager',
"      if (phase === 'preload') { st.startAt = null; st.deadline = null; }",
"      if (phase === 'preload') { st.startAt = null; st.deadline = null; }\n      if (phase === 'wager') { // 10a: blind-wager window — wagers open, question hidden\n        st.startAt = null;\n        const wsecs = Number(b.wagerSecs);\n        st.deadline = (wsecs > 0) ? now + Math.min(600, Math.max(5, wsecs)) * 1000 : null;\n        const wn = await sql`SELECT COUNT(*)::int AS n FROM trivia_answers WHERE game_id = ${gameId} AND q_key = ${q ? q.key : ''} AND (data->>'wager') IS NOT NULL`;\n        st.wagersIn = wn.length ? wn[0].n : 0;\n      }"],

['mjs wager endpoint',
"    // ----- PUBLIC: submit/replace answer -----",
"    // ----- PUBLIC: blind wager (phase 'wager' — stake before the question shows) — 10a -----\n    if (req.method === 'POST' && gameId && action === 'wager') {\n      let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }\n      const teamId = verifyTeamToken(String(b.token || ''));\n      if (!teamId) return bad('unauthorized', 401);\n      const rows = await sql`SELECT data, state FROM trivia_games WHERE id = ${gameId}`;\n      if (!rows.length) return bad('not found', 404);\n      const game = rows[0].data, st = rows[0].state || {};\n      const { q } = findQuestion(game, st.roundIdx | 0, st.qIdx | 0);\n      if (!q || q.key !== String(b.qKey || '')) return bad('Not the live question', 409);\n      if (st.phase !== 'wager') return bad('Wagers are closed', 409);\n      if (st.deadline && Date.now() > Number(st.deadline) + 1500) return bad('Time is up', 409);\n      const wager = Math.max(0, Number(b.wager) || 0);\n      const existing = await sql`SELECT id, data FROM trivia_answers\n        WHERE game_id = ${gameId} AND team_id = ${teamId} AND q_key = ${q.key}`;\n      if (existing.length) {\n        const d0 = existing[0].data || {};\n        if (d0.verdict) return bad('Already scored', 409);\n        const had = d0.wager != null;\n        d0.wager = wager; d0.blindWager = true;\n        await sql`UPDATE trivia_answers SET data = ${JSON.stringify(d0)}::jsonb WHERE id = ${existing[0].id}`;\n        if (!had) { st.wagersIn = (st.wagersIn | 0) + 1; await bumpState(gameId, st); }\n      } else {\n        const d = { answer: '', wager, blindWager: true, value: null, submittedAt: Date.now(), verdict: null, points: null };\n        await sql`INSERT INTO trivia_answers (id, game_id, team_id, q_key, data)\n          VALUES (${newId('ANS')}, ${gameId}, ${teamId}, ${q.key}, ${JSON.stringify(d)}::jsonb)`;\n        st.wagersIn = (st.wagersIn | 0) + 1;\n        await bumpState(gameId, st);\n      }\n      return json({ ok: true, qKey: q.key, wager });\n    }\n\n    // ----- PUBLIC: submit/replace answer -----"],

['mjs answer preserves blind wager',
"        wager: b.wager == null ? null : Math.max(0, Number(b.wager) || 0),",
"        wager: b.wager == null // 10a: an answer without a wager keeps the blind wager already staked\n          ? ((existing.length && existing[0].data && existing[0].data.wager != null) ? existing[0].data.wager : null)\n          : Math.max(0, Number(b.wager) || 0),"],

['mjs answer carries blindWager flag',
"        submittedAt: Date.now(),\n        verdict: null, points: null\n      };",
"        submittedAt: Date.now(),\n        verdict: null, points: null\n      };\n      if (existing.length && existing[0].data && existing[0].data.blindWager) d.blindWager = true; // 10a"],

['mjs myanswer returns blindWager',
"      return json({ answered: true, answer: d.answer, wager: d.wager, verdict: d.verdict || null, points: d.points });",
"      return json({ answered: true, answer: d.answer, wager: d.wager, blindWager: !!d.blindWager, verdict: d.verdict || null, points: d.points });"],

['mjs control endpoint',
"  // ================= games =================",
"  // ================= show control (Companion / Stream Deck / GT15 Max) — NGH-BUILD 10a =================\n  // POST /api/trivia/control  { code, action, gameId?, secs?, breakSecs? }\n  // Auth: 'code' must equal env ADMIN_CODE (also accepted via x-admin-code header).\n  // Actions: show | advance | reveal | lock | wager | scoreboard | intermission | lobby\n  // gameId optional — defaults to the most recently created game that isn't ended.\n  if (head === 'control' && req.method === 'POST') {\n    let b; try { b = await req.json(); } catch { return bad('Invalid JSON'); }\n    const code = String(b.code || req.headers.get('x-admin-code') || '');\n    if (!code || code !== String(process.env.ADMIN_CODE || '')) return bad('unauthorized', 401);\n    let gameId = b.gameId || null;\n    if (!gameId) {\n      const cand = await sql`SELECT id, state FROM trivia_games ORDER BY created_at DESC LIMIT 10`;\n      for (const c of cand) {\n        if (((c.state && c.state.phase) || 'lobby') !== 'ended') { gameId = c.id; break; }\n      }\n      if (!gameId) return bad('no active game', 404);\n    }\n    const rows = await sql`SELECT data, state FROM trivia_games WHERE id = ${gameId}`;\n    if (!rows.length) return bad('game not found', 404);\n    const game = rows[0].data, st = rows[0].state || {};\n    const now = Date.now();\n    const act = String(b.action || '');\n    const rounds = game.rounds || [];\n    let ri = st.roundIdx | 0, qi = st.qIdx | 0;\n    function goLiveSt() {\n      st.roundIdx = ri; st.qIdx = qi; st.buzzes = [];\n      st.phase = 'live';\n      st.startAt = now + 1500;\n      const secs = Math.min(600, Math.max(0, Number(b.secs) || 45));\n      st.deadline = secs > 0 ? st.startAt + secs * 1000 : null;\n    }\n    if (act === 'show') {\n      goLiveSt();\n      const f1 = findQuestion(game, ri, qi);\n      await markUsage(game, f1.q);\n    } else if (act === 'advance') {\n      qi++;\n      if (!rounds[ri] || qi >= ((rounds[ri] || {}).questions || []).length) { ri++; qi = 0; }\n      if (ri >= rounds.length) {\n        st.phase = 'scoreboard'; st.scoreboard = await computeScoreboard(gameId); st.deadline = null;\n      } else {\n        goLiveSt();\n        const f2 = findQuestion(game, ri, qi);\n        await markUsage(game, f2.q);\n      }\n    } else if (act === 'reveal') {\n      const f3 = findQuestion(game, ri, qi);\n      await autoScoreQuestion(gameId, f3.q, !!(f3.round && f3.round.isWager));\n      st.phase = 'reveal'; st.deadline = null;\n    } else if (act === 'lock') {\n      st.phase = 'locked'; st.deadline = st.deadline && st.deadline < now ? st.deadline : now;\n    } else if (act === 'wager') {\n      const f4 = findQuestion(game, ri, qi);\n      st.phase = 'wager'; st.startAt = null; st.buzzes = [];\n      const wsecs = Number(b.secs);\n      st.deadline = wsecs > 0 ? now + Math.min(600, Math.max(5, wsecs)) * 1000 : null;\n      const wn = await sql`SELECT COUNT(*)::int AS n FROM trivia_answers WHERE game_id = ${gameId} AND q_key = ${f4.q ? f4.q.key : ''} AND (data->>'wager') IS NOT NULL`;\n      st.wagersIn = wn.length ? wn[0].n : 0;\n    } else if (act === 'scoreboard') {\n      st.phase = 'scoreboard'; st.scoreboard = await computeScoreboard(gameId); st.deadline = null;\n    } else if (act === 'intermission') {\n      st.phase = 'intermission';\n      st.deadline = now + Math.min(3600, Math.max(30, Number(b.breakSecs) || 300)) * 1000;\n      st.startAt = null;\n      st.scoreboard = await computeScoreboard(gameId);\n      const nr = rounds[ri + 1];\n      st.next = nr ? { roundIdx: ri + 1, title: nr.title || '', isWager: !!nr.isWager } : null;\n    } else if (act === 'lobby') {\n      st.phase = 'lobby'; st.deadline = null; st.startAt = null;\n    } else return bad('bad action');\n    const v = await bumpState(gameId, st);\n    return json({ ok: true, gameId, v, phase: st.phase, roundIdx: st.roundIdx | 0, qIdx: st.qIdx | 0 });\n  }\n\n  // ================= games ================="],
]);

/* ================= site/trivia-display.html ================= */
patchFile('site/trivia-display.html', [

['display marker',
"<!-- NGH-BUILD 09e -->",
"<!-- NGH-BUILD 10a · 2026-09-04a — blind-wager screen; media fail-safe; Stash banner removed -->"],

['display remove stash banner',
"      h += '<div class=\"devban devban-bottom\">📵 Stash is watching — keep it fair, keep it fun</div>';\n",
""],

['display mediaBlock fail-safe',
"    return preloadAsset(q.media.url).then(function (src) {\n      readyQKey = q.key;\n      if (ph === \"preload\") return \"\";\n      if (q.media.kind === \"image\") return '<img class=\"clue\" id=\"clueMedia\" src=\"' + src + '\">';\n      if (q.media.kind === \"audio\") return '<audio id=\"clueMedia\" src=\"' + src + '\" preload=\"auto\"></audio>' +\n        '<div class=\"brand\" style=\"font-size:9vmin;margin:3vmin 0\">🎵 LISTEN…</div>';\n      return '<video id=\"clueMedia\" src=\"' + src + '\" preload=\"auto\" playsinline></video>';\n    });",
"    function renderSrc(src) { // 10a\n      if (ph === \"preload\") return \"\";\n      if (q.media.kind === \"image\") return '<img class=\"clue\" id=\"clueMedia\" src=\"' + src + '\">';\n      if (q.media.kind === \"audio\") return '<audio id=\"clueMedia\" src=\"' + src + '\" preload=\"auto\"></audio>' +\n        '<div class=\"brand\" style=\"font-size:9vmin;margin:3vmin 0\">🎵 LISTEN…</div>';\n      return '<video id=\"clueMedia\" src=\"' + src + '\" preload=\"auto\" playsinline></video>';\n    }\n    return preloadAsset(q.media.url).then(function (src) {\n      readyQKey = q.key;\n      return renderSrc(src);\n    }).catch(function () {\n      // 10a: cache/CORS fetch failed — fall back to the raw URL. An <img>/<video>\n      // tag renders cross-origin fine even when fetch() can't; the question must\n      // NEVER be held hostage by a clue that won't load.\n      readyQKey = q.key;\n      return renderSrc(q.media.url);\n    });"],

['display live render fail-safe',
"        if (ph !== \"locked\") startCountdown();\n      });\n      return;\n    }",
"        if (ph !== \"locked\") startCountdown();\n      }).catch(function () {\n        // 10a: last-resort — show the question text even if media rendering throws\n        stage.innerHTML = '<div class=\"prompt\" style=\"margin-top:2.5vmin\">' + esc(q.prompt || \"\") + \"</div>\";\n        if (ph !== \"locked\") startCountdown();\n      });\n      return;\n    }"],

['display wager screen',
"    if (ph === \"preload\") {\n      stage.innerHTML =\n        '<div class=\"brand\" style=\"font-size:7vmin\">GET READY…</div>' +",
"    if (ph === \"wager\") { // 10a: blind wager — category up, question hidden\n      stage.innerHTML =\n        '<div class=\"brand\" style=\"font-size:7vmin\">💰 ' + esc(st.wagerLabel || \"FINAL WAGER\") + '</div>' +\n        (st.round ? '<div class=\"sub\" style=\"font-size:6vmin;margin-top:2vmin\">Category: ' + esc(st.round.title) + '</div>' : \"\") +\n        '<div class=\"sub\" style=\"font-size:4.2vmin;margin-top:3vmin\">Stake your points on your phones — the question stays hidden until every stash is staked.</div>' +\n        '<div class=\"brand\" style=\"font-size:12vmin;margin-top:4vmin;color:var(--gold)\">' + (st.wagersIn | 0) + '</div>' +\n        '<div class=\"small\">wager' + ((st.wagersIn | 0) === 1 ? \"\" : \"s\") + ' in</div>';\n      startCountdown();\n      return;\n    }\n\n    if (ph === \"preload\") {\n      stage.innerHTML =\n        '<div class=\"brand\" style=\"font-size:7vmin\">GET READY…</div>' +"],
]);

/* ================= site/trivia-play.html ================= */
patchFile('site/trivia-play.html', [

['play marker',
"<!-- NGH TRIVIA PLAY — NGH-BUILD 09a -->",
"<!-- NGH TRIVIA PLAY — NGH-BUILD 10a · 2026-09-04a — blind wagers; verdict-true reveal colors -->"],

['play st-adj css',
"  .st-locked{background:rgba(122,43,53,.3);border:1px solid var(--maroon)}",
"  .st-locked{background:rgba(122,43,53,.3);border:1px solid var(--maroon)}\n  .st-adj{background:rgba(46,109,164,.25);border:1px solid #4a90d9} /* 10a: pending Guru ruling */"],

['play header round-title phases',
"    if (st && st.round && st.round.title && [\"preload\", \"live\", \"answering\", \"locked\", \"reveal\"].indexOf(st.phase) >= 0) {",
"    if (st && st.round && st.round.title && [\"preload\", \"live\", \"answering\", \"locked\", \"reveal\", \"wager\"].indexOf(st.phase) >= 0) {"],

['play header sub map',
"      sub = ({ lobby: \"Waiting to start\", intermission: \"Intermission\", scoreboard: \"Scores\", ended: \"Final\" })[st.phase] || \"\";",
"      sub = ({ lobby: \"Waiting to start\", intermission: \"Intermission\", scoreboard: \"Scores\", ended: \"Final\", wager: \"💰 Place your wagers\" })[st.phase] || \"\";"],

['play verdict refresh helper',
"  function renderPlay() {",
"  /* 10a: after reveal, keep checking until the Guru has ruled so the box\n     flips from blue (with the judges) to green/red the moment it's decided. */\n  var verdictTimer = null;\n  function scheduleVerdictRefresh(qKey) {\n    if (verdictTimer || !team) return;\n    verdictTimer = setTimeout(function () {\n      verdictTimer = null;\n      fetchMyAnswer(qKey).then(function (j) {\n        if (st.phase !== \"reveal\") return;\n        renderPlay();\n        if (j && j.answered && !j.verdict) scheduleVerdictRefresh(qKey);\n      });\n    }, 3000);\n  }\n\n  function renderPlay() {"],

['play wager phase screen',
"    if (ph === \"intermission\") {",
"    if (ph === \"wager\") { // 10a: blind wager — stake before the question shows\n      var wq = st.q, wKey = wq && wq.key;\n      var savedW = (wKey && myAns[wKey] && myAns[wKey].wager != null) ? myAns[wKey].wager : null;\n      main.innerHTML = '<div class=\"center\" style=\"padding-top:10px\">' +\n        (st.deadline ? '<div class=\"bigcount\" id=\"count\">–</div>' : \"\") +\n        \"<h1>💰 \" + esc(st.wagerLabel || \"Final Wager\") + \"</h1>\" +\n        '<div class=\"hook\">Category: ' + esc((st.round && st.round.title) || \"Final\") + \"</div>\" +\n        '<div class=\"muted\">Stake your points BEFORE you see the question. Right = win the stake. Wrong = lose it (score floor 10).</div></div>' +\n        '<div class=\"card\" style=\"border-color:var(--pink)\"><label style=\"color:var(--pink)\">Your wager</label>' +\n        '<input type=\"number\" id=\"blindWager\" inputmode=\"numeric\" min=\"0\" placeholder=\"0 = play it safe\" value=\"' + (savedW != null ? esc(String(savedW)) : \"\") + '\">' +\n        '<button class=\"primary\" id=\"blindSave\">' + (savedW != null ? \"🔁 Update wager\" : \"💰 Lock it in\") + \"</button>\" +\n        (savedW != null ? '<div class=\"muted\" style=\"margin-top:6px\">Staked: <b>' + esc(String(savedW)) + '</b> — updatable until the question shows.</div>' : \"\") +\n        \"</div>\";\n      var bs = document.getElementById(\"blindSave\");\n      if (bs) bs.onclick = function () {\n        if (!wKey) { toast(\"Hold on — the host is setting up.\"); return; }\n        var val = Number(document.getElementById(\"blindWager\").value);\n        if (isNaN(val) || val < 0) { toast(\"Enter 0 or more.\"); return; }\n        bs.disabled = true; haptic();\n        fetch(API + \"/games/\" + encodeURIComponent(GAME) + \"/wager\", {\n          method: \"POST\", headers: { \"Content-Type\": \"application/json\" },\n          body: JSON.stringify({ token: team.token, qKey: wKey, wager: val })\n        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })\n          .then(function (res) {\n            bs.disabled = false;\n            if (res.ok) {\n              myAns[wKey] = myAns[wKey] || {};\n              myAns[wKey].wager = val; myAns[wKey].blindWager = true;\n              renderPlay(); toast(\"Wager locked ✓\");\n            } else toast(res.j.error || \"Couldn\\u2019t save wager.\");\n          }).catch(function () { bs.disabled = false; toast(\"Network error — try again.\"); });\n      };\n      startCountdown();\n      return;\n    }\n    if (ph === \"intermission\") {"],

['play locked blind wager box',
"    if (isWager && answering) {\n      var wv = (pendingSel[\"w:\" + qKey] != null) ? pendingSel[\"w:\" + qKey] : (mine.wager != null ? mine.wager : \"\");",
"    if (isWager && answering && mine.blindWager) {\n      // 10a: staked blind before the question showed — display only, no edits\n      wagerBox = '<div class=\"card\" style=\"border-color:var(--pink)\"><label style=\"color:var(--pink)\">💰 ' + esc(st.wagerLabel) +\n        '</label><div class=\"hook\" style=\"margin:2px 0 0\">Locked in: ' + esc(String(mine.wager != null ? mine.wager : 0)) + ' pts</div></div>';\n    } else if (isWager && answering) {\n      var wv = (pendingSel[\"w:\" + qKey] != null) ? pendingSel[\"w:\" + qKey] : (mine.wager != null ? mine.wager : \"\");"],

['play MC reveal verdict-first',
"      else {\n        var right = chosen != null && chosen === st.q.answer;\n        h += '<div class=\"statusbar ' + (right ? \"st-open\" : \"st-locked\") + '\">' +\n          (chosen == null ? \"No answer this round.\" : (right ? \"✅ Nailed it!\" : \"❌ Not this time — it was \\u201c\" + esc(st.q.answer) + \"\\u201d\")) + \"</div>\";\n      }",
"      else {\n        var vdm = mine.verdict; // 10a: the Guru's ruling wins over raw string match\n        var right = vdm === \"correct\" || (vdm !== \"incorrect\" && chosen != null && chosen === st.q.answer);\n        h += '<div class=\"statusbar ' + (right ? \"st-open\" : \"st-locked\") + '\">' +\n          (chosen == null ? \"No answer this round.\" : (right ? \"✅ Nailed it!\" : \"❌ Not this time — it was \\u201c\" + esc(st.q.answer) + \"\\u201d\")) + \"</div>\";\n        if (chosen != null && !vdm) scheduleVerdictRefresh(qKey); // 10a: pick up late rulings\n      }"],

['play short-answer reveal 3-state',
"      var vd = mine.verdict;\n      h += '<div class=\"statusbar ' + (vd === \"correct\" ? \"st-open\" : \"st-locked\") + '\">' +\n        (mine.answer ? \"You said: \\u201c\" + esc(mine.answer) + \"\\u201d\" : \"No answer this round.\") +\n        (st.q.answer ? \" · Correct: \\u201c\" + esc(st.q.answer) + \"\\u201d\" : \"\") + \"</div>\";",
"      var vd = mine.verdict; // 10a: green ✓ / red ✗ / BLUE while the Guru rules\n      var stCls = vd === \"correct\" ? \"st-open\" : (vd === \"incorrect\" ? \"st-locked\" : (mine.answer ? \"st-adj\" : \"st-locked\"));\n      var lead = vd === \"correct\" ? \"✅ \" : (vd === \"incorrect\" ? \"❌ \" : (mine.answer ? \"⚖️ With the judges — \" : \"\"));\n      h += '<div class=\"statusbar ' + stCls + '\">' + lead +\n        (mine.answer ? \"You said: \\u201c\" + esc(mine.answer) + \"\\u201d\" : \"No answer this round.\") +\n        (st.q.answer ? \" · Correct: \\u201c\" + esc(st.q.answer) + \"\\u201d\" : \"\") + \"</div>\";\n      if (mine.answer && !vd) scheduleVerdictRefresh(qKey); // 10a"],
]);

/* ================= site/trivia-host.html ================= */
patchFile('site/trivia-host.html', [

['host marker',
"<!-- NGH-BUILD 09i · 2026-09-03a — fix Show-question crash (runAnswer→runSecs); one-tap ⏭ Next; 🚦 Auto-run loop -->",
"<!-- NGH-BUILD 10a · 2026-09-04a — 💰 blind Collect-wagers flow; official-answer panel; Auto-run wager window -->"],

['host collect wagers button',
"<button class=\"sec\" onclick=\"setPhase('preload')\">📦 Preload media</button>",
"<button class=\"sec\" onclick=\"setPhase('preload')\">📦 Preload media</button>\n          <button class=\"sec\" onclick=\"collectWagers()\">💰 Collect wagers</button>"],

['host collectWagers fn',
"function goLive() {\n  setPhase(\"live\", { leadMs: 4000, answerSecs: Number(document.getElementById(\"runSecs\").value) || 0 });\n}",
"function goLive() {\n  setPhase(\"live\", { leadMs: 4000, answerSecs: Number(document.getElementById(\"runSecs\").value) || 0 });\n}\nfunction collectWagers() { // 10a: blind wager window — question stays hidden, wagers open\n  setPhase(\"wager\", { wagerSecs: Number(document.getElementById(\"runSecs\").value) || 0 });\n}"],

['host oneTapNext wager',
"  // lobby / preload / intermission / scoreboard → show the question the selectors point at",
"  if (ph === \"wager\") { goLiveDirect(); return; } // 10a: wagers in — show the question\n  // lobby / preload / intermission / scoreboard → show the question the selectors point at"],

['host autoTick wager window',
"  if (ph === \"live\" || ph === \"answering\") {",
"  if (ph === \"wager\") { // 10a: hands-free blind-wager window\n    autoRevealAt = 0;\n    if (st.deadline && now > Number(st.deadline) + 1200) {\n      if (autoFired === key) return;\n      autoFired = key;\n      setAutoStatus(\"💰 Wagers closed — showing the question.\");\n      syncSelectorsToState();\n      goLiveDirect();\n    } else {\n      setAutoStatus(\"💰 Collecting wagers — \" + (st.wagersIn | 0) + \" in\" +\n        (st.deadline ? \", question in \" + Math.max(0, Math.ceil((Number(st.deadline) - now) / 1000)) + \"s\" : \" — tap ⏭ Next to show the question\") + \".\");\n    }\n    return;\n  }\n  if (ph === \"live\" || ph === \"answering\") {"],

['host official answer helper',
"function pollAnswers() {",
"function officialAnswerHTML(q) { // 10a: the host sees the truth right under the answers\n  if (!q || !q.answer) return \"\";\n  var alts = (q.alternates && q.alternates.length)\n    ? ' <span class=\"muted\">(also accepted: ' + esc(q.alternates.join(\", \")) + \")</span>\" : \"\";\n  return '<div style=\"margin-top:8px;padding:8px 10px;background:#17281c;border-radius:8px\">✅ <b>Official answer:</b> ' +\n    '<span style=\"color:var(--gold);font-weight:800\">' + esc(String(q.answer)) + \"</span>\" + alts + \"</div>\";\n}\nfunction pollAnswers() {"],

['host official answer — empty list',
"    if (!list.length) { box.textContent = \"No answers yet.\"; }",
"    if (!list.length) { box.innerHTML = '<span class=\"muted\">No answers yet.</span>' + officialAnswerHTML(q); }"],

['host official answer — after table',
"            (a.wager == null ? \"—\" : a.wager) + \"</td><td>\" + v + \"</td></tr>\";\n        }).join(\"\") + \"</table>\";\n    }",
"            (a.wager == null ? \"—\" : a.wager) + \"</td><td>\" + v + \"</td></tr>\";\n        }).join(\"\") + \"</table>\" + officialAnswerHTML(q); // 10a: official answer between answers and the queue\n    }"],
]);

for (const [path, src] of Object.entries(fileEdits)) fs.writeFileSync(path, src);
console.log('\nDone — ' + applied + ' edits applied across ' + Object.keys(fileEdits).length + ' files.');
console.log('Verify: findstr /M /C:"NGH-BUILD 10a" site\\trivia-host.html site\\trivia-display.html site\\trivia-play.html netlify\\functions\\trivia.mjs');
