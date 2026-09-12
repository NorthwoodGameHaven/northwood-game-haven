# Google Play listing pack — Game Haven
*NGH-BUILD 2026-09-12x. Package `guru.gamehaven.app`. Everything below is paste-ready.*

This is the copy and the form answers. The **order of operations** is in
`NGH-ANDROID-DEPLOY.md` — do that document's Parts 1–3 first, then come back
here when the Play Console asks you for words.

---

## 0. Read this before anything else.

### 0.1 Account deletion — ✅ built 2026-09-12y

Google Play's User Data policy requires that any app which lets people create
an account provides **both**:

> "an in-app path to delete their app accounts and associated data"
> …and… "a web link resource where users can request app account deletion"

The app had neither, which was a form field you could not have filled in. It
now has both, on the "request it, a Guru actions it" model you picked — nothing
is deleted automatically, because completed sales live in Lightspeed and have
to be kept for tax.

| | |
|---|---|
| **Public URL** *(this is the one Play wants)* | `https://gamehaven.guru/account-delete` |
| In-app path | Rewards → **Delete my account** |
| Endpoint | `POST /api/account/delete-request` — public on purpose |
| Queue | `deletion_requests` table; a row per request, `status = 'open'` |
| Who is told | The shop (`ADMIN_EMAIL`, reply-to set to the customer) and the customer |
| Promise made | Handled within 30 days |

**What you have to actually do when one arrives.** The email tells you, but in
short: remove their Lightspeed customer record or its personal fields, and any
bookings or registrations under that address. Completed sales stay — the
privacy page and the deletion page both say so, so you are covered, but *only
because they say so*. Do not quietly widen what you keep.

The deletion page and the privacy page have to keep agreeing with each other
and with §4 below. That three-way match is the thing Google actually checks.

### 0.2 A reviewer cannot sign in

Sign-in is email plus a six-digit code sent to that address. Google's reviewer
has no access to any of your inboxes, so every account-gated screen is
unreachable to them, and "App access" is a required section.

Options, worst to best:

| | |
|---|---|
| Tick "all functionality available without special access" | **Don't.** It is untrue, and a reviewer who finds a login wall you didn't declare can reject on that alone |
| Explain in review notes that Rewards needs a real customer account | Might pass. Might come back asking for credentials, costing a review cycle |
| **Seed a review account with a fixed code** | **Recommended.** One seeded email whose OTP check accepts a known constant, holding nothing real |

The third is a small change in `netlify/functions/account.mjs` — one email
address, one fixed code, no real customer data behind it. §6 has the exact
words to put in the App access form once it exists.

### 0.3 Also worth clearing first

`site/booking.html` still ships the staff gate code in the page source, and
prints it on screen:

```
line 543:  <p class="hint">Demo code: <code>stash2026</code>. …
line 646:  var ADMIN_CODE = window.NGH_ADMIN_CODE || "stash2026";
```

That is on the website rather than in the app, so it will not fail a Play
review by itself. It is still a published staff code sitting on a page a
reviewer may well open, and it has been on the checklist since 2026-09-12i.

---

## 1. Store listing — the text fields

### App name — 30 characters max

```
Northwood Game Haven
```
*(20 characters.)* The launcher icon on the phone stays **Game Haven** — that
comes from `capacitor.config.json` `appName` and does not have to match. Use
the full name on the listing: it is what people search for, and "Game Haven"
alone competes with everything.

### Short description — 80 characters max

```
Turn tracker, life counter, karaoke and rewards — Northwood Game Haven.
```
*(71 characters.)*

Alternates, if you prefer a different emphasis:

```
Game night HQ: table tools, karaoke, trivia and rewards in your pocket.
```
*(71.)*
```
Your table, your team, your rewards — Northwood Game Haven in your pocket.
```
*(74.)*

The first one leads with the tools that work for everybody. The other two lead
on atmosphere and will convert worse in search.

### Full description — 4000 characters max

