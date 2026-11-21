# PurrCam Protocol v1.1

> Shared wire contract for **PurrCam** — self-hosted cat baby monitor connecting a rooted **Poco F3** camera node, a **PC Hub Server**, a **PC Web/Desktop Monitor**, and an **Android Monitor** app over Local LAN, USB (`adb reverse`), or Remote 4G/5G (Cloudflare Tunnel / Tailscale / Custom HTTPS + TURN).

---

## 1. Transport, Ports & Authentication

| Parameter | Default / Format | Notes |
| --- | --- | --- |
| Server Bind | `0.0.0.0:8787` | Configurable via `PORT` env var |
| Local HTTP Base | `http://<PC_IP>:8787` | Serves REST API, `/snapshots/*`, and built web client (`web/dist`) |
| Local WS Endpoint | `ws://<PC_IP>:8787/ws` | JSON text frames (`UTF-8`); USB tunnel: `ws://127.0.0.1:8787/ws` via `adb reverse tcp:8787 tcp:8787` |
| Remote HTTPS/WSS | `https://<host>` / `wss://<host>/ws` | Cloudflare Quick Tunnel (`*.trycloudflare.com`), Tailscale, or custom reverse proxy. **Never** append `:8787` to `https://` or `wss://` URLs. |
| Auth Token | `server/data/config.json` / `PURRCAM_TOKEN` | Empty by default for local-only use; auto-generated (192-bit / 32-char URL-safe `base64url`) when starting a remote tunnel if empty. Verified in constant time (`SHA-256` + `timingSafeEqual`). Supplied via `register.token` or `?token=<token>` on WS, and `Authorization: Bearer <token>`, `X-PurrCam-Token: <token>`, or `?token=<token>` on REST. |

### External vs. Local Security Model
- A request or WebSocket connection is treated as **external/tunneled** when ANY of the following hold:
  1. Any proxy header is present (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`, `forwarded`, `x-real-ip`), **or**
  2. Remote socket IP is outside loopback (`127.0.0.0/8`, `::1`) and private LAN (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` Tailscale CGNAT, IPv6 ULA/link-local).
- **External callers** MUST authenticate with the active `token` on all protected HTTP endpoints and `/ws` (missing/invalid token → HTTP `401 Unauthorized` or WS `error` + close `4001`; repeated auth failures → HTTP `429 Too Many Requests` / WS close `4029`).
- **Admin & Host-Management Endpoints Are Strictly Local-Only (`403 Forbidden`)**: `GET/PUT /api/remote/config`, `POST /api/remote/start|stop`, `POST /api/system/adb-reverse`, and `GET /api/system/logs` MUST return `403 Forbidden` for any external/tunneled request **even if a valid token is provided**, and omit `Access-Control-Allow-Origin: *`.
- **Security Headers & Limits**: All HTTP responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. WS frames are capped at `256 KB` and JSON API bodies at `64 KB`.
- Public `GET /api/info` MUST **never** leak `token` or TURN `credential` values.

### Roles
- **`"camera"`** — Streaming node (Poco F3 running PurrCam APK in Camera Mode). At most one active camera session at a time; a new valid camera registration replaces any stale connection.
- **`"viewer"`** — Viewing & remote-control client (`clientType: "web"` for PC/mobile browser or `"android"` for PurrCam APK in Monitor Mode). Multiple simultaneous viewers are supported, each with an isolated WebRTC `PeerConnection`.

### UI Language & Lens Label Convention (v1.1)
All UI copy, status pills, notifications, and default lens labels across Server, Web, and Android are **English**:
- Ultrawide: `0.6× Wide`
- Main: `1× Main`
- Macro: `Macro`
- Telephoto: `Tele`
- Front: `Front`

---

## 2. Shared Data Models

All field names are exact `camelCase` identifiers shared across **TypeScript** (`server/`, `web/`) and **Kotlin** (`android/`, `kotlinx.serialization`). Unknown fields MUST be ignored (`ignoreUnknownKeys = true`).

