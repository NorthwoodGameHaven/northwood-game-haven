# Venue mode — one source of truth for what the room is doing
*NGH-BUILD 2026-09-12m. Read with NGH-SPEEDGAMING.md and the AV rig notes.*

Magic night, Team Trivia, Karaoke Battle and the Speed Gaming Meet-up never run at the same time. So the venue has **one mode**, and every screen, speaker and phone follows it.

That's not tidiness — it's what makes "synchronized" achievable. The alternative, where a Guru sets the TVs, then the mixer, then the app, drifts the first time someone gets pulled away mid-changeover, and it always drifts in front of a full room.

```
   Stream Deck key  ──▶  GET /api/venue/mode/karaoke?key=…
                                   │
                          venue mode  (venue.mjs)
                                   │
      ┌────────────────────────────┼────────────────────────────┐
      ▼                            ▼                            ▼
  /tv-auto                Bitfocus Companion              the NGH app
  Google TV Streamers     polls /api/venue/state          + players' phones
  point here ONCE         → X32 scene / mutes / faders
```

---

## 1. The one URL a screen ever needs

Point each **Google TV Streamer 4K** at:

```
https://gamehaven.guru/tv-auto
```

Once. Forever. It follows the mode and swaps itself to the right board — Magic, Trivia, Karaoke, Speed Gaming, or the idle house screen. Nobody touches a streamer on a Wednesday again.

To pin one screen to a single mode regardless of the venue (karaoke lyrics on one TV while the rest follow along):

```
https://gamehaven.guru/tv-auto?force=karaoke
```

Three deliberate behaviours, all about a device nobody can reach without a ladder:

- **It frames the board rather than redirecting to it.** A redirect loses the page that knows how to come back; a streamer that navigated away would need re-pointing by hand.
- **Losing the network never blanks the screen.** It keeps showing the last board and retries with backoff. Only a *cold* start that has never reached the server falls back to the house screen.
- **It reloads itself hourly while hidden**, which clears anything the embedded TV browser has quietly leaked over a multi-day run.

---

## 2. The Stream Deck surface

One bare URL per key. No body, no token dance, and pressing twice is harmless — setting a mode is idempotent by nature.

| Key | URL |
|---|---|
| Open play | `https://gamehaven.guru/api/venue/mode/idle?key=…` |
| Team Trivia | `https://gamehaven.guru/api/venue/mode/trivia?key=…` |
| Karaoke Battle | `https://gamehaven.guru/api/venue/mode/karaoke?key=…` |
| Magic night | `https://gamehaven.guru/api/venue/mode/mtg?key=…` |
| Speed Gaming | `https://gamehaven.guru/api/venue/mode/speedgaming?key=…` |

**Setting it up in Companion** (the rig already has Companion 5 at `127.0.0.1:8000`):

1. **Connections** → add **Generic HTTP** → label `Venue`, base URL `https://gamehaven.guru/api/venue/`.
2. On the **NGH SHOW** page, add five keys. Each one: action **Generic HTTP → GET**, URL `mode/karaoke?key=<VENUE_KEY>` (etc.).
3. Optional: the response body starts with `set: "Karaoke Battle"`, so a key can show what it did.

> **Do not build these by importing a page JSON.** Your own notes from the September setup: *page imports silently drop actions whose connection isn't in the file's `instances` block.* Add the connection in the GUI first, then add the keys, then export if you want a backup.

### The key

Set `VENUE_KEY` in Netlify (Site configuration → Environment variables) to a long random string, then **Trigger deploy** — env changes don't apply to the running deploy.

The key only sets modes. It cannot read customer data, touch money, or reach anything else. It exists because admin tokens expire and a Stream Deck cannot re-authenticate itself at 7pm on a Friday.

A Guru admin token works on the same endpoints, so the app can drive the mode without the shared key.

---

## 3. The X32 side

The server **does not talk to the mixer**, deliberately. The X32 is on the shop LAN and this runs on Netlify; making the PA depend on an internet link means a dropped upstream silences the room. Companion is already on the LAN, already drives the rack, and keeps working when the internet doesn't — so it does the acting.

Poll `https://gamehaven.guru/api/venue/state` and key off `mode` (or `av.cue`, which is a stable string per mode). What the server publishes is *intent*; the scene numbers, mutes and fader positions stay in Companion where they belong.

| Mode | `av.cue` | Suggested rack behaviour |
|---|---|---|
| `idle` | `house` | House playlist on Aux 5/6, mics muted |
| `trivia` | `trivia` | TRIVIA MEDIA ch 27/28 up, MIC 1 live, music bed low |
| `karaoke` | `karaoke` | Room Partyboxes, wireless pair live, backing track on OUT 5-6 |
| `mtg` | `mtg` | House playlist, MIC 1 available for announcements |
| `speedgaming` | `speedgaming` | House playlist, MIC 1 live for round calls |

**Two things I need from you to finish this end:**

1. The **X32 scene slot number** you want per mode (slot 01 is `NGH SHOW` today; the rest were empty as of 2026-09-09).
2. Whether Companion should **poll** `/api/venue/state` on a timer, or you'd rather the rack-player poll it and expose it locally on `:8765` the way `/show` already proxies trivia control.

The second is the better architecture and matches what's already there — the admin code lives in the rack-player's `config.json` rather than in Companion's page JSON, and everything keeps working if the internet drops. I didn't build it because I don't have that player's source here and I'm not guessing at a file that runs as an NSSM service.

---

## 4. Reading it from anything

```
GET /api/venue/state           the current mode (send ?v=N for a cheap unchanged poll)
GET /api/venue/modes           the mode table — labels, screens, AV cues
GET /api/venue/mode/:mode      set it (key or Guru token)
POST /api/venue/mode           {mode, note} for anything that prefers a body
POST /api/venue/note           {note} — a line for the screens, without changing mode
```

A **note** is the thing a Guru actually wants mid-event — "Round 3 starts in 5" — without touching the mode. Changing mode clears it, so a stale note from the last event can never follow the room.

---

## 5. What's tested

29 tests, and a mutation sweep on every rule that matters. Worth knowing about two of them:

**The key check is three overlapping guards** — refuse an unset key, refuse an empty one, and compare SHA-256 digests. Mutating any *single* one changes nothing, which is the point; mutating all three together is caught. The original version padded both sides to 64 characters before comparing, and mutation testing found the hole: padding makes a key of 64 spaces equal an *empty* configured key, so a blank `VENUE_KEY` would have authenticated anyone sending spaces.

**An unknown stored mode falls back to `idle`.** If a future build renames a mode while the database still holds the old name, the screens show the house board rather than going black.
