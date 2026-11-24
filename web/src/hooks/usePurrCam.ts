import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CAMERA_STATE,
  normalizeCameraState,
  type CameraSummary,
  type CommandAction,
  type CommandPayloads,
  type IceCandidatePayload,
  type IceServerConfig,
  type RelayVideoFrame,
  type RemoteTunnelStatus,
  type RtcConnectionStatus,
  type ServerToViewerMessage,
  type SnapshotMeta,
  type StreamMode,
  type StreamModePreference,
  type Telemetry,
  type ToastNotice,
  type VideoFrameMessage,
  type ViewerToServerMessage,
  type WebRtcLiveStats,
  type WsConnectionStatus,
} from '../types/protocol';
import {
  getOrCreateClientId,
  getWsUrl,
  normalizeServerUrlInput,
  type ConnectionConfig,
} from '../lib/connection';
import { deleteSnapshotById, fetchSnapshots, fetchTelemetryHistory } from '../lib/api';
import { discoverRemoteFromBeacon } from '../lib/beacon';

const STORAGE_STREAM_MODE = 'purrcam.streamMode';
const MAX_TELEMETRY_POINTS = 240;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const STATS_POLL_INTERVAL_MS = 1_000;
const WEBRTC_AUTO_FALLBACK_MS = 6_000;
const WEBRTC_DISCONNECT_FALLBACK_MS = 5_000;
const WEBRTC_STALL_WATCHDOG_MS = 10_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const BEACON_MIN_INTERVAL_MS = 20_000;

export interface PurrCamController {
  wsStatus: WsConnectionStatus;
  rtcStatus: RtcConnectionStatus;
  streamModePreference: StreamModePreference;
  activeStreamMode: StreamMode;
  setStreamModePreference: (pref: StreamModePreference) => void;
  relayFrame: RelayVideoFrame | null;
  viewerId: string;
  viewerCount: number;
  cameraOnline: boolean;
  camera: CameraSummary | null;
  telemetry: Telemetry | null;
  telemetryHistory: Telemetry[];
  snapshots: SnapshotMeta[];
  remoteStatus: RemoteTunnelStatus | null;
  setRemoteStatus: (status: RemoteTunnelStatus | null) => void;
  remoteStream: MediaStream | null;
  rtcStats: WebRtcLiveStats | null;
  talkbackActive: boolean;
  talkbackBusy: boolean;
  pendingActions: Record<string, boolean>;
  toasts: ToastNotice[];
  dismissToast: (id: string) => void;
  pushToast: (tone: ToastNotice['tone'], message: string) => void;
  sendCommand: <A extends CommandAction>(
    action: A,
    payload: CommandPayloads[A],
    options?: { silent?: boolean }
  ) => string | null;
  setTalkback: (active: boolean) => Promise<void>;
  reconnectStream: () => void;
  discoverBeaconNow: () => Promise<boolean>;
  refreshSnapshots: () => Promise<void>;
  removeSnapshot: (id: string) => Promise<void>;
  addSnapshotLocal: (snap: SnapshotMeta) => void;
}

interface StatsPrevSample {
  ts: number;
  videoBytes: number;
  audioBytes: number;
  framesDecoded: number;
}

function loadStreamModePreference(): StreamModePreference {
  try {
    const raw = localStorage.getItem(STORAGE_STREAM_MODE);
    if (raw === 'auto' || raw === 'webrtc' || raw === 'ws_relay') return raw;
  } catch {
    // ignore storage errors
  }
  return 'auto';
}

function saveStreamModePreference(pref: StreamModePreference): void {
  try {
    localStorage.setItem(STORAGE_STREAM_MODE, pref);
  } catch {
    // ignore
  }
}

function toRtcIceServers(servers: IceServerConfig[]): RTCIceServer[] {
  return servers
    .filter(
      (s) =>
        s &&
        (typeof s.urls === 'string'
          ? s.urls.trim().length > 0
          : Array.isArray(s.urls) && s.urls.length > 0)
    )
    .map((s) => {
      const entry: RTCIceServer = { urls: s.urls };
      if (typeof s.username === 'string' && s.username.length > 0) {
        entry.username = s.username;
      }
      if (typeof s.credential === 'string' && s.credential.length > 0) {
        entry.credential = s.credential;
      }
      return entry;
    });
}

function sanitizeImageMime(mime?: string): string {
  const clean = (mime || '').toLowerCase().trim();
  if (clean === 'image/jpeg' || clean === 'image/webp' || clean === 'image/png') {
    return clean;
  }
  return 'image/jpeg';
}

