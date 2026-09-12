// NGH-BUILD 2026-09-12x
// =====================================================================
// tests/mock-live.mjs — the "something is happening right now" endpoints.
//
// The app's six live screens (specials, karaoke, trivia, speed gaming,
// Magic night) all poll an /active-style endpoint and render a "nothing on
// right now" empty state when it 404s or comes back idle. tests/mock-api.mjs
// never implemented them, so every one of those screens was being exercised —
// and screenshotted — in its empty state. That tests almost nothing: the
// interesting render path is the one with data in it.
//
// Shapes here are taken from the real Netlify functions, not invented:
//   specials.mjs publicSpecial()    → bare ARRAY, not {specials:[]}
//   karaoke.mjs  GET /active        → flat {code,status,mode,v,serverNow}
//   speedgaming.mjs publicState()   → nested under {active:…} / full state
//   mtg.mjs      publicBoard()      → flat, and needs live:true to render
// The trivia function does not live in this repo; its shape is copied from
// tests/mock-specials.mjs, which the specials e2e suite already asserts on.
//
// NGH.poll() tracks `version` (not `v`) and short-circuits on {unchanged:true},
// so nothing here ever returns unchanged — the page re-renders identically and
// the poller can never wedge on a stale version.
// =====================================================================

const CREST = '/brand/crest.png';

// The app computes "today" with local getFullYear/getMonth/getDate, so the mock
// has to as well — toISOString() would hand back a UTC date and put "Today"
// on the wrong row for half the day.
export function ymdLocal(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const isoIn = (days) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(23, 59, 59, 0); return d.toISOString(); };

// ---------------------------------------------------------------- events
// /app/ shows the next five public occurrences inside a 14-day horizon.
export function EVENTS() {
  return [
    { id: 'ev_cmdr', title: 'Commander Night', date: ymdLocal(0), start: '18:00', end: '22:00', status: 'published', rooms: ['The Great Hall'] },
    { id: 'ev_pkmn', title: 'Pokémon League', date: ymdLocal(1), start: '17:00', end: '20:00', status: 'published', rooms: ['The Holt'] },
    { id: 'ev_fnm', title: 'Friday Night Magic', date: ymdLocal(2), start: '18:30', end: '22:30', status: 'published', rooms: ['The Great Hall'] },
    { id: 'ev_social', title: 'Board Game Social', date: ymdLocal(4), start: '17:00', end: '21:00', status: 'published', rooms: [] },
    { id: 'ev_speed', title: 'Speed Gaming Meet-up', date: ymdLocal(6), start: '18:00', end: '21:00', status: 'published', rooms: ['The Great Hall'] },
    { id: 'ev_rpg', title: 'One-Shot RPG Night', date: ymdLocal(9), start: '18:00', end: '22:00', status: 'published', rooms: ["Stash's Den"] },
    { id: 'ev_draft', title: 'Draft: Bloomburrow', date: ymdLocal(30), start: '18:00', end: '22:00', status: 'published' }, // outside the horizon on purpose
    { id: 'ev_hidden', title: 'Staff planning', date: ymdLocal(1), start: '09:00', end: '11:00', status: 'draft' }           // must never show
  ];
}

// ---------------------------------------------------------------- specials
const special = (o) => Object.assign({
  id: '', cat: 'food', title: '', blurb: '', terms: '', imageUrl: '', price: '', badge: '',
  startsAt: null, endsAt: null, redeem: 'show', claimLimit: null, claimed: 0
}, o);

