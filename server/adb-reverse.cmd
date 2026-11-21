@echo off
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8787"

where adb >nul 2>&1
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
    set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
  ) else (
    echo [PurrCam] adb.exe not found in PATH or Android SDK platform-tools.
    exit /b 1
  )
) else (
  set "ADB=adb"
)

echo [PurrCam] Connected ADB devices:
"%ADB%" devices -l
echo.
echo [PurrCam] Setting up USB tunnel: adb reverse tcp:%PORT% tcp:%PORT%
"%ADB%" reverse tcp:%PORT% tcp:%PORT%
if errorlevel 1 (
  echo [PurrCam] Failed to set adb reverse. Make sure USB debugging is authorized on the phone.
  exit /b 1
)
echo [PurrCam] Success! Poco F3 can now connect to ws://127.0.0.1:%PORT%/ws over USB.
endlocal
