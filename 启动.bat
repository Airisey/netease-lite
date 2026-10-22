@echo off
rem ============================================================
rem  NetEase Cloud Music Lite - Windows launcher
rem  Double-click this file to start the client.
rem
rem  ELECTRON_DISABLE_SANDBOX must be set HERE, as an environment
rem  variable. Setting it from inside main.js is too late: Chromium
rem  initialises its sandbox before the main script runs, so the
rem  process dies with a 0xC0000005 access violation before any
rem  JavaScript executes.
rem
rem  Usage:  启动.bat [--dev] [extra electron args...]
rem ============================================================
setlocal
cd /d "%~dp0"

set ELECTRON_DISABLE_SANDBOX=1
set ELECTRON_DISABLE_SECURITY_WARNINGS=1
rem Some shells export this; it turns electron.exe into a plain Node
rem interpreter and the app would exit immediately.
set ELECTRON_RUN_AS_NODE=

set EXE=node_modules\electron\dist\electron.exe
if not exist "%EXE%" (
  echo [ERROR] Electron not found. Run "npm install" first.
  echo         Missing: %EXE%
  pause
  exit /b 1
)

if "%~1"=="--dev" (
  set ELECTRON_ENABLE_LOGGING=1
  shift
  start "" "%EXE%" . --dev %1 %2 %3 %4
) else (
  start "" "%EXE%" . %*
)
endlocal
