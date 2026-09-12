# Getting the Game Haven app onto Google Play
*NGH-BUILD 2026-09-12m. Package `guru.gamehaven.app`. Follow it top to bottom.*

Nothing here needs a Mac. Everything builds in GitHub Actions; your laptop only generates one file and does some typing.

**Rough timing:** Parts 1–2 are about 20 minutes and you can do them right now. Part 3 (the Play account) has a **verification wait of a few days** — start it first if you want to move fast. Part 6 is the actual upload, ~30 minutes.

---

## Part 0 — What you need before you start

| | |
|---|---|
| A Google account for the store | Use a business one, not personal — you cannot transfer a listing between accounts easily |
| **$25**, one time | Play Console registration |
| A phone to test on | Any Android device |
| ~30 min at a keyboard | Plus the verification wait |

> **The single most important thing in this document:** in Part 2 you create a file called `ngh-upload.jks`. **If you lose it, you can never update the app again under this listing.** Not "it's difficult" — you would have to publish a brand new app and every install would be orphaned. Back it up in two places before you do anything else with it.

---

## Part 1 — Test what you already have (10 minutes, free, no accounts)

Do this first. It proves the build works before you spend money.

1. Go to **github.com/NorthwoodGameHaven/northwood-game-haven** → **Actions** tab.
2. Left sidebar → **NGH App (Android)**.
3. **Run workflow** button (right side) → branch `main` → green **Run workflow**.
4. Wait ~5–8 minutes. Click into the run when it goes green.
5. Scroll to **Artifacts** at the bottom → download **`game-haven-debug-apk`**.
6. Unzip it. You'll get `app-debug.apk`.
7. Get it onto your phone — email it to yourself, or drop it in Google Drive and open it there.
8. Tap it. Android will say "you can't install unknown apps" → **Settings** → allow for that app → back → **Install**.

**Now actually test it.** In rough priority:

- **Game Companion → Turn tracker.** Two phones on the same code. Check the **haptic buzz on end-turn** — that's native, and it's your best defence if Apple ever pushes back on "this is just a website".
- **Karaoke → join a session → Scan.** The camera QR scanner. *This was broken before 2026-09-12i — `CAMERA` was missing from the manifest, so it failed silently in the packaged app while working fine in a mobile browser. Never been tested on a real device.*
- **Speed Gaming** and **Magic** — new screens, first time in the app.
- **Trivia → Join.** Should open the player **inside the app**, no browser address bar. New in 2026-09-12l.
- Text yourself a `gamehaven.guru/app/...` link and tap it. It should open **in the app**. If it opens the browser, App Links aren't verified yet — that's Part 7, expected.

---

## Part 2 — Create the upload key (10 minutes, do it once, never again)

You need Java's `keytool`. Check first — open **PowerShell** and run:

```powershell
keytool -help
```

If that errors, install a JDK: `winget install EclipseAdoptium.Temurin.21.JDK`, then **close and reopen PowerShell**.

Now create the key. Run this in a folder you'll remember (`cd ~\Documents`):

```powershell
keytool -genkey -v -keystore ngh-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ngh
```

It will ask you things:

| Prompt | What to type |
|---|---|
| Enter keystore password | A strong password. **Write it down.** You need it forever |
| Re-enter | Same |
| First and last name | `Northwood Game Haven` |
| Organizational unit | Leave blank, press Enter |
| Organization | `Northwood Game Haven` |
| City, State | `Chippewa Falls`, `WI` |
| Two-letter country code | `US` |
| Is CN=... correct? | `yes` |
| Key password for `<ngh>` | **Press Enter** to reuse the keystore password. Simpler, and one less thing to lose |

### Back it up now, before anything else

1. Copy `ngh-upload.jks` to **Google Drive** (or wherever your business files live — not just the laptop).
2. Put the **password** in your password manager, labelled `NGH Android upload keystore`.
3. Ideally a third copy on a USB stick in the shop safe.

I am not exaggerating about this. Losing it is unrecoverable.

### Turn it into a GitHub secret

Base64-encode the keystore so it can live in a secret:

```powershell
certutil -encode ngh-upload.jks tmp.b64
notepad tmp.b64
```

In Notepad: **delete the first line** (`-----BEGIN CERTIFICATE-----`) and **the last line** (`-----END CERTIFICATE-----`). Keep everything between. **Ctrl+A, Ctrl+C.**

