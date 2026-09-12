# NGH App — Architecture & Product Spec
*NGH-BUILD 2026-09-11a. Companion to PROJECT-KNOWLEDGE-v2.md. Read this before touching anything under `site/app/`, `capacitor/`, `netlify/functions/karaoke.mjs`, `companion.mjs`, `specials.mjs`, or `rack-player/ngh-karaoke-player.mjs`. Lightspeed (rewards, order-ahead, on-account) is specified separately in NGH-LIGHTSPEED-INTEGRATION.md; deployment and setup steps are in NGH-APP-SETUP.md.*

## 0. Decisions (and why)

| Decision | Choice | Why |
|---|---|---|
| App shell | **PWA in `site/app/` + Capacitor native wrappers** (iOS / Android) | The whole site is vanilla HTML/JS on Netlify. One codebase serves gamehaven.guru/app, the App Store / Play Store builds, and the in-store TVs. No rewrite, no second deploy path. |
| Realtime layer | **Netlify Functions + versioned polling** (`GET …/state?v=N` → `{unchanged:true}`), server clock offset, scheduled `startAt` | Identical to the trivia engine, TV network and arcade. No new vendor, one `git push` deploy. Firebase RTDB is the documented upgrade path if function invocations ever become the bottleneck (§9). |
| System of record | Neon Postgres via existing `_shared/db.mjs` (`sql`, `json`, `bad`, `requireAdmin`) | Same tables/patterns as everything else. |
| TV devices | Existing **NGH TV Network** (`tv.html` + `tv.mjs` + `android-tv-app` kiosk on the Google TV Streamer 4K) | Already installed. Karaoke is pushed to TVs as a `url` channel (`/app/karaoke/tv.html?s=CODE`); the page reads its device name from `localStorage.ngh_tv_name` (set by tv.html, same origin) to know which room it is in. |
| Karaoke content | **Provider-agnostic engine.** Ships with the `local` provider (MP3+G/CDG and MP3+LRC files on the rack PC). `karafun` (OEM/API) and `stingray` adapters are stubbed with their contracts. | KaraFun Business's dashboard API covers bookings/devices/sessions only — not catalog or lyrics. KaraFun's OEM/API programme *does* expose catalog + syllable-sync lyrics + audio and explicitly allows "rebuild KaraFun with your own UX" — that is the match for this design, but it is contact-sales. See §6. |
| Karaoke audio | Rack PC plays the backing track through **X-USB OUT 5-6 → X32 → PA/zones** (`ngh-karaoke-player.mjs`, mpv). Any TV can optionally play audio itself (`&audio=1`) for rooms fed by a Partybox instead of the X32. | OUT 5-6 was reserved for karaoke when the trivia strip was built. |
| Lyrics on phones | Every official Battle participant's phone renders the same synced lyrics as the TVs: LRC/JSON lyrics from the API, or the CD+G graphics from an HTTPS copy the rack player uploads when the song is queued. | Requested; makes every room a sing-along room. Browsers on gamehaven.guru (HTTPS) can't read the rack PC's `http://` LAN URLs (mixed content), hence the hosted copy. |

## 1. Repo layout (deliverable mirrors the repo)

