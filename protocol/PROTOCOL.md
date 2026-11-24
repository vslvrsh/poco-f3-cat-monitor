# PurrCam Protocol v1.2

> Shared wire contract for **PurrCam** — self-hosted cat baby monitor connecting a rooted **Poco F3** camera node, a **PC Hub Server**, a **PC Web/Desktop Monitor**, and an **Android Monitor** app over Local LAN, USB (`adb reverse`), or Remote 4G/5G (Zero-Signup VPN-Free Tunnels `localhost.run` / `Pinggy :443` / `Cloudflare HTTP/2`, Encrypted Auto-Discovery Beacon, and Automatic WebSocket/HTTPS Video Relay Fallback).

---

## 1. Transport, Ports & Authentication

| Parameter | Default / Format | Notes |
| --- | --- | --- |
| Server Bind | `0.0.0.0:8787` | Configurable via `PORT` env var |
| Local HTTP Base | `http://<PC_IP>:8787` | Serves REST API, `/snapshots/*`, and built web client (`web/dist`) |
| Local WS Endpoint | `ws://<PC_IP>:8787/ws` | JSON text frames (`UTF-8`); USB tunnel: `ws://127.0.0.1:8787/ws` via `adb reverse tcp:8787 tcp:8787` |
| Remote HTTPS/WSS | `https://<host>` / `wss://<host>/ws` | `localhost.run` (`*.app.lhr.life`), `Pinggy :443` (`*.free.pinggy.net`), Cloudflare (`*.trycloudflare.com`), Tailscale, or custom reverse proxy. **Never** append `:8787` to `https://` or `wss://` URLs. |
| Auth Token | `server/data/config.json` / `PURRCAM_TOKEN` | Empty by default for local-only use; auto-generated (192-bit / 32-char URL-safe `base64url`) when starting a remote tunnel if empty. Verified in constant time (`SHA-256` + `timingSafeEqual`). Supplied via `register.token` or `?token=<token>` on WS, and `Authorization: Bearer <token>`, `X-PurrCam-Token: <token>`, or `?token=<token>` on REST. |

### External vs. Local Security Model
- A request or WebSocket connection is treated as **external/tunneled** when ANY of the following hold:
  1. Any proxy header is present (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`, `x-forwarded-host`, `forwarded`, `x-real-ip`, `via`), **or**
  2. The `Host` header is NOT `localhost`, `127.0.0.1`, `[::1]`, or a private LAN IPv4 address (protects SSH tunnels such as `localhost.run` / `pinggy` forwarding to `127.0.0.1`), **or**
  3. Remote socket IP is outside loopback (`127.0.0.0/8`, `::1`) and private LAN (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` Tailscale CGNAT, IPv6 ULA/link-local).
- **External callers** MUST authenticate with the active `token` on all protected HTTP endpoints and `/ws` (missing/invalid token → HTTP `401 Unauthorized` or WS `error` + close `4001`; repeated auth failures → HTTP `429 Too Many Requests` / WS close `4029`).
- **Admin & Host-Management Endpoints Are Strictly Local-Only (`403 Forbidden`)**: `GET/PUT /api/remote/config`, `POST /api/remote/start|stop`, `POST /api/system/adb-reverse`, and `GET /api/system/logs` MUST return `403 Forbidden` for any external/tunneled request **even if a valid token is provided**, and omit `Access-Control-Allow-Origin: *`.
- **Security Headers & Limits**: All HTTP responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. WS frames are capped at **`1 MB` (`1024 * 1024` bytes)** (supporting `ws_relay` JPEG frames) and JSON API bodies at `64 KB`.
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
export type RemoteProvider =
  | "auto"
  | "localhost.run"
  | "pinggy"
  | "cloudflare"
  | "tailscale"
  | "custom"
  | "none";
export type ActiveRemoteProvider =
  | "localhost.run"
  | "pinggy"
  | "cloudflare"
  | "tailscale"
  | "custom"
  | "none";

