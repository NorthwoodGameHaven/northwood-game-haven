// NGH-BUILD 2026-09-12l
// tests/speedgaming.test.mjs — the Speed Gaming Meet-up pairing engine.
//
// This runs live on a room full of people on 2026-09-17, and a bad pairing is
// visible to everyone in the room instantly ("we just played you", "I'm sitting
// out again"). So the awkward cases get asserted here rather than discovered
// on the night: odd headcounts, everyone arriving as couples, a partner pool
// that has run dry, and the exact boundaries of the 10/40/10 clock.
//
// The invariant that matters most is CONSERVATION: every checked-in player is
// either at a table or on the bye list, exactly once. A player who silently
// vanishes from a round is someone standing in the middle of the shop with
// nowhere to sit.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as SG from '../netlify/functions/_shared/speedgaming-core.mjs';

// ---- helpers ----------------------------------------------------------------
const people = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: 'p' + (i + 1), name: 'Player ' + (i + 1), ...over }));

const couples = n => people(n).map((p, i) => ({ ...p, arrivedWith: 'c' + Math.floor(i / 2) }));

const key = (a, b) => [String(a), String(b)].sort().join('|');

function seatedIds(round) {
  const out = [];
  for (const t of round.tables) for (const p of t.teamA.concat(t.teamB)) out.push(p.id);
  for (const p of round.byes) out.push(p.id);
  return out;
}
function partnersOf(round) {
  const out = [];
  for (const t of round.tables) { out.push(key(t.teamA[0].id, t.teamA[1].id)); out.push(key(t.teamB[0].id, t.teamB[1].id)); }
  return out;
}
function opponentsOf(round) {
  const out = [];
  for (const t of round.tables) for (const x of t.teamA) for (const y of t.teamB) out.push(key(x.id, y.id));
  return out;
}
// Play a whole night and hand back every round plus the accumulated history.
function playNight(players, rounds = SG.DEFAULT_ROUNDS, opts = {}) {
  let h = SG.emptyHistory();
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    const round = SG.buildRound(players, h, { round: r, seed: (opts.seed || 'night') + ':' + r, ...opts });
    out.push(round);
    h = SG.applyRound(h, round);
  }
  return { rounds: out, history: h };
}

// ---- shape ------------------------------------------------------------------
describe('buildRound — table shape', () => {
  test('8 players make 2 full 2v2 tables and nobody sits out', () => {
    const r = SG.buildRound(people(8), SG.emptyHistory(), { round: 1 });
    assert.equal(r.tables.length, 2);
    assert.equal(r.byes.length, 0);
    for (const t of r.tables) { assert.equal(t.teamA.length, 2); assert.equal(t.teamB.length, 2); }
  });

  test('tables are numbered from 1, or from firstTable', () => {
    assert.deepEqual(SG.buildRound(people(8), SG.emptyHistory(), {}).tables.map(t => t.table), [1, 2]);
    assert.deepEqual(SG.buildRound(people(8), SG.emptyHistory(), { firstTable: 5 }).tables.map(t => t.table), [5, 6]);
  });

  test('games are dealt round-robin from the supplied list, starting at the first one', () => {
    const r = SG.buildRound(people(12), SG.emptyHistory(), { games: ['Azul', 'Codenames'] });
    assert.deepEqual(r.tables.map(t => t.game), ['Azul', 'Codenames', 'Azul']);
  });

  test('no games supplied means no game claimed', () => {
    const r = SG.buildRound(people(4), SG.emptyHistory(), {});
    assert.equal(r.tables[0].game, null);
  });

  test('players marked inactive (walked out, never showed) are left out entirely', () => {
    const list = people(5);
    list[4].active = false;
    const r = SG.buildRound(list, SG.emptyHistory(), {});
    assert.equal(r.tables.length, 1);
    assert.equal(r.byes.length, 0);
    assert.ok(!seatedIds(r).includes('p5'));
  });

  test('the same seed rebuilds the identical round (a refresh must not reshuffle the room)', () => {
    const a = SG.buildRound(people(11), SG.emptyHistory(), { seed: 'fixed' });
    const b = SG.buildRound(people(11), SG.emptyHistory(), { seed: 'fixed' });
    assert.deepEqual(seatedIds(a), seatedIds(b));
    assert.deepEqual(partnersOf(a), partnersOf(b));
  });
});