Then in GitHub: repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, four times:

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | the text you just copied |
| `ANDROID_KEYSTORE_PASS` | your keystore password |
| `ANDROID_KEY_ALIAS` | `ngh` |
| `ANDROID_KEY_PASS` | same password (if you pressed Enter above) |

Delete `tmp.b64` when you're done — it's your signing key in text form.

**Check it worked:** Actions → NGH App (Android) → Run workflow. When it finishes there should now be **two** artifacts: the debug APK *and* `game-haven-release-aab`. That `.aab` is what Play wants.

---

## Part 3 — Play Console account ($25, then a wait)

1. **play.google.com/console** → sign in → **Create developer account**.
2. **Choose the account type carefully:**
   - **Organization** — needs a **D-U-N-S number** (free from Dun & Bradstreet, takes 1–2 weeks). The listing says "Northwood Game Haven".
   - **Personal** — immediate, listing says your name.
   
   You can change it later but it's fiddly. If you want the store's name on the listing and can wait, go Organization. If you want the app in testers' hands this month, go Personal.
3. Pay the **$25**.
4. **Identity verification** — Google will ask for ID and, for organizations, business documents. **This takes a few days to a couple of weeks.** You can build the listing while you wait; you just can't publish.

---

## Part 4 — Before you upload, three things must be true

### 4.1 The privacy policy must be live

Play will not accept a listing without one, and the Data Safety form is checked against it.

**I wrote it: `site/privacy.html`.** Once deployed it's at **`https://gamehaven.guru/privacy`**.

**Read it before you publish.** It describes what the app actually does — name/email/phone for bookings, Stripe for payments, Lightspeed for rewards, camera for QR only, no location, no ads, no analytics. If any of that isn't true of how you run things, change the page, not the form.

### 4.2 Bump the version before every upload

Play rejects any upload whose `versionCode` isn't higher than the last — and it tells you *after* the upload finishes, wasting a build.

**One thing to remember:** edit `capacitor/package.json`, change `"version"`. That's it. The build derives everything:

| package.json version | versionCode |
|---|---|
| `1.0.0` | 10000 |
| `1.0.1` | 10001 |
| `1.1.0` | 10100 |

*(Capacitor hardcodes `versionCode 1`, which would have made your second upload fail. The build now stamps it from package.json — added 2026-09-12m.)*

### 4.3 Store assets

| Asset | Spec | Notes |
|---|---|---|
| App icon | **512×512** PNG, no transparency | The crest on the forest-green background |
| Feature graphic | **1024×500** PNG | Banner at the top of the listing. No small text — it gets scaled down hard |
| Phone screenshots | **at least 2**, up to 8 | Take these on a real phone |
| Short description | ≤ 80 characters | |
| Full description | ≤ 4000 characters | |

**Which screenshots.** Lead with what's genuinely native, not the website parts:

1. Game Companion — turn tracker mid-game
2. Karaoke Battle — the voting screen or the live session
3. Speed Gaming — the "you're at table 3, with Ann, against Bo & Cy" screen
4. Rewards — the balance
5. Magic night — the big event code

Do **not** lead with the booking form or the marketing pages.

**Suggested copy:**

> **Short:** `Your table, your team, your rewards — Northwood Game Haven in your pocket.`

> **Full:** Game Haven is the companion app for Northwood Game Haven in Chippewa Falls. Track turns and life totals with built-in game tools. Join Karaoke Battle, vote on performances and race the buzzer. Get paired up at the Speed Gaming Meet-up and see your table, partner and opponents on your phone. Play along with Team Trivia. Check your rewards balance, browse tonight's events, and order ahead for pickup.

---

## Part 5 — Create the app listing

Play Console → **Create app**.

| Field | Value |
|---|---|
| App name | `Game Haven` |
| Default language | English (United States) |
| App or game | **App** |
| Free or paid | **Free** |
| Declarations | Tick both (Play policies, US export laws) |

Then work down the **Dashboard** checklist. The ones with real decisions:

### Data safety — the one people get wrong

Mis-declaring is the top cause of rejected updates. Declare exactly this:

| Question | Answer |
|---|---|
| Does your app collect or share user data? | **Yes** |
| Is data encrypted in transit? | **Yes** |
| Can users request deletion? | **Yes** — `stash@northwoodgamehaven.com` |

Data types to tick:

