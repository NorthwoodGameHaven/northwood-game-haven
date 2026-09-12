@echo off
REM ===================================================================
REM  APPLY-2026-09-12a.cmd  —  NGH-BUILD 2026-09-12a  (5-file patch)
REM  Only the files that changed since 2026-09-11a r2 (already live).
REM  Extract this zip to %USERPROFILE%\Downloads\ngh-2026-09-12a
REM  then run this from the REPO ROOT (the folder with site\ and netlify\).
REM ===================================================================
setlocal EnableExtensions
set DROP=%USERPROFILE%\Downloads\ngh-2026-09-12a
if not exist "%DROP%\APPLY-2026-09-12a.cmd" (echo [X] Drop not found at %DROP% & exit /b 1)
if not exist "netlify\functions\create-checkout.mjs" (echo [X] Run this from the repo root & exit /b 1)
where node >nul 2>&1 || (echo [X] Node is not on PATH & exit /b 1)
echo.
echo === 1/3  Copying 5 files ===
copy /Y "%DROP%\netlify\functions\_shared\lightspeed.mjs" "netlify\functions\_shared\lightspeed.mjs" >nul || (echo [X] copy failed: lightspeed.mjs & set FAIL=1)
copy /Y "%DROP%\netlify\functions\create-checkout.mjs"    "netlify\functions\create-checkout.mjs"    >nul || (echo [X] copy failed: create-checkout.mjs & set FAIL=1)
copy /Y "%DROP%\tests\lightspeed.test.mjs"                "tests\lightspeed.test.mjs"                >nul || (echo [X] copy failed: lightspeed.test.mjs & set FAIL=1)
copy /Y "%DROP%\docs\NGH-LIGHTSPEED-INTEGRATION.md"       "docs\NGH-LIGHTSPEED-INTEGRATION.md"       >nul || (echo [X] copy failed: NGH-LIGHTSPEED-INTEGRATION.md & set FAIL=1)
copy /Y "%DROP%\docs\NGH-APP-SETUP.md"                    "docs\NGH-APP-SETUP.md"                    >nul || (echo [X] copy failed: NGH-APP-SETUP.md & set FAIL=1)
if defined FAIL (echo. & echo [X] One or more copies failed - nothing else run. & exit /b 1)
echo     5 files copied.
echo.
echo === 2/3  Marker check ===
findstr /C:"NGH-BUILD 2026-09-12a" "netlify\functions\_shared\lightspeed.mjs" >nul && echo     lightspeed.mjs OK || echo     [X] marker missing in lightspeed.mjs
findstr /C:"NGH-BUILD 2026-09-12a" "netlify\functions\create-checkout.mjs"    >nul && echo     create-checkout.mjs OK || echo     [X] marker missing in create-checkout.mjs
echo.
echo === 3/3  Tests ===
node --test tests\lightspeed.test.mjs
echo.
echo Done. Commit + push in GitHub Desktop; Netlify builds from main automatically.
endlocal
