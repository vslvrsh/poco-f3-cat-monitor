<div align="center">

# PurrCam

**Self-hosted cat baby monitor turning a Poco F3 (or any Android phone) into a multi-lens, ultra-low-latency WebRTC security camera with a Material 3 Expressive Android app, Web Monitor, and Native Windows Control Center.**

**[🇺🇸 English](README.md) · [🇷🇺 Русский гайд](README.ru.md)**

[![Kotlin](https://img.shields.io/badge/Android-Kotlin%20%2B%20Compose%20M3%20Expressive-7F52FF?logo=kotlin&logoColor=white)](android/)
[![WebRTC](https://img.shields.io/badge/Streaming-Camera2%20%2B%20WebRTC-10B981?logo=webrtc&logoColor=white)](protocol/PROTOCOL.md)
[![React](https://img.shields.io/badge/Web%20UI-React%2019%20%2B%20TypeScript-61DAFB?logo=react&logoColor=black)](web/)
[![Windows](https://img.shields.io/badge/Desktop-Windows%20PurrCam.exe-0078D6?logo=windows&logoColor=white)](server/desktop-launcher/)
[![License: MIT](https://img.shields.io/badge/License-MIT-F59E0B.svg)](LICENSE)

</div>

---

## Highlights

- **Single Unified Android APK (Camera Mode + Monitor Mode)**
  Install one Material 3 Expressive APK on both your **Poco F3** (Camera Mode) and your **daily Android phone** (Monitor Mode), complete with Dynamic Color (Android 12+), minimalist **Material You Themed Icons** (`<monochrome>` adaptive icon + matching status-bar icon), clean multi-tab navigation, pinch-to-zoom, talkback, and local Gallery snapshot saving.
- **True Poco F3 / Xiaomi Multi-Lens Camera2 Switching (`0.6× Wide` «Ширик»)**
  Bypasses WebRTC's default camera enumerator to directly probe Xiaomi auxiliary Camera2 IDs and logical multi-camera `physicalCameraIds`, classifying lenses by **35mm-equivalent focal length** (`36 × f / sensorWidth`) so `0.6× Wide`, `1× Main`, `Macro`, and `Front` hot-switch live without dropping WebRTC viewers.
- **24/7 AMOLED Burn-In Protection & Optional Root Hardware Guard**
  - Pitch-black `#000000` cat-proof AMOLED blackout overlay (1.5s long-press or triple-tap unlock).
  - Optional **KernelSU / Magisk root** features: **0-nit hardware backlight off** (`/sys/class/backlight/*/brightness` with automatic restore) and **80% Battery Charge Guard** (pauses charging at 80%, resumes at 70% via Qualcomm/Xiaomi power-supply sysfs).
- **Native Windows Control Center (`PurrCam.exe`) + System Tray**
  Double-click `PurrCam.exe` to start the PC hub server in the background, keep Windows awake while streaming (`Keep PC Awake`), open the M3 Expressive desktop app window, toggle 1-click VPN-free remote access, run 1-click USB `adb reverse`, and minimize cleanly to the system tray.
- **1-Click, Zero-Signup, VPN-Free 4G/5G Remote Access + Auto-Sync Beacon**
  - **`Auto (No VPN)` Multi-Provider Tunnel Engine**: Uses Windows built-in OpenSSH for zero-account, non-Cloudflare tunnels (**`localhost.run`** → automatic failover to **`Pinggy :443`** → **`Cloudflare HTTP/2`**) backed by a 30-second live health probe and self-healing watchdog.
  - **Encrypted Auto-Discovery Beacon**: Publishes tunnel URL rotations end-to-end encrypted with **AES-256-GCM** (derived from your 192-bit token) to `ntfy.sh` and `ntfy.envs.net` — paired phones and browsers automatically follow URL refreshes forever with zero re-pairing!
  - **Automatic HTTPS / WebSocket Video Relay Fallback (`ws_relay`)**: If strict 4G/5G mobile CGNAT blocks WebRTC UDP (without TURN or VPN), PurrCam automatically falls back within 6 seconds to streaming upright JPEG video frames over the single TCP 443 tunnel (`LIVE · HTTPS Relay`).
- **24/7 Always-On Stability**: Removes Android 15–17's 6-hour `DATA_SYNC` foreground-service limit, adds instant `NetworkCallback` Wi-Fi ↔ 4G/5G handoff, Doze/battery-optimization exemption (auto-whitelisted with KernelSU root), Camera2 stall recovery, and 45s WebSocket heartbeat tolerance.

---

## Quick Install (GitHub Releases)

### 1. Windows PC Hub (`PurrCam-Windows-v1.1.1.zip`)
> **Prerequisite**: [Node.js 20+](https://nodejs.org/) installed on Windows.

1. Download [**`PurrCam-Windows-v1.1.1.zip`**](https://github.com/vslvrsh/poco-f3-cat-monitor/releases/latest/download/PurrCam-Windows-v1.1.1.zip) and extract it to any folder (e.g., `C:\PurrCam`).
2. Double-click **`PurrCam.exe`** — it starts the local signaling server on port `8787`, keeps the PC awake while active, creates a system tray icon, and opens the PurrCam Monitor window automatically.
3. *(Optional)* Use `server\start-remote.cmd` to start with VPN-free `Auto` remote access enabled immediately.

### 2. Android Phones (`PurrCam-Android-v1.1.1.apk`)
1. Download [**`PurrCam-Android-v1.1.1.apk`**](https://github.com/vslvrsh/poco-f3-cat-monitor/releases/latest/download/PurrCam-Android-v1.1.1.apk) and install it on:
   - Your **Poco F3** (or spare Android 9+ phone) → choose **Camera Mode**.
   - Your **main Android phone** → choose **Monitor Mode**.
2. Grant **Camera**, **Microphone**, and **Notifications** permissions when prompted, and disable battery optimization for PurrCam on the Camera phone for 24/7 background reliability (automatic when KernelSU root is granted).
3. Connect over **Local Wi-Fi** by scanning the QR code on the PC **Connect** tab (or connect over USB using **`adb reverse tcp:8787 tcp:8787`** and `ws://127.0.0.1:8787/ws`).

### 3. Optional Root Setup (Poco F3 — KernelSU / Magisk)
Root is **not required** for streaming, `0.6× Wide` switching, AMOLED black screen, or CPU/battery temperatures. To unlock **0-nit hardware backlight off**, **80% Battery Charge Guard**, and automatic Doze whitelisting:
1. Open **KernelSU Manager** (or **Magisk**) on your Poco F3.
2. Grant superuser access to **PurrCam** (`com.purrcam.app`).
3. Toggle **Root Display Off** and **80% Charge Guard** from the **Health** tab (on the phone or remotely from PC/Monitor).

---

## Remote Access (4G/5G Outside Home Wi-Fi — No VPN, No Accounts)

Watch your cat from anywhere over cellular 4G/5G with zero router port forwarding, zero VPN, and zero third-party accounts:

1. **Start the Always-On Remote Tunnel on your PC**:
   - Open PurrCam on your PC → go to the **Connect** tab → leave provider on **`Auto (No VPN)`** → click **Start Remote Tunnel**.
   - PurrCam launches a zero-signup SSH HTTPS/WSS tunnel (`localhost.run` with automatic failover to `Pinggy :443` and `Cloudflare HTTP/2`), generates a **32-character (192-bit) Access Token**, and activates the **Auto-Sync Encrypted Beacon** (`ntfy.sh` + `ntfy.envs.net`).
   - A built-in 30-second health watchdog automatically restarts or switches providers if a tunnel ever drops or rotates, and broadcasts the AES-256-GCM encrypted new URL so paired devices reconnect automatically.
2. **Pair Your Main Phone Once (1-Tap `purrcam://` Link or QR)**:
   - On the **Connect** tab, switch to **Remote (4G/5G)** and either scan the QR code or click **Copy `purrcam://` Pairing Link** and send it to your phone.
   - Open the link (or tap **Paste Pairing Link** inside PurrCam Android) and confirm in the dialog.
   - PurrCam saves **both** your Local Wi-Fi URL and Remote `wss://` URL + Token: at home it connects directly over Wi-Fi; outside on 4G/5G it fails over to the encrypted tunnel — and if the tunnel URL ever rotates, your phone automatically fetches & decrypts the fresh URL from the beacon!
3. **Automatic HTTPS Video Relay Fallback (Zero TURN Needed)**:
   - PurrCam tries low-latency WebRTC first (`Auto` stream mode). If your mobile carrier's CGNAT blocks WebRTC UDP, PurrCam automatically switches within 6 seconds to **HTTPS Relay (`ws_relay`)**, streaming upright video over the same TCP 443 tunnel (`LIVE · HTTPS Relay`).
   - *(Optional)* For full-framerate WebRTC over strict CGNAT, you can still add a free TURN relay (e.g., [Metered.ca](https://www.metered.ca/tools/openrelay/), [Cloudflare Calls TURN](https://developers.cloudflare.com/calls/turn/), or self-hosted `coturn`) in the **TURN Relay** section.
4. **Watch from Any Browser**:
   - Open your remote HTTPS URL with `/?token=<YOUR_TOKEN>` on any phone or laptop browser. The web app saves the token and immediately strips `?token=...` from the URL bar for privacy.

> **Security Note**: Over any external tunnel (`localhost.run`, `Pinggy`, `Cloudflare`, or custom), all protected API and WebSocket requests require your 192-bit Access Token (`401` / WS `4001` without it), PC admin/host endpoints (`/api/remote/*`, `/api/system/*`) strictly return **`403 Forbidden`** even with a valid token, and the auto-discovery beacon only publishes opaque AES-256-GCM ciphertext. See [SECURITY.md](SECURITY.md) for the full threat model.

---

## Architecture

```
┌───────────────────────────┐         WebRTC (Video + Audio + Talkback)         ┌───────────────────────────┐
│   Poco F3 (Camera Mode)   │◄═════════════════════════════════════════════════►│  PC Browser / Android App │
│  Camera2 (0.6×/1×/Macro)  │                                                   │       (Monitor Mode)      │
│  AMOLED Blackout + Root   │         WebSocket (/ws) Signaling & Telemetry     │  M3 Expressive Live View  │
└─────────────┬─────────────┘◄───────────────────────┬─────────────────────────►└─────────────▲─────────────┘
              │ LAN / USB                            │                                        │ LAN or
              │ (adb reverse)                        ▼                                        │ 4G/5G HTTPS/WSS
              │                        ┌───────────────────────────┐                          │ (Cloudflare +
              └───────────────────────►│   PC Hub Server (:8787)   │◄─────────────────────────┘  192-bit Token)
                                       │  Node 24 + TS + ws + UI   │
                                       │  PurrCam.exe Tray Control │
                                       └───────────────────────────┘
```

### Repository Layout

```
poco-f3-cat-monitor/
├── protocol/PROTOCOL.md   # Shared PurrCam Protocol v1.2 wire contract (WS + Beacon + ws_relay + REST)
├── server/                # Node.js + TypeScript signaling hub, tunnel manager, storage & Windows launcher
├── web/                   # React 19 + TypeScript + Vite + Tailwind M3 Expressive web monitor
├── android/               # Single Kotlin + Jetpack Compose M3 Expressive APK (Camera + Monitor modes)
├── SECURITY.md            # Security architecture, trust boundaries & vulnerability reporting
├── LICENSE                # MIT License
└── README.ru.md           # Full Russian guide (Полное руководство на русском)
```

---

## Building from Source

```bash
git clone https://github.com/vslvrsh/poco-f3-cat-monitor.git
cd poco-f3-cat-monitor
```

### 1. Web Frontend (`web/`)
> On Windows PowerShell, use `npm.cmd` and `npx.cmd` if script execution policy blocks `npm.ps1`.

```bash
cd web
npm install
npx tsc --noEmit
npm run build
```

### 2. PC Server & Windows `.exe` (`server/`)
```bash
cd server
npm install
npm run typecheck
npm run build
npm test
npm start
```
To compile the native Windows tray launcher (`PurrCam.exe`, requires Windows .NET Framework `csc.exe`):
```bash
# Local build
npm run build:exe

# Portable zero-path release build (resolves ./server/dist/index.js and PATH node.exe)
node desktop-launcher/build-exe.mjs --portable
```

### 3. Android APK (`android/`)
Requires **JDK 21** (or JDK 17) and **Android SDK** (`compileSdk 36`, `build-tools 36.0.0`):
```bash
cd android
# Debug APK
./gradlew assembleDebug testDebugUnitTest

# Signed Release APK (supply your own keystore via environment variables or Gradle properties)
# PURRCAM_KEYSTORE_PATH, PURRCAM_KEYSTORE_PASSWORD, PURRCAM_KEY_ALIAS, PURRCAM_KEY_PASSWORD
./gradlew assembleRelease
```

---

## Documentation & License

- **Wire Protocol Specification**: [protocol/PROTOCOL.md](protocol/PROTOCOL.md)
- **Security Policy**: [SECURITY.md](SECURITY.md)
- **Русский гайд**: [README.ru.md](README.ru.md)
- **License**: [MIT](LICENSE) © 2026 [vslvrsh](https://github.com/vslvrsh)