```
Northwood Game Haven is a board game café, card shop and event centre in Chippewa Falls, Wisconsin. This is the app for the people who play there.

AT THE TABLE
Game tools that work whether or not you are in the building, and whether or not you have signal:

• Who goes first — everyone puts a finger on the screen and one of them wins. Also splits teams and sets turn order.
• Turn tracker — pass the turn around the table. Every phone lights up in the active player's colour and buzzes when it is yours.
• Life counter — 2 to 6 players, 20/30/40 starting life, Commander damage, partner commanders, and a full undo history.
• RPG tools — build a dice formula and roll it, advantage and disadvantage, initiative order and hit points.

ON EVENT NIGHTS
• Karaoke Battle — every room in the building is a team. Join with the code on the TV or scan the QR, queue a song, and score the other rooms while they sing.
• Team Trivia — play along from your seat.
• Speed Gaming Meet-up — check in and the app gives you your table, your partner and your opponents, then counts down the round. New partner every round, and if you arrived with someone we put you on opposite teams.
• Magic night — the event code, format, entry and prizes, plus a link to live pairings.

YOUR HAVEN ACCOUNT
• Your rewards balance and the customer code you give at the register
• Recent purchases
• Upcoming room bookings and event registrations

ALSO IN HERE
• Tonight's events and the full calendar
• Food and drink specials, retail deals, and coupons you can claim on your phone
• Order ahead from the shop and the café for in-store pickup
• Book a party room or an overnight suite

Some of this only makes sense when you are with us — a karaoke session or a Speed Gaming round has to be running at the Haven before you can join one. The game tools work anywhere, including on the kitchen table at home.

Northwood Game Haven
115 W Spring St, Chippewa Falls, WI 54729
gamehaven.guru
```

*(1,955 characters — comfortably inside the limit.)*

No keyword stuffing, no "best app for", no competitor names. Play's listing
policy treats all three as manipulation, and the description reads better
without them.

---

## 2. Categorisation and contact

| Field | Value |
|---|---|
| App or game | **App** |
| Category | **Entertainment** |
| Tags | Board games · Events · Local |
| Free or paid | **Free** |
| Contains ads | **No** |
| Email | `stash@northwoodgamehaven.com` |
| Website | `https://gamehaven.guru` |
| Phone | Optional — the shop number if you want it public |
| Privacy policy | `https://gamehaven.guru/privacy` |

**Category.** Entertainment is the safest fit and has the browse traffic.
*Events* is arguably more accurate for what the app is actually used for on a
Friday night, and if the listing underperforms it is the one thing worth
A/B testing. Do not put it in *Games* — that category is for games themselves,
and a companion app there gets buried and mis-rated.

**Privacy policy.** `https://gamehaven.guru/privacy` is live and 302s to
`/privacy.html` (`netlify.toml` line 250). Checked today: it names Stripe,
Lightspeed, Netlify and Neon, covers the mobile app explicitly, states the
camera is used "only to scan QR codes", mentions the random device ID, and
gives the contact address. It matches §4 below, which is the thing Google
actually cross-checks.

---

## 3. Graphics

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG, no alpha | ✅ `tools/store-assets/play-icon-512.png` |
| Feature graphic | 1024×500 PNG | ✅ `tools/store-assets/play-feature-1024x500.png` |
| Phone screenshots | 2–8, min 320px, 16:9 or 9:16 | ⚠️ 15 drafts at `tests/store-shots/` — see below |
| 7"/10" tablet | only if you claim tablet support | Skip it. Untested |

### The screenshots

`node tests/app-store-shots.mjs` walks all fifteen app screens at 360×640 with
a 3× pixel ratio — exactly 1080×1920, 24-bit, no alpha, which is what Play
wants — and asserts each one loaded, rendered live data, threw nothing and did
not scroll sideways before it photographs it. 120 checks, all passing.