export interface RemoteBeaconStatus {
  enabled: boolean;
  lastPublishedAt: number | null; // Unix epoch ms of last successful encrypted publish
  endpoints: string[];            // e.g. ["https://ntfy.sh", "https://ntfy.envs.net"]
}

export interface RemoteStatus {
  enabled: boolean;
  status: RemoteTunnelStatus;
  provider: RemoteProvider;               // Requested mode (e.g. "auto", "localhost.run", "pinggy", ...)
  activeProvider?: ActiveRemoteProvider;  // Concrete backend currently serving the tunnel
  url: string | null;                     // e.g. "https://<id>.app.lhr.life"
  wsUrl: string | null;                   // e.g. "wss://<id>.app.lhr.life/ws"
  beacon?: RemoteBeaconStatus;            // Encrypted auto-discovery beacon state (v1.2)
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
    "activeProvider": "none",
    "url": null,
    "wsUrl": null,
    "beacon": {
      "enabled": false,
      "lastPublishedAt": null,
      "endpoints": ["https://ntfy.sh", "https://ntfy.envs.net"]
    },
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
  "pairingLink": "purrcam://connect?local=ws%3A%2F%2F192.168.1.100%3A8787%2Fws&remote=wss%3A%2F%2Fdemo.app.lhr.life%2Fws&token=example-32-char-url-safe-token-01"
}
```

### `PUT /api/remote/config` *(Added in v1.1 — Strictly Local LAN/Loopback Only; `403` over Tunnel)*
Updates any subset of `{ token?, customRemoteUrl?, autoStartTunnel?, iceServers? }`, persists to `server/data/config.json`, and returns the updated `RemoteConfig` (`200 OK`).

### `POST /api/remote/start` *(Updated in v1.2 — Strictly Local LAN/Loopback Only; `403` over Tunnel)*
Starts the remote access tunnel and encrypted auto-discovery beacon. Default `provider` is **`"auto"`** (tries `localhost.run` → `pinggy` `:443` → `cloudflare` `--protocol http2`, with automatic restart & failover watchdog). Auto-generates a 192-bit (32-char URL-safe) `token` if none is set, persists it, publishes the encrypted beacon (§8), and broadcasts WS `remote_status` to viewers.

Request body (optional):
```json
{ "provider": "auto", "customUrl": null }
```
Supported `provider` values: `"auto" | "localhost.run" | "pinggy" | "cloudflare" | "tailscale" | "custom"`.

Response `200 OK`:
```json
{
  "remote": {
    "enabled": true,
    "status": "running",
    "provider": "auto",
    "activeProvider": "localhost.run",
    "url": "https://demo.app.lhr.life",
    "wsUrl": "wss://demo.app.lhr.life/ws",
    "beacon": {
      "enabled": true,
      "lastPublishedAt": 1795500000000,
      "endpoints": ["https://ntfy.sh", "https://ntfy.envs.net"]
    },
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

---

## 7. Always-On Connection Resilience Invariants (v1.2)

- **Server WebSocket Heartbeat Grace**: Server pings every `15s` and tolerates up to **3 consecutive missed ticks (`~45s` grace)** before terminating a peer, preventing spurious drops over 4G/5G or proxied tunnels.
- **Client Pong & Media Watchdogs**:
  - Clients track `lastPongTs` (updated on `pong` or any incoming WS frame) and force-reconnect if `> 45s` elapse without activity.
  - Android Camera & Monitor register `ConnectivityManager.NetworkCallback` to reset backoff and reconnect immediately on Wi-Fi ↔ 4G/5G handoff; Web listens to `visibilitychange` and `online`.
  - Android Camera ForegroundService uses **only** `camera|microphone` (never `dataSync`, avoiding Android 15–17's 6-hour `DATA_SYNC` OS kill timeout) and restarts Camera2 automatically if no frame arrives for `> 12s`.
  - Both Android and Web handle WebRTC `ICE DISCONNECTED` (5s grace before recovery), `watch_request` timeout watchdogs, and 10s stalled-frame detection.

---

## 8. Encrypted Zero-Account Auto-Discovery Beacon (v1.2)

When a zero-signup, VPN-free tunnel (`localhost.run`, `pinggy`, `cloudflare`) rotates its public hostname, the PC server publishes the new endpoint encrypted end-to-end with the user's shared `token` to redundant, non-Cloudflare `ntfy` relays (`https://ntfy.sh` and `https://ntfy.envs.net`). Paired Android and Web monitors automatically fetch and decrypt the latest URL without any account, VPS, or re-pairing.

### 8.1 Exact Cryptographic Specification
Identical byte-for-byte across **Node.js `node:crypto`**, **Java/Kotlin `javax.crypto.Cipher`**, and **Browser `WebCrypto`**:

1. **Key & Topic Derivation** (UTF-8 string concatenation + SHA-256):
   - `topicId = "purrcam-" + hex(SHA256(utf8("purrcam:beacon:topic:v1:" + token))).slice(0, 32)`
     *(40 characters total: `"purrcam-"` + 32 lowercase hex characters.)*
   - `aesKey = SHA256(utf8("purrcam:beacon:aes256:v1:" + token))`
     *(32 raw bytes = AES-256-GCM key.)*
2. **Plaintext Payload** (UTF-8 JSON):
   ```json
   {
     "v": 1,
     "url": "https://demo.app.lhr.life",
     "wsUrl": "wss://demo.app.lhr.life/ws",
     "provider": "localhost.run",
     "ts": 1795500000000
   }
   ```
3. **Encryption (AES-256-GCM)**:
   - Generate a fresh random **12-byte** `iv` (`96 bits`).
   - Encrypt UTF-8 plaintext with `aesKey` and `iv`, **no AAD** (`additionalAuthenticatedData` empty/omitted), **16-byte (`128-bit`) authentication tag**.
   - Concatenate `combined = ciphertext || authTag` (tag directly appended at the end — matches Java `Cipher("AES/GCM/NoPadding")` and WebCrypto `AES-GCM` output directly; in Node `crypto`, append `cipher.getAuthTag()`).
4. **Published Envelope** (UTF-8 JSON string):
   ```json
   {
     "v": 1,
     "iv": "<standard-base64-of-12-byte-iv>",
     "ct": "<standard-base64-of-ciphertext-plus-16B-tag>"
   }
   ```

### 8.2 Publishing & Polling Endpoints
- **Server Publish** (on every tunnel startup / URL rotation + every **10 minutes** keepalive to keep `ntfy`'s 12-hour cache warm indefinitely):
  - `POST https://ntfy.sh/<topicId>`
  - `POST https://ntfy.envs.net/<topicId>`
  - Headers: `Content-Type: text/plain`, `X-Cache: yes`
  - Body: the Published Envelope JSON string above.
- **Client Poll** (triggered automatically after 2 failed Remote WS attempts or HTTP `404`/`502`/`503`/`52x` expired tunnel):
  - `GET https://ntfy.sh/<topicId>/json?poll=1&since=all`
  - `GET https://ntfy.envs.net/<topicId>/json?poll=1&since=all`
  - Parse newline-delimited JSON (`NDJSON`); for every line where `event === "message"`, parse `message` as the Encrypted Envelope JSON and attempt AES-256-GCM decryption (ignoring malformed/corrupt/wrong-key lines).
  - Validate decrypted JSON has `v === 1`, `typeof ts === "number"`, `url.startsWith("https://")`, and `wsUrl.startsWith("wss://")`.
  - Select the valid entry with the **highest `ts`**, persist the new `remoteServerUrl`, and reconnect seamlessly.

### 8.3 Reference Interoperability Test Vector
Implementations SHOULD verify byte-for-byte parity using this exact vector:

| Field | Value |
| --- | --- |
| `token` | `purrcam-test-vector-token-v1` |
| `topicId` | `purrcam-a793ba5e2ec528be44b8c7169f47de2d` |
| `aesKey` (hex) | `9d3bda26da32402321f85d3c892ef16b1a2b0ebcc21b6842c7b8a36026c1eeea` |
| `iv` (hex / base64) | `0102030405060708090a0b0c` / `AQIDBAUGBwgJCgsM` |
| `plaintext` | `{"v":1,"url":"https://demo.app.lhr.life","wsUrl":"wss://demo.app.lhr.life/ws","provider":"localhost.run","ts":1795500000000}` |
| `envelope` | `{"v":1,"iv":"AQIDBAUGBwgJCgsM","ct":"makxxxrVCdpbHF1dzommR5+Bzaej6iOtNkMXQzrV0M8Rgtkosyq7lOK1ENcS18T4qFASC4aWlqgXvNNv/cyS7kehKARzrygL4Fdu/b0HxJ7nj1zD7fNvMU7rPhbiZOX6RgDBFhtvuWTJgYOkeCnxTs0Rr/OVmB2OnsMgzWlESBdP2lBL/l5/Onl7sEk="}` |

---

## 9. Automatic WebSocket / HTTPS Video Relay Fallback (`ws_relay`, v1.2)

When a viewer is behind strict 4G/5G symmetric CGNAT or a firewall blocking WebRTC UDP (without TURN or VPN), PurrCam automatically falls back to relaying upright JPEG video frames over the existing **TCP 443 HTTPS/WSS** tunnel.

### 9.1 Messages

#### `stream_mode` (Viewer → Server → Camera)
Requests switching a viewer between `"webrtc"` (default) and `"ws_relay"`.
```json
{
  "type": "stream_mode",
  "viewerId": "web-8f3a1b",
  "mode": "ws_relay",
  "fps": 8,
  "quality": 60
}
```
- `viewerId`: optional from viewer; the server MUST stamp/overwrite `viewerId` with the sender's registered viewer ID before forwarding to the camera.
- `mode`: `"webrtc" | "ws_relay"`.
- `fps` (optional, default `8`) & `quality` (optional JPEG quality `1..100`, default `60`): hints for the camera's relay encoder.
- **Lifecycle**: Server tracks `viewer.streamMode` per viewer. When a `ws_relay` viewer disconnects or sends `watch_stop`, the server notifies the camera (`{ "type": "stream_mode", "viewerId": "...", "mode": "webrtc" }` + `viewer_left`) so the camera immediately detaches its JPEG encoder (`0%` CPU overhead when zero relay viewers remain).

#### `video_frame` (Camera → Server → `ws_relay` Viewers Only)
```json
{
  "type": "video_frame",
  "ts": 1795500001250,
  "width": 540,
  "height": 960,
  "lensLabel": "0.6× Wide",
  "mime": "image/jpeg",
  "data": "<standard-base64-jpeg>"
}
```
- Camera applies `VideoFrame.rotation` before JPEG encoding so frames are always upright and un-squished (typically throttled to ~8 fps, short edge ≤ 540 px, quality ~60).
- Server forwards `video_frame` **ONLY** to viewers currently in `streamMode === "ws_relay"`.

### 9.2 Backpressure & Payload Limits
- **Camera outbound guard**: Skip encoding/sending a frame if `webSocket.queueSize() > 262_144` (`256 KB`).
- **Server per-viewer guard**: Skip sending a `video_frame` to any viewer whose `ws.bufferedAmount > 524_288` (`512 KB`) to prevent latency buildup on slow cellular links.
- **Server WS `maxPayload`**: **`1_048_576` bytes (`1 MB`)**.

### 9.3 Client Auto-Fallback Behavior
- Clients expose stream mode preference: **`Auto`** (default), **`WebRTC`**, **`HTTPS Relay`**.
- In **`Auto`** mode:
  1. Start with low-latency **WebRTC** (`watch_request`).
  2. If WebRTC does not deliver decoded video frames within **6 seconds** (or enters `ICE FAILED` / `DISCONNECTED` > 5s / stalled frames > 10s), automatically send `{ "type": "stream_mode", "mode": "ws_relay" }` and render incoming `video_frame` images seamlessly with a **`LIVE · HTTPS Relay`** indicator.
  3. On Local LAN, prefer WebRTC (falling back to `ws_relay` only if WebRTC fails).
