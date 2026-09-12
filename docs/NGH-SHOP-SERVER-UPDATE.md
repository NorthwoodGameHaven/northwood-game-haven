# Updating the shop rack PC
*NGH-BUILD 2026-09-12m. The Geekom mini PC — hostname `gt15-max`, user `stash`.*

Everything on gamehaven.guru deploys itself from GitHub. **This document is only about the machine in the rack**, which runs three things:

| | Where | What it does |
|---|---|---|
| **ngh-rack-player** | `C:\NGH\rack-player`, NSSM service | mpv audio cues for trivia; soundboard API on `:8765`; `/show` proxies transport control up to gamehaven.guru |
| **Bitfocus Companion 5** | `C:\Program Files\Companion`, GUI `127.0.0.1:8000` | Drives the X32 and the Stream Deck |
| **X32-Edit** | | Mixer config, when you need it by hand |

**Do this when the shop is closed or quiet.** The service restart drops audio for a few seconds, and if a Companion page ends up half-edited you want time to fix it.

---

## Before you touch anything: take a backup

Five minutes, and it's the difference between "undo it" and "rebuild it".

Open **PowerShell as Administrator** on the rack PC:

```powershell
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$dest  = "C:\NGH\backups\$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

# rack-player config (contains the admin code — do not paste it anywhere)
Copy-Item "C:\NGH\rack-player\config.json" "$dest\config.json" -ErrorAction SilentlyContinue

# Companion's whole database: connections, pages, button actions
Copy-Item "$env:APPDATA\companion" "$dest\companion" -Recurse -ErrorAction SilentlyContinue

Write-Host "Backed up to $dest"
```

**Also export the Companion pages through the GUI** — it's a cleaner restore than the raw database:

1. Browser → `http://127.0.0.1:8000`
2. **Import / Export** → **Export** → **Full configuration** → save into `C:\NGH\backups\<stamp>\`.

> From your own September notes: *page imports silently drop actions whose connection isn't in the file's `instances` block.* Full-configuration exports include the instances, which is why you want that one rather than a single page.

---

## Part 1 — Point the TVs at the auto screen (5 minutes)

This is the biggest win for the least work, and it's the last time you ever touch a streamer.

On each **Google TV Streamer 4K**, open the browser and go to:

```
https://gamehaven.guru/tv-auto
```

Set it as the home page / kiosk URL so it comes back after a power cut.

From then on the screen follows the venue mode by itself — Magic, Trivia, Karaoke, Speed Gaming, or the idle house board. Nobody re-points anything on a Wednesday.

**To pin one screen to a single mode** (karaoke lyrics on one TV while the rest follow along):

```
https://gamehaven.guru/tv-auto?force=karaoke
```

Valid values: `idle`, `trivia`, `karaoke`, `mtg`, `speedgaming`.

**Test it before you leave:** set a mode from your phone (`gamehaven.guru/mtg`, sign in as Guru) and watch the TV change within about five seconds.

---

## Part 2 — Companion: five venue-mode buttons (15 minutes)

Requires `VENUE_KEY` to be set in Netlify first — see `NGH-VENUE-MODE.md`. Have the key to hand.

### 2.1 Add the connection

1. Browser → `http://127.0.0.1:8000` → **Connections**.
2. **Add connection** → search **Generic HTTP** → add it.
3. Label: `Venue`
4. **Base URL:** `https://gamehaven.guru/api/venue/`
5. **Save**.

### 2.2 Add the buttons

On the **NGH SHOW** page, pick five free keys. For each one:

1. Click the key → **Add action** → **Venue: GET**.
2. Set the URL path, exactly:

| Button label | URL path |
|---|---|
| `OPEN PLAY` | `mode/idle?key=YOUR_VENUE_KEY` |
| `TRIVIA` | `mode/trivia?key=YOUR_VENUE_KEY` |
| `KARAOKE` | `mode/karaoke?key=YOUR_VENUE_KEY` |
| `MAGIC` | `mode/mtg?key=YOUR_VENUE_KEY` |
| `SPEED GAMING` | `mode/speedgaming?key=YOUR_VENUE_KEY` |

3. Give each key a text label and a colour so they read at a glance.

**Build these by hand in the GUI. Do not import a page JSON** — your September notes record that imports drop actions whose connection isn't in the instances block, and that is exactly the failure mode here.

### 2.3 Test

Press **KARAOKE**. Within a few seconds:
- every `/tv-auto` screen swaps to the karaoke board
- `https://gamehaven.guru/api/venue/state` shows `"mode":"karaoke"`

