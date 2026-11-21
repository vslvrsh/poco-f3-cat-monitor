export type VideoResolution = '480p' | '720p' | '1080p';
export type CatSoundType = 'psps' | 'chime' | 'whistle';
export type LensType = 'ultrawide' | 'wide' | 'tele' | 'macro' | 'front' | 'other';
export type LensFacing = 'back' | 'front';
export type ChargeSource = 'ac' | 'usb' | 'wireless' | 'none' | string;

export interface LensInfo {
  id: string;
  cameraId?: string;
  physicalCameraId?: string | null;
  label: string;
  type?: LensType;
  kind?: LensType;
  facing: LensFacing | string;
  focalLengthMm?: number;
  zoomFactor?: number;
  hasFlash?: boolean;
  maxZoom?: number;
}

export interface CameraCapabilities {
  torch: boolean;
  audioIn: boolean;
  audioOut: boolean;
  root: boolean;
  chargeLimit: boolean;
  rootDisplayOff?: boolean;
}

export interface CameraState {
  activeLensId: string;
  torch: boolean;
  blackout: boolean;
  rootDisplayOff: boolean;
  resolution: VideoResolution;
  fps: number;
  bitrateKbps: number;
  ev: number;
  zoomRatio: number;
  micEnabled: boolean;
  speakerEnabled: boolean;
  chargeLimitEnabled: boolean;
  chargeLimitMaxPct: number;
  streaming: boolean;
}

export interface Telemetry {
  ts: number;
  batteryPct: number;
  charging: boolean;
  chargeSource?: ChargeSource;
  chargePaused?: boolean;
  batteryTempC: number;
  cpuTempC?: number | null;
  voltageMv?: number | null;
  currentMa?: number | null;
  wifiRssi?: number | null;
  uptimeSec?: number | null;
  freeRamMb?: number | null;
  freeStorageMb?: number | null;
  activeLensId?: string;
  fps?: number | null;
  bitrateKbps?: number | null;
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
  lensLabel?: string | null;
}

