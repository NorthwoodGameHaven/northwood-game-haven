import sys
p = sys.argv[1]
s = open(p, newline='').read()
crlf = '\r\n' in s
if crlf: s = s.replace('\r\n', '\n')
MARK = 'NGH-BUILD 2026-09-12l'
if MARK in s:
    print('[=] already patched'); sys.exit(0)

E = []
def rep(old, new, label):
    global s
    n = s.count(old)
    assert n == 1, 'anchor "%s" matched %d times' % (label, n)
    s = s.replace(old, new); E.append(label)

# ---------------------------------------------------------------- 1. engine
rep("// ---- transport ----", """// ---- Name That Tune (Battle Karaoke minigame) — """ + MARK + """ ----------
// Between performances the next singer is setting up and the room goes flat.
// This fills it: a few seconds of a song intro, first phone to buzz gets to
// name it, points go to their ROOM's battle score.
//
// The buzz model is lifted from arcade.mjs because it is already right:
//   * The host ARMS the round. goAt = armAt + a short lead, and every phone
//     flips to "GO" on its OWN clock-synced timer — no server round trip in
//     the hot path, so the race is fair regardless of who has better wifi.
//   * A press posts the phone's offset-corrected server time. Reaction is
//     t - goAt. Pressing before goAt is a JUMP: recorded, ordered last, and
//     the Guru can see who jumped the gun.
//   * Anti-cheat: t is clamped to the server's arrival time (nobody presses
//     from the future) and anything wildly early is rejected outright.
//
// Deliberately NOT automated end to end: the Guru arms it at the moment they
// start the clip, whatever the audio is coming from. Only the rack player can
// reach the LAN audio files (browsers get HTTPS-only URLs), so tying the game
// to rack-player automation would make it unusable on any night the rack PC is
// off. `mg.media` is published for the rack player to pick up when it can, and
// the game works perfectly without it.
const MG_LEAD_MS = 2500;          // between arming and GO
const MG_ANSWER_MS = 15000;       // how long the first buzzer has to answer
const MG_POINTS = 10;
const MG_STEAL_POINTS = 5;        // a steal after someone else missed

function mgPublic(mg, serverNow) {
  if (!mg) return null;
  const out = {
    id: mg.id, kind: mg.kind, round: mg.round, phase: mg.phase,
    armAt: mg.armAt || 0, goAt: mg.goAt || 0, clipMs: mg.clipMs || 0,
    points: mg.points, answerBy: mg.answerBy || 0,
    buzzes: (mg.buzzes || []).map(b => ({ memberId: b.memberId, name: b.name, room: b.room, rt: b.rt, jumped: !!b.jumped })),
    answering: mg.answering || null,
    result: mg.result || null,
    missed: mg.missed || []
  };
  // The whole game is not knowing what the song is. Title, artist and songId
  // stay server-side until the reveal — a curious player reading the JSON in
  // devtools would otherwise win every round.
  if (mg.phase === 'reveal') { out.title = mg.title; out.artist = mg.artist; out.songId = mg.songId; }
  return out;
}
function mgRoomOf(s, memberId) {
  const m = (s.members || []).find(x => x.id === memberId);
  return m ? m.room : null;
}
function mgAward(s, memberId, pts) {
  const room = mgRoomOf(s, memberId);
  if (!room || !s.rooms || !s.rooms[room]) return null;
  s.rooms[room].score = round1((Number(s.rooms[room].score) || 0) + pts);
  return room;
}
// Buzz order: everyone who went early is sorted behind everyone who didn't,
// then by reaction time.
function mgSortBuzzes(list) {
  return list.slice().sort((a, b) => (a.jumped - b.jumped) || (a.rt - b.rt) || (a.at - b.at));
}
// Who is next in line after the people who have already had their turn.
function mgNextUp(mg) {
  const done = mg.missed || [];
  return mgSortBuzzes(mg.buzzes || []).find(b => done.indexOf(b.memberId) < 0) || null;
}

// ---- transport ----""", 'Name That Tune engine')

