# NGH App — Deploy & Setup Runbook
*NGH-BUILD 2026-09-11a · NGH App (PWA + iOS/Android), Karaoke Battle, Game Companion, Specials, Lightspeed X-Series. Specs: NGH-APP-ARCHITECTURE.md, NGH-LIGHTSPEED-INTEGRATION.md.*

**Order of operations** — do these in this order; each one is finished before the next starts.

| # | Do this | Where | Time |
|---|---|---|---|
| 1 | **Deploy the code** (Part A) — extract the zip, run the deploy script, commit + push in GitHub Desktop | PC with the repo | 15 min |
| 2 | **Add the Netlify keys** (Part B) — `KARAOKE_PLAYER_KEY` now; the Lightspeed ones can wait for step 4 | app.netlify.com | 10 min |
| 3 | **Smoke-test the site** — `/app/`, `/app/karaoke/host.html`, `/app/companion/` all load | any browser | 5 min |
| 4 | **Lightspeed** (Part C) — rotate the secret, fix the redirect URL, connect the store, copy the IDs back into Netlify, add the four service products | Lightspeed + Netlify | 45 min |
| 5 | **Karaoke rack PC** (Part D2) — install the service, import your songs | rack PC | 30 min |
| 6 | **X32 + TVs** (Parts D3–D4) — karaoke strip on In 29/30, name each TV after its room, run a test battle | venue | 45 min |
| 7 | **Specials** (Part F) — add a couple of coupons | any browser | 10 min |
| 8 | **App builds** (Part E) — Android APK from GitHub Actions; iPhone when you have a Mac | GitHub / Mac | later |

Nothing customer-visible changes until you start linking to `/app/` — steps 1–3 are safe on their own.

---

## A. Deploy (Standard Drop Protocol)

