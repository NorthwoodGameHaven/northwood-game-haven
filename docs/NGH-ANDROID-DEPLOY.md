# Getting the Game Haven app onto Google Play
*NGH-BUILD 2026-09-12z. Package `guru.gamehaven.app`. Follow it top to bottom.*

Nothing here needs a Mac. Everything builds in GitHub Actions; your laptop only generates one file and does some typing.

**Rough timing:** Parts 1–2 are about 20 minutes and you can do them right now.
Part 6 is the actual upload, ~30 minutes.

**Where you are (2026-09-12):** D-U-N-S, a verified **organization** Play
Console account, the upload key, the four GitHub secrets, account deletion and
the review account are all done. **The signed release AAB builds** — run #9 at
`62c23e8` produced both `game-haven-debug-apk` and `game-haven-release-aab`,
with the log confirming `Keystore decoded: 2786 bytes`.

Because the account is an organization, there is **no closed-testing wait** —
you can publish straight to production. What is left is: test the debug APK on
a real phone (it has still never run on one), then create the app in Play
Console and paste in the listing.

> **Careful with "Re-run all".** A re-run replays the ORIGINAL run's commit, not
> the latest. Re-running an old run on 2026-09-12 rebuilt a commit that was 23
> commits and 142 files behind `main` — it succeeded, and the artifacts were
> useless. To build current code, always use **Run workflow** on the workflow's
> own page, and check the run header shows the commit you expect.

Nothing left is waiting on anyone else — it is all work you control.

---

## Part 0 — What you need before you start

| | |
|---|---|
| ~~A Google account for the store~~ | ✅ `northwoodexperiences@gmail.com` |
| ~~**$25**, one time~~ | ✅ paid, account verified |
| A phone to test on | Any Android device — **the app has still never run on one** |
| ~30 min at a keyboard | No waiting left; see Part 3 |

> **The single most important thing in this document:** in Part 2 you create a file called `ngh-upload.jks`. **If you lose it, you can never update the app again under this listing.** Not "it's difficult" — you would have to publish a brand new app and every install would be orphaned. Back it up in two places before you do anything else with it.

---

## Part 1 — Get the app onto your phone and actually use it

