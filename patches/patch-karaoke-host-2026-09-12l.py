import sys
p=sys.argv[1]
s=open(p,newline='').read()
crlf='\r\n' in s
if crlf: s=s.replace('\r\n','\n')
MARK='NGH-BUILD 2026-09-12l'
if MARK in s: print('[=] already patched'); sys.exit(0)
E=[]
def rep(old,new,label):
    global s
    n=s.count(old); assert n==1, 'anchor "%s" x%d' % (label,n)
    s=s.replace(old,new); E.append(label)

rep("""          <div id="lastRes" class="small" style="margin-top:8px"></div>""",
"""          <div id="lastRes" class="small" style="margin-top:8px"></div>

          <!-- """ + MARK + """: Name That Tune ------------------------------
               Sits with the transport because that is where the Guru already
               is between songs, which is exactly when this game gets played. -->
          <div class="card" id="mgCard" style="margin-top:10px;border-color:var(--gold)">
            <h2 style="margin-bottom:6px">🎵 Name That Tune <span class="small muted" id="mgState"></span></h2>
            <div class="small muted" id="mgAnswer" style="margin-bottom:8px"></div>
            <div class="btn-row" id="mgBtns"></div>
            <div id="mgBuzzes" class="small" style="margin-top:8px"></div>
          </div>""", 'minigame card')

rep("""    $('scBox').hidden = !s.scoring;""",
"""    mgRender(s);   /* """ + MARK + """ */
    $('scBox').hidden = !s.scoring;""", 'render hook')

rep("""  function render(){""",
"""  /* ===== """ + MARK + """: Name That Tune host controls ================
     One row of buttons whose contents depend entirely on the phase, so the
     Guru never has to work out which of eight actions applies right now.
     ARM is the only timing-critical one: press it as the clip starts. */
  function mgRender(s){
    var mg = s.mg, st = $('mgState'), ans = $('mgAnswer'), btns = $('mgBtns'), bz = $('mgBuzzes');
    if (!mg){
      st.textContent = ''; ans.textContent = 'Fills the gap while the next singer sets up.';
      btns.innerHTML = '<button class="btn sm" data-mg="mgStart">🎲 Pick a song</button>';
      bz.innerHTML = '';
    } else {
      st.textContent = '· round ' + (mg.round || 1) + ' · ' + mg.phase;
      // The Guru is the ONLY person who gets to see the answer before the
      // reveal — that is the whole point of holding it back from public state.
      ans.innerHTML = mg.phase === 'reveal'
        ? '<b>' + esc(mg.title || '') + '</b>' + (mg.artist ? ' — ' + esc(mg.artist) : '')
        : '<b>Answer:</b> ' + esc(mgSecret.title || '(pick a song)') + (mgSecret.artist ? ' — ' + esc(mgSecret.artist) : '') +
          ' <span class="muted">(only you can see this)</span>';
      var b = [];
      if (mg.phase === 'idle') b.push('<button class="btn sm teal" data-mg="mgArm">▶ Play the clip &amp; ARM</button>', '<button class="btn sm ghost" data-mg="mgStart">🎲 Different song</button>');
      else if (mg.phase === 'armed') b.push('<button class="btn sm ghost" data-mg="mgReveal">Reveal (nobody got it)</button>');
      else if (mg.phase === 'answering') b.push('<button class="btn sm teal" data-mg="mgJudge:1">✔ Correct</button>', '<button class="btn sm" data-mg="mgJudge:0">✘ Wrong — pass it on</button>', '<button class="btn sm ghost" data-mg="mgTimeout:1">⏱ Out of time</button>');
      else if (mg.phase === 'reveal') b.push('<button class="btn sm" data-mg="mgStart">🎲 Next round</button>', '<button class="btn sm ghost" data-mg="mgEnd">Done with the game</button>');
      b.push('<button class="btn sm ghost" data-mg="mgEnd">✕ Close</button>');
      btns.innerHTML = b.join('');
      var q = (mg.buzzes || []).slice().sort(function(a,b2){ return (a.jumped - b2.jumped) || (a.rt - b2.rt); });
      bz.innerHTML = q.length ? q.map(function(x, i){
        var onClock = mg.answering === x.memberId;
        return '<div' + (onClock ? ' style="color:var(--gold-lt);font-weight:700"' : '') + '>' + (i + 1) + '. ' + esc(x.name) +
          (x.jumped ? ' <span style="color:var(--red)">jumped</span>' : ' · ' + (x.rt / 1000).toFixed(2) + 's') +
          (onClock ? ' ← answering' : '') + ((mg.missed || []).indexOf(x.memberId) >= 0 ? ' <span class="muted">(missed)</span>' : '') + '</div>';
      }).join('') : '<span class="muted">No buzzes yet.</span>';
    }
    document.querySelectorAll('#mgBtns [data-mg]').forEach(function(btn){
      btn.onclick = function(){
        var parts = btn.getAttribute('data-mg').split(':');
        var extra = {};
        if (parts[0] === 'mgJudge') extra.ok = parts[1] === '1';
        if (parts[0] === 'mgTimeout') extra.force = true;
        ctl(parts[0], extra).then(function(j){
          // mgStart is the only call that hands back the answer; keep it in
          // memory on this device and never let it near the shared state.
          if (parts[0] === 'mgStart' && j && j.result) mgSecret = { title: j.result.title, artist: j.result.artist };
          if (parts[0] === 'mgEnd') mgSecret = {};
          /* ctl() re-renders before this callback runs, so without a second
             paint the Guru stares at "(pick a song)" until the next poll —
             several seconds of not knowing the answer they are about to judge. */
          if (state) mgRender(state);
        });
      };
    });
  }
  var mgSecret = {};

  function render(){""", 'host controls')

if crlf: s=s.replace('\n','\r\n')
open(p,'w',newline='').write(s)
print('[ok] %d edits: %s' % (len(E), '; '.join(E)))