### 2.1 `LensInfo`

Describes one selectable camera lens exposed by the Camera2 enumerator (top-level `cameraId`, directly probed Xiaomi aux ID, or physical sub-camera of a logical multi-camera).

```ts
export type LensType = "ultrawide" | "wide" | "tele" | "macro" | "front" | "other";
export type LensFacing = "back" | "front";

export interface LensInfo {
  id: string;                      // Stable unique lens key (e.g. "ultrawide", "wide", "macro", "front")
  cameraId: string;                // Camera2 cameraId (e.g. "0", "1", "2", "3")
  physicalCameraId: string | null; // Physical sub-camera ID (API 28+ OutputConfiguration), or null if top-level
  label: string;                   // English UI pill label (e.g. "0.6× Wide", "1× Main", "Macro", "Front")
  type: LensType;                  // Semantic lens category (field name remains `type`)
  facing: LensFacing;              // "back" | "front"
  focalLengthMm: number;           // Physical focal length in mm (e.g. 1.65, 4.71)
  zoomFactor: number;              // Nominal zoom factor vs main rear lens (e.g. 0.6, 1.0, 1.9)
  hasFlash: boolean;               // Whether torch is supported on this lens
  maxZoom: number;                 // Maximum Camera2 zoom ratio (e.g. 10.0)
}
```

### 2.2 `CameraCapabilities`

```ts
export interface CameraCapabilities {
  torch: boolean;           // Rear LED flash torch available
  audioIn: boolean;         // Microphone capture available
  audioOut: boolean;        // Speaker playback (talkback / cat sounds) available
  root: boolean;            // Root (`su`) detected and usable
  chargeLimit: boolean;     // Root battery charge pause/resume sysfs supported
  rootDisplayOff?: boolean; // Optional: root hardware backlight off supported
}
```

### 2.3 `CameraState`

```ts
export type VideoResolution = "480p" | "720p" | "1080p";

export interface CameraState {
  activeLensId: string;        // Matches one LensInfo.id
  torch: boolean;              // Rear torch ON/OFF
  blackout: boolean;           // Pitch-black AMOLED blackout overlay active
  rootDisplayOff: boolean;     // Hardware backlight set to 0 via root (when blackout is true)
  resolution: VideoResolution; // "480p" (854x480) | "720p" (1280x720) | "1080p" (1920x1080)
  fps: number;                 // Target frame rate (e.g. 15, 24, 30)
  bitrateKbps: number;         // Target video bitrate in kbps (e.g. 800..4000)
  ev: number;                  // Exposure compensation in EV stops (e.g. -2.0..+2.0, default 0)
  zoomRatio: number;           // Active Camera2 zoom ratio (1.0..lens.maxZoom)
  micEnabled: boolean;         // Camera mic audio track enabled
  speakerEnabled: boolean;     // Camera speaker (incoming talkback) enabled
  chargeLimitEnabled: boolean; // Root 24/7 battery charge limiter enabled
  chargeLimitMaxPct: number;   // Pause charging threshold % (default 80; resume at maxPct - 10)
  streaming: boolean;          // Active camera capture pipeline running
}
```

### 2.4 `Telemetry`

Periodic health snapshot published by the camera every ~3 seconds.

```ts
export type ChargeSource = "ac" | "usb" | "wireless" | "none";

export interface Telemetry {
  ts: number;                 // Unix epoch ms (server fills Date.now() if omitted)
  batteryPct: number;         // 0..100
  charging: boolean;          // True while actively charging
  chargeSource: ChargeSource; // "ac" | "usb" | "wireless" | "none"
  chargePaused: boolean;      // True when root charge limiter paused charging
  batteryTempC: number;       // Battery temperature in °C (e.g. 29.5)
  cpuTempC: number | null;    // CPU/SoC temperature in °C, or null if unreadable
  voltageMv: number;          // Battery voltage in mV (e.g. 4206)
  currentMa: number;          // Battery current in mA (positive = charging, negative = discharging)
  wifiRssi: number | null;    // Wi-Fi RSSI in dBm (e.g. -31), or null if not on Wi-Fi
  uptimeSec: number;          // Camera streaming service uptime in seconds
  freeRamMb: number;          // Available system RAM in MB
  freeStorageMb: number;      // Available internal storage in MB
  activeLensId: string;       // Currently active LensInfo.id
  fps?: number;               // Optional measured capture FPS
  bitrateKbps?: number;       // Optional current/target bitrate in kbps
}
```

