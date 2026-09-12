# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12y

Nine files. **This one does change production** — a new public page, a new API
route, a new table and an addition to the Rewards screen. Deploy it before you
fill in the Play Data safety form, because the form asks for the URL.

---

## Summary (the one-line box)

```
Account deletion: public page, in-app path, request queue (12y)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12y

WHY
Google Play's User Data policy requires that any app which lets people create
an account provides BOTH "an in-app path to delete their app accounts and
associated data" AND "a web link resource where users can request app account
deletion". The Data safety form has a required URL field for the second one.

We had neither. account.html could sign in, show a balance and sign out. That
was a form field we could not have filled in — the listing could not have gone
live, and no document said so.

WHAT IT DOES
Nothing is deleted automatically. A request is queued and two emails go out;
a Guru does the removal by hand. That is deliberate: completed sales live in
Lightspeed and have to be kept for tax, so an automatic purge is the wrong
shape and would quietly destroy records we are required to hold.

  * https://gamehaven.guru/account-delete — public page. No sign-in, no app
    needed, because the person most likely to use it has already uninstalled.
    Says what goes, what is kept and why, how long it takes, and offers a
    plain email route as well.
  * Rewards -> Delete my account — the in-app path. Two taps: the first only
    reveals the explanation, the second sends. Pre-filled from the session, so
    nobody can request deletion of an address they are not signed in as.
  * POST /api/account/delete-request — PUBLIC on purpose, and it sits ABOVE
    the session gate in account.mjs. Move it below and the web page 401s for
    everyone; there is a test that goes red if that happens.
  * deletion_requests table — the queue and the audit trail. Who asked, when,
    from the app or the web, and whether it has been dealt with.

Three per hour per address, and the fourth is swallowed rather than bounced —
a 429 would be a way to probe which addresses we hold accounts for. For the
same reason the reply to an unknown address is byte-identical to a real one,
and the confirmation email confirms the REQUEST, never the account.

PRIVACY PAGE
Updated to point at the page and to state the 30-day promise and the tax
retention exception. The deletion page, the privacy page and the Data safety
form now say the same thing in three places — that three-way match is what
Google actually checks.

ONE MOCK FIDELITY FIX
Netlify serves /foo from foo.html with no redirect rule, and we hand out both
/privacy and /account-delete extensionless. The mock server 404'd them, so a
page could pass its own tests and still be unreachable at the address we
publish. The mock now falls back the same way.

TESTS
  node --test tests/*.test.mjs      494 pass  (was 480 — 14 new)
  node tests/e2e-pages.mjs          107 pass  (was  82 — 25 new)
  node tests/guru-master.e2e.mjs    134 pass
  node tests/app-store-shots.mjs    120 pass

  Mutations, each of which turns a test red:
    - requiring a session on the route (i.e. moving it below the gate) -> 9 fail
    - removing the rate limit                                          -> 1 fail
    - not lower-casing the address before storing it                   -> 1 fail
```

---

## Files

| File | Change |
|---|---|
| `site/account-delete.html` | **new** — the public deletion page |
| `site/app/account.html` | Rewards → Delete my account |
| `site/privacy.html` | points at the page; states the 30-day promise |
| `netlify/functions/account.mjs` | `POST /delete-request`, public, above the session gate |
| `netlify/functions/_shared/db.mjs` | `deletion_requests` table |
| `netlify.toml` | `/account-delete` → `/account-delete.html` |
| `tests/account-deletion.test.mjs` | **new** — 14 tests |
| `tests/e2e-pages.mjs` | 25 new browser checks |
| `tests/mock-api.mjs` | mock route; extensionless-URL fallback |
| `docs/NGH-PLAY-LISTING-PACK.md` · `docs/NGH-ANDROID-DEPLOY.md` | §0.1 closed out |

## After it deploys

1. Open **`https://gamehaven.guru/account-delete`** — it must load, or the Play
   form fails its own check.
2. Send yourself one. You should get the confirmation; `ADMIN_EMAIL` should get
   the request with reply-to set to you.
3. Then put that URL in Data safety → *Deletion request URL*.
