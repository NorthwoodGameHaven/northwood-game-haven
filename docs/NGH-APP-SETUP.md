# NGH App — Deploy & Setup Runbook
*NGH-BUILD 2026-09-11a · NGH App (PWA + iOS/Android), Karaoke Battle, Game Companion, Specials, Lightspeed X-Series. Specs: NGH-APP-ARCHITECTURE.md, NGH-LIGHTSPEED-INTEGRATION.md.*

Work top to bottom. Parts A–B go live with one push and change nothing customers see until you use the new pages. Parts C–F are independent; do them in any order.

---

## A. Deploy (Standard Drop Protocol)

**1. Extract the newest zip** (PowerShell):
```powershell
$d="$env:USERPROFILE\Downloads\ngh-drop"; Remove-Item $d -Recurse -Force -EA 0; New-Item -ItemType Directory $d | Out-Null; $z=Get-ChildItem "$env:USERPROFILE\Downloads\*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1; Expand-Archive $z.FullName $d; "Using $($z.Name)"
```
It must print `Using NGH-APP-2026-09-11a.zip`.

**2. Pull, move, patch, verify** — from the repo root (e.g. `C:\NGH\site-repo`), in Command Prompt:
```
git pull origin main --no-rebase
%USERPROFILE%\Downloads\ngh-drop\DEPLOY-2026-09-11a.cmd
```
The script moves all 84 files into place with explicit `move /Y` lines, runs `node patches\patch-app-2026-09-11a.cjs` (booking.html + events.html; aborts file-untouched on any anchor miss), then runs `findstr /M /C:"NGH-BUILD 2026-09-11a"` over the 70 touched text files. **Every filename must print.** The 16 files that can't carry a marker (PNG icons/assets, four JSON files, two test fixtures) are checked for existence instead.

**3. GitHub Desktop:** expect **86 changed files** (76 new + 8 replaced + booking.html + events.html). Commit `NGH-BUILD 2026-09-11a — NGH App, Karaoke Battle, Game Companion, Specials, Lightspeed`, push.

**4. After Netlify shows Published:** open `https://gamehaven.guru/app/` → Ctrl+U → search `NGH-BUILD 2026-09-11a`. Then open `https://gamehaven.guru/app/karaoke/tv.html` and `https://gamehaven.guru/api/karaoke/time` (should return `{"serverNow":…}`).

The push also starts the **NGH App (Android)** GitHub Action (see E). It doesn't affect the website.

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

## B. Netlify environment variables

Site settings → Environment variables. Add, then **Deploys → Trigger deploy** so functions pick them up.

| Variable | Value | Needed for |
|---|---|---|
| `KARAOKE_PLAYER_KEY` | any long random string (same value goes in the rack PC config) | Rack player heartbeat + CD+G uploads |
| `KARAOKE_WIFI_SSID` / `KARAOKE_WIFI_PASS` | guest WiFi (optional — the host console can set it per session) | WiFi QR on the TVs |
| `LIGHTSPEED_CLIENT_ID` | from the dev portal (Online Booking app) | Lightspeed OAuth |
| `LIGHTSPEED_CLIENT_SECRET` | **the regenerated secret** (see C1) | Lightspeed OAuth |
| `LIGHTSPEED_OUTLET_ID`, `LIGHTSPEED_REGISTER_ID`, `LIGHTSPEED_USER_ID`, `LIGHTSPEED_PAYMENT_TYPE_ONLINE`, `LIGHTSPEED_PAYMENT_TYPE_ONACCOUNT`, `LIGHTSPEED_TAX_ID`, `LIGHTSPEED_TAX_ID_NONE` | copy from `/app/guru-lightspeed.html` after connecting (C4) | Sales, order-ahead, on-account |

`LIGHTSPEED_DOMAIN`, `LIGHTSPEED_TOKEN`, `LOYALTY_GROUP_DISCOUNTS` stay as they are. If `LIGHTSPEED_TOKEN` is already a working personal token, everything below works with it and C3 is optional.

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
* **Decision needed — singers over the PA.** As designed, each room's two mics play only through that room's JBL Partybox, so other rooms hear the backing track but not the singers. To let everyone judge "delivery", patch each Partybox's line/aux out (or its mic receiver) into a spare X32 input per room and add a Companion "ACTIVE ROOM" mute group the host flips when that room is up. The software doesn't care either way.

### D4. TVs (Google TV Streamers)
* Device names in the TV kiosk app map to rooms: `holt` → The Holt, `den`/`deck` → Stash's Den, `depths` → The Depths, `commons`/`raft`/`floor` → The Commons. Rename a TV with the remote's MENU button if needed. That name drives the "You're up next" and "Sing it" banners on each TV.
* Run a night: `https://gamehaven.guru/app/karaoke/host.html` → Guru code → pick rooms, team names, guest WiFi → **Create session** → **📺 Send to all TVs** → **🚀 Start battle** → **▶ Play next**. At the end, **Restore previous TV content** puts the slideshow back.
* Guests scan the TV QR (or `gamehaven.guru/karaoke`), pick their room, add songs, and get lyrics + voting on their phones.

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