export interface RemoteTunnelStatus {
  enabled: boolean;
  status: 'stopped' | 'starting' | 'running' | 'error';
  provider: 'cloudflare' | 'tailscale' | 'custom' | 'none';
  url: string | null;
  wsUrl: string | null;
  error?: string | null;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RemoteConfig {
  token: string;
  customRemoteUrl: string | null;
  autoStartTunnel: boolean;
  iceServers: IceServerConfig[];
  pairingLink: string;
}

export interface ServerInfo {
  name: string;
  version: string;
  lanIps: string[];
  tailscaleIp?: string | null;
  port: number;
  wsUrl: string;
  cameraOnline: boolean;
  viewerCount: number;
  tokenRequired: boolean;
  turnConfigured?: boolean;
  remote?: RemoteTunnelStatus;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type CommandAction =
  | 'switch_lens'
  | 'set_torch'
  | 'set_blackout'
  | 'set_video_config'
  | 'set_exposure'
  | 'set_zoom'
  | 'set_audio'
  | 'set_charge_limit'
  | 'request_snapshot'
  | 'play_sound'
  | 'reboot_camera';

export interface CommandPayloads {
  switch_lens: { lensId: string };
  set_torch: { enabled: boolean };
  set_blackout: { enabled: boolean; rootDisplayOff?: boolean };
  set_video_config: {
    resolution?: VideoResolution;
    fps?: number;
    bitrateKbps?: number;
  };
  set_exposure: { ev: number };
  set_zoom: { ratio: number };
  set_audio: { micEnabled?: boolean; speakerEnabled?: boolean };
  set_charge_limit: { enabled: boolean; maxPct?: number };
  request_snapshot: Record<string, never>;
  play_sound: { sound: CatSoundType };
  reboot_camera: Record<string, never>;
}

// Messages sent from Viewer -> Server (PurrCam Protocol v1.1)
export type ViewerToServerMessage =
  | {
      type: 'register';
      role: 'viewer';
      clientId: string;
      clientName: string;
      clientType: 'web';
      token?: string;
    }
  | { type: 'watch_request'; viewerId: string }
  | { type: 'watch_stop'; viewerId: string }
  | { type: 'rtc_answer'; viewerId: string; sdp: string }
  | { type: 'rtc_ice'; viewerId: string; candidate: IceCandidatePayload }
  | {
      type: 'command';
      commandId: string;
      action: CommandAction;
      payload?: Record<string, unknown>;
    }
  | { type: 'ping'; ts: number };

// Messages sent from Server -> Viewer (PurrCam Protocol v1.1)
export type ServerToViewerMessage =
  | {
      type: 'registered';
      id: string;
      serverTime: number;
      iceServers: IceServerConfig[];
    }
  | {
      type: 'camera_status';
      online: boolean;
      camera: CameraSummary | null;
      viewerCount: number;
    }
  | { type: 'remote_status'; remote: RemoteTunnelStatus }
  | { type: 'rtc_offer'; viewerId: string; sdp: string | { sdp: string } }
  | { type: 'rtc_ice'; viewerId: string; candidate: IceCandidatePayload }
  | { type: 'telemetry'; data: Telemetry }
  | { type: 'state_update'; state: Partial<CameraState>; lenses?: LensInfo[] }
  | {
      type: 'command_ack';
      commandId: string;
      ok: boolean;
      error?: string | null;
      state?: Partial<CameraState>;
    }
  | { type: 'snapshot_saved'; snapshot: SnapshotMeta }
  | { type: 'pong'; ts: number }
  | { type: 'error'; code?: string; message: string };

export interface WebRtcLiveStats {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
  audioBitrateKbps: number;
  rttMs: number | null;
  packetsLost: number;
  codec: string | null;
}

export type WsConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'auth_error';

export type RtcConnectionStatus =
  | 'idle'
  | 'requesting'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'failed';

export interface ToastNotice {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export const DEFAULT_CAMERA_STATE: CameraState = {
  activeLensId: '',
  torch: false,
  blackout: false,
  rootDisplayOff: false,
  resolution: '720p',
  fps: 24,
  bitrateKbps: 1800,
  ev: 0,
  zoomRatio: 1.0,
  micEnabled: true,
  speakerEnabled: true,
  chargeLimitEnabled: false,
  chargeLimitMaxPct: 80,
  streaming: false,
};

/**
 * Returns clean English lens labels (and gracefully translates any legacy Russian labels).
 */
export function formatLensLabel(lens: LensInfo, compact = false): string {
  const category = lens.type ?? lens.kind;
  if (compact) {
    if (category === 'ultrawide') return '0.6×';
    if (category === 'wide') return '1×';
    if (category === 'macro') return 'Macro';
    if (category === 'tele') return typeof lens.zoomFactor === 'number' ? `${lens.zoomFactor}×` : 'Tele';
    if (category === 'front' || lens.facing === 'front') return 'Front';
  } else {
    if (category === 'ultrawide') return '0.6× Wide';
    if (category === 'wide') return '1× Main';
    if (category === 'macro') return 'Macro';
    if (category === 'tele') return typeof lens.zoomFactor === 'number' ? `${lens.zoomFactor}× Tele` : 'Telephoto';
    if (category === 'front' || lens.facing === 'front') return 'Front';
  }

  const raw = (lens.label || '').trim();
  if (/ширик/i.test(raw)) return compact ? '0.6×' : '0.6× Wide';
  if (/осн/i.test(raw)) return compact ? '1×' : '1× Main';
  if (/макро/i.test(raw)) return 'Macro';
  if (/фронт/i.test(raw)) return 'Front';
  return raw || lens.id;
}

export function normalizeCameraState(
  raw?: Partial<CameraState> & Record<string, unknown>,
  prev: CameraState = DEFAULT_CAMERA_STATE
): CameraState {
  if (!raw) return prev;
  const torchVal =
    typeof raw.torch === 'boolean'
      ? raw.torch
      : typeof raw.torchEnabled === 'boolean'
        ? raw.torchEnabled
        : prev.torch;
  const blackoutVal =
    typeof raw.blackout === 'boolean'
      ? raw.blackout
      : typeof raw.blackoutEnabled === 'boolean'
        ? raw.blackoutEnabled
        : prev.blackout;
  const evVal =
    typeof raw.ev === 'number'
      ? raw.ev
      : typeof raw.exposureEv === 'number'
        ? raw.exposureEv
        : prev.ev;
  const resVal =
    raw.resolution === '480p' || raw.resolution === '720p' || raw.resolution === '1080p'
      ? raw.resolution
      : prev.resolution;

  return {
    activeLensId: typeof raw.activeLensId === 'string' ? raw.activeLensId : prev.activeLensId,
    torch: torchVal,
    blackout: blackoutVal,
    rootDisplayOff:
      typeof raw.rootDisplayOff === 'boolean' ? raw.rootDisplayOff : prev.rootDisplayOff,
    resolution: resVal,
    fps: typeof raw.fps === 'number' ? raw.fps : prev.fps,
    bitrateKbps: typeof raw.bitrateKbps === 'number' ? raw.bitrateKbps : prev.bitrateKbps,
    ev: evVal,
    zoomRatio: typeof raw.zoomRatio === 'number' ? raw.zoomRatio : prev.zoomRatio,
    micEnabled: typeof raw.micEnabled === 'boolean' ? raw.micEnabled : prev.micEnabled,
    speakerEnabled:
      typeof raw.speakerEnabled === 'boolean' ? raw.speakerEnabled : prev.speakerEnabled,
    chargeLimitEnabled:
      typeof raw.chargeLimitEnabled === 'boolean'
        ? raw.chargeLimitEnabled
        : prev.chargeLimitEnabled,
    chargeLimitMaxPct:
      typeof raw.chargeLimitMaxPct === 'number' ? raw.chargeLimitMaxPct : prev.chargeLimitMaxPct,
    streaming: typeof raw.streaming === 'boolean' ? raw.streaming : prev.streaming,
  };
}