### 2.5 `IceServerConfig`, `RemoteStatus`, `RemoteConfig`, `CameraSummary`, `SnapshotMeta`

```ts
export interface IceServerConfig {
  urls: string | string[]; // e.g. "stun:stun.l.google.com:19302" or "turn:turn.example.com:3478"
  username?: string;       // Optional TURN username
  credential?: string;     // Optional TURN password/credential
}

export type RemoteTunnelStatus = "stopped" | "starting" | "running" | "error";
export type RemoteProvider = "cloudflare" | "tailscale" | "custom" | "none";

export interface RemoteStatus {
  enabled: boolean;
  status: RemoteTunnelStatus;
  provider: RemoteProvider;
  url: string | null;    // e.g. "https://<slug>.trycloudflare.com"
  wsUrl: string | null;  // e.g. "wss://<slug>.trycloudflare.com/ws"
  error?: string | null;
}

export interface RemoteConfig {
  token: string;
  customRemoteUrl: string | null;
  autoStartTunnel: boolean;
  iceServers: IceServerConfig[];
  pairingLink: string;   // "purrcam://connect?local=...&remote=...&token=..."
}

export interface CameraSummary {
  deviceId: string;
  deviceName: string;
  lenses: LensInfo[];
  capabilities: CameraCapabilities;
  state: CameraState;
  telemetry: Telemetry | null;
}

export interface SnapshotMeta {
  id: string;               // Unique snapshot ID
  filename: string;         // Safe JPEG filename on server
  url: string;              // Relative URL: "/snapshots/<filename>"
  createdAt: number;        // Unix epoch ms
  sizeBytes: number;        // Size in bytes
  lensLabel: string | null; // Active lens label at capture time (e.g. "0.6× Wide")
}
```

Default STUN servers (used when no custom `iceServers` are configured):
1. `stun:stun.l.google.com:19302`
2. `stun:stun1.l.google.com:19302`
3. `stun:stun.cloudflare.com:3478`

For reliable 4G/5G NAT traversal behind symmetric CGNAT, configure one or more `turn:`/`turns:` entries with `username` and `credential` via `PUT /api/remote/config` (or env `ICE_SERVERS_JSON` / `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`).

---

## 3. WebSocket Messages (`/ws`)

Every WebSocket frame is a JSON object with a required string `"type"` discriminator.

### 3.1 Registration & Presence

#### `register` (Client → Server)
Must be the first message sent after opening `/ws`.

Camera registration:
```json
{
  "type": "register",
  "role": "camera",
  "deviceId": "poco-f3-<device-serial>",
  "deviceName": "Poco F3",
  "lenses": [
    {
      "id": "ultrawide",
      "cameraId": "2",
      "physicalCameraId": null,
      "label": "0.6× Wide",
      "type": "ultrawide",
      "facing": "back",
      "focalLengthMm": 1.65,
      "zoomFactor": 0.6,
      "hasFlash": true,
      "maxZoom": 10.0
    }
  ],
  "capabilities": {
    "torch": true,
    "audioIn": true,
    "audioOut": true,
    "root": true,
    "chargeLimit": true,
    "rootDisplayOff": true
  },
  "state": {
    "activeLensId": "wide",
    "torch": false,
    "blackout": false,
    "rootDisplayOff": false,
    "resolution": "720p",
    "fps": 24,
    "bitrateKbps": 1800,
    "ev": 0,
    "zoomRatio": 1.0,
    "micEnabled": true,
    "speakerEnabled": true,
    "chargeLimitEnabled": false,
    "chargeLimitMaxPct": 80,
    "streaming": true
  },
  "token": ""
}
```
*Note:* `state` and `token` are optional on `register`. An empty `"token": ""` falls back to any `?token=...` query parameter on the WebSocket URL.