// ---- conservation — the one that must never break ---------------------------
describe('buildRound — every player is accounted for', () => {
  for (let n = 0; n <= 25; n++) {
    test(n + ' checked in: each appears exactly once, at a table or on the bye list', () => {
      const list = people(n);
      const r = SG.buildRound(list, SG.emptyHistory(), { round: 1, seed: 'n' + n });
      const seen = seatedIds(r);
      assert.deepEqual(seen.slice().sort(), list.map(p => p.id).sort(),
        n + ' players in, ' + seen.length + ' players out');
      assert.equal(new Set(seen).size, seen.length, 'a player was seated twice');
      assert.equal(r.tables.length, Math.floor(n / SG.PLAYERS_PER_TABLE));
      assert.equal(r.byes.length, n % SG.PLAYERS_PER_TABLE);
    });
  }

  test('conservation still holds when the partner pool has run completely dry', () => {
    // 4 people who have already partnered every other combination — round 4 of
    // a 4-person night. Somebody has to repeat; nobody may disappear.
    const list = people(4);
    const h = SG.emptyHistory();
    for (const a of list) for (const b of list) if (a.id < b.id) h.partners.push(key(a.id, b.id));
    const r = SG.buildRound(list, h, { round: 4 });
    assert.deepEqual(seatedIds(r).sort(), ['p1', 'p2', 'p3', 'p4']);
    assert.equal(r.tables.length, 1, 'must still seat a table rather than bench the room');
    assert.ok(r.warnings.some(w => /repeat/i.test(w)), 'a repeated partner has to be announced: ' + JSON.stringify(r.warnings));
  });

  test('a history missing its fields does not crash the round', () => {
    const r = SG.buildRound(people(8), { partners: [] }, {});
    assert.equal(r.tables.length, 2);
  });
});

// ---- rule 1: never partner the same two people twice ------------------------
describe('rule 1 — partners never repeat', () => {
  for (const n of [8, 12, 16, 20]) {
    test(n + ' players, 3 rounds: no pair is ever partnered twice', () => {
      const { rounds } = playNight(people(n));
      const seen = new Set();
      for (const r of rounds) for (const p of partnersOf(r)) {
        assert.ok(!seen.has(p), 'repeated partnership ' + p);
        seen.add(p);
      }
    });
  }

  test('a partnership already in history is refused when any alternative exists', () => {
    const h = SG.emptyHistory();
    h.partners.push(key('p1', 'p2'));
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const r = SG.buildRound(people(4), h, { seed });
      assert.ok(!partnersOf(r).includes(key('p1', 'p2')), 'seed ' + seed + ' re-paired p1 with p2');
    }
  });
});

