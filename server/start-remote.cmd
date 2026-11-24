@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo [PurrCam] Installing server dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo [PurrCam] npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\index.js" (
  echo [PurrCam] Building TypeScript server...
  call npm.cmd run build
  if errorlevel 1 (
    echo [PurrCam] Build failed.
    pause
    exit /b 1
  )
)

set "PURRCAM_REMOTE=1"
echo [PurrCam] Starting PC Hub Server with Auto VPN-Free Remote Access Tunnel...
node dist\index.js
endlocal
