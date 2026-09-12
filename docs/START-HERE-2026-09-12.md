# Morning brief — 12 September 2026

You pushed two commits overnight (`2026-09-12l`, then the venue drop). This is what's live, what's in this package, and the order to do things in.

---

## Already live on gamehaven.guru

Assuming Netlify finished both deploys:

| | Where | Try it |
|---|---|---|
| **Speed Gaming** | `/speedgaming-guru` · `/speedgaming-tv` · `/speedgaming` | ⚠️ **Runs Thursday** — worth a dry run today |
| **Magic night board** | `/mtg` (sign in as Guru) · `/mtg-tv` | Set a code, watch the TV board |
| **Karaoke Name That Tune** | Karaoke host page, under the transport | Needs 2+ phones to feel real |
| **Trivia in the app** | App → Trivia → Join | Should have no browser bar |
| **Venue mode** | `/api/venue/state` · `/tv-auto` | Needs `VENUE_KEY` first — see below |

---

## Fixed overnight: the Rejected tab, and Robyn's booking

You asked why Robyn's Depths booking was rejected *again* and why the Rejected tab showed nothing. Same screenshot, two separate bugs, both fixed.

**The Rejected tab.** `renderAdmin` built the whole list in one expression: `el.innerHTML = list.map(reqCardHtml).join("")`. If **any single booking** throws while rendering, the exception escapes *before* `innerHTML` is assigned — so the panel silently keeps whatever the previous tab drew. On a fresh console that's the default Pending tab's empty state. Hence "Rejected (20)" highlighted above "No pending requests.", with twenty bookings you could count but not reach.

Cards now render one at a time. A record that fails costs you that one card — shown with its id, name, date and the actual error — instead of the whole tab. The failing id also goes to the browser console, so next time we'll know which record and why rather than guessing.

**Robyn's booking.** This one was worse than a rendering bug, and the first fix
was wrong. There were **two** auto-cancellers.

`autoCancelUnpaid()` ran in the Guru console, in a browser tab, **on every
console load**. Before 09-10c it required *both* the booking fee and the
refundable deposit to be settled — and the deposit is payable on the day. Robyn
paid her booking fee, owed only the deposit, and the software cancelled her
party and emailed her about it. Every time a Guru re-approved it, the next
refresh flipped it back and sent another notice. She may have received several.

I first tried to *tune* that function. That was the wrong instinct. A web page
should not be able to cancel a customer at all, so it is **deleted** — it now
returns `false` and carries a comment explaining why it must never come back. A
test asserts the function body cannot even reach `updateBooking` or `sendEmail`,
and another asserts nothing on the page calls it.

The **nightly server job** (`netlify/functions/auto-cancel.mjs`) had its rules
rewritten to match how the shop actually works:

- **The deposit never cancels anybody. Ever.** It is payable on the day, it is
  refundable, and it now appears in that file only as something that can *spare*
  a booking. Only the booking fee is ever the reason.
- **Nothing is cancelled before the booking is over.** Not the night before, not
  at the start time — after `start + hours` has passed. This cron runs `@daily`
  = midnight UTC = **7 PM Central**, so cancelling at the start time would have
  released a 6 PM room with the guests still in it.
- **Guests are only emailed within 48 hours** of the booking ending. Older
  no-shows are closed out quietly and listed in the ops digest — nobody needs a
  cancellation notice for a party three weeks ago.
- **Kill switch:** set `AUTO_CANCEL_ENABLED=0` in Netlify and trigger a deploy
  to make the sweep report-only.

**And there was a third copy nobody was running.**
`netlify/functions/_shared/auto-cancel.mjs` was a full duplicate of the
scheduled function. Netlify only schedules functions in `netlify/functions/`,
not in `_shared/` — so it never ran, but it *did* receive the 09-10c
"don't cancel partially-paid bookings" fix that the live function never got.
For a day the fix looked deployed while bookings kept being cancelled. It is now
a tombstone file; `git rm` it whenever you like.

40 tests across the two files, 11 mutations, all caught.

**Worth checking when you're up:** whether Robyn got more than one cancellation
email, and whether any of those other 19 rejected bookings were auto-cancelled
the same way rather than genuinely rejected. The Rejected tab opens now, and
auto-cancelled ones carry an `autoCanceled` flag on the record. Re-approving any
of them sticks — nothing will overrule you.

---

## Do these in this order

### 1. Apply this package and push (5 min)

Double-click `APPLY-NGH-2026-09-12n.cmd`, then commit and push. It adds the privacy policy, both runbooks, the Android version fix and the store graphics.

### 2. Set `VENUE_KEY` in Netlify (2 min) — unblocks the whole A/V layer

Netlify → your site → **Site configuration** → **Environment variables** → **Add a variable**:

- Key: `VENUE_KEY`
- Value: a long random string (30+ characters — a password manager will make one)

Then **Deploys** → **Trigger deploy** → **Deploy site**. Environment changes don't reach the running deploy without this.

**Save that value somewhere you'll find it at the shop** — you need it to build the Stream Deck buttons.

### 3. Start the Google Play account (10 min, then days of waiting)

