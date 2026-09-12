@echo off
REM ===================================================================
REM  DEPLOY-2026-09-11a.cmd  —  NGH-BUILD 2026-09-11a
REM  NGH App (PWA + iOS/Android), Karaoke Battle, Game Companion,
REM  Specials, Lightspeed X-Series (rewards, order-ahead, on-account)
REM  Run from the REPO ROOT (the folder with site\ and netlify\).
REM ===================================================================
setlocal EnableExtensions
set DROP=%USERPROFILE%\Downloads\ngh-drop
if not exist "%DROP%\DEPLOY-2026-09-11a.cmd" (echo [X] Drop not found at %DROP% - run the PowerShell extract first & exit /b 1)
if not exist "site\booking.html" (echo [X] Run this from the repo root - site\booking.html not found here & exit /b 1)
if not exist "netlify\functions\trivia.mjs" (echo [X] Run this from the repo root & exit /b 1)
where node >nul 2>&1 || (echo [X] Node is not on PATH & exit /b 1)
echo.
echo === 1/4  Moving 84 files into the repo ===
if not exist ".github\workflows" mkdir ".github\workflows"
if not exist "capacitor" mkdir "capacitor"
if not exist "capacitor\assets" mkdir "capacitor\assets"
if not exist "capacitor\scripts" mkdir "capacitor\scripts"
if not exist "docs" mkdir "docs"
if not exist "netlify\functions" mkdir "netlify\functions"
if not exist "netlify\functions\_shared" mkdir "netlify\functions\_shared"
if not exist "patches" mkdir "patches"
if not exist "rack-player" mkdir "rack-player"
if not exist "site" mkdir "site"
if not exist "site\.well-known" mkdir "site\.well-known"
if not exist "site\app" mkdir "site\app"
if not exist "site\app\companion" mkdir "site\app\companion"
if not exist "site\app\icons" mkdir "site\app\icons"
if not exist "site\app\karaoke" mkdir "site\app\karaoke"
if not exist "site\app\trivia" mkdir "site\app\trivia"
if not exist "tests" mkdir "tests"
if not exist "tests\fixtures" mkdir "tests\fixtures"
move /Y "%DROP%\.github\workflows\ngh-app-android.yml" ".github\workflows\ngh-app-android.yml" >nul || (echo [X] move failed: .github\workflows\ngh-app-android.yml & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\.gitignore" "capacitor\.gitignore" >nul || (echo [X] move failed: capacitor\.gitignore & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\assets\icon-background.png" "capacitor\assets\icon-background.png" >nul || (echo [X] move failed: capacitor\assets\icon-background.png & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\assets\icon-foreground.png" "capacitor\assets\icon-foreground.png" >nul || (echo [X] move failed: capacitor\assets\icon-foreground.png & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\assets\icon-only.png" "capacitor\assets\icon-only.png" >nul || (echo [X] move failed: capacitor\assets\icon-only.png & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\assets\splash-dark.png" "capacitor\assets\splash-dark.png" >nul || (echo [X] move failed: capacitor\assets\splash-dark.png & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\assets\splash.png" "capacitor\assets\splash.png" >nul || (echo [X] move failed: capacitor\assets\splash.png & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\capacitor.config.json" "capacitor\capacitor.config.json" >nul || (echo [X] move failed: capacitor\capacitor.config.json & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\package.json" "capacitor\package.json" >nul || (echo [X] move failed: capacitor\package.json & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\scripts\patch-android.mjs" "capacitor\scripts\patch-android.mjs" >nul || (echo [X] move failed: capacitor\scripts\patch-android.mjs & set MOVEFAIL=1)
move /Y "%DROP%\capacitor\scripts\sync-web.mjs" "capacitor\scripts\sync-web.mjs" >nul || (echo [X] move failed: capacitor\scripts\sync-web.mjs & set MOVEFAIL=1)
move /Y "%DROP%\docs\NGH-APP-ARCHITECTURE.md" "docs\NGH-APP-ARCHITECTURE.md" >nul || (echo [X] move failed: docs\NGH-APP-ARCHITECTURE.md & set MOVEFAIL=1)
move /Y "%DROP%\docs\NGH-APP-SETUP.md" "docs\NGH-APP-SETUP.md" >nul || (echo [X] move failed: docs\NGH-APP-SETUP.md & set MOVEFAIL=1)
move /Y "%DROP%\docs\NGH-LIGHTSPEED-INTEGRATION.md" "docs\NGH-LIGHTSPEED-INTEGRATION.md" >nul || (echo [X] move failed: docs\NGH-LIGHTSPEED-INTEGRATION.md & set MOVEFAIL=1)
move /Y "%DROP%\netlify.toml" "netlify.toml" >nul || (echo [X] move failed: netlify.toml & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\_shared\lightspeed-core.mjs" "netlify\functions\_shared\lightspeed-core.mjs" >nul || (echo [X] move failed: netlify\functions\_shared\lightspeed-core.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\_shared\lightspeed.mjs" "netlify\functions\_shared\lightspeed.mjs" >nul || (echo [X] move failed: netlify\functions\_shared\lightspeed.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\account.mjs" "netlify\functions\account.mjs" >nul || (echo [X] move failed: netlify\functions\account.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\auto-cancel.mjs" "netlify\functions\auto-cancel.mjs" >nul || (echo [X] move failed: netlify\functions\auto-cancel.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\companion.mjs" "netlify\functions\companion.mjs" >nul || (echo [X] move failed: netlify\functions\companion.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\create-checkout.mjs" "netlify\functions\create-checkout.mjs" >nul || (echo [X] move failed: netlify\functions\create-checkout.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\karaoke.mjs" "netlify\functions\karaoke.mjs" >nul || (echo [X] move failed: netlify\functions\karaoke.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\lightspeed.mjs" "netlify\functions\lightspeed.mjs" >nul || (echo [X] move failed: netlify\functions\lightspeed.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\registrations.mjs" "netlify\functions\registrations.mjs" >nul || (echo [X] move failed: netlify\functions\registrations.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\shop-sync.mjs" "netlify\functions\shop-sync.mjs" >nul || (echo [X] move failed: netlify\functions\shop-sync.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\shop.mjs" "netlify\functions\shop.mjs" >nul || (echo [X] move failed: netlify\functions\shop.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\specials.mjs" "netlify\functions\specials.mjs" >nul || (echo [X] move failed: netlify\functions\specials.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\stripe-webhook.mjs" "netlify\functions\stripe-webhook.mjs" >nul || (echo [X] move failed: netlify\functions\stripe-webhook.mjs & set MOVEFAIL=1)
move /Y "%DROP%\netlify\functions\ticket.mjs" "netlify\functions\ticket.mjs" >nul || (echo [X] move failed: netlify\functions\ticket.mjs & set MOVEFAIL=1)
move /Y "%DROP%\patches\patch-app-2026-09-11a.cjs" "patches\patch-app-2026-09-11a.cjs" >nul || (echo [X] move failed: patches\patch-app-2026-09-11a.cjs & set MOVEFAIL=1)
move /Y "%DROP%\rack-player\INSTALL-KARAOKE-PLAYER.cmd" "rack-player\INSTALL-KARAOKE-PLAYER.cmd" >nul || (echo [X] move failed: rack-player\INSTALL-KARAOKE-PLAYER.cmd & set MOVEFAIL=1)
move /Y "%DROP%\rack-player\karaoke-config.example.json" "rack-player\karaoke-config.example.json" >nul || (echo [X] move failed: rack-player\karaoke-config.example.json & set MOVEFAIL=1)
move /Y "%DROP%\rack-player\ngh-karaoke-player.mjs" "rack-player\ngh-karaoke-player.mjs" >nul || (echo [X] move failed: rack-player\ngh-karaoke-player.mjs & set MOVEFAIL=1)
move /Y "%DROP%\site\.well-known\apple-app-site-association" "site\.well-known\apple-app-site-association" >nul || (echo [X] move failed: site\.well-known\apple-app-site-association & set MOVEFAIL=1)
move /Y "%DROP%\site\.well-known\assetlinks.json" "site\.well-known\assetlinks.json" >nul || (echo [X] move failed: site\.well-known\assetlinks.json & set MOVEFAIL=1)
move /Y "%DROP%\site\app\account.html" "site\app\account.html" >nul || (echo [X] move failed: site\app\account.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\app.css" "site\app\app.css" >nul || (echo [X] move failed: site\app\app.css & set MOVEFAIL=1)
move /Y "%DROP%\site\app\companion\first-player.html" "site\app\companion\first-player.html" >nul || (echo [X] move failed: site\app\companion\first-player.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\companion\index.html" "site\app\companion\index.html" >nul || (echo [X] move failed: site\app\companion\index.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\companion\life-counter.html" "site\app\companion\life-counter.html" >nul || (echo [X] move failed: site\app\companion\life-counter.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\companion\rpg.html" "site\app\companion\rpg.html" >nul || (echo [X] move failed: site\app\companion\rpg.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\companion\turn-tracker.html" "site\app\companion\turn-tracker.html" >nul || (echo [X] move failed: site\app\companion\turn-tracker.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\guru-lightspeed.html" "site\app\guru-lightspeed.html" >nul || (echo [X] move failed: site\app\guru-lightspeed.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\guru-specials.html" "site\app\guru-specials.html" >nul || (echo [X] move failed: site\app\guru-specials.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\icons\apple-touch-icon.png" "site\app\icons\apple-touch-icon.png" >nul || (echo [X] move failed: site\app\icons\apple-touch-icon.png & set MOVEFAIL=1)
move /Y "%DROP%\site\app\icons\icon-1024.png" "site\app\icons\icon-1024.png" >nul || (echo [X] move failed: site\app\icons\icon-1024.png & set MOVEFAIL=1)
move /Y "%DROP%\site\app\icons\icon-192.png" "site\app\icons\icon-192.png" >nul || (echo [X] move failed: site\app\icons\icon-192.png & set MOVEFAIL=1)
move /Y "%DROP%\site\app\icons\icon-512.png" "site\app\icons\icon-512.png" >nul || (echo [X] move failed: site\app\icons\icon-512.png & set MOVEFAIL=1)
move /Y "%DROP%\site\app\icons\maskable-512.png" "site\app\icons\maskable-512.png" >nul || (echo [X] move failed: site\app\icons\maskable-512.png & set MOVEFAIL=1)
move /Y "%DROP%\site\app\index.html" "site\app\index.html" >nul || (echo [X] move failed: site\app\index.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\karaoke\cdg.js" "site\app\karaoke\cdg.js" >nul || (echo [X] move failed: site\app\karaoke\cdg.js & set MOVEFAIL=1)
move /Y "%DROP%\site\app\karaoke\host.html" "site\app\karaoke\host.html" >nul || (echo [X] move failed: site\app\karaoke\host.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\karaoke\index.html" "site\app\karaoke\index.html" >nul || (echo [X] move failed: site\app\karaoke\index.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\karaoke\join.html" "site\app\karaoke\join.html" >nul || (echo [X] move failed: site\app\karaoke\join.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\karaoke\karaoke-client.js" "site\app\karaoke\karaoke-client.js" >nul || (echo [X] move failed: site\app\karaoke\karaoke-client.js & set MOVEFAIL=1)
move /Y "%DROP%\site\app\karaoke\karaoke-lyrics.js" "site\app\karaoke\karaoke-lyrics.js" >nul || (echo [X] move failed: site\app\karaoke\karaoke-lyrics.js & set MOVEFAIL=1)
move /Y "%DROP%\site\app\karaoke\providers.js" "site\app\karaoke\providers.js" >nul || (echo [X] move failed: site\app\karaoke\providers.js & set MOVEFAIL=1)
move /Y "%DROP%\site\app\karaoke\tv.html" "site\app\karaoke\tv.html" >nul || (echo [X] move failed: site\app\karaoke\tv.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\manifest.webmanifest" "site\app\manifest.webmanifest" >nul || (echo [X] move failed: site\app\manifest.webmanifest & set MOVEFAIL=1)
move /Y "%DROP%\site\app\ngh-app.js" "site\app\ngh-app.js" >nul || (echo [X] move failed: site\app\ngh-app.js & set MOVEFAIL=1)
move /Y "%DROP%\site\app\shop-orders.html" "site\app\shop-orders.html" >nul || (echo [X] move failed: site\app\shop-orders.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\shop.html" "site\app\shop.html" >nul || (echo [X] move failed: site\app\shop.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\specials.html" "site\app\specials.html" >nul || (echo [X] move failed: site\app\specials.html & set MOVEFAIL=1)
move /Y "%DROP%\site\app\sw.js" "site\app\sw.js" >nul || (echo [X] move failed: site\app\sw.js & set MOVEFAIL=1)
move /Y "%DROP%\site\app\trivia\play.html" "site\app\trivia\play.html" >nul || (echo [X] move failed: site\app\trivia\play.html & set MOVEFAIL=1)
move /Y "%DROP%\site\ngh-config.js" "site\ngh-config.js" >nul || (echo [X] move failed: site\ngh-config.js & set MOVEFAIL=1)
move /Y "%DROP%\tests\.gitignore" "tests\.gitignore" >nul || (echo [X] move failed: tests\.gitignore & set MOVEFAIL=1)
move /Y "%DROP%\tests\_karaoke-hooks.mjs" "tests\_karaoke-hooks.mjs" >nul || (echo [X] move failed: tests\_karaoke-hooks.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\_mock-hooks.mjs" "tests\_mock-hooks.mjs" >nul || (echo [X] move failed: tests\_mock-hooks.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\_register-karaoke.mjs" "tests\_register-karaoke.mjs" >nul || (echo [X] move failed: tests\_register-karaoke.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\check-scripts-all.mjs" "tests\check-scripts-all.mjs" >nul || (echo [X] move failed: tests\check-scripts-all.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\check-scripts.mjs" "tests\check-scripts.mjs" >nul || (echo [X] move failed: tests\check-scripts.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\companion.e2e.mjs" "tests\companion.e2e.mjs" >nul || (echo [X] move failed: tests\companion.e2e.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\e2e-pages.mjs" "tests\e2e-pages.mjs" >nul || (echo [X] move failed: tests\e2e-pages.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\fixtures\test.cdg" "tests\fixtures\test.cdg" >nul || (echo [X] move failed: tests\fixtures\test.cdg & set MOVEFAIL=1)
move /Y "%DROP%\tests\fixtures\test.lrc" "tests\fixtures\test.lrc" >nul || (echo [X] move failed: tests\fixtures\test.lrc & set MOVEFAIL=1)
move /Y "%DROP%\tests\index.js" "tests\index.js" >nul || (echo [X] move failed: tests\index.js & set MOVEFAIL=1)
move /Y "%DROP%\tests\karaoke-harness.mjs" "tests\karaoke-harness.mjs" >nul || (echo [X] move failed: tests\karaoke-harness.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\karaoke.e2e.mjs" "tests\karaoke.e2e.mjs" >nul || (echo [X] move failed: tests\karaoke.e2e.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\lightspeed.test.mjs" "tests\lightspeed.test.mjs" >nul || (echo [X] move failed: tests\lightspeed.test.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\lyrics-cdg.test.mjs" "tests\lyrics-cdg.test.mjs" >nul || (echo [X] move failed: tests\lyrics-cdg.test.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\mock-api.mjs" "tests\mock-api.mjs" >nul || (echo [X] move failed: tests\mock-api.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\mock-specials.mjs" "tests\mock-specials.mjs" >nul || (echo [X] move failed: tests\mock-specials.mjs & set MOVEFAIL=1)
move /Y "%DROP%\tests\specials.e2e.mjs" "tests\specials.e2e.mjs" >nul || (echo [X] move failed: tests\specials.e2e.mjs & set MOVEFAIL=1)
if defined MOVEFAIL (echo [X] One or more moves failed - fix and re-run & exit /b 1)
echo     moved.
echo.
echo === 2/4  Patching site\booking.html + site\events.html ===
node patches\patch-app-2026-09-11a.cjs || (echo [X] PATCH FAILED - nothing was changed in the file that failed & exit /b 1)
echo.
echo === 3/4  Build-marker check - EVERY file below must print ===
findstr /M /C:"NGH-BUILD 2026-09-11a" .github\workflows\ngh-app-android.yml capacitor\.gitignore capacitor\package.json capacitor\scripts\patch-android.mjs capacitor\scripts\sync-web.mjs docs\NGH-APP-ARCHITECTURE.md docs\NGH-APP-SETUP.md docs\NGH-LIGHTSPEED-INTEGRATION.md netlify.toml netlify\functions\_shared\lightspeed-core.mjs netlify\functions\_shared\lightspeed.mjs netlify\functions\account.mjs netlify\functions\auto-cancel.mjs netlify\functions\companion.mjs netlify\functions\create-checkout.mjs netlify\functions\karaoke.mjs netlify\functions\lightspeed.mjs netlify\functions\registrations.mjs netlify\functions\shop-sync.mjs netlify\functions\shop.mjs netlify\functions\specials.mjs netlify\functions\stripe-webhook.mjs netlify\functions\ticket.mjs patches\patch-app-2026-09-11a.cjs rack-player\INSTALL-KARAOKE-PLAYER.cmd rack-player\ngh-karaoke-player.mjs site\.well-known\apple-app-site-association site\app\account.html site\app\app.css site\app\companion\first-player.html site\app\companion\index.html site\app\companion\life-counter.html site\app\companion\rpg.html site\app\companion\turn-tracker.html site\app\guru-lightspeed.html site\app\guru-specials.html site\app\index.html site\app\karaoke\cdg.js site\app\karaoke\host.html site\app\karaoke\index.html site\app\karaoke\join.html site\app\karaoke\karaoke-client.js site\app\karaoke\karaoke-lyrics.js site\app\karaoke\providers.js site\app\karaoke\tv.html site\app\ngh-app.js site\app\shop-orders.html site\app\shop.html site\app\specials.html site\app\sw.js
findstr /M /C:"NGH-BUILD 2026-09-11a" site\app\trivia\play.html site\ngh-config.js tests\.gitignore tests\_karaoke-hooks.mjs tests\_mock-hooks.mjs tests\_register-karaoke.mjs tests\check-scripts-all.mjs tests\check-scripts.mjs tests\companion.e2e.mjs tests\e2e-pages.mjs tests\index.js tests\karaoke-harness.mjs tests\karaoke.e2e.mjs tests\lightspeed.test.mjs tests\lyrics-cdg.test.mjs tests\mock-api.mjs tests\mock-specials.mjs tests\specials.e2e.mjs site\booking.html site\events.html
echo     (70 files above)
echo.
echo === 4/4  Files that can't carry a marker (images, JSON, fixtures) ===
if exist "capacitor\assets\icon-background.png" (echo     ok  capacitor\assets\icon-background.png) else (echo [X] MISSING capacitor\assets\icon-background.png)
if exist "capacitor\assets\icon-foreground.png" (echo     ok  capacitor\assets\icon-foreground.png) else (echo [X] MISSING capacitor\assets\icon-foreground.png)
if exist "capacitor\assets\icon-only.png" (echo     ok  capacitor\assets\icon-only.png) else (echo [X] MISSING capacitor\assets\icon-only.png)
if exist "capacitor\assets\splash-dark.png" (echo     ok  capacitor\assets\splash-dark.png) else (echo [X] MISSING capacitor\assets\splash-dark.png)
if exist "capacitor\assets\splash.png" (echo     ok  capacitor\assets\splash.png) else (echo [X] MISSING capacitor\assets\splash.png)
if exist "capacitor\capacitor.config.json" (echo     ok  capacitor\capacitor.config.json) else (echo [X] MISSING capacitor\capacitor.config.json)
if exist "rack-player\karaoke-config.example.json" (echo     ok  rack-player\karaoke-config.example.json) else (echo [X] MISSING rack-player\karaoke-config.example.json)
if exist "site\.well-known\assetlinks.json" (echo     ok  site\.well-known\assetlinks.json) else (echo [X] MISSING site\.well-known\assetlinks.json)
if exist "site\app\icons\apple-touch-icon.png" (echo     ok  site\app\icons\apple-touch-icon.png) else (echo [X] MISSING site\app\icons\apple-touch-icon.png)
if exist "site\app\icons\icon-1024.png" (echo     ok  site\app\icons\icon-1024.png) else (echo [X] MISSING site\app\icons\icon-1024.png)
if exist "site\app\icons\icon-192.png" (echo     ok  site\app\icons\icon-192.png) else (echo [X] MISSING site\app\icons\icon-192.png)
if exist "site\app\icons\icon-512.png" (echo     ok  site\app\icons\icon-512.png) else (echo [X] MISSING site\app\icons\icon-512.png)
if exist "site\app\icons\maskable-512.png" (echo     ok  site\app\icons\maskable-512.png) else (echo [X] MISSING site\app\icons\maskable-512.png)
if exist "site\app\manifest.webmanifest" (echo     ok  site\app\manifest.webmanifest) else (echo [X] MISSING site\app\manifest.webmanifest)
if exist "tests\fixtures\test.cdg" (echo     ok  tests\fixtures\test.cdg) else (echo [X] MISSING tests\fixtures\test.cdg)
if exist "tests\fixtures\test.lrc" (echo     ok  tests\fixtures\test.lrc) else (echo [X] MISSING tests\fixtures\test.lrc)
echo.
echo ===================================================================
echo  GitHub Desktop should show 86 changed files:
echo    76 new + 8 replaced + booking.html + events.html (patched)
echo  Commit message:
echo    NGH-BUILD 2026-09-11a - NGH App, Karaoke Battle, Game Companion, Specials, Lightspeed
echo  Then: docs\NGH-APP-SETUP.md  (Netlify env vars, Lightspeed, rack PC, TVs, app stores)
echo ===================================================================
endlocal
