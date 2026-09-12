# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12aa

Two files. Small, but one of them closes a fail-open.

---

## Summary (the one-line box)

```
Remove the published staff code from booking.html, and close the gate it left open (12aa)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12aa

booking.html printed a literal staff password on the Guru access screen —
"Demo code: stash2026" — and carried the same string as the fallback for
ADMIN_CODE.

It was already dead code. ngh-config.js has set NGH_API_BASE since going live,
so Store.apiMode() is true and login() goes to POST /admin-login on the server;
the local comparison is never reached. But it still read to every visitor, and
would have read to a store reviewer, as a real published password.

Removing it exposed a second, live problem. The check was:

    if(!this.apiMode()){ return code === ADMIN_CODE; }

Blank the code and that becomes "" === "", so an EMPTY box unlocks the console.
A gate with nothing configured has to refuse everything, not accept anything —
so it is now:

    if(!this.apiMode()){ return !!ADMIN_CODE && code === ADMIN_CODE; }

Fail closed. This only bites if live server mode is ever switched off, which is
exactly when you would least want the fallback to be "anyone gets in".

The hint line now says to use your staff code rather than printing one.

TESTS  (7 new, in tests/booking-admin-render.test.mjs)
  - "stash2026" appears in no .html/.js/.mjs/.json/.css under site/ at all
  - the gate screen prints nothing that looks like a literal code
  - ngh-config.js still sets NGH_API_BASE, so the local gate stays unreachable
    (if that line is ever commented out this test says so)
  - the real gate expression, pulled out of the shipped page and evaluated:
    empty box refused, guesses refused, a configured code still works

  node --test tests/*.test.mjs      515 pass  (was 509)
  node tests/e2e-pages.mjs          121 pass
  node tests/guru-master.e2e.mjs    134 pass
  node tests/app-store-shots.mjs    120 pass

  Mutations, each of which turns a test red:
    - restoring `code === ADMIN_CODE`      -> 1 fail
    - putting the code back in the fallback -> 1 fail
```

---

## Files

| File | Change |
|---|---|
| `site/booking.html` | code removed from the hint and the fallback; demo gate fails closed |
| `tests/booking-admin-render.test.mjs` | 7 new tests |

## Note

This changes nothing about how you sign in to the Guru console. That has gone
through the server since live mode was switched on; the code you actually type
lives in `ADMIN_SECRET` in Netlify and is untouched.
