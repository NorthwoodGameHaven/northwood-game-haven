# Copy/paste for GitHub Desktop — NGH-BUILD 2026-09-12ac

Three files. **Push this before you add the keystore secrets** — it fixes a
fault that would have killed your first signed build.

---

## Summary (the one-line box)

```
Fix the release-signing step: Windows base64 broke the keystore decode (12ac)
```

---

## Description (the big box)

```
NGH-BUILD 2026-09-12ac

THE BUG
The release-AAB step decoded the keystore with:

    echo "$KS" | base64 -d > upload.jks

Our own runbook told you to produce that secret with Windows
`certutil -encode` and copy it out of Notepad — which gives you CRLF line
endings. GNU base64 on the Linux runner rejects carriage returns outright:

    base64: invalid input

That is the entire error. No mention of line endings, no mention of the
keystore. The first signed build would have failed, roughly five minutes in,
with two words that do not point at the cause — and the natural next guess is
that the keystore or the password is wrong, which sends you round the loop
re-generating a key you must never regenerate casually.

Verified rather than assumed: encoded a file with CRLF exactly the way
certutil does and fed it through the old command. Fails. Same bytes with LF:
decodes fine.

THE FIX, BOTH ENDS

1. The workflow now strips whitespace before decoding — base64 has none of its
   own, so nothing valid is lost — and then checks the result:
     * decode failure  -> names certutil's header/footer lines as the likely cause
     * empty result    -> says the secret is probably blank
     * wrong magic     -> says it decoded but is not a keystore
                          (expects JKS "feedfeed" or PKCS#12 "3082")
   Checked against five realistic mistakes: CRLF base64 (now passes), header
   and footer left in, empty secret, a PKCS#12 keystore (passes), and pasting
   the password into the wrong box.

2. Part 2 of the runbook no longer tells you to use certutil. One PowerShell
   line puts clean base64 straight on the clipboard — no header lines to
   delete by hand, no CRLF:

     [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\\ngh-upload.jks")) | Set-Clipboard

   NGH-APP-STORE-RELEASE.md carried the same certutil instruction; fixed too.

ALSO
Part 0 and the header no longer tell you to go and get a Play account and pay
$25 — that is done. Part 0 now says the thing that is actually still true: the
app has never run on a phone.
```

---

## Files

| File | Change |
|---|---|
| `.github/workflows/ngh-app-android.yml` | whitespace-tolerant decode + three readable failure messages |
| `docs/NGH-ANDROID-DEPLOY.md` | PowerShell one-liner instead of certutil; Part 0 refreshed |
| `docs/NGH-APP-STORE-RELEASE.md` | same certutil instruction fixed |

## After it merges

Push this **first**, then create the keystore and add the four secrets. Run the
workflow and you should get two artifacts instead of one — `game-haven-debug-apk`
and `game-haven-release-aab`. The signing step now prints
`Keystore decoded: N bytes` when it is happy, so you will know before Gradle
starts whether the secret was good.
