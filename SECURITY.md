# Security Policy

PurrCam is a self-hosted home camera and monitoring system designed to run on your local network, with optional encrypted remote access over 4G/5G via a Cloudflare Quick Tunnel, Tailscale, or your own reverse proxy.

## Security Architecture & Trust Boundaries

### 1. Local LAN vs. External Tunnel Boundary
PurrCam enforces a strict separation between **local** callers and **external / proxied** callers:

- A request or WebSocket connection is classified as **external** if **any** proxy header is present (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`, `forwarded`, `x-real-ip`) **or** the TCP socket peer address is outside loopback (`127.0.0.0/8`, `::1`) and private LAN ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, IPv6 ULA/link-local).
- **Admin & Host-Management Endpoints Are Strictly Local-Only (`403 Forbidden`)**:
  - `GET /api/remote/config`, `PUT /api/remote/config`
  - `POST /api/remote/start`, `POST /api/remote/stop`
  - `POST /api/system/adb-reverse`, `GET /api/system/logs`
  - All of these return **`403 Forbidden`** to any external/tunneled request **even if a valid viewer access token is provided**. Remote viewers can only watch the stream and operate camera controls — never run `adb`, inspect host logs, or reconfigure tunnels/credentials.
  - Admin endpoints omit wildcard CORS headers (`Access-Control-Allow-Origin: *`).
- **Public Info Hygiene**: `GET /api/info` never exposes the access token or TURN credentials.

### 2. Authentication, Token Entropy & Rate Limiting
- **192-bit Access Tokens**: Starting a remote tunnel automatically generates a cryptographically random 192-bit URL-safe token (`crypto.randomBytes(24).toString("base64url")`, 32 characters) if none is configured, and persists it locally in `server/data/config.json` (gitignored).
- **Constant-Time Verification**: All HTTP and WebSocket token comparisons hash inputs with SHA-256 and compare via `crypto.timingSafeEqual` to prevent timing side channels.
- **Brute-Force Rate Limiting**: An in-memory per-IP sliding-window limiter throttles repeated failed authentication attempts (15 failures per 5 minutes → HTTP `429 Too Many Requests` / WebSocket close `4029`).
- **Token Leakage Prevention**:
  - All HTTP responses include `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`.
  - When opening the Web UI with `?token=...`, the client saves the token to `localStorage` and immediately strips `?token=...` from the browser URL via `window.history.replaceState(...)` so it does not persist in address bars or browser history.

### 3. Input, Upload & Transport Hardening
- **Snapshot Validation**: `POST /api/snapshots` enforces a 10 MB size cap and verifies JPEG magic bytes (`0xFF 0xD8 0xFF`), rejecting invalid or disguised payloads with `400 Bad Request`.
- **Sandboxed Serving**: `GET /snapshots/:filename` enforces strict basename-only filename validation (preventing path traversal) and serves files with `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`.
- **Payload Caps**: WebSocket frames are capped at `256 KB` and JSON API request bodies at `64 KB`.
- **Safe Process Execution**: Local ADB helper execution uses `execFile` without a shell and validates device serial strings against `^[A-Za-z0-9._:-]+$`.

### 4. Android App & Optional Root Safety
- **No Cloud Credential Backup**: `AndroidManifest.xml` disables cloud/ADB backup (`android:allowBackup="false"`, `android:fullBackupContent="false"`) so server URLs and access tokens are never backed up externally.
- **Private Camera Service**: `CameraStreamService` declares `android:exported="false"` so third-party apps cannot bind or control the camera foreground service.
- **Deep Link Confirmation**: Opening a `purrcam://connect?...` pairing link never silently overwrites saved server URLs or tokens — the app displays a confirmation dialog showing the parsed Local URL, Remote URL, and masked token before applying any changes.
- **Strictly Whitelisted Root Commands**: Optional root features (0-nit hardware backlight off and 80% battery charge guard) only run when the user explicitly grants root in KernelSU/Magisk. `RootPowerController` only writes validated, bounded integers (`0`, `1`, or `0..maxBrightness`) to canonical whitelisted sysfs paths under `/sys/class/backlight/`, `/sys/class/power_supply/battery/`, and `/sys/class/thermal/` — no remote or user-supplied strings are ever interpolated into a root shell command.

## Operational Recommendations
- Keep your **Access Token** private and rotate it via the **Connect** tab if you ever share a link or suspect exposure.
- Stop the Cloudflare Quick Tunnel when you do not need away-from-home access (Quick Tunnel URLs are ephemeral and rotate on every start).
- For long-term remote deployments, consider placing PurrCam behind **Tailscale** or your own authenticated HTTPS reverse proxy with a dedicated TURN server.

## Reporting a Vulnerability

If you discover a security vulnerability in PurrCam:

1. **Please do not open a public GitHub issue** with exploit details.
2. Report it privately using **GitHub Security Advisories** ("Security" → "Report a vulnerability" in this repository).
3. Include a clear description of the issue, reproduction steps, affected component (`server/`, `web/`, `android/`, or `protocol/`), and any suggested mitigation.

We aim to acknowledge reports within 72 hours and coordinate a fix before public disclosure.