Viewer registration:
```json
{
  "type": "register",
  "role": "viewer",
  "clientId": "web-8f3a1b",
  "clientName": "PC Monitor",
  "clientType": "web",
  "token": ""
}
```
`clientType` is `"web" | "android"`.

#### `registered` (Server → Client)
Sent immediately upon successful registration (includes configured STUN + TURN servers with credentials).
```json
{
  "type": "registered",
  "id": "web-8f3a1b",
  "serverTime": 1795239300000,
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "stun:stun1.l.google.com:19302" },
    { "urls": "stun:stun.cloudflare.com:3478" }
  ]
}
```
On missing/invalid token (especially on external tunneled requests), server sends `{ "type": "error", "code": "UNAUTHORIZED", "message": "Invalid token" }` and closes the socket with code `4001`.

#### `camera_status` (Server → Viewer(s))
Sent immediately to a newly registered viewer, and broadcast to all viewers whenever the camera connects, disconnects, or updates lenses/state.
```json
{
  "type": "camera_status",
  "online": true,
  "camera": {
    "deviceId": "poco-f3-<device-serial>",
    "deviceName": "Poco F3",
    "lenses": [],
    "capabilities": { "torch": true, "audioIn": true, "audioOut": true, "root": true, "chargeLimit": true },
    "state": { "activeLensId": "wide", "torch": false, "blackout": false, "rootDisplayOff": false, "resolution": "720p", "fps": 24, "bitrateKbps": 1800, "ev": 0, "zoomRatio": 1.0, "micEnabled": true, "speakerEnabled": true, "chargeLimitEnabled": false, "chargeLimitMaxPct": 80, "streaming": true },
    "telemetry": null
  },
  "viewerCount": 1
}
```
When offline: `{ "type": "camera_status", "online": false, "camera": null, "viewerCount": 1 }`.

#### `remote_status` (Server → Viewers) *(Added in v1.1)*
Broadcast to connected viewers whenever remote tunnel state changes (start, running, error, stopped).
```json
{
  "type": "remote_status",
  "remote": {
    "enabled": true,
    "status": "running",
    "provider": "cloudflare",
    "url": "https://example.trycloudflare.com",
    "wsUrl": "wss://example.trycloudflare.com/ws",
    "error": null
  }
}
```

#### `viewer_joined` / `viewer_left` (Server → Camera)
```json
{ "type": "viewer_joined", "viewerId": "web-8f3a1b", "clientName": "PC Monitor", "clientType": "web" }
{ "type": "viewer_left", "viewerId": "web-8f3a1b" }
```

---

### 3.2 WebRTC Signaling

**Signaling role invariant (glare-free):**
1. The **Viewer** sends `watch_request`.
2. The **Camera** is always the WebRTC **Offerer**: creates a `PeerConnection` for `viewerId` with `iceServers` (passing both `username` and `credential` when present), attaches shared `VideoTrack` + `AudioTrack`, creates SDP offer, and sends `rtc_offer`.
3. The **Viewer** sets remote description, attaches optional local mic track (muted until Talk is pressed), creates SDP answer, and sends `rtc_answer`.
4. Both sides exchange trickle ICE candidates via `rtc_ice`.
5. For viewer-originated `watch_request`, `watch_stop`, `rtc_answer`, and `rtc_ice`, the server stamps `viewerId` with the sender's registered ID before forwarding to the camera.

```json
{ "type": "watch_request", "viewerId": "web-8f3a1b" }
{ "type": "watch_stop", "viewerId": "web-8f3a1b" }
{ "type": "rtc_offer", "viewerId": "web-8f3a1b", "sdp": "v=0\r\n..." }
{ "type": "rtc_answer", "viewerId": "web-8f3a1b", "sdp": "v=0\r\n..." }
{
  "type": "rtc_ice",
  "viewerId": "web-8f3a1b",
  "candidate": { "candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0 }
}
```

