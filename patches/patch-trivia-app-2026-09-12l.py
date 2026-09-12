import sys
p = sys.argv[1]
s = open(p, newline='').read()
crlf = '\r\n' in s
if crlf: s = s.replace('\r\n','\n')
MARK = 'NGH-BUILD 2026-09-12l'
if MARK in s:
    print('[=] already patched'); sys.exit(0)

E = []
def rep(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, 'anchor %s matched %d times' % (label, n)
    s = s.replace(old, new); E.append(label)

rep("</style>", """
  /* ===== """ + MARK + """: play the real game INSIDE the app =========
     The player at /trivia-play.html is the proven surface — team join, answers,
     blind wagers, buzz, Reflex Rally taps. In the packaged app NGH.go() sends
     an off-app URL to the system browser sheet, which puts a browser chrome bar
     over a live game and loses the app's back button. Hosting it in a full-bleed
     frame keeps the game logic in ONE place (a fork of the buzz/Reflex timing
     code is the last thing this system needs) while it looks and behaves like
     an app screen. The frame loads the LIVE deployed player, so it can never
     drift from the server the way a bundled copy would. */
  #playWrap{position:fixed;inset:0;z-index:200;background:var(--forest-dk);display:flex;flex-direction:column}
  #playWrap[hidden]{display:none!important}
  #playBar{display:flex;align-items:center;gap:10px;flex:none;
    padding:calc(6px + var(--safe-t)) 12px 6px;background:rgba(19,42,29,.98);border-bottom:1px solid var(--line)}
  #playBar .t{flex:1;font-family:var(--font-head);font-size:.92rem;letter-spacing:.03em;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #playBar button{width:36px;height:36px;border-radius:50%;border:1px solid var(--line);
    background:rgba(255,255,255,.05);color:var(--cream);font-size:19px;line-height:1;flex:none}
  #playFrame{flex:1;width:100%;border:0;background:var(--forest-dk)}
</style>""", 'player overlay styles')

rep("<body>", """<body>
<!-- """ + MARK + """ -->
<div id="playWrap" hidden>
  <div id="playBar">
    <button type="button" id="playBack" aria-label="Back">&lsaquo;</button>
    <span class="t" id="playTitle">Team Trivia</span>
  </div>
  <iframe id="playFrame" title="Team Trivia"
          allow="screen-wake-lock; fullscreen; autoplay"
          referrerpolicy="same-origin"></iframe>
</div>""", 'player overlay markup')

rep("""  $('joinBtn').addEventListener('click', function () { NGH.haptic('success'); });""",
"""  /* """ + MARK + """ — open the player in-app rather than in a browser sheet. */
  var playOpen = false;
  function openPlay() {
    if (!game) return;
    playOpen = true;
    NGH.haptic('success');
    $('playTitle').textContent = kindLabel(game.kind);
    /* Replace the iframe element rather than re-pointing it. A frame that is
       navigated pushes an entry onto the PARENT's history, so re-opening the
       game repeatedly would bury our own pushState and the hardware back
       button would start stepping through the game's history instead of
       closing it. A fresh element's first load does not push. */
    var old = $('playFrame'), f = old.cloneNode(false);
    f.setAttribute('src', joinUrl(game.id));
    old.parentNode.replaceChild(f, old);
    $('playWrap').hidden = false;
    document.body.style.overflow = 'hidden';
    NGH.wakeLock();
    /* Give the hardware/app back button something to pop, so it closes the
       game instead of leaving the Trivia screen entirely. */
    try { history.pushState({ nghPlay: 1 }, ''); } catch (e) {}
  }
  function closePlay(fromPop) {
    if (!playOpen) return;
    playOpen = false;
    $('playWrap').hidden = true;
    document.body.style.overflow = '';
    /* Drop the frame so the game stops polling in the background. Blank it
       first: removing the attribute alone leaves the loaded document alive in
       some engines. */
    var f = $('playFrame');
    if (f) { try { f.setAttribute('src', 'about:blank'); } catch (e) {} f.removeAttribute('src'); }
    if (!fromPop) { try { if (history.state && history.state.nghPlay) history.back(); } catch (e) {} }
  }
  $('joinBtn').addEventListener('click', function (e) { e.preventDefault(); openPlay(); });
  $('playBack').addEventListener('click', function () { NGH.haptic('light'); closePlay(); });
  window.addEventListener('popstate', function () { if (playOpen) closePlay(true); });
  /* The packaged app routes the hardware back button through Capacitor. The
     shell's global handler calls history.back(), which is right for normal
     pages but can be swallowed by the framed game, so close the overlay here
     first and let the shell handle anything else. */
  try {
    var CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (CapApp && CapApp.addListener) CapApp.addListener('backButton', function () { if (playOpen) closePlay(); });
  } catch (e) {}
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && playOpen) closePlay(); });
  /* The player runs cross-origin, so it can buzz `navigator.vibrate` itself on
     Android but cannot reach Capacitor Haptics. If it posts up to us, we do it
     natively — and if it never does, nothing breaks. */
  window.addEventListener('message', function (e) {
    if (!playOpen || !e.data || e.data.ngh !== 'haptic') return;
    if (String(e.origin).indexOf(NGH.SITE) !== 0) return;
    NGH.haptic(String(e.data.kind || 'light'));
  });""", 'openPlay / closePlay / back handling')

rep("""  function showIdle() {
    if (game) { game = null; closeTv(); }""",
"""  function showIdle() {
    if (game) { game = null; closeTv(); closePlay(); }   /* """ + MARK + """ */""",
 'close the player when the game ends')

if crlf: s = s.replace('\n','\r\n')
open(p,'w',newline='').write(s)
print('[ok] %d edits: %s' % (len(E), ', '.join(E)))