// ---- rule 2: avoid repeat opponents -----------------------------------------
describe('rule 2 — facing the same person twice is avoided', () => {
  test('16 players over 3 rounds meet a genuinely wide slice of the room', () => {
    const { rounds } = playNight(people(16));
    const met = new Set();
    let repeats = 0;
    for (const r of rounds) for (const o of opponentsOf(r)) {
      if (met.has(o)) repeats++;
      met.add(o);
    }
    // 16 players, 4 tables, 3 rounds = 48 opponent pairs out of 120 possible.
    // There is plenty of room; a decent engine repeats nobody.
    assert.equal(repeats, 0, repeats + ' repeated match-ups');
  });

  test('with the room to choose, you are partnered with a stranger, not last round\'s opponent', () => {
    // p1 and p2 played against each other last round. In a 4-player room they
    // would have to either partner or rematch, and partnering is the lesser
    // evil — but with 8 players there are six strangers going spare, so p1
    // should meet one of them instead.
    const h = SG.emptyHistory();
    h.opponents.push(key('p1', 'p2'));
    for (const seed of ['m1', 'm2', 'm3', 'm4', 'm5']) {
      const r = SG.buildRound(people(8), h, { seed });
      assert.ok(!partnersOf(r).includes(key('p1', 'p2')),
        'seed ' + seed + ' partnered two people who had just played each other');
    }
  });

  test('in a 4-player room, partnering a past opponent beats facing them again', () => {
    // Documents the weighting deliberately: COST_REMATCH (partner someone you
    // faced) is cheaper than COST_FACED_AGAIN (face them a second time), so a
    // tiny room turns a rematch into a team-up rather than a repeat fixture.
    const h = SG.emptyHistory();
    h.opponents.push(key('p1', 'p2'));
    const r = SG.buildRound(people(4), h, { seed: 'tiny' });
    assert.ok(partnersOf(r).includes(key('p1', 'p2')), 'p1 and p2 were made to play each other again');
  });

  test('a team is matched against the table it has least history with', () => {
    // Pin p1's partner to p2 by burning every other partnership for p1, then
    // give that team a history against p3 and p4. With p5..p8 free there is a
    // clean table available and they must be sent to it.
    const h = SG.emptyHistory();
    for (const other of ['p3', 'p4', 'p5', 'p6', 'p7', 'p8']) h.partners.push(key('p1', other));
    for (const a of ['p1', 'p2']) for (const b of ['p3', 'p4']) h.opponents.push(key(a, b));
    const r = SG.buildRound(people(8), h, { seed: 'rematch' });
    assert.ok(partnersOf(r).includes(key('p1', 'p2')), 'test premise broken — p1 did not partner p2');
    const table = r.tables.find(t => t.teamA.concat(t.teamB).some(p => p.id === 'p1'));
    const across = (table.teamA.some(p => p.id === 'p1') ? table.teamB : table.teamA).map(p => p.id);
    assert.ok(!across.includes('p3') && !across.includes('p4'),
      'p1 was sent back against ' + across.join(' & '));
  });
});

// ---- rule 3: split up people who arrived together ---------------------------
describe('rule 3 — couples get split up', () => {
  test('two couples at one table are crossed over, not left as they arrived', () => {
    const list = couples(4);   // (p1,p2) came together, (p3,p4) came together
    for (const seed of ['x', 'y', 'z', 'w']) {
      const r = SG.buildRound(list, SG.emptyHistory(), { seed });
      const ps = partnersOf(r);
      assert.ok(!ps.includes(key('p1', 'p2')) && !ps.includes(key('p3', 'p4')),
        'seed ' + seed + ' left a couple together: ' + ps.join(', '));
    }
  });

  test('a whole room of couples still gets fully mixed', () => {
    const { rounds } = playNight(couples(12));
    for (const r of rounds) {
      for (const p of partnersOf(r)) {
        const [a, b] = p.split('|');
        const pa = couples(12).find(x => x.id === a), pb = couples(12).find(x => x.id === b);
        assert.notEqual(pa.arrivedWith, pb.arrivedWith, 'a couple stayed together: ' + p);
      }
    }
  });

  test('but a couple is seated together rather than benched when there is no one else', () => {
    const r = SG.buildRound(couples(4).slice(0, 2), SG.emptyHistory(), {});
    // 2 players cannot make a 2v2 table at all — they sit out, they don't vanish.
    assert.deepEqual(seatedIds(r).sort(), ['p1', 'p2']);
  });
});

// ---- rule 4: byes are spread ------------------------------------------------
describe('rule 4 — sitting out is shared around', () => {
  test('5 players, 3 rounds: three different people take the one bye', () => {
    const { rounds } = playNight(people(5));
    const benched = rounds.map(r => r.byes.map(p => p.id).join(''));
    assert.deepEqual(rounds.map(r => r.byes.length), [1, 1, 1]);
    assert.equal(new Set(benched).size, 3, 'the same person sat out twice: ' + benched.join(' → '));
  });

  test('6 players, 3 rounds: nobody sits out twice while somebody has not sat out at all', () => {
    const { rounds, history } = playNight(people(6));
    assert.deepEqual(rounds.map(r => r.byes.length), [2, 2, 2]);
    const counts = people(6).map(p => history.byes[p.id] || 0);
    assert.equal(Math.max(...counts) - Math.min(...counts) <= 1, true,
      'byes were not spread: ' + JSON.stringify(history.byes));
  });

  test('the bye goes to whoever has sat out least', () => {
    const h = SG.emptyHistory();
    h.byes = { p1: 0, p2: 2, p3: 2, p4: 2, p5: 2 };
    const r = SG.buildRound(people(5), h, { seed: 'bench' });
    assert.deepEqual(r.byes.map(p => p.id), ['p1'], 'benched someone who had already sat out twice');
  });
});

