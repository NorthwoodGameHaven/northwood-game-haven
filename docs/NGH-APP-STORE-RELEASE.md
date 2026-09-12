# Game Haven app — testing, Google Play, and the App Store
*NGH-BUILD 2026-09-12i. Package `guru.gamehaven.app`. Read with NGH-APP-SETUP.md Part E.*

## 0. Read this first — the two things that will actually cost you time

**iOS cannot be built on Windows.** Archiving and uploading to App Store Connect needs Xcode, which needs macOS. Your laptop is Windows, so iOS is blocked until you pick one of:

| Option | Cost | Notes |
|---|---|---|
| A Mac (Mac mini is the cheap end) | one-off | Simplest, and you own the build machine |
| **Codemagic / Bitrise** (macOS CI) | free tier, then ~$0.$$/min | **Recommended.** Builds and uploads to App Store Connect from a config file — no Mac in the building. Works from the same GitHub repo. |
| MacinCloud / MacStadium (rented Mac) | ~$25–80/mo | A remote desktop you drive by hand |

Android has no such constraint — the GitHub Action already builds it.

**Apple will scrutinise this app under Guideline 4.2 (Minimum Functionality).** A shell around a website gets rejected, and much of this app is exactly that. Be honest with yourself about the risk and lead with what is genuinely native:

* **Game Companion** — first-player randomiser, turn tracker with haptics, CCG life counters, RPG tools. These work as real app screens and are the strongest 4.2 defence.
* **Karaoke Battle** — live session join, on-device QR scan, star voting during a performance.
* **Rewards** — Lightspeed loyalty balance and purchase history.
* Haptics, deep links from the in-store TV QR codes, and the native browser sheet for non-app pages.

Write the App Store description around those, take the screenshots from those screens, and do **not** show the booking form or the marketing pages in the first three screenshots. If it gets rejected on 4.2, the fix is more native surface, not an appeal.

---

## 1. Test the Android build today (free, no accounts)

1. GitHub → **Actions** → **NGH App (Android)** → the latest green run.
2. Download the **`game-haven-debug-apk`** artifact, unzip it.
3. Copy the `.apk` to an Android phone and open it. Allow "install unknown apps" when prompted.
4. It builds automatically on every push touching `site/app/**` or `capacitor/**`, and you can start one by hand with **Run workflow**.

What to check on the phone, in rough priority:

* Game Companion → turn tracker: two phones joining the same code, colours, **haptics on end-turn** (this is the native bit).
* Karaoke → join a session, then **Scan** — the camera QR scanner. *This was broken before NGH-BUILD 2026-09-12i: `CAMERA` was missing from the manifest, so `getUserMedia` failed silently in the packaged app while the same page worked in a mobile browser. Typing the code always worked.*
* Tap a `gamehaven.guru/app/…` link from a text message — it should open **in the app**, not the browser. If it opens the browser, App Links aren't verified yet: that needs step 2.4 below.
* Rewards sign-in, Specials, the libraries, and that non-app links open the in-app browser sheet rather than leaving the app.

---

## 2. Google Play

**2.1 Account.** play.google.com/console — **$25 one-time**. Register as an organisation if the store is a legal entity; that requires a D-U-N-S number and takes longer, so register as yourself if you want to move now.

**2.2 Upload keystore.** Generate once and never lose it — losing it means you can never update the app under the same listing.

```
keytool -genkey -v -keystore ngh-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias ngh
```

Back the `.jks` up somewhere that isn't the laptop. Then add four repo secrets (GitHub → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | `certutil -encode ngh-upload.jks tmp.b64` then strip the header/footer lines |
| `ANDROID_KEYSTORE_PASS` | keystore password |
| `ANDROID_KEY_ALIAS` | `ngh` |
| `ANDROID_KEY_PASS` | key password |

The workflow already checks for these and produces `game-haven-release-aab` when they exist.

**2.3 Create the app.** Play Console → Create app → "Game Haven", package `guru.gamehaven.app`, App, Free. Then upload the AAB to **Internal testing** first — it reaches your own devices in minutes and doesn't need full review.

