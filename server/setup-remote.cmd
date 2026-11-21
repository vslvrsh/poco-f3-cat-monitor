@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo [PurrCam] Installing server dependencies...
  call npm.cmd install
  if errorlevel 1 exit /b 1
)

if not exist "dist\tunnel.js" (
  echo [PurrCam] Building TypeScript server...
  call npm.cmd run build
  if errorlevel 1 exit /b 1
)

echo [PurrCam] Checking / downloading official cloudflared binary for Remote Access...
node -e "import('./dist/config.js').then(async ({PurrCamConfigStore}) => { const {RemoteTunnelManager} = await import('./dist/tunnel.js'); const cs = new PurrCamConfigStore({ dataDir: './data' }); await cs.init(); const tm = new RemoteTunnelManager({ binDir: './bin', configStore: cs, getPort: () => 8787 }); const p = await tm.ensureCloudflaredBinary(); console.log('[PurrCam] cloudflared ready at:', p); });"
if errorlevel 1 (
  echo [PurrCam] Failed to set up cloudflared.
  exit /b 1
)
echo [PurrCam] Remote Access setup complete! Run start-remote.cmd or enable Remote Access in the Connect tab.
endlocal