Press it twice — nothing bad happens. That's deliberate.

### 2.4 Make the X32 follow (needs a decision from you)

The server publishes *intent*; Companion owns the mixer. Two ways to wire it, and **I need you to pick before I build the second one**:

**Option A — Companion polls (simpler, works today).**
Add a **Generic HTTP** variable polling `https://gamehaven.guru/api/venue/state` every 5 seconds, then a **Trigger** on the `mode` variable changing that fires your X32 actions per value.

**Option B — the rack-player proxies it (better, matches what's already there).**
The rack-player already holds the admin code in `config.json` and already proxies `/show` to gamehaven.guru. Adding a `/venue` endpoint and a mode-follow poll means the credential never enters Companion's page JSON, and the whole thing keeps working when the internet drops.

**B is the right architecture.** I haven't built it because I don't have that player's source in this workspace and I won't guess at a file running as an NSSM service. When you hand me the rack PC, that's job one — I'll read `C:\NGH\rack-player\player.mjs` first.

**What I need from you either way:** the **X32 scene slot number** you want per mode. Slot 01 is `NGH SHOW`; the rest were empty as of 2026-09-09.

---

## Part 3 — Updating the rack-player (only when I ship a new one)

Nothing in the 2026-09-12l or 2026-09-12m drops changes the rack-player. This is the procedure for when something does.

```powershell
# 1. Stop the service
nssm stop ngh-rack-player

# 2. Back up the current copy
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
Copy-Item "C:\NGH\rack-player" "C:\NGH\backups\rack-player-$stamp" -Recurse

# 3. Copy the new files in (config.json is NOT overwritten — it holds your admin code)

# 4. Start it again
nssm start ngh-rack-player

# 5. Check it came up
Start-Sleep -Seconds 3
Invoke-RestMethod http://127.0.0.1:8765/health
Get-Content C:\NGH\logs\*.log -Tail 30
```

**If it won't start**, run it in the foreground to see the actual error — the service log can swallow startup failures:

```powershell
nssm stop ngh-rack-player
cd C:\NGH\rack-player
node player.mjs
```

`Ctrl+C` when you've read the error, fix, then `nssm start ngh-rack-player`.

**To roll back:** stop the service, delete `C:\NGH\rack-player`, rename the backup folder back, start the service.

---

## Part 4 — Handing me the machine

You've done this before and it worked well. When you're at the shop:

1. Open the **Claude desktop app** on the rack PC (`gt15-max`).
2. Start a new task, or open this one, and choose **Link to this computer**.
3. Tell me you're on the rack PC and what you want done.

Then I can read the actual files instead of writing instructions about them. What I'd do, in order:

1. **Read `C:\NGH\rack-player\player.mjs`** and add the `/venue` proxy and mode-follow poll (Option B above).
2. **Drive the Companion GUI in the browser pane** to build the five venue buttons, verifying each one actually fires rather than assuming.
3. **Wire the X32 scenes** to the modes once you've given me the slot numbers.
4. **Test the whole loop live**: Stream Deck → mode → TVs swap → mixer follows.

Two things I already know about that machine from last time, so we don't rediscover them:

- The Cowork computer-use approval dialog showed **no Allow button**, so installs go through double-clicked `RUN-*.cmd` scripts in Downloads rather than direct commands.
- The built-in browser pane **caches pages** — check anything you've just deployed with a hard reload or `cache:'no-store'`.

---

## Quick reference

| Thing | Where |
|---|---|
| Companion GUI | `http://127.0.0.1:8000` |
| Rack-player API | `http://127.0.0.1:8765` |
| X32 | `192.168.1.87` (X32RACK, fw 4.13) |
| Rack-player files | `C:\NGH\rack-player` |
| Logs | `C:\NGH\logs` |
| mpv | `C:\NGH\mpv\mpv.com` |
| nssm | `C:\NGH\nssm.exe` |
| Backups | `C:\NGH\backups` |
| Venue mode state | `https://gamehaven.guru/api/venue/state` |
| Auto TV | `https://gamehaven.guru/tv-auto` |

**Audio routing, for reference:** Windows must output to the **BEHRINGER X-USB OUT 1-2** endpoint — the generic "Speakers (2- X-USB)" endpoint passes no audio. Card 1–8 → X32 In 25–32; Aux 5/6 = MUSIC; rack-player trivia audio is pinned to OUT 3-4 → In 27/28 (TRIVIA L/R); OUT 5-6 is free for karaoke.
