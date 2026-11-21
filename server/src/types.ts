export type ClientRole = "camera" | "viewer";
export type ViewerClientType = "web" | "android";
export type LensType = "ultrawide" | "wide" | "tele" | "macro" | "front" | "other";
export type LensFacing = "back" | "front";
export type VideoResolution = "480p" | "720p" | "1080p";
export type ChargeSource = "ac" | "usb" | "wireless" | "none";

export type RemoteTunnelStatus = "stopped" | "starting" | "running" | "error";
export type RemoteProvider = "cloudflare" | "tailscale" | "custom" | "none";

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RemoteStatus {
  enabled: boolean;
  status: RemoteTunnelStatus;
  provider: RemoteProvider;
  url: string | null;
  wsUrl: string | null;
  error?: string | null;
}

export interface PersistedConfig {
  token: string;
  customRemoteUrl: string | null;
  autoStartTunnel: boolean;
  iceServers: IceServerConfig[];
}

export interface RemoteConfigResponse extends PersistedConfig {
  pairingLink: string;
}

export interface LensInfo {
  id: string;
  cameraId: string;
  physicalCameraId: string | null;
  label: string;
  type: LensType | string;
  facing: LensFacing | string;
  focalLengthMm: number;
  zoomFactor: number;
  hasFlash: boolean;
  maxZoom: number;
  [key: string]: unknown;
}

export interface CameraCapabilities {
  torch: boolean;
  audioIn: boolean;
  audioOut: boolean;
  root: boolean;
  chargeLimit: boolean;
  rootDisplayOff?: boolean;
  [key: string]: unknown;
}

export interface CameraState {
  activeLensId?: string;
  torch?: boolean;
  blackout?: boolean;
  rootDisplayOff?: boolean;
  resolution?: VideoResolution | string;
  fps?: number;
  bitrateKbps?: number;
  ev?: number;
  zoomRatio?: number;
  micEnabled?: boolean;
  speakerEnabled?: boolean;
  chargeLimitEnabled?: boolean;
  chargeLimitMaxPct?: number;
  streaming?: boolean;
  [key: string]: unknown;
}

export interface Telemetry {
  ts: number;
  batteryPct?: number;
  charging?: boolean;
  chargeSource?: ChargeSource | string;
  chargePaused?: boolean;
  batteryTempC?: number;
  cpuTempC?: number | null;
  voltageMv?: number;
  currentMa?: number;
  wifiRssi?: number | null;
  uptimeSec?: number;
  freeRamMb?: number;
  freeStorageMb?: number;
  activeLensId?: string;
  fps?: number;
  bitrateKbps?: number;
  [key: string]: unknown;
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
  id: string;
  filename: string;
  url: string;
  createdAt: number;
  sizeBytes: number;
  lensLabel: string | null;
}

export type CommandAction =
  | "switch_lens"
  | "set_torch"
  | "set_blackout"
  | "set_video_config"
  | "set_exposure"
  | "set_zoom"
  | "set_audio"
  | "set_charge_limit"
  | "request_snapshot"
  | "play_sound"
  | "reboot_camera"
  | string;

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  [key: string]: unknown;
}

// --- Client -> Server Messages ---

export interface CameraRegisterMessage {
  type: "register";
  role: "camera";
  deviceId: string;
  deviceName: string;
  lenses?: LensInfo[];
  capabilities?: Partial<CameraCapabilities>;
  state?: CameraState;
  telemetry?: Telemetry;
  token?: string;
}

export interface ViewerRegisterMessage {
  type: "register";
  role: "viewer";
  clientId?: string;
  clientName?: string;
  clientType?: ViewerClientType;
  token?: string;
}

export type RegisterMessage = CameraRegisterMessage | ViewerRegisterMessage;

export interface WatchRequestMessage {
  type: "watch_request";
  viewerId?: string;
  [key: string]: unknown;
}

export interface WatchStopMessage {
  type: "watch_stop";
  viewerId?: string;
}

export interface RtcOfferMessage {
  type: "rtc_offer";
  viewerId: string;
  sdp: unknown;
}

export interface RtcAnswerMessage {
  type: "rtc_answer";
  viewerId?: string;
  sdp: unknown;
}

export interface RtcIceMessage {
  type: "rtc_ice";
  viewerId?: string;
  candidate: IceCandidatePayload | unknown;
}

export interface TelemetryMessage {
  type: "telemetry";
  data: Telemetry;
}

export interface StateUpdateMessage {
  type: "state_update";
  state: CameraState;
  lenses?: LensInfo[];
}

export interface CommandMessage {
  type: "command";
  commandId?: string;
  action: CommandAction;
  payload?: Record<string, unknown>;
}

export interface CommandAckMessage {
  type: "command_ack";
  commandId: string;
  ok: boolean;
  error?: string | null;
  state?: CameraState;
}

export interface PingMessage {
  type: "ping";
  ts?: number;
}

export interface PongMessage {
  type: "pong";
  ts?: number;
}

// --- Server -> Client Messages ---

export interface RegisteredMessage {
  type: "registered";
  id: string;
  serverTime: number;
  iceServers: IceServerConfig[];
}

export interface CameraStatusMessage {
  type: "camera_status";
  online: boolean;
  camera: CameraSummary | null;
  viewerCount: number;
}

export interface RemoteStatusMessage {
  type: "remote_status";
  remote: RemoteStatus;
}

export interface ViewerJoinedMessage {
  type: "viewer_joined";
  viewerId: string;
  clientName: string;
  clientType: ViewerClientType;
}

export interface ViewerLeftMessage {
  type: "viewer_left";
  viewerId: string;
}

export interface SnapshotSavedMessage {
  type: "snapshot_saved";
  snapshot: SnapshotMeta;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  message: string;
}

// --- REST API DTOs ---

export interface ServerInfoResponse {
  name: "PurrCam";
  version: string;
  lanIps: string[];
  tailscaleIp: string | null;
  port: number;
  wsUrl: string;
  cameraOnline: boolean;
  camera?: CameraSummary | null;
  viewerCount: number;
  tokenRequired: boolean;
  turnConfigured: boolean;
  remote: RemoteStatus;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Explicit strict token from env/overrides (if non-empty, enforced on ALL requests including local). */
  token: string;
  /** Explicit ICE servers from env/overrides (if provided, overrides persisted iceServers). */
  iceServers?: IceServerConfig[];
  /** Auto-start Cloudflare Quick Tunnel on boot (from PURRCAM_REMOTE=1 or override). */
  autoStartRemote: boolean;
  dataDir: string;
  binDir: string;
  webDistDir: string;
  maxTelemetrySamples: number;
  telemetryFlushIntervalMs: number;
  heartbeatIntervalMs: number;
  registerTimeoutMs: number;
  maxSnapshotBytes: number;
  authRateLimitMaxFailures: number;
  authRateLimitWindowMs: number;
}