# ---------------------------------------------------------------- 2. redaction
rep("  out.serverNow = serverNow;", """  out.mg = mgPublic(s.mg, serverNow);   /* """ + MARK + """ */
  out.serverNow = serverNow;""", 'publish the minigame (redacted until reveal)')

# ---------------------------------------------------------------- 3. buzz route
rep("""    // ---- host control ----
    if (sub === 'control' && req.method === 'POST') {""",
"""    // ---- PUBLIC: Name That Tune buzz (""" + MARK + """) ----
    if (sub === 'mgbuzz' && req.method === 'POST') {
      const b = await readBody(req);
      const arrival = now();
      const r = await mutate(code, (s) => {
        const mg = s.mg;
        if (!mg || mg.phase !== 'armed') throw { status: 409, error: 'no round is live' };
        if (b.mgId && b.mgId !== mg.id) throw { status: 409, error: 'stale round' };
        const m = findMember(s, b.token);
        if (!m) throw { status: 403, error: 'not checked in' };
        // One buzz per person per round. Answering "you already buzzed" is not
        // an error — a double-tap on a phone is the most ordinary thing there is.
        const prior = (mg.buzzes || []).find(x => x.memberId === m.id);
        if (prior) return { noChange: true, already: true, rt: prior.rt, jumped: prior.jumped, position: mgSortBuzzes(mg.buzzes).findIndex(x => x.memberId === m.id) + 1 };
        let t = Number(b.t);
        if (!isFinite(t)) t = arrival;                  // phone never synced its clock
        if (t > arrival + 250) t = arrival;             // no presses from the future
        if (t < Number(mg.armAt || 0) - 2000) throw { status: 409, error: 'too early' };
        const jumped = t < Number(mg.goAt || 0);
        const rt = Math.round(t - Number(mg.goAt || 0));
        mg.buzzes = mg.buzzes || [];
        mg.buzzes.push({ memberId: m.id, name: m.name, room: m.room, at: t, rt, jumped });
        // First clean buzz takes the floor and starts their answer clock.
        if (!mg.answering && !jumped) {
          mg.answering = m.id;
          mg.answerBy = now() + MG_ANSWER_MS;
          mg.phase = 'answering';
        }
        return { rt, jumped, position: mgSortBuzzes(mg.buzzes).findIndex(x => x.memberId === m.id) + 1 };
      });
      if (r.error) return bad(r.error, r.status);
      return json(Object.assign({ ok: true, serverNow: now() }, r.result));
    }

    // ---- host control ----
    if (sub === 'control' && req.method === 'POST') {""", 'mgbuzz route')