---

### 3.3 Telemetry & State Synchronization

#### `telemetry` (Camera → Server → Viewers)
```json
{ "type": "telemetry", "data": { /* Telemetry */ } }
```
Server appends `data` to its 720-sample persisted ring buffer and broadcasts to all viewers.

#### `state_update` (Camera → Server → Viewers)
```json
{ "type": "state_update", "state": { /* CameraState */ }, "lenses": [] }
```
`lenses` is optional; when present, server updates the cached lens list.

---

### 3.4 Remote Commands

#### `command` (Viewer → Server → Camera)
```json
{
  "type": "command",
  "commandId": "cmd-1795239310-1",
  "action": "switch_lens",
  "payload": { "lensId": "ultrawide" }
}
```

| `action` | `payload` Schema | Behavior on Camera |
| --- | --- | --- |
| `switch_lens` | `{ "lensId": string }` | Hot-switches Camera2 capturer to requested `LensInfo.id` without dropping active PeerConnections. |
| `set_torch` | `{ "enabled": boolean }` | Turns rear flash torch ON/OFF (`FLASH_MODE_TORCH`). |
| `set_blackout` | `{ "enabled": boolean, "rootDisplayOff"?: boolean }` | Enables/disables `#000000` AMOLED blackout overlay; when `rootDisplayOff: true` and root is available, writes `0` to backlight sysfs and restores on unlock. |
| `set_video_config` | `{ "resolution"?: "480p" \| "720p" \| "1080p", "fps"?: number, "bitrateKbps"?: number }` | Updates capture resolution, target FPS, and/or WebRTC max bitrate. |
| `set_exposure` | `{ "ev": number }` | Sets Camera2 exposure compensation in EV stops (clamped to AE range). |
| `set_zoom` | `{ "ratio": number }` | Sets Camera2 zoom (`CONTROL_ZOOM_RATIO` on API 30+ / `SCALER_CROP_REGION` fallback). |
| `set_audio` | `{ "micEnabled"?: boolean, "speakerEnabled"?: boolean }` | Mutes/unmutes outgoing mic track and/or incoming talkback speaker. |
| `set_charge_limit` | `{ "enabled": boolean, "maxPct"?: number }` | Enables/disables root 24/7 battery charge guard (default `maxPct = 80`, resume at `maxPct - 10`). |
| `request_snapshot` | `{}` | Captures a JPEG frame and uploads it via `POST /api/snapshots`. |
| `play_sound` | `{ "sound": "psps" \| "chime" \| "whistle" }` | Plays synthesized cat-attention audio cue on camera speaker. |
| `reboot_camera` | `{}` | Cleanly restarts capture pipeline & renegotiates active WebRTC sessions. |

#### `command_ack` (Camera → Server → Viewer(s))
```json
{ "type": "command_ack", "commandId": "cmd-1795239310-1", "ok": true, "error": null, "state": { /* CameraState */ } }
```

---

### 3.5 Snapshots, Heartbeat & Errors

```json
{ "type": "snapshot_saved", "snapshot": { /* SnapshotMeta */ } }
{ "type": "ping", "ts": 1795239330000 }
{ "type": "pong", "ts": 1795239330000 }
{ "type": "error", "code": "UNAUTHORIZED", "message": "Invalid token" }
```

---

## 4. REST API Contract

