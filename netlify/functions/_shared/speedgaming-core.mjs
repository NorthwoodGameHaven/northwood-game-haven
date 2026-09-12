// netlify/functions/_shared/speedgaming-core.mjs
// NGH-BUILD 2026-09-12l — Speed Gaming Meet-up: pairing engine + round clock.
//
// The event (EVT-PITPB5-103, first run 2026-09-17): players arrive alone or in
// pairs, get matched into 2v2 teams, and swap PARTNERS every round so they meet
// as many people as possible. 3 rounds, each 10 min teach + 40 min play + 10 min
// break. Prizes each round.
//
// The whole point of the night is meeting new people, so the pairing rules are
// ranked in that order:
//   1. never partner the same two people twice          (hard — costs FORBIDDEN)
//   2. avoid facing anyone you have already faced        (strong preference)
//   3. split up people who arrived together              (preference)
//   4. keep everyone playing — byes go to whoever has sat out LEAST
//
// Above all of it sits one structural guarantee: CONSERVATION. Every active
// player comes back either at a table or on the bye list, exactly once. A
// player who falls out of a round is a real person left standing in the shop,
// so the matching is built to always produce a complete pairing and the
// preferences are expressed as costs — never as a refusal to seat someone.
//
// Method: greedy cheapest-pair-first to get a complete matching, then a 2-opt
// repair pass that swaps members between two teams (or opponents between two
// tables) whenever that lowers total cost. Greedy alone can strand a bad pair
// at the end — e.g. the last two people left are the couple who arrived
// together — and the repair pass is what fixes those without ever leaving a
// player unmatched.
//
// Pure module: no db, no network, deterministic given a seed, so the awkward
// cases (odd numbers, 2 players, a room that is entirely couples, a partner
// pool that has run dry) get tested rather than discovered on the night.

export const DEFAULT_PHASES = [
  { id: 'teach', label: 'Teach the game', minutes: 10 },
  { id: 'play', label: 'Play', minutes: 40 },
  { id: 'break', label: 'Break / swap partners', minutes: 10 }
];
export const DEFAULT_ROUNDS = 3;
export const TEAM_SIZE = 2;
export const PLAYERS_PER_TABLE = TEAM_SIZE * 2;   // 2v2

// Cost weights. FORBIDDEN is a large finite number rather than Infinity so the
// repair pass can still do arithmetic on it and so a room with no legal pairing
// left degrades into "repeat a partner and say so" instead of into no round.
const FORBIDDEN = 1e6;          // rule 1 — already partnered
const COST_REMATCH = 2;         // rule 2 — partnering someone you have faced
const COST_TOGETHER = 8;        // rule 3 — partnering whoever you arrived with
const COST_FACED_AGAIN = 3;     // rule 2 — facing someone you have faced, per pair
// Convergence guard on the repair pass. Measured: it settles in a SINGLE pass
// on every room shape tested (4–100 players, fresh and 3 rounds deep, with and
// without couples), so the extra iterations never actually run — they are here
// so a shape nobody has tried yet still terminates at a local optimum rather
// than shipping whatever the first pass happened to leave.
const REPAIR_PASSES = 24;

// ---- tiny deterministic RNG so a round can be regenerated identically -------
export function rng(seed) {
  let s = 0;
  const str = String(seed == null || seed === '' ? 'ngh' : seed);
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
  if (!s) s = 0x9e3779b9;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}
function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

const key = (a, b) => [String(a), String(b)].sort().join('|');

// history: { partners: ["a|b"…], opponents: ["a|b"…], byes: {id: count} }
export function emptyHistory() { return { partners: [], opponents: [], byes: {} }; }

// A round may be rebuilt from a stored history that predates a field, or from a
// hand-written one in the Guru console. Never trust its shape.
//
// The Sets matter: the repair pass asks "have these two met?" tens of thousands
// of times for a big room, and an indexOf over a growing array turned a
// 40-player night into a multi-second stall. Built once per round, read many.
function normalizeHistory(h) {
  const partners = Array.isArray(h && h.partners) ? h.partners : [];
  const opponents = Array.isArray(h && h.opponents) ? h.opponents : [];
  return {
    partners, opponents,
    byes: (h && h.byes && typeof h.byes === 'object') ? h.byes : {},
    _p: new Set(partners),
    _o: new Set(opponents)
  };
}

