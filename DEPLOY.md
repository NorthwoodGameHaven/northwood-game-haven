# Northwood Game Haven — Deployment Guide

This is everything you need to put the site **and** the real booking backend
online with Netlify. Two ways to do it: the **quick demo deploy** (no backend,
5 minutes) and the **full production deploy** (real shared database, logins,
and emails, ~30 minutes).

```
ngh/
├─ site/                     ← published web pages
│   ├─ ngh.html  index.html  ← marketing site (identical; index.html is the homepage)
│   ├─ booking.html          ← the booking app (customer + staff console)
│   ├─ ngh-config.js         ← flips demo-mode ↔ live-server-mode
│   ├─ board-game-library.html, video-game-equipment.html, terms.html
├─ netlify/functions/        ← the backend (serverless functions)
│   ├─ admin-login.mjs, bookings.mjs, events.mjs, blackouts.mjs,
│   ├─ send-email.mjs, auto-cancel.mjs, _shared/db.mjs
├─ netlify.toml              ← Netlify config (publish dir, redirects, cron)
└─ package.json
```

> **Naming note:** Netlify serves `index.html` as your homepage automatically.
> `ngh.html` is an identical copy kept because internal links point to
> `ngh.html`. You can keep both, or rename links to `/` if you prefer — both work.

---

## Option A — Quick demo deploy (no backend)

Good for sharing the design and clicking through the flow. Bookings are saved
only in the visitor's own browser; no shared data, no real emails.

1. Make sure `site/ngh-config.js` has the `NGH_API_BASE` line **commented out**
   (it is by default).
2. Go to <https://app.netlify.com> → **Add new site → Deploy manually**.
3. Drag the **`site/`** folder onto the upload area.
4. Done — you get a `something.netlify.app` URL. The booking app runs in
   "Demo (this browser only)" mode (you'll see that label in the staff console).

---

## Option B — Full production deploy (database + logins + email)

### Step 1 — Put the project in a Git repo

Netlify builds best from GitHub/GitLab/Bitbucket.

```bash
cd ngh
git init
git add .
git commit -m "Northwood Game Haven site + booking backend"
# create an empty repo on GitHub, then:
git remote add origin https://github.com/<you>/northwood-game-haven.git
git push -u origin main
```

### Step 2 — Create the Netlify site

1. <https://app.netlify.com> → **Add new site → Import an existing project**.
2. Pick your repo. Netlify reads `netlify.toml`, so the settings auto-fill:
   - **Publish directory:** `site`
   - **Functions directory:** `netlify/functions`
3. Click **Deploy**. (The first deploy works even before the DB exists; the
   booking app will just stay in demo mode until Step 4.)

### Step 3 — Add the database (Neon / Netlify DB)

I recommend **Neon** — it's serverless Postgres, built by Netlify, and the
connection string is injected automatically. Two ways:

**Easiest (dashboard):**
- In your site → **Extensions** (or **Integrations**) → search **Neon** →
  **Install**. It provisions a database and sets the `NETLIFY_DATABASE_URL`
  environment variable for you.

**Or via CLI:**
```bash
npm install                       # installs deps incl. netlify-cli
npx netlify login
npx netlify link                  # link this folder to your Netlify site
npx netlify db init               # creates the Neon DB + env var
```

You don't need to create any tables — the backend creates them automatically
on first request (see `ensureSchema()` in `_shared/db.mjs`).

### Step 4 — Set environment variables

Site → **Project configuration → Environment variables** → add:

| Variable               | Value (example)                                          | Why |
|------------------------|---------------------------------------------------------|-----|
| `ADMIN_CODE`           | a strong staff password, e.g. `Otter!Stash-2026`        | staff console login |
| `ADMIN_SECRET`         | any long random string (token signing key)              | secures login tokens |
| `ADMIN_EMAIL`          | `stash@northwoodgamehaven.com`                          | where new-request alerts go |
| `RESEND_API_KEY`       | `re_xxx…` (see Step 5)                                   | sends real emails |
| `MAIL_FROM`            | `Northwood Game Haven <bookings@northwoodgamehaven.com>`| the From: line |

`NETLIFY_DATABASE_URL` is already set by the Neon extension — leave it alone.

### Step 5 — Hook up email (Resend)

1. Sign up at <https://resend.com> (free tier covers a small shop).
2. **Add your domain** `northwoodgamehaven.com` and add the DNS records they
   give you (SPF/DKIM). This lets mail actually land in inboxes.
3. Create an **API key** → paste it into the `RESEND_API_KEY` env var above.
4. Set `MAIL_FROM` to an address on your verified domain.

> Don't want Resend? The code calls a standard REST API; you can swap in
> SendGrid, Postmark, or Amazon SES by editing `send-email.mjs` and
> `auto-cancel.mjs` (one `fetch` call each). If `RESEND_API_KEY` is absent,
> the system still works — it just logs emails instead of sending them.

### Step 6 — Flip the app to live-server mode

Edit **`site/ngh-config.js`** and uncomment the API line:

```js
window.NGH_API_BASE = "/.netlify/functions";
```

Commit + push. Netlify redeploys automatically. The staff console will now show
a green **"● Live server"** badge, all devices share one database, and emails
send for real.

### Step 7 — Point your domain

Site → **Domain management → Add a custom domain** → `northwoodgamehaven.com`.
Netlify walks you through DNS and issues a free HTTPS certificate.

---

## How the pieces map to your requirements

- **Book / Shop corner buttons + per-section links** — already in `ngh.html`,
  `index.html`, and `booking.html` (Book = `booking.html`, Shop =
  `https://northwoodgamehaven.company.site`, VRBO suites link to
  `vrbo.com/5183022` and `vrbo.com/5183156`).
- **Public NGH Events** — staff console → **Public Events** tab. Create
  one-off or recurring events; they appear **teal** on the calendar and block
  those rooms from being booked.
- **Four calendar colors** — amber (pending/on-hold), green (approved), teal
  (public event), red (blackout). Approved-but-unpaid gets a gold outline;
  recurring items show 🔁.
- **Real backend** — Netlify Functions + Neon Postgres. Admin login is a real
  server check (`admin-login.mjs`); status changes and email all run
  server-side.
- **Email notifications** — new-request alert to staff; approval / on-hold /
  rejection / auto-cancel emails to the guest (`send-email.mjs`).
- **Military / First-Responder 15% off** — checkbox on the form. The discount
  is only created when the box is checked, starts as **"Verify ID"**, and a
  staff member marks it **Verified** (applies the 15%) or **Not verified**
  (removes it). For a recurring series you can **verify all instances at once**;
  **paid/unpaid stays per-instance** because each occurrence is paid separately.
- **Auto-cancel unpaid** — nightly scheduled function (`auto-cancel.mjs`,
  `@daily`) cancels approved-but-unpaid bookings past the day-before deadline
  and emails the guest.

---

## Test it locally before going live

```bash
npm install
npx netlify dev      # serves site + functions at http://localhost:8888
```

With `netlify dev` and a linked Neon DB, you can exercise the full flow
locally. Without a DB, the app stays in demo mode automatically.

## Day-to-day staff use

1. Open the booking page → footer **Staff Login** (or add `?admin=1` to the URL).
2. Enter your `ADMIN_CODE`.
3. **Request List** to approve/hold/reject and mark paid + verify Mil/FR ID.
4. **Calendar** to see everything color-coded.
5. **Public Events** to schedule tournaments / game nights.
6. **Manage Blackout Dates** for closures and private buyouts.