**1. Extract the newest zip** (PowerShell):
```powershell
$d="$env:USERPROFILE\Downloads\ngh-drop"; Remove-Item $d -Recurse -Force -EA 0; New-Item -ItemType Directory $d | Out-Null; $z=Get-ChildItem "$env:USERPROFILE\Downloads\*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1; Expand-Archive $z.FullName $d; "Using $($z.Name)"
```
It must print `Using NGH-APP-2026-09-11a-r2.zip` (the newest zip in Downloads — that's the one to use).

**2. Pull the latest main first.** In GitHub Desktop: pick the `northwood-game-haven` repository → **Fetch origin** → **Pull origin** (if it offers). Or, in a Command Prompt at the repo root: `git pull origin main --no-rebase`. Never run the drop on a stale checkout.

**3. Run the deploy script from the repo root.** In GitHub Desktop: **Repository → Open in Command Prompt** (that opens at the repo root, e.g. `C:\NGH\site-repo`), then:
```
%USERPROFILE%\Downloads\ngh-drop\DEPLOY-2026-09-11a.cmd
```
The script moves all 84 files into place with explicit `move /Y` lines, runs `node patches\patch-app-2026-09-11a.cjs` (booking.html + events.html; aborts file-untouched on any anchor miss), then runs `findstr /M /C:"NGH-BUILD 2026-09-11a"` over the 70 touched text files. **Every filename must print.** The 16 files that can't carry a marker (PNG icons/assets, four JSON files, two test fixtures) are checked for existence instead.

**4. Commit and push — this is the whole GitHub step.** Everything the script moved is meant to go to GitHub: the new app pages under `site/app/`, the new/changed Netlify functions, `netlify.toml`, the patched `booking.html` + `events.html`, and the supporting folders (`patches/`, `rack-player/`, `capacitor/`, `.github/`, `docs/`, `tests/`). Nothing is left out and nothing is uploaded anywhere else.
   1. Open GitHub Desktop → the changed-files list on the left should read **86 changed files** (76 new + 8 replaced + booking.html + events.html patched). If the count is different, stop — something didn't move.
   2. Summary: `NGH-BUILD 2026-09-11a — NGH App, Karaoke Battle, Game Companion, Specials, Lightspeed`.
   3. **Commit to main** → **Push origin**.
   4. Netlify starts building within a few seconds (app.netlify.com → **northwoodgamehaven** → Deploys). Wait for **Published** — about 1–2 minutes.

**5. After Netlify shows Published:** open `https://gamehaven.guru/app/` → Ctrl+U → search `NGH-BUILD 2026-09-11a`. Then open `https://gamehaven.guru/app/karaoke/tv.html` and `https://gamehaven.guru/api/karaoke/time` (should return `{"serverNow":…}`).

The push also starts the **NGH App (Android)** GitHub Action (see E). It builds a phone app in the background and doesn't affect the website.

*If something looks wrong after the push:* GitHub Desktop → **History** → right-click the commit → **Revert changes**, then push. Netlify redeploys the previous version in a minute.

### What changed in existing files (read before committing)
| File | Change |
|---|---|
| `netlify.toml` | New `/api/*` aliases (karaoke, companion, specials, lightspeed, account, shop), short links (`/karaoke`, `/sing`, `/turns`, `/companion`, `/rewards`, `/order`, `/specials`), deep-link headers, `shop-sync` every 30 min. **Removed** the three invalid `/.netlify/functions/*` self-redirects (queued cleanup; Netlify was ignoring them). |
| `netlify/functions/auto-cancel.mjs` | **Bug fix:** the 2026-09-10c "don't cancel partially-paid bookings" guard was committed to `_shared/auto-cancel.mjs`, which Netlify never runs. The live scheduled function still cancelled fee-paid/deposit-unpaid bookings. The guard is now in the live file, plus on-account bookings. |
| `create-checkout.mjs`, `stripe-webhook.mjs`, `_shared/lightspeed.mjs` | Lightspeed sale recording, order-ahead checkout, pay-on-account. Card checkout never waits on Lightspeed; a failed Lightspeed write is logged and replayable. Loyalty discount behaves as before. |
| `registrations.mjs`, `ticket.mjs` | On-account wording in the "event confirmed" email, staff cancel email, and ticket status chip (additive). |
| `site/ngh-config.js` | `window.NGH_LIGHTSPEED_ONACCOUNT = false;` (flip after Part C). |
| `site/booking.html`, `site/events.html` | Patched (not replaced): on-account badge/buttons in the Guru Console and approval email, return banner, "on your Haven account" on My registrations. Invisible while the flag is false. |

---

## B. Netlify environment variables (the "keys")

These are the values the site's server code reads. They are **not** in the repo — they live only in Netlify.

### B1. Add or change one in the Netlify UI
1. Go to **https://app.netlify.com** and sign in.
2. Click the site **northwoodgamehaven** (Sites list, or Projects → the site).
3. Left sidebar: **Site configuration** (older UI: *Site settings*).
4. Left sidebar inside that: **Environment variables**.
5. **To add:** click **Add a variable** → **Add a single variable**.
   * **Key:** exactly as spelled in the table below (capitals and underscores matter).
   * **Values:** leave the scope as **Same value for all deploy contexts**.
   * **Value:** paste it. For anything secret (client secret, player key) tick **Contains secret value** if the option is shown — then Netlify hides it after saving.
   * **Scopes:** leave **All scopes** (Functions must be included — that's what uses them).
   * Click **Create variable**.
6. **To change one that already exists** (e.g. after you regenerate the Lightspeed secret): find the row → **Options ⋯** on the right → **Edit** → replace the value → **Save**. (If it was marked secret you can't read the old value — you can only overwrite it.)
7. **To delete one:** Options ⋯ → **Delete**.
8. **Apply the change — this step is required.** Env-var edits do *not* affect the running site until a new deploy: left sidebar **Deploys** → **Trigger deploy** ▾ → **Deploy site**. Wait for **Published**.
9. Check it took: open `https://gamehaven.guru/app/guru-lightspeed.html`, sign in with the Guru code — the "Configured" card lists which Lightspeed variables the server can now see.

### B2. Same thing from the rack PC command line (optional)
The rack PC already has the Netlify CLI linked to the site, so this works from `C:\NGH\site-repo`:
```
netlify env:set KARAOKE_PLAYER_KEY "paste-a-long-random-string"
netlify env:set LIGHTSPEED_CLIENT_ID "K8kX…"
netlify env:set LIGHTSPEED_CLIENT_SECRET "the-new-secret"
netlify env:list
netlify deploy --build --prod
```
`env:set` overwrites an existing key, so it's also how you rotate one.

### B3. What to set

| Variable | Value | When |
|---|---|---|
| `KARAOKE_PLAYER_KEY` | any long random string you invent (the rack PC config gets the same string) | Step 2 — before karaoke |
| `KARAOKE_WIFI_SSID` / `KARAOKE_WIFI_PASS` | guest WiFi name / password (optional — the host console can also set it per session) | Step 2 (optional) |
| `LIGHTSPEED_CLIENT_ID` | Client ID from the dev portal (Online Booking app) | Step 4 |
| `LIGHTSPEED_CLIENT_SECRET` | **the regenerated** secret (C1) | Step 4 |
| `LIGHTSPEED_OUTLET_ID`, `LIGHTSPEED_REGISTER_ID`, `LIGHTSPEED_USER_ID`, `LIGHTSPEED_PAYMENT_TYPE_ONLINE`, `LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT`, `LIGHTSPEED_TAX_ID`, `LIGHTSPEED_TAX_ID_NONE` | copy from `/app/guru-lightspeed.html` after you connect the store (C3–C4); each row there has a Copy button and shows the variable name it belongs to | Step 4 |

`LIGHTSPEED_DOMAIN`, `LIGHTSPEED_TOKEN`, `LOYALTY_GROUP_DISCOUNTS`, and everything else already in there stay exactly as they are. If `LIGHTSPEED_TOKEN` is a working personal token, the new features use it and connecting over OAuth (C3) is optional.

---

## C. Lightspeed X-Series

1. **Rotate the client secret.** The secret was pasted into a chat, so treat it as exposed: developers.retail.lightspeed.app → Organisations → Northwood Game Haven → Online Booking → **Generate New Secret**. Put the new value only in Netlify (`LIGHTSPEED_CLIENT_SECRET`). Also change the developer-account password you shared.
2. **Fix the Redirect URL** on the same page (Edit Application): `https://gamehaven.guru/api/lightspeed/callback`. (`/booking` can't receive the OAuth code.)
3. **Connect the store:** `https://gamehaven.guru/app/guru-lightspeed.html` → sign in with the Guru code → **Connect Lightspeed** → sign in to Lightspeed as the account owner → Allow. You land back on the page with "Connected".
4. **Copy the reference IDs** from that page into the Netlify variables in B (each ID has a Copy button and shows its variable name). Trigger a deploy.
5. **In Lightspeed Retail:**
   * Products → add four **non-inventory service products** with these SKUs: `NGH-ROOM` (Room booking, taxable), `NGH-DEPOSIT` (Refundable deposit, **No Tax**), `NGH-KARAOKE` (Karaoke add-on, $0), `NGH-EVENT` (Event registration, taxable). Price $0 — the website sends the amount.
   * Setup → Payment types → add **"Online — Stripe"** (type: Other). Its ID is `LIGHTSPEED_PAYMENT_TYPE_ONLINE`. The **On Account** type's ID is `LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT`.
   * Setup → On-account → **Yes, enable online payments** (lets you email Lightspeed Payments pay links for on-account sales).
   * Users → add a **"Website"** user; its ID is `LIGHTSPEED_USER_ID` so web sales are attributed to it.
   * Loyalty: Setup → Loyalty on, with your earn rate. The app shows it as "Earn X¢ for every $1".
6. **Sync the shop catalog:** guru-lightspeed page → **Sync catalog now** (then it runs every 30 minutes). Check `https://gamehaven.guru/app/shop.html`.
7. **Test with real money, small:** order-ahead a $1 item → Pay now → confirm a CLOSED sale appears in Sales history on the "Website" user and the pickup order appears at `/app/shop-orders.html`. Then a "Pay at pickup" order → Sell → Retrieve Sale shows `ORDER AHEAD ORD-…`.
8. **Turn on pay-on-account** when you're happy: set `window.NGH_LIGHTSPEED_ONACCOUNT = true;` in `site/ngh-config.js`, push. The Guru Console gets "🧾 Fee + deposit on account" buttons and approval emails get a "Put it on my Haven account" button. To collect: Lightspeed → Sell → Sales history → the on-account sale → **Email receipt with pay link**.
9. If a Lightspeed write fails (bad SKU, token expired), the payment still records on the website. Fix the cause, then guru-lightspeed → **Replay unsynced**.

Card payments still run through Stripe — X-Series has no API to take an online card payment. The Lightspeed-native alternative (eCom E-Series + Lightspeed Payments) is written up in NGH-LIGHTSPEED-INTEGRATION.md §8 as a phase-2 decision.

---

## D. Karaoke Battle

### D1. Songs (licensed content)
* **Today:** your own karaoke files. Put `Artist - Title.mp3` with a matching `.cdg` (MP3+G) or `.lrc` (synced lyrics) in `C:\NGH\karaoke\media` (subfolders fine). LRC files give the smoothest word-by-word highlight on TVs *and* phones. Buy from a source licensed for commercial use; public performance in the venue is covered by your PRO licences (ASCAP/BMI/SESAC).
* **KaraFun:** the venue subscription (KaraFun Business) has no catalog/lyrics API. KaraFun's **OEM & API** programme does (catalog, syllable-synced lyrics, audio, licensing handled by KaraFun) and explicitly allows a custom UX. Ask for it at business.karafun.com/oem — say you need catalog search, stream URLs, and syllable timings for a multi-screen venue battle app. The adapter hook is `site/app/karaoke/providers.js` + `KLyrics.fromKaraFun()`.

### D2. Rack PC service
1. Copy the `rack-player` folder from the drop to the rack PC (e.g. `Downloads\rack-player`). Double-click **INSTALL-KARAOKE-PLAYER.cmd**.
2. It installs to `C:\NGH\karaoke-player`, lists audio devices, and pauses. Edit `C:\NGH\karaoke-player\config.json`: `playerKey` = the Netlify `KARAOKE_PLAYER_KEY`, `adminCode` = Guru admin code, `audioDevice` = the `wasapi/…` line for **X-USB OUT 5-6**. Save, press a key — the NSSM service `ngh-karaoke-player` starts (log `C:\NGH\logs\karaoke-player.log`).
3. Import the library: `"C:\Program Files\nodejs\node.exe" C:\NGH\karaoke-player\ngh-karaoke-player.mjs import`. Re-run whenever you add songs. The host console shows the song count.

### D3. X32
* X-USB OUT 5-6 arrives on X32 **In 29/30** (Card 5/6, same Card 1–8 → In 25–32 routing as music/trivia). Label them **KARAOKE L/R**, pan L/R, assign to Main LR so every zone matrix gets it. Add a Companion button like the trivia strip setup.
* **Mics (as you have it):** the room that's performing sings on the **Shure wireless mics into the X32**, so the vocals ride Main LR out to every zone with the backing track — that's what the other rooms rate. The **two JBL Partybox mics in each room stay local** (cheering and commentary in that room only). Nothing in the software needs changing for this; keep the Shure channels un-muted during a battle and hand the two Shure handhelds to whichever room is up.

### D4. TVs (Google TV Streamers)
* Device names in the TV kiosk app map to rooms: `holt` → The Holt, `den`/`deck` → Stash's Den, `depths` → The Depths, `commons`/`raft`/`floor` → The Commons. Rename a TV with the remote's MENU button if needed. That name drives the "You're up next" and "Sing it" banners on each TV.
* Run a night: `https://gamehaven.guru/app/karaoke/host.html` → Guru code → pick rooms, team names, guest WiFi → **Create session** → **📺 Send to all TVs** → **🚀 Start battle** → **▶ Play next**. At the end, **Restore previous TV content** puts the slideshow back.
* Guests scan the TV QR (or `gamehaven.guru/karaoke`), pick their room, add songs, and get lyrics + voting on their phones.
* **Scoring, exactly:** one room performs; when the song ends, only participants in the **other** rooms get the star screen (the performing room's own members are blocked by the server). They rate that performance twice — song choice (1–5 ★ → up to 5 pts) and delivery (1–5 ★ × 2 → up to 10 pts) — and the points go to the performing room. Rooms are never rated against each other song-by-song; the scoreboard is just each room's running total. Default is one vote per participant; the host's Settings sheet can switch to "each room counts as one judge" instead.

---

## E. App stores

**Android (automatic build):** GitHub → Actions → **NGH App (Android)** runs on every push that touches `site/app/` or `capacitor/`. Download the `game-haven-debug-apk` artifact and sideload it to test. For Google Play:
1. Google Play Console ($25 one-time) → create app "Game Haven", package `guru.gamehaven.app`.
2. Create an upload keystore (Android Studio → Generate Signed Bundle, or `keytool`), then add repo secrets `ANDROID_KEYSTORE_B64` (base64 of the .jks), `ANDROID_KEYSTORE_PASS`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASS`. The action then also produces `game-haven-release-aab`.
3. Upload the AAB to internal testing. Play Console → App integrity → copy the **App signing SHA-256** into `site/.well-known/assetlinks.json` (replace the placeholder), push — QR links to gamehaven.guru/app/… will open the app.

**iPhone (needs a Mac):** Apple Developer Program ($99/yr) and a Mac with Xcode 26+ and Node 22+.
```
cd capacitor
npm install
npm run add:ios
npm run assets -- --ios
npx cap sync ios
npx cap open ios
```
In Xcode: Signing & Capabilities → your team → add **Associated Domains** `applinks:gamehaven.guru` → Product → Archive → Distribute → App Store Connect. Put your Team ID into `site/.well-known/apple-app-site-association` (replace `REPLACE_TEAMID`), push. Review tip: lead the App Store description with the native features (turn tracker haptics, live karaoke voting, rewards card, first-player chooser) — Apple rejects apps that look like a website wrapper.

**PWA (today, free):** `gamehaven.guru/app` → Share → Add to Home Screen (iPhone) or the Install prompt (Android).

---

## F. Specials

`https://gamehaven.guru/app/guru-specials.html` → add Food & Drink and Retail specials (image URL, dates, "show at counter" or "claim a one-time coupon" with a limit). Redeem coupons in the same page by typing or scanning the code. The "Order food" button appears when you set the partner URL in Settings.

---

## G. Local testing (optional)

From the repo root with Node 22 + Playwright installed: `node --test tests/` (Lightspeed, 36), `node tests/karaoke.e2e.mjs` (37), `node tests/companion.e2e.mjs` (135), `node tests/lyrics-cdg.test.mjs` (12), `node tests/specials.e2e.mjs` (46), `node tests/e2e-pages.mjs` (82). To click around the karaoke pages locally: `node --import ./tests/_register-karaoke.mjs tests/karaoke-harness.mjs` then open `http://localhost:8888/app/karaoke/host.html` (Guru code `1234`).

## H. Not built yet
Cleanup worth doing next build: `netlify/functions/_shared/auto-cancel.mjs`, `_shared/birthday.mjs` and `_shared/events.mjs` are stale copies of the real functions (their imports don't even resolve from `_shared/`), which is how the 09-10c guard ended up in the wrong file.

Push notifications · real food ordering (partner TBD; the button opens a URL) · KaraFun/Stingray content (adapters stubbed) · Lightspeed-processed online card payments (E-Series option, §8 of the Lightspeed spec) · Firebase realtime (only if Netlify function invocations get expensive; see architecture §9).