*The build works (run #9). This is the step that has never been done: the app
has never run on real hardware.*

### 1a. Download the APK — on the laptop, not the phone

GitHub only lets a signed-in account download artifacts, and it hands them over
as a **ZIP**. Android cannot install a ZIP. So: laptop first.

1. Open the run:
   **github.com/NorthwoodGameHaven/northwood-game-haven/actions** → **NGH App
   (Android)** → the newest run with a green tick. Check the commit next to the
   branch name is the one you expect.
2. Scroll to the very bottom — **Artifacts**.
3. Click **`game-haven-debug-apk`**. You get `game-haven-debug-apk.zip` in
   Downloads.
4. **Right-click it → Extract All → Extract.** Inside is **`app-debug.apk`**.
   That is the file you want. If you skip this and send the ZIP to your phone,
   Android will just shrug at it.

> Use the **debug** APK for this, not the release AAB. An `.aab` is not an app —
> it is a bundle Google opens and turns into per-device APKs. Nothing but Play
> can install it.

### 1b. Get it to the phone

Any of these; pick whichever you already have open.

| | How |
|---|---|
| **Google Drive** *(easiest)* | Upload `app-debug.apk` to Drive on the laptop → open the Drive app on the phone → tap the file |
| **USB cable** | Plug in, set the phone to **File transfer**, drop the APK into `Downloads`, then open **Files** on the phone |
| **Email** | Send it to yourself. Gmail may block a `.apk` attachment — if it does, use Drive |
| **Quick Share** | Windows 11 → right-click → Share → Quick Share, if your phone supports it |

### 1c. Install it

1. Tap `app-debug.apk` on the phone.
2. Android blocks it: **"For your security, your phone is not allowed to install
   unknown apps from this source."** Tap **Settings** → turn on **Allow from
   this source** → press **Back**. *(The permission attaches to the app you
   tapped from — Drive, Files, Chrome — so if you switch methods later you will
   be asked again.)*
3. Tap **Install**.
4. **Play Protect will probably warn you: "Unsafe app blocked" or "App scan
   recommended".** Tap **More details** → **Install anyway**. This is normal and
   expected — the APK is signed with a debug key, not your upload key, so Google
   has never seen it before. It is not a sign anything is wrong.
5. Open **Game Haven** from the app drawer.

> ### Uninstall the old build before every new one
>
> Not just before installing from Play — **between every CI build too.**
>
> A debug APK is signed with Android's throwaway debug key, and a GitHub runner
> is a fresh machine each time, so it generates a **new debug key on every run**.
> Two debug APKs from two different runs therefore have different signatures,
> and Android will not install one over the other. You get **"App not
> installed"** with no explanation of why.
>
> So the loop is always: **uninstall → install**, never install-over-the-top.
>
> **To uninstall:** long-press the **Game Haven** icon → **Uninstall** (on some
> launchers: → **App info** → **Uninstall**). Or **Settings → Apps → Game
> Haven → Uninstall**.
>
> The same signature rule is why you must uninstall before your first install
> from Play — that build is signed with your upload key, different again.

### 1d. What to actually test

Two lists, because half of this needs something running at the Haven.

**Works anywhere, no session needed — do these first:**

- [ ] The app opens without a white screen or a browser address bar
- [ ] **Game Companion → Who goes first** — several fingers on the screen, one wins
- [ ] **Game Companion → Life counter** — 2–6 players, 20/30/40, Commander damage, undo
- [ ] **Game Companion → RPG tools** — build a dice formula, roll, advantage/disadvantage
- [ ] **Turn tracker on two phones** — same code on both; the **haptic buzz on end-turn** is the single most important native behaviour in the app
- [ ] **Rewards** — sign in with your own email and the code you are emailed. Balance, customer code and QR should render
- [ ] **Specials**, **Shop**, the **libraries** and **tonight's events** all load
- [ ] Turn on **airplane mode** and reopen Game Companion — the tools must still work. That is the offline promise on the store listing
- [ ] Nothing scrolls sideways on any screen

**⚠️ The one that has never worked on a device:**

- [ ] **Karaoke → Join → Scan.** Does the camera actually open and ask permission?
      *`CAMERA` was missing from the manifest until 2026-09-12i, so this failed
      silently in the packaged app while working perfectly in a mobile browser.
      You do not need a valid QR code to test it — you only need the camera
      view to appear. If it does nothing, that is the bug back again.*

**Needs a live session — start one from the Guru console:**

- [ ] **Speed Gaming** — check in, see a table/partner/opponents and the countdown
- [ ] **Magic night** — the event code and pairings link
- [ ] **Trivia → Join** — must open **inside the app**, with no browser address bar

**Expected to FAIL for now, do not chase it:**

- [ ] Text yourself `https://gamehaven.guru/app/karaoke/join.html` and tap it. It
      will open the **browser**, not the app. App Links need the Play signing
      SHA-256 in `assetlinks.json`, which does not exist until after your first
      upload — that is Part 7.

Anything broken here is far cheaper to find now than after a reviewer finds it.

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

It asks eight things, **one per line**. Answer them in this exact order — the
prompts do not say what format they want, and an answer in the wrong box ends
up baked into the certificate:

| # | Prompt (exact wording) | What to type |
|---|---|---|
| 1 | `Enter keystore password` | A strong password. **Nothing appears as you type** — no dots, no asterisks. That is normal. **Write it down first.** |
| 2 | `Re-enter new password` | The same thing, also invisible |
| 3 | `What is your first and last name?` | `Northwood Experiences` |
| 4 | `What is the name of your organizational unit?` | *(nothing — just press Enter)* |
| 5 | `What is the name of your organization?` | `Northwood Experiences LLC` |
| 6 | `What is the name of your City or Locality?` | `Chippewa Falls` — **city only, no state** |
| 7 | `What is the name of your State or Province?` | `WI` |
| 8 | `What is the two-letter country code for this unit?` | `US` — the country, **not** yes/no |
| 9 | `Is CN=… correct?` | `yes` — *this* is the yes/no one |
| 10 | `Enter key password for <ngh>` | **Press Enter** to reuse the keystore password. One less thing to lose |

> **Read line 9 back before you type `yes`.** It should say:
> `CN=Northwood Experiences, OU=Unknown, O=Northwood Experiences LLC, L=Chippewa Falls, ST=WI, C=US`
>
> If it says `ST=US, C=yes`, the answers have slipped one box down — type `n`
> and it walks you through again with your previous answers as defaults. Google
> never validates this, so a mangled name will not block anything, but it is
> stamped into your upload certificate permanently and it is thirty seconds to
> get right.

### Back it up now, before anything else

1. Copy `ngh-upload.jks` to **Google Drive** (or wherever your business files live — not just the laptop).
2. Put the **password** in your password manager, labelled `NGH Android upload keystore`.
3. Ideally a third copy on a USB stick in the shop safe.

I am not exaggerating about this. Losing it is unrecoverable.

> **And the other half of that sentence: do not send it anywhere.** Not into a
> chat, not by email, not to a contractor, not to me. The only places it
> belongs are your own backups and — as base64 — the GitHub secret. Anyone with
> the file *and* the password can sign an update as you.
>
> If it does get out before you have published anything, the fix is free:
> delete it, run `keytool` again, and replace the secret. Once the app is live
> on Play you can still rotate an upload key, but it means a support request to
> Google, so the cheap moment is now.

### Turn it into a GitHub secret

Base64-encode the keystore so it can live in a secret. **Use this, not
`certutil`** — one line, straight to your clipboard, no header lines to delete
and no Windows line endings to go wrong:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\ngh-upload.jks")) | Set-Clipboard
```

Nothing is printed. Check it actually landed:

```powershell
(Get-Clipboard).Length
```

**Expect roughly 3,700.** A small number — 22, 40, whatever — means
`Set-Clipboard` did not take and the clipboard still holds whatever you copied
last (quite possibly the password you just pasted into `keytool`). Do not paste
that into GitHub. Use the file route instead, which never touches the
clipboard and tells you the real length:

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Documents\ngh-upload.jks"))
$b64.Length
Set-Content -Path "$HOME\Documents\ngh-b64.txt" -Value $b64 -NoNewline
notepad "$HOME\Documents\ngh-b64.txt"
```

`$b64.Length` is the truth — it is the string itself, not the clipboard. In
Notepad: **Ctrl+A, Ctrl+C**, paste into the secret, then **delete
`ngh-b64.txt`** — it is your signing key in plain text.

> *Why not `certutil -encode`?* It wraps the output in
> `-----BEGIN CERTIFICATE-----` lines you have to delete by hand, and it writes
> **CRLF** line endings. The Linux build runner decodes with GNU `base64 -d`,
> which rejects carriage returns outright — the build died with a bare
> `base64: invalid input`. The workflow now strips whitespace before decoding
> and checks the result really is a keystore, so either method works, but the
> PowerShell line avoids the whole problem *(NGH-BUILD 2026-09-12ac)*.

> ### These four go in GitHub, **not** Netlify
>
> This project has two separate places for secrets and it is genuinely easy to
> put a value in the wrong one — especially right after setting
> `PLAY_REVIEW_EMAIL` and `PLAY_REVIEW_CODE`, which *do* live in Netlify.
>
> | | What belongs there | Why |
> |---|---|---|
> | **Netlify** env vars | Anything the **website or a Netlify Function** reads at runtime — `ADMIN_SECRET`, `LIGHTSPEED_*`, `PLAY_REVIEW_*` | Netlify runs the site |
> | **GitHub** Actions secrets | Anything the **Android build** needs — the four `ANDROID_*` below | GitHub Actions builds the app; Netlify never touches it |
>
> Put the `ANDROID_*` four in Netlify and nothing breaks loudly — the workflow's
> `if: env.KS != ''` guard just finds an empty secret, skips the signing step,
> and hands you a debug APK with no release AAB and no error to explain why.
>
> It is also the wrong place for the keystore on its own terms: a Netlify
> variable is readable by every build and every serverless function at runtime,
> and unless you tick "secret" it is visible in the Netlify UI as plain text.
> If you have already added them there, **delete all four from Netlify.**

Then in GitHub: repo → **Settings** → **Secrets and variables** → **Actions** →
**Repository secrets** tab → **New repository secret**, four times:

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | the text you just copied |
| `ANDROID_KEYSTORE_PASS` | your keystore password |
| `ANDROID_KEY_ALIAS` | `ngh` |
| `ANDROID_KEY_PASS` | same password (if you pressed Enter above) |

Clear your clipboard afterwards (copy anything else) — it currently holds
your signing key in text form. If you did use `certutil` and made a
`tmp.b64`, delete that file too.

**Check it worked:** Actions → NGH App (Android) → **Run workflow** (on the
workflow's page, not inside a run). When it finishes there should be **two**
artifacts: the debug APK *and* `game-haven-release-aab`. That `.aab` is what
Play wants. The signing step prints `Keystore decoded: N bytes` when the
secret was good, before Gradle starts.

> Every run shows **2 warnings** — Node 20 deprecation and `setup-java@v4`.
> Both are GitHub deprecating action versions, not faults in the build, and
> the actions are already being forced onto Node 24 successfully. Bumping the
> five actions to `@v5` is a tidy-up for a quiet moment, not something to do
> while you are depending on the build working.

---

## Part 3 — Play Console account ✅ DONE

*Settled 2026-09-12. Left here because the rest of the document depends on it.*

| | |
|---|---|
| Account | **Organization**, fully verified |
| Account ID | `7315290518002454172` |
| Legal entity | Northwood Experiences LLC |
| D-U-N-S | **14-743-1636** |
| Email | `northwoodexperiences@gmail.com` |
| Domain | `gamehaven.guru` associated in Search Console |

**What this buys you: you can publish straight to production.** The
12-testers-opted-in-for-14-continuous-days closed-testing requirement applies
to *personal* accounts created after 13 November 2023. It does not apply to an
organization account. That is roughly a month saved, and it is why the account
type mattered.

**One thing to sort before you publish:** the verified entity is Northwood
Experiences LLC, but the app is Northwood Game Haven (ECCentric LLC). Set the
Developer name, and check which address goes public — the LLC's principal
office is the shop, not your house. `NGH-PLAY-LISTING-PACK.md` §0.3.

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

### 4.2b Two Play requirements the app did not meet — both now built

Found 2026-09-12x by auditing the app against the Play policies rather than
against this document. Both are code, both are done, both need deploying.

1. **Account deletion** *(built 12y)*. Play requires an in-app path **and** a
   public web URL, and the Data safety form has a required field for the URL.
   Now `https://gamehaven.guru/account-delete` and Rewards → Delete my account.
   Requests queue in a `deletion_requests` table and email you; a Guru does the
   actual removal.
2. **The Rewards review account** *(built 12z)*. Sign-in is an emailed
   six-digit code and Google's reviewer has no access to your inbox, so the
   whole Rewards screen was unreachable to them. One address now has a fixed
   code and shows an invented dashboard that never touches Lightspeed.

   **This one needs two environment variables from you or it stays off:**

   | Key | Value |
   |---|---|
   | `PLAY_REVIEW_EMAIL` | `play-review@gamehaven.guru` |
   | `PLAY_REVIEW_CODE` | six random digits — **not** in the repo |

   Netlify → Site configuration → Environment variables, then **Trigger
   deploy**. Env vars do not reach the functions until a deploy runs.

Full steps, including how to verify it, in **`NGH-PLAY-LISTING-PACK.md` §0**.

### 4.3 Store assets

The full paste-ready copy, every Data safety answer, the content-rating
answers and the App access text now live in **`NGH-PLAY-LISTING-PACK.md`** —
use that rather than the sketch below, which it supersedes.

| Asset | Spec | Notes |
|---|---|---|
| App icon | **512×512** PNG, no transparency | The crest on the forest-green background |
| Feature graphic | **1024×500** PNG | Banner at the top of the listing. No small text — it gets scaled down hard |
| Phone screenshots | **at least 2**, up to 8 | 15 drafts exist: `node tests/app-store-shots.mjs` → `tests/store-shots/`. Re-shoot on the phone for the real fonts |
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

You have an **organization** account, so this is the short version: there is no
closed-testing wait to serve.

1. Do **Internal testing** first anyway (Part 6). It reaches your own phone in
   minutes, skips full review, and is the only way to test App Links properly.
2. When it feels right: **Production** → **Create new release** → same AAB →
   roll out.

First review takes **a few days to two weeks** for a new developer account.
Later updates are usually hours.

If it is rejected, the reason is in the Play Console inbox and is usually
specific. The likely ones, in order:

- **App access** — the reviewer could not reach Rewards. Check the review
  account actually works (`NGH-PLAY-LISTING-PACK.md` §0.2 step 4) before you
  submit, not after.
- **Data safety mismatch** — the form says something the privacy page does not.
  Fix whichever is wrong; they have to agree.
- **Account deletion** — the URL must load and the deletion path must be
  obvious on it. Open `https://gamehaven.guru/account-delete` yourself.
- **Minimum functionality** — rare on Android (this is an Apple obsession), but
  if it happens, point at Game Companion, the karaoke buzzer and Speed Gaming,
  and lead the screenshots with those.

---

## Checklist

- [x] **D-U-N-S number** — 14-743-1636
- [x] **Play Console account** — organization, verified, `7315290518002454172`
- [ ] Debug APK installed and tested on a real phone (Part 1)
- [x] `ngh-upload.jks` created and backed up — *regenerated 2026-09-12 after the first one was exposed; 2,786 bytes*
- [x] Four GitHub secrets set; **release AAB builds** — run #9 at `62c23e8`, 3m 16s, both artifacts, log confirms `Keystore decoded: 2786 bytes`
- [x] `PLAY_REVIEW_EMAIL` + `PLAY_REVIEW_CODE` set in Netlify and deployed — *verified live 2026-09-12*
- [x] Developer name set — `Northwood Experiences LLC`
- [ ] Public address on the developer page = the shop, not the house *(waiting on D-U-N-S / ID verification)*
- [x] **Account deletion**: in-app path + public web URL — *`https://gamehaven.guru/account-delete` verified live 2026-09-12*
- [x] `stash2026` removed from `site/booking.html` *(12aa — also closed a fail-open)*
- [x] `https://gamehaven.guru/privacy` is live *(verified 2026-09-12x)* — read it
- [ ] Version bumped in `capacitor/package.json` *(1.0.0 → versionCode 10000 is fine for the FIRST upload; bump before the second)*
- [ ] Icon, feature graphic, 2+ screenshots *(drafts exist; re-shoot for real fonts)*
- [ ] Data safety form matches the privacy page (`NGH-PLAY-LISTING-PACK.md` §4)
- [ ] Content rating done (`NGH-PLAY-LISTING-PACK.md` §5)
- [ ] Internal testing release live, installed from Play on your phone
- [ ] `assetlinks.json` has the real SHA-256; App Links verified
- [ ] Camera QR scan tested on a real device *(never yet tested)*

## Where iOS stands

Blocked on macOS — Apple requires Xcode to archive and upload, full stop. When you want it: **Codemagic** builds and uploads from this same repo without a Mac in the building. Apple is also far stricter on Guideline 4.2 (minimum functionality), so lead the App Store listing with Game Companion and the karaoke buzzer, and never with the booking form. Details in `NGH-APP-STORE-RELEASE.md`.