All JSON endpoints return `Content-Type: application/json; charset=utf-8` with `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. Non-admin endpoints allow CORS; local-only admin endpoints omit `Access-Control-Allow-Origin: *`.

### `GET /api/info` (Public)
Returns server identity, LAN/Tailscale URLs (prioritizing physical LAN adapters over VPN TUN/TAP), live status, and safe remote tunnel status. **Never leaks `token` or TURN `credential`.**

Response `200 OK`:
```json
{
  "name": "PurrCam",
  "version": "1.1.0",
  "lanIps": ["192.168.1.100"],
  "tailscaleIp": null,
  "port": 8787,
  "wsUrl": "ws://192.168.1.100:8787/ws",
  "cameraOnline": true,
  "viewerCount": 1,
  "tokenRequired": false,
  "turnConfigured": false,
  "remote": {
    "enabled": false,
    "status": "stopped",
    "provider": "none",
    "url": null,
    "wsUrl": null,
    "error": null
  }
}
```

### `GET /api/remote/config` *(Added in v1.1 — Strictly Local LAN/Loopback Only; `403` over Tunnel)*
Returns persisted remote config (`server/data/config.json`) including the active access token, TURN/STUN `iceServers`, and ready-to-share `pairingLink`. Returns `403 Forbidden` on any external/proxied request even with a valid token.

Response `200 OK`:
```json
{
  "token": "example-32-char-url-safe-token-01",
  "customRemoteUrl": null,
  "autoStartTunnel": false,
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "stun:stun1.l.google.com:19302" },
    { "urls": "stun:stun.cloudflare.com:3478" }
  ],
  "pairingLink": "purrcam://connect?local=ws%3A%2F%2F192.168.1.100%3A8787%2Fws&remote=wss%3A%2F%2Fexample.trycloudflare.com%2Fws&token=example-32-char-url-safe-token-01"
}
```

### `PUT /api/remote/config` *(Added in v1.1 — Strictly Local LAN/Loopback Only; `403` over Tunnel)*
Updates any subset of `{ token?, customRemoteUrl?, autoStartTunnel?, iceServers? }`, persists to `server/data/config.json`, and returns the updated `RemoteConfig` (`200 OK`).

### `POST /api/remote/start` *(Added in v1.1 — Strictly Local LAN/Loopback Only; `403` over Tunnel)*
Starts remote access tunnel (Cloudflare Quick Tunnel via `cloudflared`, auto-downloaded into `server/bin/cloudflared.exe` if absent) or activates a custom remote HTTPS URL. Auto-generates a 192-bit (32-char URL-safe) `token` if none is set, persists it, and broadcasts WS `remote_status` to viewers.

Request body (optional):
```json
{ "provider": "cloudflare", "customUrl": null }
```
Response `200 OK`:
```json
{
  "remote": {
    "enabled": true,
    "status": "running",
    "provider": "cloudflare",
    "url": "https://example.trycloudflare.com",
    "wsUrl": "wss://example.trycloudflare.com/ws",
    "error": null
  },
  "token": "example-32-char-url-safe-token-01",
  "pairingLink": "purrcam://connect?local=...&remote=...&token=..."
}
```

### `POST /api/remote/stop` *(Added in v1.1 — Strictly Local LAN/Loopback Only; `403` over Tunnel)*
Stops the active tunnel cleanly, broadcasts WS `remote_status`, and returns `200 OK` with `{ "remote": RemoteStatus }`.

### `POST /api/system/adb-reverse` & `GET /api/system/logs` *(Strictly Local LAN/Loopback Only; `403` over Tunnel)*
Host helper endpoints for local USB `adb reverse tcp:8787 tcp:8787` setup (validating serial against `^[A-Za-z0-9._:-]+$` via `execFile`, no shell) and local PC server log viewer. Both strictly return `403 Forbidden` to any external/tunneled request.

### `GET /api/telemetry/history?limit=120`
Returns recent telemetry samples in chronological order (oldest → newest, `limit` `1..720`, default `120`).
Response `200 OK`: `{ "items": Telemetry[] }`.

### `GET /api/snapshots`
Lists saved snapshots, newest first.
Response `200 OK`: `{ "items": SnapshotMeta[] }`.

### `POST /api/snapshots`
Saves a JPEG snapshot to `server/data/snapshots/`, broadcasts `snapshot_saved` to viewers, and returns `201 Created` with `SnapshotMeta`. Server validates JPEG magic bytes (`0xFF 0xD8 0xFF`) and enforces a `10 MB` cap (returning `400 Bad Request` for non-JPEG payloads).
Accepts either:
1. `Content-Type: image/jpeg` raw binary body (max 10 MB) + optional `X-Lens-Label` header (RFC 3986 `%20`-encoded UTF-8), **or**
2. `Content-Type: application/json` `{ "imageBase64": "...", "lensLabel"?: "0.6× Wide" }`.

### `DELETE /api/snapshots/:id`
Deletes snapshot JPEG and metadata. Response `200 OK`: `{ "deleted": true, "id": "..." }` (`404` if missing).

### `GET /snapshots/:filename`
Serves saved JPEG (`Content-Type: image/jpeg`) with strict basename-only validation to prevent path traversal, `Content-Security-Policy: default-src 'none'; sandbox`, and `X-Content-Type-Options: nosniff`.

### Static Frontend Fallback
`GET /` and non-API SPA routes serve `../web/dist` with fallback to `index.html` (or an English status page if `web/dist` isn't built yet).

---

## 5. Pairing Deep Link & URL Normalization (v1.1)

### `purrcam://connect` Deep Link
```
purrcam://connect?local=<urlEncodedLocalWsUrl>&remote=<urlEncodedRemoteWsUrl>&token=<urlEncodedToken>
```
- `local`: e.g. `ws://192.168.1.100:8787/ws`
- `remote`: optional e.g. `wss://example.trycloudflare.com/ws`
- `token`: optional access token
- **Security**: Android displays an explicit confirmation dialog showing the parsed Local URL, Remote URL, and masked token before applying a `purrcam://connect` link.