function hasMet(set, a, b) { return set.has(key(a, b)); }

// How bad is it to partner these two? Lower is better. Takes PLAYERS, not ids —
// arrivedWith lives on the player object.
function partnerCost(h, a, b) {
  let cost = 0;
  if (hasMet(h._p, a.id, b.id)) cost += FORBIDDEN;
  if (hasMet(h._o, a.id, b.id)) cost += COST_REMATCH;
  if (a.arrivedWith && a.arrivedWith === b.arrivedWith) cost += COST_TOGETHER;
  return cost;
}
function matchCost(h, t1, t2) {
  let cost = 0;
  for (const x of t1) for (const y of t2) if (hasMet(h._o, x.id, y.id)) cost += COST_FACED_AGAIN;
  return cost;
}

// Greedy cheapest-first over EVERY pair, so the matching is always complete.
// `cost(a, b)` is called on the items themselves; ties keep input order, which
// is the shuffled order, which is what makes this deterministic per seed.
function matchAll(items, cost) {
  const pairs = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      pairs.push({ i, j, c: cost(items[i], items[j]) });
  pairs.sort((x, y) => x.c - y.c);
  const used = new Array(items.length).fill(false);
  const out = [];
  for (const p of pairs) {
    if (used[p.i] || used[p.j]) continue;
    used[p.i] = used[p.j] = true;
    out.push([items[p.i], items[p.j]]);
  }
  return out;   // items.length even ⇒ every item is used
}

// What one table costs: its two partnerships plus the four match-ups across it.
function tableCost(t, h) {
  return partnerCost(h, t.teamA[0], t.teamA[1])
       + partnerCost(h, t.teamB[0], t.teamB[1])
       + matchCost(h, t.teamA, t.teamB);
}
export function roundCost(tables, h) {
  const hh = h && h._p ? h : normalizeHistory(h);
  return (tables || []).reduce((c, t) => c + tableCost(t, hh), 0);
}

// Pairing people and then matching the teams is greedy twice over — a partner
// choice that looked free in step one can force a rematch in step two. So the
// finished seating gets one pass that judges both at once: try swapping every
// two seats in the room and keep any swap that lowers the total.
//
// Only the one or two tables a swap touches can change, so the delta is scored
// from those alone. Scoring the whole room instead made a 40-player night take
// seconds; this makes it imperceptible.
function repairSeats(tables, h) {
  if (tables.length < 1) return tables;
  const seats = [];
  tables.forEach((t, ti) => {
    for (const side of ['teamA', 'teamB']) for (let s = 0; s < TEAM_SIZE; s++) seats.push({ ti, side, s });
  });
  for (let pass = 0; pass < REPAIR_PASSES; pass++) {
    let improved = false;
    for (let x = 0; x < seats.length; x++) {
      for (let y = x + 1; y < seats.length; y++) {
        const A = seats[x], B = seats[y];
        if (A.ti === B.ti && A.side === B.side) continue;          // same team — no change
        const sameTable = A.ti === B.ti;
        const before = tableCost(tables[A.ti], h) + (sameTable ? 0 : tableCost(tables[B.ti], h));
        const ta = tables[A.ti][A.side], tb = tables[B.ti][B.side];
        const tmp = ta[A.s]; ta[A.s] = tb[B.s]; tb[B.s] = tmp;     // swap
        const after = tableCost(tables[A.ti], h) + (sameTable ? 0 : tableCost(tables[B.ti], h));
        if (after < before) improved = true;
        else { const t2 = ta[A.s]; ta[A.s] = tb[B.s]; tb[B.s] = t2; }   // put them back
      }
    }
    if (!improved) break;
  }
  return tables;
}

