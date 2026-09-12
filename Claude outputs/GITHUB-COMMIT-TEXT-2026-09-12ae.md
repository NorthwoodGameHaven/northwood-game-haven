# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12ae

Three files. Puts the Android build script under test for the first time, and
hardens the build order.

**The workflow file is in this drop and GitHub Desktop will show it — but I
could not write it into your repo remotely (protected path). Download
`ngh-app-android.yml` from the chat and drop it into `.github\workflows\`
yourself, replacing the existing one.**

---

## Summary (the one-line box)

```
Test patch-android.mjs; run it after cap sync instead of before (12ae)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12ae

capacitor/scripts/patch-android.mjs runs inside the GitHub Actions build,
between `cap add android` and Gradle. Nothing checked it, and every way it can
go wrong is quiet:

  * a malformed manifest fails Gradle with an XML error a long way from us;
  * a missed versionCode stamp is only rejected by Play AFTER the upload
    finishes, wasting a whole cycle;
  * a missing CAMERA permission makes the QR scanner silently do nothing on a
    real phone while working perfectly in a browser — which is exactly the bug
    this script exists to fix (12i).

17 tests now cover it. Each one builds a throwaway copy of the tree
`npx cap add android` actually produces — the real Capacitor 8 manifest, with
the launcher intent-filter and INTERNET after </application>, and the real
build.gradle with its hardcoded `versionCode 1` — drops the real script in,
and runs it the way the build does.

  * the patched manifest still parses as XML (checked with a parser, not a
    regex — Gradle will not build a malformed one)
  * App Links land INSIDE <activity>; outside it they do nothing at all
  * all five TV QR prefixes present: /app/ /karaoke /turns /speedgaming /mtg
  * the LAUNCHER intent-filter survives (losing it = no icon in the drawer)
  * CAMERA and VIBRATE declared; camera required="false" so the app still
    installs on a device without one
  * INTERNET not clobbered
  * running twice adds nothing — exactly one intent-filter, one CAMERA
  * 1.0.0/1.0.1/1.2.0/2.0.0/1.11.9 stamp 10000/10001/10200/20000/11109
  * Capacitor's hardcoded `versionCode 1` is gone
  * the version stamp STILL runs when the manifest was already patched — the
    trap an early return would create, shipping an unbumped versionCode
  * a gradle with no versionCode, a nonsense package.json version, and a
    missing android/ each fail loudly rather than building something broken

Good news: no bug. The script was already right, including the re-run trap.
Mutations confirm the tests bite — dropping CAMERA fails 2, early-returning on
a re-run fails 1, marking the camera required fails 1.

BUILD ORDER
patch-android.mjs ran immediately after `cap add android`, which quietly
depends on nothing downstream regenerating AndroidManifest.xml or
app/build.gradle. That holds for Capacitor 8 today. If a future version ever
rewrites either, the App Links, the CAMERA permission and the versionCode
stamp would vanish with no error — a scanner that does nothing, and an upload
Play rejects after it completes. The script is idempotent, so it now runs LAST,
after `cap sync android`. Free, and the whole class of failure goes away.

DOCS
§0.3a of the listing pack recommended setting the developer name to "Northwood
Game Haven". It is now "Northwood Experiences LLC", which is consistent with
Northwood Experiences owning the app — so the doc records the decision and its
two consequences instead of arguing with it.
```

---

## Files

| File | Change |
|---|---|
| `tests/patch-android.test.mjs` | **new** — 17 tests against a real Capacitor fixture |
| `.github/workflows/ngh-app-android.yml` | patch runs after `cap sync`, not before |
| `docs/NGH-PLAY-LISTING-PACK.md` | §0.3a/§0.3c updated to what was actually decided |

## Still on your list

- [ ] Public address on the developer page = the shop, not the house (§0.3b) —
      you said the D-U-N-S update is waiting on ID verification
- [ ] Confirm the developer-name review banner has cleared before publishing
- [ ] Keystore + four secrets, then run the workflow