**2.4 Verify App Links** (this is what makes the in-store TV QR codes open the app). After the first upload: Play Console → **App integrity → App signing** → copy the **SHA-256 certificate fingerprint** → paste it into `site/.well-known/assetlinks.json` replacing the placeholder → push. Re-install the app and re-test a link.

**2.5 Store listing.** You need:

* App icon **512×512** PNG, feature graphic **1024×500**
* At least 2 phone screenshots (16:9 or 9:16, min 320px); a 7" and 10" tablet set if you want tablet distribution
* Short description (80 chars) and full description (4000)
* **Privacy policy URL** — mandatory. `gamehaven.guru/privacy` needs to exist and cover what's below.

**2.6 Data safety form.** Declare honestly — mis-declaring is the most common cause of a rejected update. This app collects:

| Data | Why | Notes |
|---|---|---|
| Name, email, phone | bookings, event registrations, pickup orders | linked to the user |
| Purchase history / loyalty balance | rewards account (Lightspeed) | linked to the user |
| Camera | QR scanning only | **not** stored or transmitted — say so |
| No location, no ads, no analytics SDKs | | |

Payments go to **Stripe**, not through Play Billing. That's allowed: physical goods and real-world services (room bookings, event tickets, in-store pickup) are explicitly exempt from Play Billing. Say "physical goods and services" if asked.

**2.7 Content rating** — fill in the IARC questionnaire. Expect Everyone / PEGI 3 unless you declare user-to-user content; karaoke song titles and team names are user-generated text, so answer that question truthfully (it usually lands at Everyone 10+ / PEGI 7 with a "users interact" note).

---

## 3. Apple App Store

**3.1 Account.** developer.apple.com — **$99/year**. Organisation enrolment needs a D-U-N-S number; individual enrolment is immediate.

**3.2 Build.** Either on a Mac (`npm run add:ios` then `npx cap open ios`) or via macOS CI. In Xcode: Signing & Capabilities → your team → add **Associated Domains** → `applinks:gamehaven.guru`. Product → Archive → Distribute → App Store Connect.

**3.3 Universal Links.** Put your **Team ID** into `site/.well-known/apple-app-site-association`, replacing `REPLACE_TEAMID`, and push. That file must be served as `application/json` with no extension — `netlify.toml` already handles it, but verify at `https://gamehaven.guru/.well-known/apple-app-site-association` after deploy.

**3.4 Assets.** 1024×1024 icon (no alpha, no rounded corners), screenshots for **6.9"** and **6.5"** iPhone at minimum. iPad screenshots only if you claim iPad support — don't, unless you've tested it.

**3.5 Privacy nutrition labels** — same disclosure as the Play data-safety form, plus an explicit **`NSCameraUsageDescription`** string in `Info.plist`. Word it for a human: *"Game Haven uses the camera only to scan QR codes for joining Karaoke Battle and redeeming specials."* A missing or vague camera string is an automatic rejection.

**3.6 Review notes.** Give the reviewer a demo path, because most of the value is behind a live session. Include: a test Guru code if you're willing, or a note that Karaoke Battle needs an in-store session and pointing them at Game Companion instead. Reviewers reject what they cannot reach.

---

## 4. Before either submission

- [ ] `site/.well-known/assetlinks.json` has the real Play signing SHA-256
- [ ] `site/.well-known/apple-app-site-association` has the real Team ID
- [ ] A privacy policy exists at a public URL and matches both forms
- [ ] `stash2026` is gone from `ngh-config.js` (see the 2026-09-12 findings doc) — a published staff code is a bad look in a store review
- [ ] Version bumped in `capacitor/package.json`; Android `versionCode` must increase on every Play upload
- [ ] Test on a real phone, not just the emulator — especially haptics, the camera scan, and deep links

## 5. Honest status

| | State |
|---|---|
| Android debug APK | ✅ building in CI now, sideloadable today |
| Android release AAB | ⏳ needs the keystore secrets (2.2) |
| Google Play listing | ⏳ needs account, assets, privacy policy |
| iOS build | ❌ blocked on a Mac or macOS CI |
| App Store listing | ❌ blocked behind the iOS build |
| Camera QR in the packaged app | ✅ fixed in 2026-09-12i — untested on a real device |
| App Links / Universal Links | ⏳ placeholders still in both well-known files |