**This is the long pole. Start it before anything else you feel like doing.**

`docs/NGH-ANDROID-DEPLOY.md` **Part 3**. $25, and identity verification takes days to a couple of weeks. Everything else Android-related can happen while you wait — but nothing publishes until it clears.

One decision in there: **Organization** account (listing says "Northwood Game Haven", needs a free D-U-N-S number, 1–2 weeks) versus **Personal** (immediate, listing says your name).

### 4. Create the upload keystore (10 min) — then back it up twice

`docs/NGH-ANDROID-DEPLOY.md` **Part 2**.

> **Lose `ngh-upload.jks` and you can never update the app under that listing again.** Not "difficult" — you'd publish a new app and orphan every install. Google Drive plus a USB stick in the safe, and the password in your password manager.

### 5. Test the debug APK on your phone (15 min, free)

`docs/NGH-ANDROID-DEPLOY.md` **Part 1**. No accounts needed, works right now.

Two things have **never been tested on a real device**:
- the **camera QR scanner** (fixed in 12i, still unverified on hardware)
- the new **Speed Gaming** and **Magic** app screens

### 6. Read the privacy policy (5 min)

`https://gamehaven.guru/privacy` once deployed.

I wrote it to match what the app actually does. **Read it** — Play's Data Safety form is checked against it, and a mismatch is the most common cause of a rejected update. If anything in it isn't true of how you run the business, change the page rather than the form.

---

## When you're next at the shop

`docs/NGH-SHOP-SERVER-UPDATE.md` is the runbook. Short version:

1. **Back up first** — one PowerShell block, plus a Companion full-configuration export.
2. **Point each Google TV Streamer at `https://gamehaven.guru/tv-auto`** — once, forever. It follows the venue mode by itself.
3. **Build five Stream Deck buttons** in Companion (Generic HTTP connection, five bare GETs). By hand in the GUI — *not* by importing a page JSON, for the reason your own September notes record.

Then hand me the machine (Claude desktop app → **Link to this computer**) and I'll do the part that needs the actual files:

- read `C:\NGH\rack-player\player.mjs` and add the `/venue` proxy so the credential stays on the rack PC and the mixer keeps working when the internet drops
- wire the X32 scenes to the modes
- test the whole loop live

**Two things I need from you for that:**
1. The **X32 scene slot number** per mode (slot 01 is `NGH SHOW`; the rest were empty on 09-09).
2. Whether Companion polls gamehaven.guru directly, or the rack-player proxies it. I recommend the second.

---

## In this package

| File | What |
|---|---|
| `site/privacy.html` | Privacy policy — a hard Play requirement that didn't exist |
| `docs/NGH-ANDROID-DEPLOY.md` | Click-by-click, laptop to store |
| `docs/NGH-SHOP-SERVER-UPDATE.md` | Rack PC runbook |
| `capacitor/scripts/patch-android.mjs` | Stamps `versionCode` from `package.json`; App Links for the new QRs |
| `tools/store-assets/play-icon-512.png` | Store icon, 512×512, no alpha |
| `tools/store-assets/play-feature-1024x500.png` | Feature graphic |
| `tools/make-store-assets.mjs` | Regenerates both if you want different copy |
| `tests/karaoke-nametune.test.mjs` | Now self-registering, so one command runs everything |
| `site/booking.html` | Rejected-tab fix; browser-side auto-cancel deleted |
| `netlify/functions/auto-cancel.mjs` | Deposit can never cancel; nothing cancels until the booking is over |
| `netlify/functions/_shared/auto-cancel.mjs` | Tombstoned duplicate that shadowed a fix |
| `tests/auto-cancel.test.mjs` | 26 tests: the two promises above, run against a mock DB |
| `tests/booking-admin-render.test.mjs` | 29 tests pulled from the real page |

### The Android fix worth knowing about

Capacitor hardcodes `versionCode 1`. Play refuses any upload whose versionCode isn't higher than the last — and tells you **after** the upload completes. Your *second* release would have failed, with a wasted build cycle and no obvious cause.

Now the build stamps it from one place. Before a Play upload, the only thing to remember is: **bump `version` in `capacitor/package.json`.** `1.0.0` → 10000, `1.0.1` → 10001, `1.1.0` → 10100.

### Tests

```
node --test tests/*.test.mjs
```

**314 tests. One command.** That command didn't actually work before this package — the karaoke suite needed an extra flag, so the documented "run everything" failed on exactly one file. It self-registers now.

---

## Open items I'm carrying

- **X32 scene numbers per mode** — blocks finishing the A/V loop.
- **Companion polls directly vs. rack-player proxy** — architecture call, I recommend the proxy.
- **Change the WPN password.** It's been in this chat twice. I never used it and never stored it.
- **Two malformed Lightspeed returns** (receipts 1619, 1620) from debugging earlier — Lightspeed support can remove them. Receipt 1619 carries a −$10.55 payment against zero goods, so it may surface in a reconciliation.
- **Military discount is self-served** — `milRequested` applies 15% while `milVerified` stays `"pending"`. Your policy call, not a bug.
- **iOS** — blocked on macOS. Codemagic when you want it.