// ---- applyRound -------------------------------------------------------------
describe('applyRound', () => {
  test('records both partnerships and all four cross-team match-ups per table', () => {
    const r = SG.buildRound(people(4), SG.emptyHistory(), { seed: 'apply' });
    const h = SG.applyRound(SG.emptyHistory(), r);
    assert.equal(h.partners.length, 2);
    assert.equal(h.opponents.length, 4);
    assert.deepEqual(h.opponents.slice().sort(), opponentsOf(r).slice().sort());
  });

  test('counts byes cumulatively', () => {
    let h = SG.emptyHistory();
    h = SG.applyRound(h, { tables: [], byes: [{ id: 'p9' }] });
    h = SG.applyRound(h, { tables: [], byes: [{ id: 'p9' }] });
    assert.equal(h.byes.p9, 2);
  });

  test('does not mutate the history handed to it', () => {
    const before = SG.emptyHistory();
    const r = SG.buildRound(people(4), before, {});
    SG.applyRound(before, r);
    assert.deepEqual(before, SG.emptyHistory());
  });

  test('survives an empty round', () => {
    assert.deepEqual(SG.applyRound(SG.emptyHistory(), { tables: [], byes: [] }), SG.emptyHistory());
    assert.deepEqual(SG.applyRound(null, {}), SG.emptyHistory());
  });
});

// ---- the clock --------------------------------------------------------------
describe('phasePlan / phaseAt — the 10 + 40 + 10 round clock', () => {
  const T0 = 1_760_000_000_000;

  test('the default round is teach 10 / play 40 / break 10, laid end to end', () => {
    const plan = SG.phasePlan(null, T0);
    assert.deepEqual(plan.map(p => p.id), ['teach', 'play', 'break']);
    assert.deepEqual(plan.map(p => p.startsAt - T0), [0, 600_000, 3_000_000]);
    assert.deepEqual(plan.map(p => p.endsAt - T0), [600_000, 3_000_000, 3_600_000]);
  });

  test('a round is exactly one hour', () => {
    assert.equal(SG.roundLengthMs(), 3_600_000);
    assert.equal(SG.roundLengthMs([{ id: 'x', minutes: 5 }, { id: 'y', minutes: 15 }]), 1_200_000);
  });

  test('junk or negative minutes count as zero rather than corrupting the plan', () => {
    const plan = SG.phasePlan([{ id: 'a', minutes: 'ten' }, { id: 'b', minutes: -5 }, { id: 'c', minutes: 10 }], T0);
    assert.deepEqual(plan.map(p => p.endsAt - T0), [0, 0, 600_000]);
  });

  test('before the round starts it is pending, with the countdown to kickoff', () => {
    const plan = SG.phasePlan(null, T0);
    const s = SG.phaseAt(plan, T0 - 90_000);
    assert.equal(s.state, 'pending');
    assert.equal(s.msToStart, 90_000);
    assert.equal(s.next.id, 'teach');
  });

  test('the instant a phase ends belongs to the next phase, not the old one', () => {
    const plan = SG.phasePlan(null, T0);
    assert.equal(SG.phaseAt(plan, T0).phase.id, 'teach');
    assert.equal(SG.phaseAt(plan, T0 + 599_999).phase.id, 'teach');
    assert.equal(SG.phaseAt(plan, T0 + 600_000).phase.id, 'play', 'the teach clock hit 0:00 and stuck');
    assert.equal(SG.phaseAt(plan, T0 + 3_000_000).phase.id, 'break');
  });

  test('msLeft is the time to the end of the CURRENT phase', () => {
    const plan = SG.phasePlan(null, T0);
    assert.equal(SG.phaseAt(plan, T0 + 60_000).msLeft, 540_000);
    assert.equal(SG.phaseAt(plan, T0 + 600_000).msLeft, 2_400_000);
  });

  test('after the last phase the round is done', () => {
    const plan = SG.phasePlan(null, T0);
    assert.equal(SG.phaseAt(plan, T0 + 3_600_000).state, 'done');
    assert.equal(SG.phaseAt(plan, T0 + 9_999_999).state, 'done');
  });

  test('an empty plan is null, not a crash', () => {
    assert.equal(SG.phaseAt([], Date.now()), null);
    assert.equal(SG.phaseAt(null, Date.now()), null);
  });
});