export function SPECIALS() {
  return [
    special({
      id: 'sp_slice', cat: 'food', title: 'Two-Slice Tuesday', price: '$6', badge: 'Tuesdays', imageUrl: CREST,
      blurb: 'Two slices and a fountain soda, every Tuesday from open to close.',
      terms: 'Dine-in only. One per person per visit.', endsAt: isoIn(21), redeem: 'show'
    }),
    special({
      id: 'sp_float', cat: 'food', title: 'Haven Root Beer Float', price: '$5.50', badge: 'Guru pick', imageUrl: CREST,
      blurb: 'Sprecher root beer over two scoops of vanilla, made when you order.',
      terms: 'While the vanilla lasts.', endsAt: isoIn(14), redeem: 'claim', claimLimit: 40, claimed: 12
    }),
    special({
      id: 'sp_popcorn', cat: 'food', title: 'Bottomless Popcorn', price: '$4', imageUrl: '',
      blurb: 'Keep the bowl filled for as long as you are at the table.',
      terms: 'Table service only.', endsAt: isoIn(28), redeem: 'show'
    }),
    special({
      id: 'sp_bundle', cat: 'retail', title: 'Three Boosters, Save $3', price: '$11.97', badge: 'This week', imageUrl: CREST,
      blurb: 'Any three single boosters from the wall — mix Pokémon, Magic and Lorcana however you like.',
      terms: 'In-store only. Excludes collector boosters.', endsAt: isoIn(7), redeem: 'claim', claimLimit: 60, claimed: 41
    }),
    special({
      id: 'sp_shelf', cat: 'retail', title: '20% Off the Shelf of Shame', price: '20% off', badge: 'Clearance', imageUrl: CREST,
      blurb: 'Open-box and demo copies from the library, all in good shape.',
      terms: 'As marked. No holds.', endsAt: isoIn(30), redeem: 'show'
    }),
    special({
      id: 'sp_dice', cat: 'retail', title: 'Free Dice with Any RPG Book', price: 'Free', imageUrl: '',
      blurb: 'Pick a set from the jar when you buy any hardcover rulebook.',
      terms: 'One set per book.', endsAt: isoIn(45), redeem: 'claim', claimLimit: 25, claimed: 25 // → "All claimed"
    })
  ];
}

// ---------------------------------------------------------------- speed gaming
const SG_CODE = 'SG4T';
const SG_NAMES = ['Alex', 'Priya', 'Marcus', 'Dana', 'Tomás', 'Erin', 'Kwame', 'Lena', 'Ravi',
  'Beth', 'Owen', 'Nadia', 'Cole', 'Simone', 'Hugo', 'Maya', 'Jonas', 'Tess'];
const sgPlayers = () => SG_NAMES.map((name, i) => ({ id: 'p' + (i + 1), name, active: true, arrivedWith: '' }));
const ref = (p) => ({ id: p.id, name: p.name });
const GAMES = ['Sushi Go Party!', 'Azul', 'Wingspan', 'Just One', 'Cascadia'];