```
site/app/                        PWA + app shell (served at gamehaven.guru/app/, bundled into the store apps)
  index.html                     Home: feature grid, coming-up events, overnight, hours, contact, socials
  manifest.webmanifest, sw.js    Installable PWA, offline shell (website only; not used by the native apps)
  app.css / ngh-app.js           Brand tokens + components / runtime: API origin, fetch, polling, clock sync,
                                 Guru auth, haptics, share, QR URLs, native link routing + deep links
  specials.html / guru-specials.html    Food & Drink + Retail specials, coupon wallet / Guru editor + redeem
  account.html                   Haven Rewards (Lightspeed customer, loyalty balance, customer code QR)
  shop.html / shop-orders.html   Order Ahead (Lightspeed catalog, pickup) / Guru pickup queue
  guru-lightspeed.html           Guru: connect Lightspeed, reference ids, catalog sync, replay sales
  trivia/play.html               Finds the active trivia game and joins it (hands off to /trivia-play.html)
  companion/index.html           Game Companion hub
  companion/first-player.html    Multi-touch finger chooser (single / groups / order)
  companion/turn-tracker.html    Shared turn tracker (host QR → players; companion.mjs)
  companion/life-counter.html    CCG life counter (commander damage, counters, monarch/initiative, undo)
  companion/rpg.html             RPG companion (dice, initiative/combat, d20 character sheet, SRD refs, notes)
  karaoke/index.html             Karaoke hub (live session card, join by code, rules)
  karaoke/join.html              Participant: room + name, add songs, live lyrics, star voting, scoreboard
  karaoke/host.html              Guru console: sessions, queue, transport, scoring, rooms/teams, TV push/restore, player status
  karaoke/tv.html                1920×1080 TV display (lyrics/CD+G, now singing, on-deck 5, scoreboard, logo, join + WiFi QR)
  karaoke/karaoke-client.js      Shared: session polling, song position, lyric loader, optional in-browser audio
  karaoke/karaoke-lyrics.js      Timed-lyrics model, LRC / enhanced-LRC parser, KaraFun syllable adapter, word-fill renderer
  karaoke/cdg.js                 CD+G decoder + canvas renderer
  karaoke/providers.js           Provider interface + local / karafun / stingray adapters
site/.well-known/                assetlinks.json + apple-app-site-association templates (deep links)
netlify/functions/
  karaoke.mjs                    Sessions, rooms/teams, queue, transport, votes, results, catalog, hosted CD+G, player heartbeat
  companion.mjs                  Short-lived shared tables (turn tracker)
  specials.mjs                   Specials/coupons catalog, claim, redeem, settings
  lightspeed.mjs, account.mjs, shop.mjs, shop-sync.mjs, _shared/lightspeed(-core).mjs   see NGH-LIGHTSPEED-INTEGRATION.md
  create-checkout.mjs, stripe-webhook.mjs, registrations.mjs, ticket.mjs, auto-cancel.mjs  on-account + sale-recording hooks
netlify.toml                     + /api/karaoke|companion|specials|lightspeed|account|shop, short links, deep-link headers, shop-sync schedule
patches/patch-app-2026-09-11a.cjs   Surgical booking.html + events.html patch (Lightspeed on-account UI)
rack-player/                     ngh-karaoke-player.mjs (mpv on X-USB OUT 5-6, LAN library, importer, CD+G uploader) + installer
capacitor/                       Capacitor 8 project: config, web sync, Android App Links patch, icon/splash sources
.github/workflows/ngh-app-android.yml   Builds the Android APK (and signed AAB when secrets exist)
tests/                           Node + Playwright suites and local harnesses (see §11)
docs/                            This file, NGH-LIGHTSPEED-INTEGRATION.md, NGH-APP-SETUP.md
```

## 2. App shell

* **Origin-aware API base.** `ngh-app.js` sets `NGH.API = (location.origin matches gamehaven.guru) ? '/api' : 'https://gamehaven.guru/api'`. Inside Capacitor (`https://localhost` on Android, `capacitor://localhost` on iOS) everything hits production.
* **Native link routing.** In the store apps `/app/…` pages load from the bundle; every other gamehaven.guru page (booking, events, libraries, FAQ, tickets) and every external site (Stripe Checkout, VRBO, TCGplayer) opens in the in-app browser sheet (`@capacitor/browser`); `tel:`/`mailto:` go to the OS. Scripts navigate with `NGH.go(path)` instead of `location.href`.
* **Feature grid** (home): Book a Party Room → `/booking.html` · Book an Overnight Stay → VRBO Lodge / Adventurer's Rest + Haven Takeover (`/birthday`) · Food & Drink Specials → `specials.html?cat=food` · Retail Specials → `specials.html?cat=retail` · Tabletop Library → `/board-game-library.html` · Video Game Library → `/video-game-equipment.html` · Game Companion → `companion/` · Karaoke → `karaoke/` · Trivia → `trivia/play.html` · Events → `/events.html` (+ Request an Event → `/#request-event`) · Website → `https://gamehaven.guru`.
* **Native (Capacitor) extras** when present: haptics on turn changes and votes, share sheet, status bar color, splash, Android back button, deep links (`gamehaven.guru/app/karaoke/join.html?s=CODE`, `/karaoke`, `/turns` open the app via App Links / Universal Links). Push notifications are not built yet (phase 2).
* **Admin/Guru auth** reuses `POST /api/admin-login {code}` → Bearer token (`NGH.adminFetch`). Tokens live in `localStorage.ngh_admin_token` exactly like the Guru pages.