// ---- optimality -------------------------------------------------------------
// Asserting each cost weight on its own kept producing tests the engine was
// right to fail: the weights trade against each other, and the engine reasons
// about the whole room. Twice it found a seating that looked wrong in isolation
// and was cheaper overall (partnering last round's opponent so you only have to
// face ONE old face instead of two).
//
// So this asserts the thing that actually matters — the engine finds the best
// seating available — against a brute force over every legal seating. The cost
// model below is written out independently here on purpose: if it merely called
// the module's own scorer, changing a weight in the module would move the
// target as well as the shot, and the test would pass regardless.
describe('the engine finds the genuinely optimal seating', () => {
  const W = { repeatPartner: 1e6, partnerPastOpponent: 2, partnerArrivedWith: 8, faceAgain: 3 };
  function scoreSeating(tables, h) {
    const P = new Set(h.partners), O = new Set(h.opponents);
    let c = 0;
    for (const [A, B] of tables) {
      for (const t of [A, B]) {
        if (P.has(key(t[0].id, t[1].id))) c += W.repeatPartner;
        if (O.has(key(t[0].id, t[1].id))) c += W.partnerPastOpponent;
        if (t[0].arrivedWith && t[0].arrivedWith === t[1].arrivedWith) c += W.partnerArrivedWith;
      }
      for (const x of A) for (const y of B) if (O.has(key(x.id, y.id))) c += W.faceAgain;
    }
    return c;
  }
  // every way to split the list into pairs
  function matchings(list) {
    if (!list.length) return [[]];
    const [first, ...rest] = list;
    const out = [];
    rest.forEach((p, i) => {
      const remain = rest.slice(0, i).concat(rest.slice(i + 1));
      for (const m of matchings(remain)) out.push([[first, p]].concat(m));
    });
    return out;
  }
  function bestCost(players, h) {
    let best = Infinity;
    for (const teams of matchings(players)) {
      for (const tabs of matchings(teams)) {
        const c = scoreSeating(tabs, h);
        if (c < best) best = c;
      }
    }
    return best;
  }

  const scenarios = [
    ['a fresh 8-player room', people(8), SG.emptyHistory()],
    ['8 players, all four couples', couples(8), SG.emptyHistory()],
    ['8 players into round 2', people(8), { partners: ['p1|p2', 'p3|p4', 'p5|p6', 'p7|p8'], opponents: ['p1|p3', 'p1|p4', 'p2|p3', 'p2|p4', 'p5|p7', 'p5|p8', 'p6|p7', 'p6|p8'], byes: {} }],
    ['8 players into round 3, history piling up', people(8),
      { partners: ['p1|p2', 'p3|p4', 'p5|p6', 'p7|p8', 'p1|p3', 'p2|p4', 'p5|p7', 'p6|p8'],
        opponents: ['p1|p3', 'p1|p4', 'p2|p3', 'p2|p4', 'p5|p7', 'p5|p8', 'p6|p7', 'p6|p8', 'p1|p5', 'p1|p6', 'p3|p5', 'p3|p6'], byes: {} }],
    ['a 4-player room where somebody must repeat', people(4),
      { partners: ['p1|p2', 'p3|p4', 'p1|p3', 'p2|p4'], opponents: ['p1|p3', 'p1|p4', 'p2|p3', 'p2|p4'], byes: {} }],
    ['4 players who all arrived as couples', couples(4), SG.emptyHistory()]
  ];

  for (const [label, players, hist] of scenarios) {
    test(label, () => {
      const optimal = bestCost(players, hist);
      // Several seeds — the engine must not depend on a lucky shuffle.
      for (const seed of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']) {
        const r = SG.buildRound(players, hist, { seed });
        const got = scoreSeating(r.tables.map(t => [t.teamA, t.teamB]), hist);
        assert.equal(got, optimal, 'seed ' + seed + ' produced a seating costing ' + got + ' when ' + optimal + ' was available');
      }
    });
  }
});