export function sgSessionState(now) {
  const players = sgPlayers();
  // 23 minutes into the round: teach is done, play is running with 27 left.
  const roundStart = now - 23 * 60000;
  let cursor = roundStart;
  const phases = [
    { id: 'teach', label: 'Teach the game', minutes: 10 },
    { id: 'play', label: 'Play', minutes: 40 },
    { id: 'break', label: 'Break / swap partners', minutes: 10 }
  ].map((p) => { const startsAt = cursor; cursor += p.minutes * 60000; return { ...p, startsAt, endsAt: cursor }; });
  const cur = phases.find((p) => now >= p.startsAt && now < p.endsAt) || null;

  const tables = [];
  for (let t = 0; t < 4; t++) {
    tables.push({
      table: t + 1, game: GAMES[t % GAMES.length], result: null,
      teamA: [ref(players[t * 4]), ref(players[t * 4 + 1])],
      teamB: [ref(players[t * 4 + 2]), ref(players[t * 4 + 3])]
    });
  }
  const round = {
    n: 2, seed: 'r2-seed', publishedAt: roundStart - 60000, startAt: roundStart,
    phases, endedEarly: false, warnings: [], byes: [ref(players[16]), ref(players[17])], tables
  };
  const standings = players.slice(0, 12).map((p, i) => {
    const wins = Math.max(0, 2 - Math.floor(i / 4));
    return { id: p.id, name: p.name, wins, draws: i % 5 === 0 ? 1 : 0, played: 2, byes: 0, points: wins * 3 + (i % 5 === 0 ? 1 : 0) };
  }).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  // you = table 4's teamA lead, so the partner/opponents line up with the board.
  const you = {
    id: players[12].id, name: players[12].name, active: true, table: 4,
    partner: ref(players[13]), opponents: [ref(players[14]), ref(players[15])],
    bye: false, nextUp: null, game: tables[3].game, result: null
  };

  return {
    code: SG_CODE, status: 'live', version: 12,
    eventId: 'ev_speed', date: ymdLocal(0), title: 'Speed Gaming Meet-up',
    settings: { rounds: 3, phases: phases.map(({ id, label, minutes }) => ({ id, label, minutes })), games: GAMES, allowSelfJoin: true, roundLengthMs: 60 * 60000 },
    players, playing: players.length, current: 2,
    round, rounds: [round], draft: null, standings,
    clock: cur ? { state: 'running', phase: cur, msLeft: cur.endsAt - now } : { state: 'done', msLeft: 0 },
    serverNow: now,
    you
  };
}
export const SG_SESSION_CODE = SG_CODE;

// ---------------------------------------------------------------- router
// Returns {status, body} for a handled route, or null to fall through to the
// rest of the mock. `p` has already had trailing slashes stripped by the caller.
export function liveApi(p, m, url) {
  const now = Date.now();
  if (m !== 'GET') return null;
  let mm;

  if (p === '/api/specials/settings') return { body: { foodOrderUrl: 'https://gamehaven.guru/order' } };
  if (p === '/api/specials') {
    const cat = url.searchParams.get('cat') || '';
    return { body: SPECIALS().filter((s) => !cat || s.cat === cat) };
  }

  // Four characters: join.html's own copy says "Enter the 4-letter code on the
  // TV", and a five-character code in the screenshot under that line looks like
  // a bug to anyone reading the listing.
  if (p === '/api/karaoke/active') return { body: { code: 'HAVN', status: 'live', mode: 'battle', v: 7, serverNow: now } };
  if (p === '/api/karaoke/time') return { body: { serverNow: now } };

  if (p === '/api/trivia/active') {
    return { body: { id: 'TRV-7K2Q', gameId: 'TRV-7K2Q', kind: 'trivia', phase: 'live', v: 3, serverNow: now } };
  }

  if (p === '/api/speedgaming/time') return { body: { serverNow: now } };
  if (p === '/api/speedgaming/active') {
    return { body: { active: { code: SG_CODE, status: 'live', title: 'Speed Gaming Meet-up', date: ymdLocal(0), playing: SG_NAMES.length }, serverNow: now } };
  }
  if ((mm = p.match(/^\/api\/speedgaming\/sessions\/([^/]+)\/state$/))) {
    if (mm[1].toUpperCase() !== SG_CODE) return { status: 404, body: { error: 'no such session' } };
    return { body: sgSessionState(now) };
  }

  if (p === '/api/mtg/board') {
    return {
      body: {
        live: true, eventId: 'ev_fnm', date: ymdLocal(0), title: 'Friday Night Magic',
        format: 'Modern', startLabel: '6:30 pm', entry: '$10',
        prizes: 'Two packs per match win, plus a promo for everyone who plays all four rounds.',
        code: 'FNM7K2',
        note: 'Round 2 pairings are up. Table 6 is short a player — see a Guru if you want in.',
        nextNote: 'Next week: Standard, same time, $5 entry.',
        mirrorUrl: 'https://eventlink.wizards.com/stores/northwood-game-haven/events/98217/mirror',
        updatedAt: new Date(now - 4 * 60000).toISOString(),
        version: 5, serverNow: now
      }
    };
  }

  return null;
}