- **Personal info → Name, Email address, Phone number** — Collected, not shared. Purpose: *App functionality*, *Account management*. **Required.**
- **Financial info → Purchase history** — Collected, not shared. Purpose: *App functionality*. Optional.
- **Photos and videos → Photos** — ⚠️ **Do NOT tick this.** The camera is used for live QR scanning only; nothing is stored or transmitted, so it is not "collected". Google's own guidance says on-device-only processing isn't collection.

Do **not** tick: Location, Contacts, Messages, Files, Health, App activity/analytics, Device IDs for advertising.

### App content

- **Ads:** No.
- **Content rating:** fill in the IARC questionnaire. Answer **yes** to user-generated content — karaoke song titles, team names and player names are typed by users and shown on screens. Expect Everyone or Everyone 10+.
- **Target audience:** 13+. Not "designed for families" — that opens extra requirements you don't need.
- **Government app:** No. **Financial features:** No.
- **Privacy policy:** `https://gamehaven.guru/privacy`

### Payments

If asked why you don't use Play Billing: **physical goods and real-world services**. Room bookings, event tickets and in-store pickup are explicitly exempt. Stripe is correct here and Google's policy allows it.

---

## Part 6 — Upload and get it on your phone

Start with **Internal testing** — it reaches your devices in minutes and skips full review.

1. **Testing** → **Internal testing** → **Create new release**.
2. **Play App Signing** — accept it. Google holds the real signing key; yours is the *upload* key. This is what makes a lost upload key merely painful rather than fatal, but back it up anyway.
3. **Upload** the `.aab` from the `game-haven-release-aab` artifact.
4. Release name fills itself in. Release notes: `First internal build — Speed Gaming, Karaoke Battle, Game Companion, Rewards.`
5. **Next** → **Start rollout to Internal testing**.
6. **Testers** tab → create an email list → add your own address and anyone else's → **Save**.
7. Copy the **opt-in URL**, open it on your phone, **Become a tester**, then install from Play.

Installing from Play (rather than sideloading) is what makes App Links work — do this before Part 7.

---

## Part 7 — Make the TV QR codes open the app

Right now `gamehaven.guru/app/...` links open the browser. To fix that, Google needs proof the app and the domain belong together.

1. Play Console → **Test and release** → **Setup** → **App integrity** → **App signing** tab.
2. Under **App signing key certificate**, copy the **SHA-256 certificate fingerprint** (long, colon-separated hex).
3. Open `site/.well-known/assetlinks.json` in the repo. Replace:
   ```
   "REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FROM_PLAY_CONSOLE"
   ```
   with your fingerprint in quotes. Keep the colons.
4. Commit and push. Wait for Netlify.
5. Check it: open `https://gamehaven.guru/.well-known/assetlinks.json` — you should see your fingerprint, served as JSON.
6. **Uninstall and reinstall the app** from Play. Verification happens at install time.
7. Test: text yourself `https://gamehaven.guru/app/karaoke/join.html` and tap it. It should open in the app.

---

## Part 8 — Going public

Once internal testing feels right:

**Production** → **Create new release** → same AAB → roll out.

First review takes **a few days to two weeks** for a new developer account. Later updates are usually hours.

If it's rejected, the reason is in the Play Console inbox and is usually specific. The two likely ones:

- **Data safety mismatch** — the form says something the privacy page doesn't. Fix whichever is wrong.
- **Minimum functionality** — rare on Android (this is an Apple obsession), but if it happens, point at Game Companion, the karaoke buzzer and Speed Gaming, and add screenshots of those.

---

## Checklist

- [ ] Debug APK installed and tested on a real phone (Part 1)
- [ ] `ngh-upload.jks` created and **backed up in two places**
- [ ] Four GitHub secrets set; the release AAB builds
- [ ] Play Console account paid for and verified
- [ ] `https://gamehaven.guru/privacy` is live and you've read it
- [ ] Version bumped in `capacitor/package.json`
- [ ] Icon, feature graphic, 2+ screenshots
- [ ] Data safety form matches the privacy page
- [ ] Content rating done
- [ ] Internal testing release live, installed from Play on your phone
- [ ] `assetlinks.json` has the real SHA-256; App Links verified
- [ ] Camera QR scan tested on a real device *(never yet tested)*

## Where iOS stands

Blocked on macOS — Apple requires Xcode to archive and upload, full stop. When you want it: **Codemagic** builds and uploads from this same repo without a Mac in the building. Apple is also far stricter on Guideline 4.2 (minimum functionality), so lead the App Store listing with Game Companion and the karaoke buzzer, and never with the booking form. Details in `NGH-APP-STORE-RELEASE.md`.
