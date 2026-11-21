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
  Install one Material 3 Expressive APK on both your **Poco F3** (Camera Mode) and your **daily Android phone** (Monitor Mode), complete with Dynamic Color (Android 12+), clean multi-tab navigation, pinch-to-zoom, talkback, and local Gallery snapshot saving.
- **True Poco F3 / Xiaomi Multi-Lens Camera2 Switching (`0.6× Wide` «Ширик»)**
  Bypasses WebRTC's default camera enumerator to directly probe Xiaomi auxiliary Camera2 IDs and logical multi-camera `physicalCameraIds`, classifying lenses by **35mm-equivalent focal length** (`36 × f / sensorWidth`) so `0.6× Wide`, `1× Main`, `Macro`, and `Front` hot-switch live without dropping WebRTC viewers.
- **24/7 AMOLED Burn-In Protection & Optional Root Hardware Guard**
  - Pitch-black `#000000` cat-proof AMOLED blackout overlay (1.5s long-press or triple-tap unlock).
  - Optional **KernelSU / Magisk root** features: **0-nit hardware backlight off** (`/sys/class/backlight/*/brightness` with automatic restore) and **80% Battery Charge Guard** (pauses charging at 80%, resumes at 70% via Qualcomm/Xiaomi power-supply sysfs).
- **Native Windows Control Center (`PurrCam.exe`) + System Tray**
  Double-click `PurrCam.exe` to start the PC hub server in the background, open the M3 Expressive desktop app window, toggle Cloudflare remote access, run 1-click USB `adb reverse`, and minimize cleanly to the system tray.
- **Zero-Config 4G/5G Remote Access + Security by Default**
  Built-in **Cloudflare Quick Tunnel** (`cloudflared` auto-downloaded on demand), auto-generated 192-bit access tokens, `purrcam://connect` pairing links & QR codes, automatic **Local Wi-Fi → Remote 4G/5G failover**, and **TURN relay** support for strict mobile CGNAT.

---

## Quick Install (GitHub Releases)

### 1. Windows PC Hub (`PurrCam-Windows-v1.0.0.zip`)
> **Prerequisite**: [Node.js 20+](https://nodejs.org/) installed on Windows.

1. Download [**`PurrCam-Windows-v1.0.0.zip`**](https://github.com/vslvrsh/poco-f3-cat-monitor/releases/latest/download/PurrCam-Windows-v1.0.0.zip) and extract it to any folder (e.g., `C:\PurrCam`).
2. Double-click **`PurrCam.exe`** — it starts the local signaling server on port `8787`, creates a system tray icon, and opens the PurrCam Monitor window automatically.
3. *(Optional)* Use `server\start-remote.cmd` to start with a Cloudflare Quick Tunnel enabled immediately.

### 2. Android Phones (`PurrCam-Android-v1.0.0.apk`)
1. Download [**`PurrCam-Android-v1.0.0.apk`**](https://github.com/vslvrsh/poco-f3-cat-monitor/releases/latest/download/PurrCam-Android-v1.0.0.apk) and install it on:
   - Your **Poco F3** (or spare Android 9+ phone) → choose **Camera Mode**.
   - Your **main Android phone** → choose **Monitor Mode**.
2. Grant **Camera**, **Microphone**, and **Notifications** permissions when prompted.
3. Connect over **Local Wi-Fi** by scanning the QR code on the PC **Connect** tab (or connect over USB using **`adb reverse tcp:8787 tcp:8787`** and `ws://127.0.0.1:8787/ws`).

### 3. Optional Root Setup (Poco F3 — KernelSU / Magisk)
Root is **not required** for streaming, `0.6× Wide` switching, AMOLED black screen, or CPU/battery temperatures. To unlock **0-nit hardware backlight off** and **80% Battery Charge Guard**:
1. Open **KernelSU Manager** (or **Magisk**) on your Poco F3.
2. Grant superuser access to **PurrCam** (`com.purrcam.app`).
3. Toggle **Root Display Off** and **80% Charge Guard** from the **Health** tab (on the phone or remotely from PC/Monitor).

---

## Remote Access (4G/5G Outside Home Wi-Fi)

Watch your cat from anywhere over cellular 4G/5G without router port forwarding:

1. **Start the Cloudflare Tunnel on your PC**:
   - Open PurrCam on your PC → go to the **Connect** tab → click **Start Remote Tunnel (Cloudflare)**.
   - On first run, the server automatically downloads the official `cloudflared` binary into `server/bin/` and generates a **32-character (192-bit) Access Token**.
   - Within a few seconds you will see your live `https://<tunnel-id>.trycloudflare.com` URL.
2. **Pair Your Main Phone (1-Tap `purrcam://` Link or QR)**:
   - On the **Connect** tab, switch to **Remote (4G/5G)** and either scan the QR code or click **Copy `purrcam://` Pairing Link** and send it to your phone.
   - Open the link (or tap **Paste Pairing Link** inside PurrCam Android) and confirm in the dialog.
   - PurrCam saves **both** your Local Wi-Fi URL and Remote `wss://` URL + Token: at home it connects directly over Wi-Fi (~2.5s check); outside on 4G/5G it automatically fails over to the encrypted tunnel.
3. **Watch from Any Browser**:
   - Open `https://<tunnel-id>.trycloudflare.com/?token=<YOUR_TOKEN>` on any phone or laptop browser. The web app saves the token and immediately strips `?token=...` from the URL bar for privacy.
4. **Optional TURN Relay (Recommended for Strict Mobile CGNAT)**:
   - Standard STUN works on most networks, but strict mobile carriers (symmetric CGNAT) may block direct peer-to-peer WebRTC UDP.
   - In the PC **Connect** tab → expand **TURN Relay (4G/5G NAT)** and enter a `turn:`/`turns:` URL, username, and credential from [Metered.ca Open Relay / Free TURN](https://www.metered.ca/tools/openrelay/), [Cloudflare Calls TURN](https://developers.cloudflare.com/calls/turn/), or your own `coturn` instance.
   - *(Alternatively, configure via environment variables `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, or `ICE_SERVERS_JSON`.)*

> **Security Note**: Over an external tunnel, all protected API and WebSocket requests require your Access Token (`401` / WS `4001` without it), and PC admin/host endpoints (`/api/remote/*`, `/api/system/*`) strictly return **`403 Forbidden`** even with a valid token. See [SECURITY.md](SECURITY.md) for the full threat model.

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
├── protocol/PROTOCOL.md   # Shared PurrCam Protocol v1.1 wire contract (WS + REST + Deep Links)
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