## 3. Realtime pattern (house style)

Every shared-state feature uses the trivia/TV pattern:

1. Server state row `{id, data JSONB, version INT}`; every mutation `version = version + 1`.
2. Clients `GET …/state?v=<lastSeen>`; the server answers `{unchanged:true, serverNow}` (tiny) unless the version moved, then the full state + `serverNow`.
3. Clients keep `offset = median(serverNow − localNow)` from a few `/time` round-trips (NTP-style). Anything timed (song start, scoring deadline) is scheduled in **server epoch ms** a couple of seconds ahead so every device starts together.
4. Poll intervals: TVs 1.5 s while a song plays / 3 s idle; phones 2 s active / 5 s idle / 15 s backgrounded (`visibilitychange`). Turn tracker: 1 s when it is *about* to be your turn, otherwise 2 s.
5. Public writes carry a per-device **token** issued at join (random 24 hex, stored in the row's `members`). Admin writes carry the Guru Bearer token.

`NGH.poll(url, {onState, interval})` in `ngh-app.js` implements 2–4 for all pages.

## 4. Karaoke Battle — data model (`karaoke.mjs`)

```
karaoke_sessions   id TEXT PK (4-letter code), data JSONB (whole session document), version INT, status TEXT, created_at, updated_at
karaoke_songs      id TEXT PK ('local:<sha1>'), provider, title, artist, duration_ms, data JSONB {media:{audio,cdg,cdgHosted}, lyrics, offsetMs}
karaoke_votes      PK(session_id, entry_id, member_id), room, choice 1–5, delivery 1–5, at
karaoke_media      PK(song_id, kind='cdg'), b64 TEXT, bytes, updated_at   (HTTPS copies of queued CD+G files; purged after 7 days)
karaoke_players    PK(session_id, name), data JSONB {status, position, entryId, device, error}, last_seen
```

`session.data` (public state, minus tokens):
```jsonc
{
  "code": "HAVEN", "mode": "battle" | "openmic", "status": "lobby" | "live" | "ended",
  "settings": { "maxSingers": 2, "onDeck": 5, "voteSeconds": 45, "voteWeighting": "participant" | "room",
                "rotateRooms": true, "wifi": { "ssid": "…", "pass": "…", "auth": "WPA" } },
  "rooms":   { "commons": {"name":"The Commons","team":"Team name","color":"#…","score":12.5,"songs":3}, "holt": {…}, "depths": {…}, "den": {…} },
  "members": [ { "id":"m_…", "name":"Dustin", "room":"holt", "joinedAt": 0 } ],           // tokens stripped
  "queue":   [ { "id":"q_…", "songId":"…", "title":"…", "artist":"…", "room":"holt", "singers":["Jen","Sarah"],
                 "requestedBy":"m_…", "status":"queued|playing|scoring|done|skipped", "addedAt":0, "order":0 } ],
  "nowPlaying": { "entryId":"q_…", "songId":"…", "startAt": 1757550000000, "pausedAt": null, "durationMs": 214000,
                  "media": { "audio":"http://<rack>:8766/media/…mp3 (rack player only)", "cdg":"/api/karaoke/media/<id>/cdg | null" },
                  "lyricsUrl":"/api/karaoke/songs/…/lyrics", "seq": 7 },
  "scoring":  { "entryId":"q_…", "opensAt": 0, "closesAt": 0, "tally": { "count": 7, "choiceAvg": 4.1, "deliveryAvg": 4.6 } },
  "results":  [ { "entryId":"q_…", "room":"holt", "title":"…", "singers":[…], "choice": 4.1, "delivery": 4.6, "points": 13.3, "votes": 7 } ],
  "history":  [ … last 20 done entries … ],
  "player":   { "name":"rack", "online": true, "position": 12345, "seenAt": 0 }
}
```

### Transport state machine (host only)
`lobby → live` (start battle) · `play(entryId?)` schedules `nowPlaying.startAt = serverNow + 3000` (player + TVs + phones preload) · `pause` sets `pausedAt` · `resume` sets `startAt = serverNow + 1500 − (pausedAt − startAt)` · `skip` marks entry skipped · **song end** (player heartbeat reports `ended`, or host presses End) → entry `scoring`, `scoring.opensAt = serverNow`, `closesAt = +voteSeconds` · `closeScoring` (host, or auto when a client observes `closesAt` passed and calls `POST …/tally`) → results row + room score · `next` = play the first `queued` entry in on-deck order.

### On-deck order
`rotateRooms=true` (default for battle): interleave rooms round-robin starting after the room that sang last, taking each room's oldest queued entry; ties by `addedAt`. `false`: FIFO. Host drag-reorder writes explicit `order` values that win over both.

### Scoring math (from the brief)
For a finished entry E sung by room R, votes come only from members **not in R**, one vote per member (`UNIQUE(session, entry, token)`), each `choice ∈ 1..5`, `delivery ∈ 1..5`.
* `voteWeighting = "participant"` (default — every participant vote counts equally): `choiceAvg = mean(choice)`, `deliveryAvg = mean(delivery)`.
* `voteWeighting = "room"` (each other room is one judge): average within each room first, then average the room averages.
* `pointsDelivery = round1(deliveryAvg × 2)` (max 10) · `pointsChoice = round1(choiceAvg)` (max 5) · `points = pointsDelivery + pointsChoice` (max 15) · `rooms[R].score += points`.
* No votes → 0 points, flagged `unscored` so the host can re-open scoring; re-scoring replaces the earlier result (no double counting).
* The host console confirms before *Play next* skips a song that is still playing (skipped songs are never scored) or closes a vote that is still open.

### Participant rules
Join by QR (`join.html?s=CODE`) → pick room (only rooms enabled for the session) → display name → token. A member may have several queued songs; each entry lists 1–`maxSingers` singer names (free text, prefilled with the member's name). Members can remove their own queued (not playing) entries. Voting UI appears only when `scoring.entryId` is set and the member's room ≠ singing room; one submission, editable until `closesAt`.

### TV layout (1920×1080, `tv.html`)
Left 68 %: lyric stage (CDG canvas or LRC renderer; 3 lines visible; word-fill highlight gold→cream; countdown dots for intros ≥ 4 s). Right 32 % column: **Now Singing** card (song, artist, singers, room badge in room color) · **On Deck** (next 5 with #, song, singers, room badge) · **Scoreboard** (rooms sorted by score, this TV's room outlined). Bottom bar: NGH crest (left), "Join Karaoke Battle" QR + code, WiFi QR (right). Overlays: `scoring` (live star tally + countdown), `results` splash (points awarded, 8 s), `lobby` (big join QR + leaderboard), `paused`. The TV that belongs to the on-deck room shows a "You're up next — get to the mic" banner.

## 5. Audio & hardware routing (open items for Dustin)

* Backing track: rack PC → mpv → X-USB **OUT 5-6** → X32 In 29/30 (Card 5/6) → strip "KARAOKE" → Main LR → all zone matrices. Add a Companion button "SETUP KARAOKE STRIP" the same way the trivia strip was done (channels 29/30, magenta, panned L/R).
* Vocals: each room's two mics feed that room's JBL Partybox only (per the brief). **Open question:** other rooms will hear the backing track but not the singing room's vocals unless the active room's Partybox line-out (or a spare Shure channel) is patched into the X32. Two options: (a) accept it — it's a sing-along battle and "delivery" is judged loosely / by whoever wanders by; (b) route the active room's mic mix to the X32 via the Partybox's line/aux out on an "ACTIVE ROOM" strip that the host console un-mutes (Companion action) when that room is up. The software works either way; `settings.vocalsToPA` is exposed for UI copy only.
* Rooms without an X32 zone (The Holt, Stash's Den) could instead run the TV in `&audio=1` mode so the Google TV Streamer's HDMI audio feeds the Partybox's AUX. That only works with media served over HTTPS (e.g. a KaraFun OEM stream) — the local provider's MP3s live on the rack PC's `http://` LAN server, which HTTPS pages can't load. With local files, feed those rooms from the X32 (a zone matrix → Partybox line-in).

## 6. Karaoke content providers (`providers.js`)

Interface: `search(q) → [{id,title,artist,durationMs,provider}]`, `resolve(id) → {media:{audio,cdg?}, lyrics?: TimedLyrics, durationMs}`, `licensingNote`.

| Provider | Status | Notes |
|---|---|---|
| `local` | **Shipped** | Files in `C:\NGH\karaoke\media` (`Artist - Title.mp3` + `.cdg` and/or `.lrc`). `ngh-karaoke-player.mjs import` parses LRC → timed-lyrics JSON and pushes metadata to `PUT /api/karaoke/catalog` (admin). While a session runs, the player plays the MP3 locally and uploads each queued `.cdg` (≤ 4 MB) to `PUT /api/karaoke/media/<id>/cdg`, so TVs and phones fetch it over HTTPS. You need a commercial-use source for the files (e.g. Karaoke Version, Sunfly/Zoom packs) plus the venue's PRO licences (ASCAP/BMI/SESAC) that cover live music. |
| `karafun` | Stub | KaraFun OEM/API: catalog + syllable-sync lyrics + audio, KaraFun handles licensing/royalties. Contact via business.karafun.com/oem. Adapter maps their syllable timings to `TimedLyrics`. KaraFun **Business** (the venue subscription) does not expose catalog/lyrics — its API is for booking/device/session management only. |
| `stingray` | Stub | Stingray Karaoke REST API (developer ToS): catalog, streaming, in-sync lyrics. Constraints: Stingray logo, prescribed nav, no offline caching, consumer tiers — likely a poor fit for a custom battle frame; kept for evaluation. |
| KaraokeCloud Pro / Singa Business | Not adaptable | Commercially licensed, but closed players (Karaoki / Singa Pro) with no lyric data or API. Could still run as the black-box audio+video source with this system only doing queue/battle/scoring and TVs mirroring the HDMI feed. |

`TimedLyrics` = `{ lines: [ { t, end, words: [ { t, end, text } ] } ], meta:{title,artist,offset} }` (ms). LRC line-only files get words distributed evenly across the line; enhanced LRC (`<mm:ss.xx>`) keeps word timings.

## 7. Game Companion

* **First Player Randomizer** (`first-player.html`): multi-touch; each finger gets a colored ring; ~2.5 s after the last finger settles it picks a winner (Single), splits into N groups (Groups), or ranks everyone (Order); haptic + confetti; works with mouse for demo. No backend.
* **Turn Tracker** (`turn-tracker.html` + `companion.mjs`): Host creates a table → 5-letter code + QR (`turn-tracker.html?t=CODE`). Players pick a color (32-color palette covering common player colors: red, blue, green, yellow, white, black, purple, orange, pink, brown, teal, grey, gold, silver, lime, navy, …) and a name. Host starts; the active player's screen is all their own color; every other player's screen shows the active color in the center with a fat border in their own color and "RED'S TURN"; big END TURN button only on the active device (host can force-advance/skip/reverse/pause/reorder). Turn timer optional. Vibrates when your turn arrives.
* **CCG Life Counter** (`life-counter.html`): Commander-first (based on the feature set of the top-rated Commander apps: Lifetap / Mythic Tools / TheStack): 2–6 players, rotated tiles for around-the-table use, starting life 20/30/40, per-opponent commander damage (auto-deducts, 21 lethal flag), poison (10 lethal), energy, experience, monarch, initiative, city's blessing, day/night, dice/coin, timer, undo history, player names & colors, keep-screen-on. No backend.
* **RPG Companion** (`rpg.html`): dice roller (formulas, advantage/disadvantage, history), initiative/combat tracker (HP, AC, conditions, round counter, sort), 5e character sheet (abilities, saves, skills, HP, spell slots, inventory, notes — stored locally, JSON export/import), SRD reference (conditions, actions in combat, exhaustion), session notes. Local-only.

## 8. Specials & Trivia

* `specials.mjs`: admin-managed `specials` rows `{id, cat: food|retail, title, blurb, terms, imageUrl, startsAt, endsAt, redeem: 'show'|'claim'}`; `claim` issues a one-time code + QR (same idea as Box Office coupons) that staff redeem from the Guru side (`POST /api/specials/redeem` with admin token, or scan in `checkin.html`-style flow). "Order food" button is a stub that opens the partner's URL from settings (`settings.foodOrderUrl`) — swap in a real ordering integration when the restaurant partner is chosen.
* Trivia: `trivia/play.html` calls `GET /api/trivia/active` and hands off to `/trivia-play.html?game=<id>` (the existing player); when no game is live it shows the next trivia events from `/api/events`. "TV feed on your phone" = `/trivia-display.html?game=<id>&display=PHONE-…` in a scaled frame.

## 9. Scaling note (when polling is no longer enough)

A busy battle night ≈ 4 TVs @ 1.5 s + 30 phones @ 2 s ≈ 18 req/s ≈ 65 k invocations/hour (all tiny `unchanged` responses). Check Netlify's function-invocation quota against how many nights a month this runs. If it ever bites: swap `NGH.poll` for a Firebase RTDB listener (`NGH.subscribe`) — the state shape is already a single JSON document per session, so the server writes the same blob to RTDB on each mutation and clients stop polling. Nothing in the UI changes.

## 10. Lightspeed

Rewards accounts, order-ahead pickup, sale recording for bookings/registrations and pay-on-account are specified in **NGH-LIGHTSPEED-INTEGRATION.md**. The booking console and events page pick up the on-account UI through `patches/patch-app-2026-09-11a.cjs`; the buttons stay hidden until `window.NGH_LIGHTSPEED_ONACCOUNT = true` in `site/ngh-config.js`.

## 11. Tests and local harnesses

| Command | What it proves |
|---|---|
| `node --test tests/` | 36 Lightspeed unit/integration tests (OAuth, token refresh, sale payloads, account/shop/webhook/checkout handlers, on-account incl. fee + deposit) |
| `node tests/karaoke.e2e.mjs` | Real `karaoke.mjs` + `companion.mjs` on an in-memory DB stand-in; TV + host + two phones: join, queue, synced lyrics, scoring math (5 + 4×2 = 13.0), rotation, TV push/restore, hosted CD+G, turn-tracker colors |
| `node tests/companion.e2e.mjs` | 135 checks across the CCG life counter and RPG companion |
| `node tests/lyrics-cdg.test.mjs` | LRC / enhanced LRC / KaraFun adapter and the CD+G decoder against synthetic fixtures |
| `node tests/specials.e2e.mjs`, `node tests/e2e-pages.mjs` | Specials/coupons/trivia pages and rewards/shop/Guru Lightspeed pages against mocks |
| `node tests/check-scripts-all.mjs site/app` | Every inline `<script>` compiles |
| `node --import ./tests/_register-karaoke.mjs tests/karaoke-harness.mjs` | Local karaoke server on :8888 (admin code 1234) for poking at the TV/host/join pages by hand |