export function usePurrCam(
  config: ConnectionConfig,
  onDiscoveredServerUrl?: (newOrigin: string, provider?: string) => void
): PurrCamController {
  const clientIdRef = useRef<string>(getOrCreateClientId());
  const [viewerId, setViewerId] = useState<string>(clientIdRef.current);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('connecting');
  const [rtcStatus, setRtcStatus] = useState<RtcConnectionStatus>('idle');
  const [streamModePreference, setStreamModePreferenceState] = useState<StreamModePreference>(() =>
    loadStreamModePreference()
  );
  const [activeStreamMode, setActiveStreamMode] = useState<StreamMode>(() =>
    loadStreamModePreference() === 'ws_relay' ? 'ws_relay' : 'webrtc'
  );
  const [relayFrame, setRelayFrame] = useState<RelayVideoFrame | null>(null);
  const [viewerCount, setViewerCount] = useState<number>(0);
  const [cameraOnline, setCameraOnline] = useState<boolean>(false);
  const [camera, setCamera] = useState<CameraSummary | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [telemetryHistory, setTelemetryHistory] = useState<Telemetry[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [remoteStatus, setRemoteStatus] = useState<RemoteTunnelStatus | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [rtcStats, setRtcStats] = useState<WebRtcLiveStats | null>(null);
  const [talkbackActive, setTalkbackActive] = useState<boolean>(false);
  const [talkbackBusy, setTalkbackBusy] = useState<boolean>(false);
  const [pendingActions, setPendingActions] = useState<Record<string, boolean>>({});
  const [toasts, setToasts] = useState<ToastNotice[]>([]);

  // Lifecycle & watchdog refs
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ]);
  const pendingIceRef = useRef<IceCandidatePayload[]>([]);
  const registeredIdRef = useRef<string>(clientIdRef.current);
  const cameraOnlineRef = useRef<boolean>(false);
  const streamModePrefRef = useRef<StreamModePreference>(streamModePreference);
  const activeStreamModeRef = useRef<StreamMode>(activeStreamMode);
  const rtcStatusRef = useRef<RtcConnectionStatus>(rtcStatus);

  const wsReconnectTimerRef = useRef<number | null>(null);
  const wsRetryCountRef = useRef<number>(0);
  const heartbeatTimerRef = useRef<number | null>(null);
  const lastPongTsRef = useRef<number>(Date.now());
  const forceReconnectWsRef = useRef<(() => void) | null>(null);

  const rtcRetryTimerRef = useRef<number | null>(null);
  const offerWatchdogRef = useRef<number | null>(null);
  const autoFallbackTimerRef = useRef<number | null>(null);
  const statsTimerRef = useRef<number | null>(null);
  const statsPrevRef = useRef<StatsPrevSample | null>(null);
  const lastVideoProgressTsRef = useRef<number>(0);
  const hasDecodedVideoRef = useRef<boolean>(false);

  const relayFrameTimestampsRef = useRef<number[]>([]);
  const lastRelayFrameTsRef = useRef<number>(0);
  const relayWatchdogTimerRef = useRef<number | null>(null);

  const lastBeaconQueryTsRef = useRef<number>(0);
  const beaconInFlightRef = useRef<boolean>(false);
  const onDiscoveredServerUrlRef = useRef(onDiscoveredServerUrl);
  onDiscoveredServerUrlRef.current = onDiscoveredServerUrl;

  const pendingCmdMapRef = useRef<Map<string, { action: CommandAction; timer: number }>>(new Map());

  const silentAudioCtxRef = useRef<AudioContext | null>(null);
  const silentTrackRef = useRef<MediaStreamTrack | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const talkbackSenderRef = useRef<RTCRtpSender | null>(null);
  const talkbackActiveRef = useRef<boolean>(false);

  const updateRtcStatus = useCallback((next: RtcConnectionStatus | ((prev: RtcConnectionStatus) => RtcConnectionStatus)) => {
    setRtcStatus((prev) => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      rtcStatusRef.current = resolved;
      return resolved;
    });
  }, []);

  const pushToast = useCallback((tone: ToastNotice['tone'], message: string) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-3), { id, tone, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3600);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const sendWs = useCallback((msg: ViewerToServerMessage): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  const getOrCreateSilentTrack = useCallback((): MediaStreamTrack | null => {
    if (silentTrackRef.current && silentTrackRef.current.readyState === 'live') {
      return silentTrackRef.current;
    }
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      const ctx = silentAudioCtxRef.current ?? new AudioCtx();
      silentAudioCtxRef.current = ctx;
      const dest = ctx.createMediaStreamDestination();
      const track = dest.stream.getAudioTracks()[0] ?? null;
      if (track) {
        track.enabled = false;
        silentTrackRef.current = track;
      }
      return track;
    } catch {
      return null;
    }
  }, []);

  const stopMicTracks = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    talkbackActiveRef.current = false;
    setTalkbackActive(false);
  }, []);

  const clearRtcTimers = useCallback(() => {
    if (rtcRetryTimerRef.current !== null) {
      window.clearTimeout(rtcRetryTimerRef.current);
      rtcRetryTimerRef.current = null;
    }
    if (offerWatchdogRef.current !== null) {
      window.clearTimeout(offerWatchdogRef.current);
      offerWatchdogRef.current = null;
    }
    if (autoFallbackTimerRef.current !== null) {
      window.clearTimeout(autoFallbackTimerRef.current);
      autoFallbackTimerRef.current = null;
    }
    if (statsTimerRef.current !== null) {
      window.clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (relayWatchdogTimerRef.current !== null) {
      window.clearInterval(relayWatchdogTimerRef.current);
      relayWatchdogTimerRef.current = null;
    }
  }, []);

  const closePeerConnection = useCallback(
    (preserveStream = false) => {
      clearRtcTimers();
      pendingIceRef.current = [];
      talkbackSenderRef.current = null;
      statsPrevRef.current = null;
      hasDecodedVideoRef.current = false;
      lastVideoProgressTsRef.current = 0;

      if (pcRef.current) {
        try {
          pcRef.current.ontrack = null;
          pcRef.current.onicecandidate = null;
          pcRef.current.oniceconnectionstatechange = null;
          pcRef.current.onconnectionstatechange = null;
          pcRef.current.close();
        } catch {
          // ignore close errors
        }
        pcRef.current = null;
      }

      if (!preserveStream) {
        setRemoteStream(null);
        setRtcStats(null);
        stopMicTracks();
      }
    },
    [clearRtcTimers, stopMicTracks]
  );

  // Switch cleanly into WebSocket/HTTPS Video Relay fallback mode (Protocol v1.2 §9)
  const activateWsRelay = useCallback(
    (reason?: string) => {
      closePeerConnection(false);
      activeStreamModeRef.current = 'ws_relay';
      setActiveStreamMode('ws_relay');
      relayFrameTimestampsRef.current = [];
      lastRelayFrameTsRef.current = Date.now();

      if (cameraOnlineRef.current) {
        updateRtcStatus('connecting');
        sendWs({
          type: 'stream_mode',
          viewerId: registeredIdRef.current,
          mode: 'ws_relay',
          fps: 12,
          quality: 72,
        });

        // Relay watchdog: re-assert stream_mode if frames stall >10s while camera is online
        relayWatchdogTimerRef.current = window.setInterval(() => {
          if (
            activeStreamModeRef.current === 'ws_relay' &&
            cameraOnlineRef.current &&
            wsRef.current?.readyState === WebSocket.OPEN &&
            Date.now() - lastRelayFrameTsRef.current > 10_000
          ) {
            lastRelayFrameTsRef.current = Date.now();
            sendWs({
              type: 'stream_mode',
              viewerId: registeredIdRef.current,
              mode: 'ws_relay',
              fps: 12,
              quality: 72,
            });
          }
        }, 5_000);
      } else {
        updateRtcStatus('idle');
      }

      if (reason === 'webrtc-timeout' || reason === 'webrtc-failed' || reason === 'webrtc-stalled') {
        pushToast('info', 'Switched to HTTPS Relay for smooth playback');
      }
    },
    [closePeerConnection, pushToast, sendWs, updateRtcStatus]
  );

  const requestWatch = useCallback(
    (reason?: string) => {
      if (!cameraOnlineRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // If user explicitly chose HTTPS Relay, never launch WebRTC
      if (streamModePrefRef.current === 'ws_relay') {
        activateWsRelay('pref-relay');
        return;
      }

      if (offerWatchdogRef.current !== null) {
        window.clearTimeout(offerWatchdogRef.current);
        offerWatchdogRef.current = null;
      }

      activeStreamModeRef.current = 'webrtc';
      setActiveStreamMode('webrtc');
      setRelayFrame(null);
      hasDecodedVideoRef.current = false;

      // Ensure server/camera know we are in webrtc mode
      if (reason === 'manual-webrtc' || reason === 'camera-online' || reason === 'manual') {
        sendWs({
          type: 'stream_mode',
          viewerId: registeredIdRef.current,
          mode: 'webrtc',
        });
      }

      updateRtcStatus((prev) => (prev === 'live' ? 'reconnecting' : 'requesting'));
      sendWs({ type: 'watch_request', viewerId: registeredIdRef.current });

      // In 'auto' mode, if WebRTC fails to deliver decoded frames within 6s, auto-fallback to ws_relay
      if (streamModePrefRef.current === 'auto') {
        if (autoFallbackTimerRef.current !== null) {
          window.clearTimeout(autoFallbackTimerRef.current);
        }
        autoFallbackTimerRef.current = window.setTimeout(() => {
          autoFallbackTimerRef.current = null;
          if (
            streamModePrefRef.current === 'auto' &&
            activeStreamModeRef.current === 'webrtc' &&
            cameraOnlineRef.current &&
            wsRef.current?.readyState === WebSocket.OPEN &&
            !hasDecodedVideoRef.current
          ) {
            activateWsRelay('webrtc-timeout');
          }
        }, WEBRTC_AUTO_FALLBACK_MS);
      }

      // Watchdog: if no offer arrives in 6s while in forced webrtc mode, retry watch_request
      offerWatchdogRef.current = window.setTimeout(() => {
        offerWatchdogRef.current = null;
        if (
          activeStreamModeRef.current === 'webrtc' &&
          cameraOnlineRef.current &&
          wsRef.current?.readyState === WebSocket.OPEN &&
          (!pcRef.current || pcRef.current.connectionState !== 'connected')
        ) {
          if (streamModePrefRef.current === 'auto') {
            activateWsRelay('webrtc-timeout');
          } else {
            requestWatch('watchdog');
          }
        }
      }, reason === 'watchdog' ? 9_000 : 6_000);
    },
    [activateWsRelay, sendWs, updateRtcStatus]
  );

  const startStatsPolling = useCallback(
    (pc: RTCPeerConnection) => {
      if (statsTimerRef.current !== null) {
        window.clearInterval(statsTimerRef.current);
      }
      statsPrevRef.current = null;
      lastVideoProgressTsRef.current = Date.now();

      statsTimerRef.current = window.setInterval(async () => {
        if (pcRef.current !== pc || pc.connectionState === 'closed') return;
        try {
          const report = await pc.getStats();
          let width = 0;
          let height = 0;
          let fps = 0;
          let videoBytes = 0;
          let audioBytes = 0;
          let framesDecoded = 0;
          let packetsLost = 0;
          let rttMs: number | null = null;
          let videoCodecId: string | null = null;
          const codecs = new Map<string, string>();

          report.forEach((stat) => {
            if (stat.type === 'codec' && typeof stat.mimeType === 'string') {
              codecs.set(stat.id, stat.mimeType.replace(/^(video|audio)\//i, ''));
            } else if (stat.type === 'inbound-rtp') {
              if (stat.kind === 'video') {
                width = typeof stat.frameWidth === 'number' ? stat.frameWidth : width;
                height = typeof stat.frameHeight === 'number' ? stat.frameHeight : height;
                fps = typeof stat.framesPerSecond === 'number' ? stat.framesPerSecond : fps;
                videoBytes =
                  typeof stat.bytesReceived === 'number' ? stat.bytesReceived : videoBytes;
                framesDecoded =
                  typeof stat.framesDecoded === 'number' ? stat.framesDecoded : framesDecoded;
                packetsLost +=
                  typeof stat.packetsLost === 'number' ? stat.packetsLost : 0;
                if (typeof stat.codecId === 'string') videoCodecId = stat.codecId;
              } else if (stat.kind === 'audio') {
                audioBytes =
                  typeof stat.bytesReceived === 'number' ? stat.bytesReceived : audioBytes;
              }
            } else if (
              stat.type === 'candidate-pair' &&
              (stat.nominated || stat.state === 'succeeded') &&
              typeof stat.currentRoundTripTime === 'number'
            ) {
              rttMs = Math.round(stat.currentRoundTripTime * 1000);
            }
          });

          const now = performance.now();
          const wallNow = Date.now();
          let bitrateKbps = 0;
          let audioBitrateKbps = 0;
          let progressed = false;

          if (statsPrevRef.current && now > statsPrevRef.current.ts) {
            const dtSec = (now - statsPrevRef.current.ts) / 1000;
            if (videoBytes > statsPrevRef.current.videoBytes) {
              bitrateKbps = Math.round(
                ((videoBytes - statsPrevRef.current.videoBytes) * 8) / dtSec / 1000
              );
              progressed = true;
            }
            if (framesDecoded > statsPrevRef.current.framesDecoded) {
              progressed = true;
            }
            if (audioBytes >= statsPrevRef.current.audioBytes) {
              audioBitrateKbps = Math.round(
                ((audioBytes - statsPrevRef.current.audioBytes) * 8) / dtSec / 1000
              );
            }
          } else if (videoBytes > 0 || framesDecoded > 0) {
            progressed = true;
          }

          statsPrevRef.current = { ts: now, videoBytes, audioBytes, framesDecoded };

          if (progressed || framesDecoded > 0 || width > 0) {
            if (progressed) {
              lastVideoProgressTsRef.current = wallNow;
            }
            if (framesDecoded > 0 || (progressed && videoBytes > 0)) {
              hasDecodedVideoRef.current = true;
              if (autoFallbackTimerRef.current !== null) {
                window.clearTimeout(autoFallbackTimerRef.current);
                autoFallbackTimerRef.current = null;
              }
            }
          }

          setRtcStats({
            width,
            height,
            fps: Math.round(fps),
            bitrateKbps,
            audioBitrateKbps,
            rttMs,
            packetsLost,
            codec: videoCodecId ? (codecs.get(videoCodecId) ?? null) : null,
          });

          // 10-second stalled-video watchdog while connected
          if (
            rtcStatusRef.current === 'live' &&
            cameraOnlineRef.current &&
            lastVideoProgressTsRef.current > 0 &&
            wallNow - lastVideoProgressTsRef.current >= WEBRTC_STALL_WATCHDOG_MS
          ) {
            lastVideoProgressTsRef.current = wallNow;
            if (streamModePrefRef.current === 'auto') {
              activateWsRelay('webrtc-stalled');
            } else {
              requestWatch('stalled-video');
            }
          }
        } catch {
          // ignore transient getStats errors
        }
      }, STATS_POLL_INTERVAL_MS);
    },
    [activateWsRelay, requestWatch]
  );

  const handleRtcOffer = useCallback(
    async (rawSdp: string | { sdp: string }) => {
      if (activeStreamModeRef.current === 'ws_relay') return;

      const sdp = typeof rawSdp === 'string' ? rawSdp : rawSdp?.sdp;
      if (!sdp) return;

      if (offerWatchdogRef.current !== null) {
        window.clearTimeout(offerWatchdogRef.current);
        offerWatchdogRef.current = null;
      }

      // Preserve auto-fallback timer if already running during initial connect
      const keepFallbackActive =
        streamModePrefRef.current === 'auto' && !hasDecodedVideoRef.current;

      closePeerConnection(true);
      updateRtcStatus('connecting');

      if (keepFallbackActive) {
        autoFallbackTimerRef.current = window.setTimeout(() => {
          autoFallbackTimerRef.current = null;
          if (
            streamModePrefRef.current === 'auto' &&
            activeStreamModeRef.current === 'webrtc' &&
            cameraOnlineRef.current &&
            !hasDecodedVideoRef.current
          ) {
            activateWsRelay('webrtc-timeout');
          }
        }, WEBRTC_AUTO_FALLBACK_MS);
      }

      const pc = new RTCPeerConnection({
        iceServers: iceServersRef.current,
        bundlePolicy: 'max-bundle',
      });
      pcRef.current = pc;

      const incomingStream = new MediaStream();

      pc.ontrack = (event) => {
        if (pcRef.current !== pc) return;
        const stream = event.streams?.[0];
        if (stream) {
          stream.getTracks().forEach((track) => {
            if (!incomingStream.getTrackById(track.id)) {
              incomingStream.addTrack(track);
            }
          });
        } else if (event.track && !incomingStream.getTrackById(event.track.id)) {
          incomingStream.addTrack(event.track);
        }
        setRemoteStream(new MediaStream(incomingStream.getTracks()));
      };

      pc.onicecandidate = (event) => {
        if (pcRef.current !== pc || !event.candidate) return;
        sendWs({
          type: 'rtc_ice',
          viewerId: registeredIdRef.current,
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid ?? null,
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
          },
        });
      };

      const scheduleRecovery = (delayMs: number, isFailure: boolean) => {
        if (rtcRetryTimerRef.current !== null) return;
        rtcRetryTimerRef.current = window.setTimeout(() => {
          rtcRetryTimerRef.current = null;
          if (pcRef.current === pc && cameraOnlineRef.current) {
            if (streamModePrefRef.current === 'auto') {
              activateWsRelay(isFailure ? 'webrtc-failed' : 'webrtc-timeout');
            } else {
              requestWatch('ice-recovery');
            }
          }
        }, delayMs);
      };

      pc.oniceconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        const st = pc.iceConnectionState;
        if (st === 'connected' || st === 'completed') {
          if (rtcRetryTimerRef.current !== null) {
            window.clearTimeout(rtcRetryTimerRef.current);
            rtcRetryTimerRef.current = null;
          }
          updateRtcStatus('live');
          startStatsPolling(pc);
        } else if (st === 'disconnected') {
          updateRtcStatus('reconnecting');
          scheduleRecovery(WEBRTC_DISCONNECT_FALLBACK_MS, false);
        } else if (st === 'failed') {
          updateRtcStatus('reconnecting');
          scheduleRecovery(1_000, true);
        }
      };

      pc.onconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        if (pc.connectionState === 'connected') {
          updateRtcStatus('live');
          startStatsPolling(pc);
        } else if (pc.connectionState === 'failed') {
          updateRtcStatus('reconnecting');
          scheduleRecovery(1_000, true);
        }
      };

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        if (pcRef.current !== pc) return;

        const audioTransceiver = pc
          .getTransceivers()
          .find(
            (t) =>
              t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio'
          );

        const activeMicTrack = micStreamRef.current?.getAudioTracks()[0] ?? null;
        const bindTrack =
          talkbackActiveRef.current && activeMicTrack
            ? activeMicTrack
            : getOrCreateSilentTrack();

        if (audioTransceiver) {
          audioTransceiver.direction = 'sendrecv';
          if (bindTrack) {
            await audioTransceiver.sender.replaceTrack(bindTrack);
          }
          talkbackSenderRef.current = audioTransceiver.sender;
        } else if (bindTrack) {
          talkbackSenderRef.current = pc.addTrack(bindTrack);
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (pcRef.current !== pc) return;

        sendWs({
          type: 'rtc_answer',
          viewerId: registeredIdRef.current,
          sdp: answer.sdp ?? '',
        });

        const queued = pendingIceRef.current.splice(0, pendingIceRef.current.length);
        for (const cand of queued) {
          try {
            await pc.addIceCandidate({
              candidate: cand.candidate,
              sdpMid: cand.sdpMid ?? undefined,
              sdpMLineIndex: cand.sdpMLineIndex ?? undefined,
            });
          } catch {
            // ignore stale candidates
          }
        }
      } catch (err) {
        console.error('[PurrCam] WebRTC offer handling failed:', err);
        updateRtcStatus('failed');
        scheduleRecovery(1_500, true);
      }
    },
    [
      activateWsRelay,
      closePeerConnection,
      getOrCreateSilentTrack,
      requestWatch,
      sendWs,
      startStatsPolling,
      updateRtcStatus,
    ]
  );

  const handleRemoteIce = useCallback(async (candidate: IceCandidatePayload) => {
    if (!candidate || !candidate.candidate) return;
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) {
      pendingIceRef.current.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      });
    } catch {
      // ignore stale ICE candidates
    }
  }, []);

  const handleVideoFrame = useCallback(
    (msg: VideoFrameMessage) => {
      if (!msg.data || typeof msg.data !== 'string') return;
      const now = Date.now();
      lastRelayFrameTsRef.current = now;

      // Compute rolling FPS over the last 1.5s window
      const timestamps = relayFrameTimestampsRef.current;
      timestamps.push(now);
      const cutoff = now - 1_500;
      while (timestamps.length > 0 && timestamps[0] < cutoff) {
        timestamps.shift();
      }
      const spanSec =
        timestamps.length >= 2
          ? Math.max(0.25, (timestamps[timestamps.length - 1] - timestamps[0]) / 1000)
          : 1;
      const fps = timestamps.length >= 2 ? Math.round((timestamps.length - 1) / spanSec) : 1;

      const mime = sanitizeImageMime(msg.mime);
      setRelayFrame({
        dataUrl: `data:${mime};base64,${msg.data}`,
        mime,
        base64: msg.data,
        width: typeof msg.width === 'number' ? msg.width : 0,
        height: typeof msg.height === 'number' ? msg.height : 0,
        ts: typeof msg.ts === 'number' ? msg.ts : now,
        fps,
        lensLabel: msg.lensLabel ?? null,
      });

      if (activeStreamModeRef.current !== 'ws_relay') {
        activeStreamModeRef.current = 'ws_relay';
        setActiveStreamMode('ws_relay');
      }
      if (rtcStatusRef.current !== 'live') {
        updateRtcStatus('live');
      }
    },
    [updateRtcStatus]
  );

  const setStreamModePreference = useCallback(
    (pref: StreamModePreference) => {
      streamModePrefRef.current = pref;
      setStreamModePreferenceState(pref);
      saveStreamModePreference(pref);

      if (!cameraOnlineRef.current) {
        if (pref === 'ws_relay') {
          activeStreamModeRef.current = 'ws_relay';
          setActiveStreamMode('ws_relay');
        } else {
          activeStreamModeRef.current = 'webrtc';
          setActiveStreamMode('webrtc');
        }
        return;
      }

      if (pref === 'ws_relay') {
        activateWsRelay('manual');
      } else if (pref === 'webrtc') {
        closePeerConnection(false);
        requestWatch('manual-webrtc');
      } else {
        // Switching to 'auto' — try WebRTC fresh with 6s automatic fallback
        closePeerConnection(false);
        requestWatch('manual-webrtc');
      }
    },
    [activateWsRelay, closePeerConnection, requestWatch]
  );

  const discoverBeaconNow = useCallback(
    async (silent = false): Promise<boolean> => {
      const token = config.token.trim();
      if (!token || beaconInFlightRef.current) return false;
      beaconInFlightRef.current = true;
      lastBeaconQueryTsRef.current = Date.now();

      try {
        const discovered = await discoverRemoteFromBeacon(token);
        if (!discovered) {
          if (!silent) {
            pushToast('warning', 'No active Auto-Sync Beacon found for this token');
          }
          return false;
        }

        const discoveredOrigin = normalizeServerUrlInput(discovered.url);
        const currentOrigin = normalizeServerUrlInput(config.serverUrl || window.location.origin);

        if (discoveredOrigin && discoveredOrigin !== currentOrigin) {
          onDiscoveredServerUrlRef.current?.(discoveredOrigin, discovered.provider);
          return true;
        }
        if (!silent) {
          pushToast('info', `Beacon matches current server (${discovered.provider})`);
        }
        return false;
      } finally {
        beaconInFlightRef.current = false;
      }
    },
    [config.serverUrl, config.token, pushToast]
  );

  const sendCommand = useCallback(
    <A extends CommandAction>(
      action: A,
      payload: CommandPayloads[A],
      options?: { silent?: boolean }
    ): string | null => {
      const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const sent = sendWs({
        type: 'command',
        commandId,
        action,
        payload: payload as Record<string, unknown>,
      });

      if (!sent) {
        if (!options?.silent) {
          pushToast('warning', 'Not connected to PurrCam server');
        }
        return null;
      }

      setPendingActions((prev) => ({ ...prev, [action]: true }));
      const timer = window.setTimeout(() => {
        pendingCmdMapRef.current.delete(commandId);
        setPendingActions((prev) => {
          const next = { ...prev };
          delete next[action];
          return next;
        });
      }, 6_000);

      pendingCmdMapRef.current.set(commandId, { action, timer });
      return commandId;
    },
    [pushToast, sendWs]
  );

  const setTalkback = useCallback(
    async (active: boolean) => {
      if (active === talkbackActiveRef.current) return;
      if (active && activeStreamModeRef.current === 'ws_relay') {
        pushToast('info', 'Switch to WebRTC in Tune to use two-way Talkback');
        return;
      }
      setTalkbackBusy(true);

      try {
        if (active) {
          if (!navigator.mediaDevices?.getUserMedia) {
            pushToast('error', 'Microphone unavailable (requires HTTPS or localhost)');
            return;
          }
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });

          const micTrack = stream.getAudioTracks()[0];
          if (!micTrack) {
            stream.getTracks().forEach((t) => t.stop());
            pushToast('error', 'Could not open microphone track');
            return;
          }

          micStreamRef.current = stream;
          const sender =
            talkbackSenderRef.current ??
            pcRef.current?.getSenders().find((s) => s.track?.kind === 'audio') ??
            null;

          if (sender) {
            await sender.replaceTrack(micTrack);
          } else if (pcRef.current) {
            talkbackSenderRef.current = pcRef.current.addTrack(micTrack, stream);
          }

          talkbackActiveRef.current = true;
          setTalkbackActive(true);
          sendCommand('set_audio', { speakerEnabled: true }, { silent: true });
        } else {
          const silentTrack = getOrCreateSilentTrack();
          const sender =
            talkbackSenderRef.current ??
            pcRef.current?.getSenders().find((s) => s.track?.kind === 'audio') ??
            null;

          if (sender) {
            try {
              await sender.replaceTrack(silentTrack);
            } catch {
              // ignore if PC closed
            }
          }
          stopMicTracks();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Microphone permission denied';
        pushToast('error', `Microphone: ${msg}`);
        stopMicTracks();
      } finally {
        setTalkbackBusy(false);
      }
    },
    [getOrCreateSilentTrack, pushToast, sendCommand, stopMicTracks]
  );

  const refreshSnapshots = useCallback(async () => {
    try {
      const items = await fetchSnapshots(config.serverUrl, config.token);
      setSnapshots(items);
    } catch {
      // Server offline
    }
  }, [config.serverUrl, config.token]);

  const removeSnapshot = useCallback(
    async (id: string) => {
      await deleteSnapshotById(config.serverUrl, id, config.token);
      setSnapshots((prev) => prev.filter((item) => item.id !== id));
      pushToast('info', 'Snapshot deleted');
    },
    [config.serverUrl, config.token, pushToast]
  );

  const addSnapshotLocal = useCallback((snap: SnapshotMeta) => {
    setSnapshots((prev) => {
      if (prev.some((item) => item.id === snap.id)) return prev;
      return [snap, ...prev];
    });
  }, []);

  const reconnectStream = useCallback(() => {
    if (!cameraOnlineRef.current) return;
    if (streamModePrefRef.current === 'ws_relay') {
      activateWsRelay('manual');
    } else {
      closePeerConnection(true);
      requestWatch('manual');
    }
  }, [activateWsRelay, closePeerConnection, requestWatch]);

  useEffect(() => {
    let cancelled = false;

    const loadInitial = async () => {
      try {
        const [hist, snaps] = await Promise.all([
          fetchTelemetryHistory(config.serverUrl, 120, config.token).catch(() => []),
          fetchSnapshots(config.serverUrl, config.token).catch(() => []),
        ]);
        if (cancelled) return;
        if (hist.length > 0) {
          setTelemetryHistory(hist.slice(-MAX_TELEMETRY_POINTS));
          setTelemetry((prev) => prev ?? hist[hist.length - 1]);
        }
        setSnapshots(snaps);
      } catch {
        // WS will retry
      }
    };

    loadInitial();
    return () => {
      cancelled = true;
    };
  }, [config.serverUrl, config.token]);

  // Main WebSocket connection + 45s heartbeat watchdog + visibility/online recovery + beacon failover
  useEffect(() => {
    let disposed = false;

    const clearHeartbeat = () => {
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };

    const connect = () => {
      if (disposed) return;

      if (wsReconnectTimerRef.current !== null) {
        window.clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }

      const wsUrl = getWsUrl(config.serverUrl, config.token);
      setWsStatus(wsRetryCountRef.current > 0 ? 'reconnecting' : 'connecting');

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        setWsStatus('reconnecting');
        wsReconnectTimerRef.current = window.setTimeout(connect, 3_000);
        return;
      }

      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return;
        wsRetryCountRef.current = 0;
        lastPongTsRef.current = Date.now();
        setWsStatus('connected');

        sendWs({
          type: 'register',
          role: 'viewer',
          clientId: clientIdRef.current,
          clientName: 'PC Monitor',
          clientType: 'web',
          ...(config.token ? { token: config.token } : {}),
        });

        clearHeartbeat();
        heartbeatTimerRef.current = window.setInterval(() => {
          if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastPongTsRef.current > HEARTBEAT_TIMEOUT_MS) {
            // Zombie/half-open WS detected (>45s without pong/message) — force immediate reconnect
            try {
              ws.close(4008, 'Heartbeat timeout');
            } catch {
              // ignore
            }
            return;
          }
          sendWs({ type: 'ping', ts: Date.now() });
        }, HEARTBEAT_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return;
        lastPongTsRef.current = Date.now();

        let msg: ServerToViewerMessage;
        try {
          msg = JSON.parse(String(event.data)) as ServerToViewerMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case 'registered': {
            registeredIdRef.current = msg.id || clientIdRef.current;
            setViewerId(registeredIdRef.current);
            if (Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
              const converted = toRtcIceServers(msg.iceServers);
              if (converted.length > 0) {
                iceServersRef.current = converted;
              }
            }
            fetchSnapshots(config.serverUrl, config.token)
              .then((items) => {
                if (!disposed) setSnapshots(items);
              })
              .catch(() => {});
            fetchTelemetryHistory(config.serverUrl, 120, config.token)
              .then((hist) => {
                if (!disposed && hist.length > 0) {
                  setTelemetryHistory(hist.slice(-MAX_TELEMETRY_POINTS));
                }
              })
              .catch(() => {});
            break;
          }

          case 'camera_status': {
            const wasOnline = cameraOnlineRef.current;
            cameraOnlineRef.current = msg.online;
            setCameraOnline(msg.online);
            setViewerCount(typeof msg.viewerCount === 'number' ? msg.viewerCount : 0);

            if (msg.online && msg.camera) {
              const normalizedCam: CameraSummary = {
                ...msg.camera,
                lenses: Array.isArray(msg.camera.lenses) ? msg.camera.lenses : [],
                state: normalizeCameraState(
                  msg.camera.state as Partial<CameraSummary['state']> & Record<string, unknown>,
                  DEFAULT_CAMERA_STATE
                ),
              };
              setCamera(normalizedCam);
              if (normalizedCam.telemetry) {
                setTelemetry(normalizedCam.telemetry);
              }

              if (streamModePrefRef.current === 'ws_relay') {
                if (!wasOnline || activeStreamModeRef.current !== 'ws_relay') {
                  activateWsRelay('camera-online');
                }
              } else if (activeStreamModeRef.current === 'ws_relay' && wasOnline) {
                // Already cleanly playing via automatic HTTPS relay — do not interrupt on state_update
              } else {
                const needsStream =
                  !wasOnline ||
                  (!pcRef.current && offerWatchdogRef.current === null) ||
                  pcRef.current?.connectionState === 'failed' ||
                  pcRef.current?.connectionState === 'closed';
                if (needsStream) {
                  requestWatch('camera-online');
                }
              }
            } else {
              setCamera(null);
              setRelayFrame(null);
              closePeerConnection(false);
              updateRtcStatus('idle');
            }
            break;
          }

          case 'remote_status': {
            if (msg.remote) {
              setRemoteStatus(msg.remote);
            }
            break;
          }

          case 'rtc_offer': {
            void handleRtcOffer(msg.sdp);
            break;
          }

          case 'rtc_ice': {
            void handleRemoteIce(msg.candidate);
            break;
          }

          case 'video_frame': {
            handleVideoFrame(msg);
            break;
          }

          case 'telemetry': {
            if (msg.data) {
              const point: Telemetry = {
                ...msg.data,
                ts: typeof msg.data.ts === 'number' ? msg.data.ts : Date.now(),
              };
              setTelemetry(point);
              setTelemetryHistory((prev) => {
                if (prev.length > 0 && prev[prev.length - 1].ts === point.ts) {
                  return prev;
                }
                return [...prev.slice(-(MAX_TELEMETRY_POINTS - 1)), point];
              });
            }
            break;
          }

          case 'state_update': {
            setCamera((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                lenses:
                  Array.isArray(msg.lenses) && msg.lenses.length > 0 ? msg.lenses : prev.lenses,
                state: normalizeCameraState(
                  msg.state as Partial<CameraSummary['state']> & Record<string, unknown>,
                  prev.state
                ),
              };
            });
            break;
          }

          case 'command_ack': {
            const pending = pendingCmdMapRef.current.get(msg.commandId);
            if (pending) {
              window.clearTimeout(pending.timer);
              pendingCmdMapRef.current.delete(msg.commandId);
              setPendingActions((prev) => {
                const next = { ...prev };
                delete next[pending.action];
                return next;
              });
            }
            if (msg.state) {
              setCamera((prev) =>
                prev
                  ? {
                      ...prev,
                      state: normalizeCameraState(
                        msg.state as Partial<CameraSummary['state']> & Record<string, unknown>,
                        prev.state
                      ),
                    }
                  : prev
              );
            }
            if (!msg.ok && msg.error) {
              pushToast('error', `Command failed: ${msg.error}`);
            }
            break;
          }

          case 'snapshot_saved': {
            if (msg.snapshot) {
              addSnapshotLocal(msg.snapshot);
              pushToast('success', 'Snapshot saved to Gallery');
            }
            break;
          }

          case 'error': {
            if (msg.code === 'UNAUTHORIZED') {
              setWsStatus('auth_error');
              pushToast('error', 'Valid access token required');
            } else if (msg.message) {
              pushToast('warning', msg.message);
            }
            break;
          }

          case 'pong':
            break;
        }
      };

      ws.onclose = (ev) => {
        if (disposed || wsRef.current !== ws) return;
        clearHeartbeat();
        wsRef.current = null;
        closePeerConnection(false);
        setRelayFrame(null);
        cameraOnlineRef.current = false;
        setCameraOnline(false);
        updateRtcStatus('idle');

        if (ev.code === 4001) {
          setWsStatus('auth_error');
          return;
        }

        if (ev.code === 4029) {
          // 60-second cooldown retry on rate limit (never permanent stop)
          setWsStatus('reconnecting');
          pushToast('warning', 'Rate limited — retrying automatically in 60s');
          wsReconnectTimerRef.current = window.setTimeout(connect, RATE_LIMIT_COOLDOWN_MS);
          return;
        }

        setWsStatus('reconnecting');
        wsRetryCountRef.current += 1;

        // If remote WS failed >= 2 times and we have a token, query encrypted beacon for rotated tunnel URL
        const hasToken = config.token.trim().length > 0;
        const effectiveHost = (config.serverUrl || window.location.origin).toLowerCase();
        const isLocalOnly =
          effectiveHost.includes('://localhost') || effectiveHost.includes('://127.0.0.1');

        if (
          hasToken &&
          !isLocalOnly &&
          wsRetryCountRef.current >= 2 &&
          Date.now() - lastBeaconQueryTsRef.current >= BEACON_MIN_INTERVAL_MS
        ) {
          void discoverBeaconNow(true);
        }

        const delay = Math.min(1000 * Math.pow(1.6, wsRetryCountRef.current - 1), 8_000);
        wsReconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose handles reconnection
      };
    };

    forceReconnectWsRef.current = () => {
      if (disposed) return;
      const cur = wsRef.current;
      if (cur) {
        try {
          cur.onopen = null;
          cur.onmessage = null;
          cur.onclose = null;
          cur.onerror = null;
          cur.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
      clearHeartbeat();
      wsRetryCountRef.current = 0;
      connect();
    };

    const handleWakeup = () => {
      if (disposed) return;
      if (document.visibilityState === 'hidden') return;

      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        forceReconnectWsRef.current?.();
        return;
      }

      if (ws.readyState === WebSocket.OPEN) {
        if (Date.now() - lastPongTsRef.current > 25_000) {
          forceReconnectWsRef.current?.();
          return;
        }
        sendWs({ type: 'ping', ts: Date.now() });

        if (cameraOnlineRef.current) {
          if (activeStreamModeRef.current === 'ws_relay') {
            if (Date.now() - lastRelayFrameTsRef.current > 6_000) {
              activateWsRelay('wakeup');
            }
          } else if (!pcRef.current || pcRef.current.connectionState !== 'connected') {
            requestWatch('wakeup');
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleWakeup);
    window.addEventListener('online', handleWakeup);

    connect();

    return () => {
      disposed = true;
      forceReconnectWsRef.current = null;
      document.removeEventListener('visibilitychange', handleWakeup);
      window.removeEventListener('online', handleWakeup);
      clearHeartbeat();
      if (wsReconnectTimerRef.current !== null) {
        window.clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
      pendingCmdMapRef.current.forEach(({ timer }) => window.clearTimeout(timer));
      pendingCmdMapRef.current.clear();
      if (wsRef.current) {
        try {
          if (wsRef.current.readyState === WebSocket.OPEN) {
            if (activeStreamModeRef.current === 'ws_relay') {
              wsRef.current.send(
                JSON.stringify({
                  type: 'stream_mode',
                  viewerId: registeredIdRef.current,
                  mode: 'webrtc',
                })
              );
            }
            wsRef.current.send(
              JSON.stringify({ type: 'watch_stop', viewerId: registeredIdRef.current })
            );
          }
          wsRef.current.close();
        } catch {
          // ignore
        }
        wsRef.current = null;
      }
      closePeerConnection(false);
      if (silentTrackRef.current) {
        silentTrackRef.current.stop();
        silentTrackRef.current = null;
      }
      if (silentAudioCtxRef.current) {
        void silentAudioCtxRef.current.close().catch(() => {});
        silentAudioCtxRef.current = null;
      }
    };
  }, [
    activateWsRelay,
    addSnapshotLocal,
    closePeerConnection,
    config.serverUrl,
    config.token,
    discoverBeaconNow,
    handleRemoteIce,
    handleRtcOffer,
    handleVideoFrame,
    pushToast,
    requestWatch,
    sendWs,
    updateRtcStatus,
  ]);

  return {
    wsStatus,
    rtcStatus,
    streamModePreference,
    activeStreamMode,
    setStreamModePreference,
    relayFrame,
    viewerId,
    viewerCount,
    cameraOnline,
    camera,
    telemetry,
    telemetryHistory,
    snapshots,
    remoteStatus,
    setRemoteStatus,
    remoteStream,
    rtcStats,
    talkbackActive,
    talkbackBusy,
    pendingActions,
    toasts,
    dismissToast,
    pushToast,
    sendCommand,
    setTalkback,
    reconnectStream,
    discoverBeaconNow: () => discoverBeaconNow(false),
    refreshSnapshots,
    removeSnapshot,
    addSnapshotLocal,
  };
}
