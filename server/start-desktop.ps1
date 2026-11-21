param(
  [int]$Port = 8787,
  [switch]$AdbReverse,
  [switch]$Remote,
  [switch]$NoBrowser,
  [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
$ServerDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ServerDir

function Find-Adb {
  $cmd = Get-Command adb -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $sdkAdb = Join-Path $env:LOCALAPPDATA "Android\Sdk\platform-tools\adb.exe"
  if (Test-Path $sdkAdb) { return $sdkAdb }
  return $null
}

function Find-AppBrowser {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:LOCALAPPDATA}\Google\Chrome\Application\chrome.exe"
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path $path)) { return $path }
  }
  return $null
}

function Test-ServerReady([int]$TargetPort) {
  try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$TargetPort/api/info" -TimeoutSec 2
    return ($resp.name -eq "PurrCam")
  } catch {
    return $false
  }
}

# 1. Optional ADB USB reverse tunnel (also runs automatically if -AdbReverse or if a phone is ready)
$adb = Find-Adb
if ($adb) {
  $devicesOut = & $adb devices 2>$null | Out-String
  $hasOnlineDevice = ($devicesOut -match "(?m)^\S+\s+device\r?$")
  if ($AdbReverse -or $hasOnlineDevice) {
    Write-Host "[PurrCam] Configuring ADB USB reverse tcp:$Port -> tcp:$Port ..." -ForegroundColor Cyan
    & $adb reverse "tcp:$Port" "tcp:$Port" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[PurrCam] ADB USB reverse active (ws://127.0.0.1:$Port/ws)." -ForegroundColor Green
    } elseif ($AdbReverse) {
      Write-Warning "[PurrCam] adb reverse failed; ensure USB debugging is authorized."
    }
  }
}

# 2. Ensure dependencies & build exist
if (-not (Test-Path (Join-Path $ServerDir "node_modules"))) {
  Write-Host "[PurrCam] Installing server dependencies..." -ForegroundColor Yellow
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw "npm.cmd install failed" }
}

if ($Rebuild -or -not (Test-Path (Join-Path $ServerDir "dist\index.js"))) {
  Write-Host "[PurrCam] Building PurrCam server..." -ForegroundColor Yellow
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "npm.cmd run build failed" }
}

# 3. Start server if not already running on this port
if (-not (Test-ServerReady -TargetPort $Port)) {
  Write-Host "[PurrCam] Starting PurrCam server on port $Port..." -ForegroundColor Cyan
  $env:PORT = "$Port"
  if ($Remote) {
    $env:PURRCAM_REMOTE = "1"
    Write-Host "[PurrCam] Remote Access (Cloudflare Quick Tunnel) enabled." -ForegroundColor Cyan
  }
  Start-Process -FilePath "node" `
    -ArgumentList "dist\index.js" `
    -WorkingDirectory $ServerDir `
    -WindowStyle Minimized

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-ServerReady -TargetPort $Port) {
      $ready = $true
      break
    }
  }
  if (-not $ready) {
    throw "PurrCam server did not respond on http://127.0.0.1:$Port/api/info"
  }
} else {
  Write-Host "[PurrCam] Server is already running on port $Port." -ForegroundColor Green
}

$info = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/info" -TimeoutSec 2
Write-Host "[PurrCam] Local : http://localhost:$Port" -ForegroundColor Green
if ($info.lanIps -and $info.lanIps.Count -gt 0) {
  Write-Host "[PurrCam] LAN   : http://$($info.lanIps[0]):$Port  ($($info.wsUrl))" -ForegroundColor Green
}

# 4. Open Chrome/Edge in standalone desktop app window mode
if (-not $NoBrowser) {
  $url = "http://localhost:$Port"
  $browser = Find-AppBrowser
  if ($browser) {
    Write-Host "[PurrCam] Launching desktop app window via $(Split-Path -Leaf $browser)..." -ForegroundColor Cyan
    Start-Process -FilePath $browser -ArgumentList "--app=$url", "--window-size=1280,820"
  } else {
    Write-Host "[PurrCam] Opening default browser at $url..." -ForegroundColor Cyan
    Start-Process $url
  }
}