**One caveat, and it matters.** The build sandbox has no route to
`fonts.googleapis.com`, so the headings fall back from Cinzel to Georgia. The
layout, spacing and content are exactly right; the typeface is not the shipping
one. Re-shoot on the phone once you have the app installed, or on any machine
with normal internet — the script reports which of the two you got.

**Use these eight, in this order.** Play shows the first two or three in search
results, so they carry the install decision:

| # | File | Why |
|---|---|---|
| 1 | `12-speedgaming.png` | The strongest single image: "ROUND 2 OF 3 · YOU'RE AT TABLE 4 · WITH Simone · AGAINST Hugo & Maya · PLAY 26:59". Instantly legible |
| 2 | `13-mtg.png` | The oversized event code carries the whole frame |
| 3 | `07-life-counter.png` | Proves there are real tools in here, not a wrapped website |
| 4 | `09-karaoke.png` | The live-now card |
| 5 | `11-trivia.png` | "Trivia is LIVE — join now" |
| 6 | `02-specials-food.png` | The everyday reason to open it |
| 7 | `05-account.png` | Rewards |
| 8 | `01-home.png` | The crest and the tile grid, for brand |

Do **not** lead with the booking form or the marketing pages — a reviewer
skimming those forms an opinion about how much of this is a wrapped website,
and on iOS later that opinion is Guideline 4.2.

The specials screenshot currently shows the crest as the deal photo because
that is what the mock serves. On the real store it will show whatever image is
attached to the live special, so shoot that one when there is a real photo on it.

---

## 4. Data safety form

Audited against the source today, not guessed. No analytics SDK, no ad SDK, no
`geolocation` call, no advertising ID, no contacts access anywhere under
`site/app/`.

| Question | Answer |
|---|---|
| Does your app collect or share user data? | **Yes** |
| Is all data encrypted in transit? | **Yes** (HTTPS throughout; `allowMixedContent: false`) |
| Do you provide a way for users to request data deletion? | **Yes** |
| Deletion request URL | `https://gamehaven.guru/account-delete` |
| Is data collected required or optional? | See each row |
| Independent security review | No |

### Data types — tick exactly these

| Category → type | Collected | Shared | Purpose | Required? |
|---|---|---|---|---|
| Personal info → **Name** | Yes | No | App functionality, Account management | Required |
| Personal info → **Email address** | Yes | No | App functionality, Account management | Required |
| Personal info → **Phone number** | Yes | No | App functionality, Account management | Optional |
| Financial info → **Purchase history** | Yes | No | App functionality | Optional |
| App info → **Other user-generated content** | Yes | No | App functionality | Optional |

The last row covers display names, karaoke song choices, team names and the
note field on a pickup order. It is easy to forget and it is user data.

### Do NOT tick

| | Why |
|---|---|
| **Photos and videos** | The camera scans a QR code in the browser and nothing is stored, transmitted or written to disk. Google's guidance is explicit that on-device-only processing is not collection |
| **Location** | No `geolocation` call exists anywhere in the app |
| **Device or other IDs** | The device ID is a random string this app generates into `localStorage` to keep your place in a session. It is not an advertising ID and is not tied to a person |
| **Financial info → Payment info** | Card details go to Stripe's own hosted checkout. You never receive them, so you do not collect them |
| Contacts, Messages, Calendar, Files, Health, App activity/analytics | None present |

### If Play asks why you are not using Play Billing

Physical goods and real-world services — room bookings, event tickets, café and
retail pickup orders — are explicitly exempt from Play Billing. Stripe is the
correct processor here and the policy allows it. Say "physical goods and
services".

---

## 5. App content declarations

| Section | Answer |
|---|---|
| Privacy policy | `https://gamehaven.guru/privacy` |
| Ads | **No ads** |
| App access | See §6 — do not tick "no special access" |
| Content rating | IARC questionnaire, see below |
| Target audience | **13+**. Do not opt into Designed for Families |
| News app | No |
| COVID-19 apps | No |
| Data safety | §4 |
| Government apps | No |
| Financial features | **No** — you sell goods; you are not a financial product |
| Health apps | No |