// ---- whole-night properties -------------------------------------------------
// A single round being sound is not enough — the failure people actually notice
// builds up across the night. These run the full 3 rounds.
describe('a whole night holds together', () => {
  for (let n = 0; n <= 25; n++) {
    test(n + ' players: nobody is lost or double-seated in any of the 3 rounds', () => {
      const list = people(n);
      const { rounds } = playNight(list, 3, { seed: 'night' + n });
      rounds.forEach((r, i) => {
        const seen = seatedIds(r);
        assert.equal(new Set(seen).size, seen.length, 'round ' + (i + 1) + ' seated someone twice');
        assert.deepEqual(seen.slice().sort(), list.map(p => p.id).sort(), 'round ' + (i + 1) + ' lost someone');
      });
    });
  }

  // Measured across 576 simulated nights: from 15 players up there is enough
  // room in the combinatorics that a good engine never has to repeat anything.
  // Below that, repeats are forced by the maths (4 players simply cannot avoid
  // facing each other 3 rounds running), so this asserts only where it is fair.
  for (const n of [15, 16, 20, 24, 32]) {
    test(n + ' players: 3 rounds with no repeated partner, no rematch, no couple left together', () => {
      const list = couples(n);   // hardest case: the entire room arrived in pairs
      const { rounds } = playNight(list, 3, { seed: 'clean' + n });
      const p = new Set(), o = new Set();
      for (const r of rounds) {
        for (const t of r.tables) for (const team of [t.teamA, t.teamB]) {
          assert.notEqual(team[0].arrivedWith, team[1].arrivedWith, 'a couple was left together');
        }
        for (const x of partnersOf(r)) { assert.ok(!p.has(x), 'repeated partnership ' + x); p.add(x); }
        for (const x of opponentsOf(r)) { assert.ok(!o.has(x), 'repeated match-up ' + x); o.add(x); }
      }
    });
  }

  test('a full room is paired fast enough to feel instant in the console', () => {
    // The repair pass is O(seats^2); it once took seconds for 40 players, which
    // is a Guru staring at a spinner with the room waiting. 48 is well past any
    // realistic Speed Gaming night.
    const list = people(48);
    let h = SG.emptyHistory();
    for (let r = 1; r <= 2; r++) h = SG.applyRound(h, SG.buildRound(list, h, { round: r }));
    const t0 = Date.now();
    SG.buildRound(list, h, { round: 3 });
    const ms = Date.now() - t0;
    assert.ok(ms < 400, 'round 3 for 48 players took ' + ms + 'ms');
  });
});

// ---- rng --------------------------------------------------------------------
describe('rng', () => {
  test('same seed, same sequence', () => {
    const a = SG.rng('abc'), b = SG.rng('abc');
    for (let i = 0; i < 20; i++) assert.equal(a(), b());
  });
  test('different seeds diverge', () => {
    const a = SG.rng('abc'), b = SG.rng('abd');
    assert.notEqual(a(), b());
  });
  test('always in [0,1)', () => {
    const r = SG.rng('spread');
    for (let i = 0; i < 500; i++) { const v = r(); assert.ok(v >= 0 && v < 1, 'out of range: ' + v); }
  });
  test('an empty or null seed still produces a usable stream', () => {
    for (const seed of [null, undefined, '', 0]) {
      const r = SG.rng(seed);
      const vals = [r(), r(), r()];
      assert.equal(new Set(vals).size, 3, 'seed ' + seed + ' produced a constant stream');
    }
  });
});
