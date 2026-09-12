@echo off
REM NGH-BUILD 2026-09-11a — installs ngh-karaoke-player as a Windows service on the rack PC
REM Prereqs already on the rack PC: Node 24 (winget), C:\NGH\mpv\mpv.com, C:\NGH\nssm.exe
setlocal
set DEST=C:\NGH\karaoke-player
set NODE=C:\Program Files\nodejs\node.exe
if not exist "%DEST%" mkdir "%DEST%"
if not exist "C:\NGH\karaoke\media" mkdir "C:\NGH\karaoke\media"
if not exist "C:\NGH\logs" mkdir "C:\NGH\logs"
copy /Y "%~dp0ngh-karaoke-player.mjs" "%DEST%\ngh-karaoke-player.mjs" >nul
if not exist "%DEST%\config.json" copy /Y "%~dp0karaoke-config.example.json" "%DEST%\config.json" >nul
echo.
echo === Audio devices (copy the X-USB "OUT 5-6" line into config.json "audioDevice") ===
"%NODE%" "%DEST%\ngh-karaoke-player.mjs" devices | findstr /I "wasapi"
echo.
echo Edit %DEST%\config.json now (playerKey, adminCode, audioDevice). Press any key when saved...
pause >nul
C:\NGH\nssm.exe stop ngh-karaoke-player >nul 2>&1
C:\NGH\nssm.exe remove ngh-karaoke-player confirm >nul 2>&1
C:\NGH\nssm.exe install ngh-karaoke-player "%NODE%" "%DEST%\ngh-karaoke-player.mjs"
C:\NGH\nssm.exe set ngh-karaoke-player AppDirectory "%DEST%"
C:\NGH\nssm.exe set ngh-karaoke-player AppStdout "C:\NGH\logs\karaoke-player.log"
C:\NGH\nssm.exe set ngh-karaoke-player AppStderr "C:\NGH\logs\karaoke-player.log"
C:\NGH\nssm.exe set ngh-karaoke-player AppRotateFiles 1
C:\NGH\nssm.exe set ngh-karaoke-player AppRotateBytes 5000000
C:\NGH\nssm.exe set ngh-karaoke-player Start SERVICE_AUTO_START
C:\NGH\nssm.exe start ngh-karaoke-player
echo.
echo Service started. Log: C:\NGH\logs\karaoke-player.log
echo Import your library any time:  "%NODE%" "%DEST%\ngh-karaoke-player.mjs" import
echo Allow Windows Firewall for Node on port 8766 only if you want TVs on the LAN to use it (not required).
pause