### URL Normalization Rules
1. `https://<host>` or `https://<host>/...` → WS `wss://<host>/ws`, HTTP `https://<host>` (**no `:8787` appended**).
2. `wss://<host>` or `wss://<host>/ws` → WS `wss://<host>/ws`, HTTP `https://<host>` (**no `:8787` appended**).
3. `http://<host>[:port]` → WS `ws://<host>[:port]/ws`, HTTP `http://<host>[:port]`.
4. Bare `<host>` (no scheme) → default WS `ws://<host>:8787/ws`, HTTP `http://<host>:8787`.
5. **Local → Remote Auto-Failover**: Clients store both `localServerUrl` and `remoteServerUrl` (+ `token`). On connect, try `local` first (~2.5s timeout on Wi-Fi) and automatically fail over to `remote` (`wss://`) when outside the home LAN (4G/5G).
6. **Web Remote One-Tap Sign-In**: Opening `https://<tunnel>/?token=<TOKEN>` in a browser saves `token` to `localStorage` and immediately strips `token` from the address bar via `window.history.replaceState(...)`.

---

## 6. Design System (v1.1 — Material 3 Expressive)

Both **Web** and **Android** follow **Material 3 Expressive** in English with clean, uncluttered multi-tab navigation:
- **Android 12+**: Dynamic Color (`dynamicDarkColorScheme` / `dynamicLightColorScheme`) with M3 dark tonal fallback (`surfaceContainerLowest` → `surfaceContainerHighest`), expressive `28dp` card corners, pill controls, and bouncy spring physics (`Spring.DampingRatioMediumBouncy`).
- **Web Dark Tonal Fallback**:
  - Canvas: `#0E1116` (`surface`)
  - Container: `#161A22` (`surfaceContainer`)
  - Elevated Container: `#1F2530` (`surfaceContainerHigh`)
  - AMOLED Blackout: `#000000` (true pixel-off canvas)
  - Tonal Accents: `#A8C7FA` (primary), `#F6C177` (warm highlight), `#7DD3A8` (live/healthy), `#F28B82` (alert/thermal)
- **Navigation Structure**:
  - **Web**: 4 focused views (`Live`, `Health`, `Gallery`, `Connect`).
  - **Android Camera Mode**: 3 tabs (`Live`, `Health`, `Settings`).
  - **Android Monitor Mode**: 4 tabs (`Live`, `Device`, `Gallery`, `Settings`).