### Content rating questionnaire

Category: **Reference, News, or Educational** *(the closest fit for a utility
app; do not pick a game category — it opens violence questions that make no
sense here and can push the rating up)*.

| Question | Answer |
|---|---|
| Violence, sexuality, profanity, controlled substances, crude humour | **No** to all |
| Gambling, simulated gambling, contests with prizes of real value | **No.** Event prizes are packs handed over a counter in person — not in-app |
| Does the app allow users to interact or exchange content? | **Yes** |
| Can users share their personal information with other users? | **No** — display names only, no profiles, no DMs |
| Does the app share the user's current location with other users? | **No** |
| Does the app contain user-generated content? | **Yes** — display names, team names, song choices |
| Is UGC moderated, and can users report it? | **Answer honestly** — see below |
| Digital purchases | **No** |

**The UGC moderation question is the one with teeth.** Karaoke display names,
trivia team names and Speed Gaming check-in names are typed by customers and
shown on a TV in a family venue. Google expects apps with UGC to have a way to
report content and a means of moderating it. What you actually have is a Guru
standing next to the TV who can remove a name — that is real moderation and it
is fine to say so, but say it accurately rather than ticking a box that implies
an automated system.

Expect **Everyone** or **Everyone 10+** with a "users interact" note.

---

## 6. App access instructions

Once §0.2 is built, paste this into **App access → All or some functionality is
restricted**:

> **Instructions**
> Most of the app needs no account: the Game Companion tools (first player,
> turn tracker, life counter, RPG tools), the event calendar, specials, the
> game libraries and the shop all work signed out.
>
> **Rewards** requires a Northwood Game Haven customer account. Sign-in is by
> email plus a six-digit code we send to that address, so we have seeded a
> review account that accepts a fixed code:
>
> Email: `play-review@gamehaven.guru`
> Code: `<the fixed code>`
>
> Enter the email on the Rewards screen, tap "Send code", then enter the code
> above. The account holds sample data only.
>
> **Please also note:** Karaoke Battle, Team Trivia, Speed Gaming and Magic
> Night are live in-venue features. They show a "nothing on right now" state
> unless a session is actually running at our venue in Chippewa Falls,
> Wisconsin. That empty state is correct behaviour, not a failure to load. If
> you would like a session started so you can see those screens working, email
> stash@northwoodgamehaven.com and we will run one at a time that suits you.

That last paragraph exists because four of the app's best screens will look
empty to a reviewer, and an empty screen reads as a broken screen unless you
say otherwise.

---

## 7. Release notes for the first build

**Internal testing:**
```
First internal build. Game Companion, Karaoke Battle, Team Trivia, Speed Gaming, Magic night, rewards and order-ahead.
```

**Production (≤500 characters):**
```
The first release of the Game Haven app. Game tools for the table — first player, turn tracker, life counter and RPG dice — that work offline. Join Karaoke Battle, Team Trivia and the Speed Gaming Meet-up from your seat. Check your rewards balance, see what's on tonight, claim specials and order ahead for pickup.
```
*(314 characters.)*

---

## 8. Checklist for this document

- [x] **Account deletion**: in-app path + public web URL (§0.1) — *built 2026-09-12y, deploy it*
- [ ] **Review account** seeded with a fixed code (§0.2) — *near-blocker, still to do*
- [ ] `stash2026` removed from `site/booking.html` (§0.3)
- [ ] App name, short and full descriptions pasted (§1)
- [ ] Category, contact and privacy URL set (§2)
- [ ] Icon and feature graphic uploaded (§3)
- [ ] Screenshots **re-shot with real fonts** and uploaded in the §3 order
- [ ] Data safety form matches §4 *and* the privacy page
- [ ] Content rating done, UGC answered honestly (§5)
- [ ] App access instructions pasted with the real code (§6)
