import sys
p = sys.argv[1]
s = open(p, newline='').read()
crlf = '\r\n' in s
if crlf: s = s.replace('\r\n','\n')
MARK = 'NGH-BUILD 2026-09-12l'
if MARK in s:
    print('[=] already patched'); sys.exit(0)
E=[]
def rep(old,new,label):
    global s
    n=s.count(old); assert n==1, 'anchor "%s" x%d' % (label,n)
    s=s.replace(old,new); E.append(label)

# ---- styles ----------------------------------------------------------------
rep("</style>", """
  /* ===== """ + MARK + """: Name That Tune ==============================
     A full-screen takeover, on purpose. When the buzzer round is live this is
     the only thing that should be on the phone — a player hunting for a small
     button in a tab bar has already lost the race, and the whole game is the
     race being fair. */
  #mgWrap{position:fixed;inset:0;z-index:300;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;
    background:radial-gradient(circle at 50% 30%,#20472e,#0e2116 70%)}
  #mgWrap[hidden]{display:none!important}
  #mgWrap .lbl{font-family:var(--font-head);letter-spacing:.22em;text-transform:uppercase;
    font-size:.82rem;color:var(--muted)}
  #mgWrap .big{font-family:var(--font-display);font-size:2rem;line-height:1.15;color:var(--gold-lt)}
  /* One enormous target. Thumbs, adrenaline, bad lighting. */
  #mgBtn{width:min(74vw,300px);height:min(74vw,300px);border-radius:50%;border:0;
    font-family:var(--font-display);font-size:2.4rem;color:#1b1206;
    background:radial-gradient(circle at 40% 32%,#ffd97a,#c9973a 68%,#8a6218);
    box-shadow:0 14px 40px rgba(0,0,0,.55),inset 0 -10px 22px rgba(0,0,0,.28);
    transition:transform .06s ease;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  #mgBtn:active{transform:scale(.955)}
  #mgBtn:disabled{filter:grayscale(.75) brightness(.62);box-shadow:none}
  #mgBtn.ready{background:radial-gradient(circle at 40% 32%,#7bf59b,#28a35a 68%,#166a37);color:#04220f;
    animation:mgpulse 1s ease-in-out infinite}
  @keyframes mgpulse{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}
  #mgWrap .res{font-size:1.06rem;color:var(--cream);min-height:1.4em}
  #mgWrap .rt{font-family:var(--font-display);font-size:1.5rem;color:var(--gold-lt)}
  #mgWrap .queue{font-size:.88rem;color:var(--muted);max-width:340px}
  #mgWrap .youre-up{background:var(--gold);color:#26211a;font-weight:800;border-radius:999px;
    padding:9px 20px;font-size:1.05rem}
  #mgWrap .jumped{color:#ff9b8a}
</style>""", 'buzzer styles')

# ---- markup ----------------------------------------------------------------
rep('<nav class="tabbar" id="tabs" hidden>', """<!-- """ + MARK + """ -->
<div id="mgWrap" hidden>
  <div class="lbl" id="mgRound">Name that tune</div>
  <div class="big" id="mgHead">Get ready…</div>
  <button id="mgBtn" type="button" disabled>WAIT</button>
  <div class="res" id="mgRes"></div>
  <div class="queue" id="mgQueue"></div>
</div>

<nav class="tabbar" id="tabs" hidden>""", 'buzzer markup')

