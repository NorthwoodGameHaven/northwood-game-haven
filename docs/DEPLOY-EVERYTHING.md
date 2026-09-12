# Deploy everything — the single page
*NGH-BUILD 2026-09-12n · written 12 September 2026*

Four things, in order. **1 and 2 you can do from the laptop right now.** 3 and 4 need you at the shop.

1. [Git deploy](#1-git-deploy) — 5 minutes
2. [The app (Android)](#2-the-app-android) — 30 min of work, then days of waiting, **start it first**
3. [TV devices](#3-tv-devices) — 5 minutes, at the shop
4. [The shop server](#4-the-shop-server) — 20 minutes, at the shop

---

# 1. Git deploy

**Everything is already in your working tree.** I wrote it there directly. Open GitHub Desktop and you'll see the changes.

### What's changed since your last push

| File | Why |
|---|---|
| `site/booking.html` | **Rejected tab fix + Robyn's booking fix** — see below |
| `site/privacy.html` | **New.** Google Play won't accept a listing without one |
| `netlify.toml` | adds the `/privacy` route |
| `capacitor/scripts/patch-android.mjs` | stamps `versionCode`; App Links for the new QRs |
| `tests/booking-admin-render.test.mjs` | **New.** 14 tests for the booking fixes |
| `tests/karaoke-nametune.test.mjs` | self-registering, so one command runs the whole suite |
| `tools/make-store-assets.mjs` + `tools/store-assets/*.png` | **New.** Play icon and feature graphic |
| `docs/*.md` | this page, the morning brief, the Android and shop runbooks |
| `patches/*` | the scripts that made the edits, for the record |

### The two bugs fixed

**Why the Rejected tab showed nothing.** `renderAdmin` built the list in one expression — `el.innerHTML = list.map(reqCardHtml).join("")`. If **any single booking** throws while rendering, the exception escapes *before* `innerHTML` is assigned, so the panel keeps whatever the previous tab drew. On a fresh console that's the Pending tab's empty state. That's exactly what you saw: "Rejected (20)" highlighted above "No pending requests." Cards now render one at a time, so a bad record costs you that card — shown with its id, name and the real error — not the tab.

**Why Robyn's booking kept coming back rejected.** `autoCancelUnpaid()` runs on **every console load** and re-cancelled any approved-and-unpaid booking past its payment deadline, with **no lower bound**. A booking whose date has passed is eligible forever — so every time a Guru re-approved it, the next refresh flipped it back **and emailed her another cancellation.** She may have had several. Now auto-cancel only fires between the payment deadline and the end of the booking date, and a manual re-approval exempts the booking permanently.

> **Worth checking:** whether Robyn got more than one cancellation email, and whether some of those other 19 "rejected" bookings were auto-cancelled rather than genuinely rejected. The tab will open now.

### Do this

1. Open **GitHub Desktop** → repository `northwood-game-haven`.
2. **Summary:**
   ```
   Booking console fixes, privacy policy, Android deploy prep
   ```
3. **Description:**
   ```
   NGH-BUILD 2026-09-12n.

   BOOKING CONSOLE - two bugs from one screenshot.

   The Rejected tab rendered nothing while the count said 20. renderAdmin
   assigned el.innerHTML from list.map(reqCardHtml).join(""), so one booking
   that throws took the exception out of the function before innerHTML was
   ever set - leaving the panel showing the previous tab's empty state. Cards
   now render individually; a failing record shows its id, name, date and the
   error, and logs to the console, instead of costing the whole tab.

   autoCancelUnpaid re-cancelled any approved-and-unpaid booking past its
   payment deadline with no lower bound, so a past-dated booking stayed
   eligible forever. Re-approving one flipped it back to rejected on the next
   console refresh and emailed the guest another cancellation. Auto-cancel now
   only fires between the deadline and the end of the booking date, and a
   manual re-approval sets autoCancelExempt.

   14 tests that extract the real functions out of booking.html and run them,
   so they cannot drift from the shipped page. 4 mutations, all caught.

   PRIVACY POLICY - site/privacy.html, routed at /privacy. Google Play will
   not accept a listing without one and checks the Data Safety form against
   it. Describes what the app actually does: name/email/phone for bookings,
   Stripe for payments, Lightspeed for rewards, camera for QR scanning only,
   no location, no ads, no analytics SDKs.

   ANDROID - patch-android.mjs now stamps versionCode and versionName from
   capacitor/package.json. Capacitor hardcodes versionCode 1, so the second
   Play upload would always have been rejected, after the upload completed,
   with no obvious cause. Also adds App Links for /speedgaming and /mtg so the
   new TV QR codes open the app. Play store icon and feature graphic generated
   from the crest under tools/store-assets/.

   TESTS - the karaoke suite now registers its own module hooks, so
   `node --test tests/*.test.mjs` runs everything: 273 tests, one command.
   That command previously failed on exactly that one file.
   ```
4. **Commit to main** → **Push origin**.
5. Wait for Netlify, then check **`https://gamehaven.guru/privacy`** loads.

### Set `VENUE_KEY` while you're there

Netlify → your site → **Site configuration** → **Environment variables** → **Add a variable**:

- Key: `VENUE_KEY`
- Value: a long random string, 30+ characters

Then **Deploys** → **Trigger deploy** → **Deploy site**. Environment changes don't reach a running deploy.

**Save that value.** You need it at the shop for the Stream Deck buttons.

### Run the tests any time

```
node --test tests/*.test.mjs
```

273 tests, one command.

---

# 2. The app (Android)

Full detail: `docs/NGH-ANDROID-DEPLOY.md`. This is the shape of it.

### Start the Play account today — it's the long pole

**play.google.com/console** → **Create developer account** → **$25**.

Identity verification takes **days to a couple of weeks**. Everything else can happen while you wait; nothing publishes until it clears.

One decision: **Organization** (listing says "Northwood Game Haven", needs a free D-U-N-S number, 1–2 weeks extra) or **Personal** (immediate, listing says your name).

### Test the app right now, free, no accounts

1. GitHub → **Actions** → **NGH App (Android)** → **Run workflow** → `main`.
2. ~6 minutes. Open the green run → **Artifacts** → download **`game-haven-debug-apk`**.
3. Unzip, email the `.apk` to yourself, open it on your phone, allow "unknown apps", install.

What to check, in priority order:

- **Game Companion → turn tracker** with two phones. Feel the **haptic on end-turn** — that's genuinely native.
- **Karaoke → join → Scan.** ⚠️ The camera scanner has **never been tested on real hardware**.
- **Speed Gaming** and **Magic** — new screens.
- **Trivia → Join** — should open with no browser address bar.

### Create the signing key (once, ever)

```powershell
keytool -genkey -v -keystore ngh-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ngh
```

Answer: password (**write it down**), `Northwood Game Haven`, blank, `Northwood Game Haven`, `Chippewa Falls`, `WI`, `US`, `yes`, then **Enter** to reuse the password.

> **Lose `ngh-upload.jks` and you can never update the app under that listing again.** Google Drive **and** a USB stick in the safe. Password in your password manager.

Then base64 it and add four GitHub secrets — exact commands in the full doc:

`ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASS`, `ANDROID_KEY_ALIAS` (`ngh`), `ANDROID_KEY_PASS`.

Re-run the workflow; you should now get a **`game-haven-release-aab`** artifact too.

### Before every Play upload

**Bump `version` in `capacitor/package.json`.** That's the only thing to remember — the build derives `versionCode` from it (`1.0.0` → 10000, `1.0.1` → 10001).

### Listing assets — ready to upload

- `tools/store-assets/play-icon-512.png` — 512×512, no alpha
- `tools/store-assets/play-feature-1024x500.png` — feature graphic
- Screenshots: take them on a real phone. **Lead with Game Companion, Karaoke and Speed Gaming**, not the booking form.
- Privacy policy URL: `https://gamehaven.guru/privacy`

### Data Safety form — the bit people get wrong

- **Name, Email, Phone** — collected, not shared, required, for app functionality and account management.
- **Purchase history** — collected, not shared, optional.
- **Photos** — ⚠️ **do NOT tick.** The camera does live on-device QR scanning; nothing is stored or sent, so it isn't "collected".
- Nothing else. No location, no analytics, no ad IDs.

Then: **Internal testing** → upload the AAB → add yourself as a tester → install from Play (not sideload, so App Links verify) → copy the **SHA-256** from **App integrity → App signing** into `site/.well-known/assetlinks.json` → push → reinstall.

---

# 3. TV devices

On each **Google TV Streamer 4K**, open the browser and go to:

```
https://gamehaven.guru/tv-auto
```

Set it as the home page / kiosk URL so it survives a power cut. **That's it — once, forever.**

The screen now follows the venue mode by itself: Magic, Trivia, Karaoke, Speed Gaming, or the idle house board. Nobody re-points a streamer on a Wednesday again.

**To pin one screen to one mode** (karaoke lyrics on one TV while the others follow along):

```
https://gamehaven.guru/tv-auto?force=karaoke
```

Values: `idle`, `trivia`, `karaoke`, `mtg`, `speedgaming`.

**Test before you walk away:** set a mode from your phone at `gamehaven.guru/mtg` (sign in as Guru) and watch the TV change within about five seconds.

Three things it does on purpose, because nobody can reach a ceiling-mounted streamer:

- **Frames the board rather than redirecting** — a redirect loses the page that knows how to come back.
- **Never blanks on a network drop** — it keeps the last board and retries with backoff.
- **Reloads itself hourly while hidden** — clears anything the TV browser leaks over a multi-day run.

---

# 4. The shop server

Full detail: `docs/NGH-SHOP-SERVER-UPDATE.md`. Do it when the shop is quiet.

### Back up first — five minutes, saves an evening

PowerShell **as Administrator** on the rack PC (`gt15-max`):

```powershell
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$dest  = "C:\NGH\backups\$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "C:\NGH\rack-player\config.json" "$dest\config.json" -ErrorAction SilentlyContinue
Copy-Item "$env:APPDATA\companion" "$dest\companion" -Recurse -ErrorAction SilentlyContinue
Write-Host "Backed up to $dest"
```

Also: Companion GUI at `http://127.0.0.1:8000` → **Import / Export** → **Export** → **Full configuration** → save into that same folder.

### Add the five venue buttons

Needs `VENUE_KEY` from step 1.

1. `http://127.0.0.1:8000` → **Connections** → **Add connection** → **Generic HTTP**.
   - Label `Venue`, Base URL `https://gamehaven.guru/api/venue/`
2. On the **NGH SHOW** page, five keys, each an action **Venue: GET**:

| Label | URL path |
|---|---|
| `OPEN PLAY` | `mode/idle?key=YOUR_VENUE_KEY` |
| `TRIVIA` | `mode/trivia?key=YOUR_VENUE_KEY` |
| `KARAOKE` | `mode/karaoke?key=YOUR_VENUE_KEY` |
| `MAGIC` | `mode/mtg?key=YOUR_VENUE_KEY` |
| `SPEED GAMING` | `mode/speedgaming?key=YOUR_VENUE_KEY` |

> **Build these by hand in the GUI. Do not import a page JSON.** Your own September notes: *page imports silently drop actions whose connection isn't in the file's `instances` block.*

3. Press **KARAOKE**. Within seconds every `/tv-auto` screen should swap, and `https://gamehaven.guru/api/venue/state` should read `"mode":"karaoke"`. Pressing twice is harmless by design.

### The X32 — needs a decision from you

The server publishes *intent* (`av.cue` per mode); Companion owns the mixer. Deliberately: the X32 is on your LAN and the site runs on Netlify, so making the PA depend on an internet link would mean a dropped upstream silences the room.

**Option A — Companion polls** `https://gamehaven.guru/api/venue/state` every 5s and triggers X32 actions on `mode` changing. Works today.

**Option B — the rack-player proxies it.** It already holds the admin code in `config.json` and already proxies `/show`. The credential never enters Companion's page JSON and it keeps working when the internet drops. **This is the better architecture** and I'll build it when you hand me the machine — I won't guess at a file running as an NSSM service.

**What I need from you:** the **X32 scene slot number per mode**. Slot 01 is `NGH SHOW`; the rest were empty on 09-09.

### Handing me the rack PC

Open the **Claude desktop app** on `gt15-max`, start or open a task, choose **Link to this computer**, and tell me you're on the rack PC. Then I'll read `C:\NGH\rack-player\player.mjs`, add the `/venue` proxy, drive the Companion GUI to verify each button actually fires, wire the X32 scenes, and test the whole loop live.

Two things I already know about that machine: the computer-use approval dialog shows no Allow button, so installs go through double-clicked `RUN-*.cmd` scripts in Downloads; and the built-in browser pane caches pages, so anything freshly deployed needs a hard reload.

---

## Still open

- **X32 scene numbers per mode** — blocks finishing the A/V loop.
- **Companion polls vs. rack-player proxy** — I recommend the proxy.
- **Change the WPN password.** It's been in our chat twice. I never used it and never stored it.
- **Two malformed Lightspeed returns** (receipts 1619, 1620) from debugging — Lightspeed support can remove them. 1619 carries a −$10.55 payment against zero goods, so it may surface in a reconciliation.
- **Military discount is self-served** — `milRequested` applies 15% while `milVerified` stays `"pending"`. Policy call, not a bug.
- **iOS** — blocked on macOS. Codemagic builds from this same repo without a Mac when you want it.