// ---- one round --------------------------------------------------------------
// players: [{ id, name, arrivedWith?, active? }]  (already checked in)
// Returns { tables:[{table, teamA:[p,p], teamB:[p,p], game}], byes:[p], warnings:[] }
export function buildRound(players, history, opts = {}) {
  const h = normalizeHistory(history);
  const rand = rng(opts.seed != null ? opts.seed : 'r' + (opts.round || 1));
  const games = Array.isArray(opts.games) ? opts.games.slice() : [];
  const warnings = [];

  const active = (players || []).filter(p => p && p.id != null && p.active !== false);

  // --- byes: 2v2 needs a multiple of 4 ---------------------------------------
  // Shuffle first, then a STABLE sort by how often each player has already sat
  // out, and bench from the FRONT — the people who have sat out least. Shuffle
  // + stable sort is what breaks ties fairly without a random comparator (which
  // is non-transitive and would make the result non-deterministic).
  let pool = shuffled(active, rand);
  const byes = [];
  const remainder = active.length % PLAYERS_PER_TABLE;
  if (remainder) {
    pool.sort((a, b) => (h.byes[a.id] || 0) - (h.byes[b.id] || 0));
    for (let i = 0; i < remainder; i++) byes.push(pool.shift());
    pool = shuffled(pool, rand);
    warnings.push(remainder + ' player' + (remainder === 1 ? '' : 's') + ' sitting out this round (a 2v2 night needs a multiple of 4)');
  }
  if (pool.length < PLAYERS_PER_TABLE) {
    return {
      tables: [], byes: byes.concat(pool),
      warnings: warnings.concat(['not enough players for a 2v2 table'])
    };
  }

  // --- pair into teams -------------------------------------------------------
  const teams = matchAll(pool, (a, b) => partnerCost(h, a, b));

  // --- match teams against teams, then settle the room as a whole ------------
  const matched = matchAll(teams, (t1, t2) => matchCost(h, t1, t2));
  const tables = repairSeats(matched.map((m, i) => ({
    table: (Number(opts.firstTable) || 1) + i,
    teamA: m[0],
    teamB: m[1],
    game: games.length ? games[i % games.length] : null
  })), h);

  // Warn only about what SURVIVED the repair passes.
  for (const t of tables) {
    for (const team of [t.teamA, t.teamB]) {
      if (hasMet(h._p, team[0].id, team[1].id)) {
        warnings.push(team[0].name + ' and ' + team[1].name + ' had to repeat a partnership — everyone else is already used up');
      }
    }
  }
  return { tables, byes, warnings };
}

// Fold a generated round back into history so the next round avoids repeats.
export function applyRound(history, round) {
  const h = normalizeHistory(history);
  const out = { partners: h.partners.slice(), opponents: h.opponents.slice(), byes: Object.assign({}, h.byes) };
  for (const t of ((round && round.tables) || [])) {
    out.partners.push(key(t.teamA[0].id, t.teamA[1].id));
    out.partners.push(key(t.teamB[0].id, t.teamB[1].id));
    for (const x of t.teamA) for (const y of t.teamB) out.opponents.push(key(x.id, y.id));
  }
  for (const p of ((round && round.byes) || [])) out.byes[p.id] = (out.byes[p.id] || 0) + 1;
  return out;
}

// ---- round clock ------------------------------------------------------------
// Server-epoch scheduling, same shape as the trivia/karaoke engines: the client
// is told when each phase ENDS and runs its own clock, so the display never
// jitters and a dropped poll doesn't stall the countdown.
export function phasePlan(phases, startAtMs) {
  const list = (phases && phases.length ? phases : DEFAULT_PHASES);
  let t = Number(startAtMs) || 0;
  return list.map(p => {
    const startsAt = t;
    t += Math.max(0, Number(p.minutes) || 0) * 60000;
    return { id: p.id, label: p.label, minutes: p.minutes, startsAt, endsAt: t };
  });
}
export function roundLengthMs(phases) {
  return (phases && phases.length ? phases : DEFAULT_PHASES)
    .reduce((a, p) => a + Math.max(0, Number(p.minutes) || 0) * 60000, 0);
}
// Which phase is running at `now`, and how long is left of it. The instant a
// phase ends belongs to the next phase, so a clock never sits at 0:00.
export function phaseAt(plan, now) {
  const t = Number(now) || 0;
  if (!plan || !plan.length) return null;
  if (t < plan[0].startsAt) return { state: 'pending', next: plan[0], msToStart: plan[0].startsAt - t };
  for (const p of plan) if (t < p.endsAt) return { state: 'running', phase: p, msLeft: p.endsAt - t };
  return { state: 'done', msLeft: 0 };
}