# ---- behaviour --------------------------------------------------------------
rep("  function render(){", """  /* ===== """ + MARK + """: Name That Tune ==============================
     The GO moment is computed from the shared server clock, not from a message
     the server pushes at that instant — so every phone unlocks together and the
     race does not reward whoever happens to have the best signal. The press we
     report is the clock-corrected local time, and the server clamps anything
     implausible. */
  var mgTick = null, mgSeenId = null, mgMine = null, mgArmedHaptic = false;

  function mgPost(){
    if (!state || !state.mg) return;
    var mg = state.mg;
    $('mgBtn').disabled = true;
    NGH.haptic('heavy');
    NGH.fetchJSON(KClient.sessionUrl(CODE) + '/mgbuzz', {
      method: 'POST', body: { token: me.token, mgId: mg.id, t: NGH.clock.now() }
    }).then(function(j){
      mgMine = j;
      mgPaint();
      if (pollH) pollH.kick();
    }).catch(function(e){
      // A refusal is almost always "too early" or the round moving on. Say so
      // plainly rather than leaving a dead button.
      mgMine = { error: e && e.message ? e.message : 'no good' };
      mgPaint();
    });
  }

  function mgPaint(){
    var mg = state && state.mg;
    var w = $('mgWrap');
    if (!mg || mg.phase === 'idle'){ if (!w.hidden){ w.hidden = true; clearInterval(mgTick); mgTick = null; } return; }
    if (w.hidden){ w.hidden = false; NGH.wakeLock(); }
    if (mg.id !== mgSeenId){ mgSeenId = mg.id; mgMine = null; mgArmedHaptic = false; }

    var now = NGH.clock.now(), btn = $('mgBtn'), head = $('mgHead'), res = $('mgRes');
    $('mgRound').textContent = 'Name that tune · round ' + (mg.round || 1);

    if (mg.phase === 'reveal'){
      clearInterval(mgTick); mgTick = null;
      btn.disabled = true; btn.className = ''; btn.textContent = '♪';
      head.textContent = mg.title || 'Time\\u2019s up';
      res.innerHTML = (mg.artist ? '<div class="muted">' + esc(mg.artist) + '</div>' : '') +
        (mg.result === 'correct' ? '<div class="rt">Got it!</div>' : '<div class="muted">Nobody got that one</div>');
      $('mgQueue').textContent = '';
      return;
    }

    var mine = (mg.buzzes || []).find(function(b){ return b.memberId === (me && me.id); });
    var onClock = mg.answering && me && mg.answering === me.id;

    if (onClock){
      btn.disabled = true; btn.className = ''; btn.textContent = '🎤';
      head.innerHTML = '<span class="youre-up">You\\u2019re up — say it!</span>';
      res.innerHTML = mine ? '<span class="rt">' + (mine.rt / 1000).toFixed(2) + 's</span>' : '';
    } else if (mine){
      btn.disabled = true; btn.className = ''; btn.textContent = mine.jumped ? '✋' : '✓';
      head.textContent = mine.jumped ? 'Too soon!' : 'Buzzed';
      res.innerHTML = mine.jumped
        ? '<span class="jumped">You went before the go — out for this round.</span>'
        : '<span class="rt">' + (mine.rt / 1000).toFixed(2) + 's</span>' +
          (mg.answering ? '<div class="muted">Someone beat you to it — stay ready for the steal.</div>' : '');
    } else if (now < mg.goAt){
      var left = Math.max(0, mg.goAt - now);
      btn.disabled = true; btn.className = ''; btn.textContent = 'WAIT';
      head.textContent = 'Get ready…';
      res.textContent = (left / 1000).toFixed(1) + 's';
    } else {
      btn.disabled = false; btn.className = 'ready'; btn.textContent = 'BUZZ';
      head.textContent = 'Name it!';
      res.textContent = '';
      if (!mgArmedHaptic){ mgArmedHaptic = true; NGH.haptic('heavy'); }
    }
    if (mgMine && mgMine.error){ res.innerHTML = '<span class="jumped">' + esc(mgMine.error) + '</span>'; }

    var q = (mg.buzzes || []).slice().sort(function(a,b){ return (a.jumped - b.jumped) || (a.rt - b.rt); });
    $('mgQueue').innerHTML = q.length
      ? q.slice(0, 6).map(function(b, i){
          return (i + 1) + '. ' + esc(b.name) + (b.jumped ? ' <span class="jumped">(jumped)</span>' : ' · ' + (b.rt / 1000).toFixed(2) + 's');
        }).join('<br>')
      : '';

    if (!mgTick) mgTick = setInterval(mgPaint, 100);
  }
  $('mgBtn').addEventListener('click', mgPost);

  function render(){""", 'buzzer behaviour')

# call it from render()
rep("    var s = state, np = s.nowPlaying, mine = me && me.id;",
    "    var s = state, np = s.nowPlaying, mine = me && me.id;\n    mgPaint();   /* " + MARK + " */", 'hook into render')

if crlf: s = s.replace('\n','\r\n')
open(p,'w',newline='').write(s)
print('[ok] %d edits: %s' % (len(E), '; '.join(E)))