# ---------------------------------------------------------------- 4. controls
rep("          case 'setSettings': Object.assign(s.settings, sanitizeSettings(body.settings || {})); return {};",
"""          /* ===== """ + MARK + """: Name That Tune ===================== */
          case 'mgStart': {
            // Pick a song the room has a chance at: prefer the catalog, and
            // never one that has already been used tonight.
            const used = (s.mgUsed || []);
            let song = null;
            if (body.songId) {
              const rows = await sql`SELECT id, title, artist, data FROM karaoke_songs WHERE id = ${String(body.songId)}`;
              if (!rows.length) throw { status: 404, error: 'no such song' };
              song = rows[0];
            } else {
              const rows = await sql`SELECT id, title, artist, data FROM karaoke_songs ORDER BY random() LIMIT 40`;
              song = rows.find(r => used.indexOf(r.id) < 0) || rows[0] || null;
              if (!song) throw { status: 409, error: 'the song catalog is empty — add songs first' };
            }
            const d = song.data || {};
            s.mg = {
              id: rid('mg'), kind: 'nametune', round: ((s.mg && s.mg.round) || 0) + 1,
              phase: 'idle', songId: song.id, title: song.title, artist: song.artist,
              armAt: 0, goAt: 0, clipMs: Math.min(30000, Math.max(2000, Math.round(Number(body.clipMs) || 7000))),
              points: MG_POINTS, buzzes: [], answering: null, answerBy: 0, result: null, missed: [],
              // Only the rack player can use a LAN audio path; browsers never see it.
              media: d.media && d.media.audio ? { audio: d.media.audio } : null
            };
            return { mgId: s.mg.id, title: song.title, artist: song.artist, hasAudio: !!s.mg.media };
          }
          case 'mgArm': {
            if (!s.mg) throw { status: 409, error: 'start a round first' };
            if (s.mg.phase === 'armed' || s.mg.phase === 'answering') throw { status: 409, error: 'this round is already live' };
            s.mg.armAt = now();
            s.mg.goAt = s.mg.armAt + Math.min(10000, Math.max(0, Math.round(Number(body.leadMs) != null ? Number(body.leadMs) : MG_LEAD_MS)));
            s.mg.phase = 'armed';
            s.mg.buzzes = []; s.mg.answering = null; s.mg.answerBy = 0; s.mg.result = null; s.mg.missed = [];
            return { goAt: s.mg.goAt };
          }
          // Correct: points to the answerer's room, and the answer is revealed.
          // Wrong: they are struck off and the floor opens to the next buzzer
          // for a steal, which is the bit that makes the game fun.
          case 'mgJudge': {
            const mg = s.mg;
            if (!mg || !mg.answering) throw { status: 409, error: 'nobody is answering' };
            const who = mg.answering;
            if (body.ok) {
              const steal = (mg.missed || []).length > 0;
              const pts = steal ? MG_STEAL_POINTS : mg.points;
              const room = mgAward(s, who, pts);
              mg.result = 'correct'; mg.phase = 'reveal'; mg.wonBy = who; mg.wonPoints = pts; mg.wonRoom = room;
              s.mgUsed = (s.mgUsed || []).concat([mg.songId]).slice(-200);
              return { correct: true, points: pts, room };
            }
            mg.missed = (mg.missed || []).concat([who]);
            const next = mgNextUp(mg);
            if (next) { mg.answering = next.memberId; mg.answerBy = now() + MG_ANSWER_MS; mg.phase = 'answering'; return { steal: next.name }; }
            mg.answering = null; mg.answerBy = 0; mg.phase = 'armed';
            return { reopened: true };
          }
          // The answer clock ran out. Same shape as a wrong answer so the game
          // never stalls waiting for a Guru who is dealing with something else.
          case 'mgTimeout': {
            const mg = s.mg;
            if (!mg || !mg.answering) return { noChange: true };
            if (mg.answerBy && now() < mg.answerBy && !body.force) return { noChange: true };
            mg.missed = (mg.missed || []).concat([mg.answering]);
            const next = mgNextUp(mg);
            if (next) { mg.answering = next.memberId; mg.answerBy = now() + MG_ANSWER_MS; mg.phase = 'answering'; return { steal: next.name }; }
            mg.answering = null; mg.answerBy = 0; mg.phase = 'armed';
            return { reopened: true };
          }
          case 'mgReveal': {
            if (!s.mg) throw { status: 409, error: 'no round' };
            s.mg.phase = 'reveal';
            if (!s.mg.result) s.mg.result = 'nobody';
            s.mgUsed = (s.mgUsed || []).concat([s.mg.songId]).slice(-200);
            return {};
          }
          case 'mgEnd': { s.mg = null; return {}; }
          /* ===================================================== end """ + MARK + """ */
          case 'setSettings': Object.assign(s.settings, sanitizeSettings(body.settings || {})); return {};""",
 'mgStart / mgArm / mgJudge / mgTimeout / mgReveal / mgEnd')

# A session that ends should not leave a minigame hanging on the TV.
rep("          case 'endSession': if (s.nowPlaying) endCurrent(s, 'skip'); if (s.scoring) await tallyVotes(code, s, true); s.status = 'ended'; s.endedAt = now(); return {};",
    "          case 'endSession': s.mg = null; /* " + MARK + " */ if (s.nowPlaying) endCurrent(s, 'skip'); if (s.scoring) await tallyVotes(code, s, true); s.status = 'ended'; s.endedAt = now(); return {};",
    'clear the minigame on endSession')

if crlf: s = s.replace('\n', '\r\n')
open(p, 'w', newline='').write(s)
print('[ok] %d edits: %s' % (len(E), '; '.join(E)))
