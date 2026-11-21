import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_CAMERA_STATE,
  normalizeCameraState,
  type CameraSummary,
  type CommandAction,
  type CommandPayloads,
  type IceCandidatePayload,
  type IceServerConfig,
  type RemoteTunnelStatus,
  type RtcConnectionStatus,
  type ServerToViewerMessage,
  type SnapshotMeta,
  type Telemetry,
  type ToastNotice,
  type ViewerToServerMessage,
  type WebRtcLiveStats,
  type WsConnectionStatus,
} from '../types/protocol';
import { getOrCreateClientId, getWsUrl, type ConnectionConfig } from '../lib/connection';
import { deleteSnapshotById, fetchSnapshots, fetchTelemetryHistory } from '../lib/api';

const MAX_TELEMETRY_POINTS = 240;
const HEARTBEAT_INTERVAL_MS = 15_000;
const STATS_POLL_INTERVAL_MS = 1_000;

export interface PurrCamController {
  wsStatus: WsConnectionStatus;
  rtcStatus: RtcConnectionStatus;
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
  refreshSnapshots: () => Promise<void>;
  removeSnapshot: (id: string) => Promise<void>;
  addSnapshotLocal: (snap: SnapshotMeta) => void;
}

interface StatsPrevSample {
  ts: number;
  videoBytes: number;
  audioBytes: number;
}

function toRtcIceServers(servers: IceServerConfig[]): RTCIceServer[] {
  return servers
    .filter((s) => s && (typeof s.urls === 'string' ? s.urls.trim().length > 0 : Array.isArray(s.urls) && s.urls.length > 0))
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

export function usePurrCam(config: ConnectionConfig): PurrCamController {
  const clientIdRef = useRef<string>(getOrCreateClientId());
  const [viewerId, setViewerId] = useState<string>(clientIdRef.current);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('connecting');
  const [rtcStatus, setRtcStatus] = useState<RtcConnectionStatus>('idle');
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

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ]);
  const pendingIceRef = useRef<IceCandidatePayload[]>([]);
  const registeredIdRef = useRef<string>(clientIdRef.current);
  const cameraOnlineRef = useRef<boolean>(false);
  const wsReconnectTimerRef = useRef<number | null>(null);
  const wsRetryCountRef = useRef<number>(0);
  const heartbeatTimerRef = useRef<number | null>(null);
  const rtcRetryTimerRef = useRef<number | null>(null);
  const offerWatchdogRef = useRef<number | null>(null);
  const statsTimerRef = useRef<number | null>(null);
  const statsPrevRef = useRef<StatsPrevSample | null>(null);
  const pendingCmdMapRef = useRef<Map<string, { action: CommandAction; timer: number }>>(new Map());

  const silentAudioCtxRef = useRef<AudioContext | null>(null);
  const silentTrackRef = useRef<MediaStreamTrack | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const talkbackSenderRef = useRef<RTCRtpSender | null>(null);
  const talkbackActiveRef = useRef<boolean>(false);

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
    if (statsTimerRef.current !== null) {
      window.clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
  }, []);

  const closePeerConnection = useCallback(
    (preserveStream = false) => {
      clearRtcTimers();
      pendingIceRef.current = [];
      talkbackSenderRef.current = null;
      statsPrevRef.current = null;

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

  const requestWatch = useCallback(
    (reason?: string) => {
      if (!cameraOnlineRef.current) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (offerWatchdogRef.current !== null) {
        window.clearTimeout(offerWatchdogRef.current);
        offerWatchdogRef.current = null;
      }

      setRtcStatus((prev) => (prev === 'live' ? 'reconnecting' : 'requesting'));
      sendWs({ type: 'watch_request', viewerId: registeredIdRef.current });

      offerWatchdogRef.current = window.setTimeout(() => {
        if (
          cameraOnlineRef.current &&
          wsRef.current?.readyState === WebSocket.OPEN &&
          (!pcRef.current || pcRef.current.connectionState !== 'connected')
        ) {
          requestWatch('watchdog');
        }
      }, reason === 'watchdog' ? 9_000 : 6_000);
    },
    [sendWs]
  );

  const startStatsPolling = useCallback((pc: RTCPeerConnection) => {
    if (statsTimerRef.current !== null) {
      window.clearInterval(statsTimerRef.current);
    }
    statsPrevRef.current = null;

    statsTimerRef.current = window.setInterval(async () => {
      if (pcRef.current !== pc || pc.connectionState === 'closed') return;
      try {
        const report = await pc.getStats();
        let width = 0;
        let height = 0;
        let fps = 0;
        let videoBytes = 0;
        let audioBytes = 0;
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
              videoBytes = typeof stat.bytesReceived === 'number' ? stat.bytesReceived : videoBytes;
              packetsLost += typeof stat.packetsLost === 'number' ? stat.packetsLost : 0;
              if (typeof stat.codecId === 'string') videoCodecId = stat.codecId;
            } else if (stat.kind === 'audio') {
              audioBytes = typeof stat.bytesReceived === 'number' ? stat.bytesReceived : audioBytes;
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
        let bitrateKbps = 0;
        let audioBitrateKbps = 0;

        if (statsPrevRef.current && now > statsPrevRef.current.ts) {
          const dtSec = (now - statsPrevRef.current.ts) / 1000;
          if (videoBytes >= statsPrevRef.current.videoBytes) {
            bitrateKbps = Math.round(((videoBytes - statsPrevRef.current.videoBytes) * 8) / dtSec / 1000);
          }
          if (audioBytes >= statsPrevRef.current.audioBytes) {
            audioBitrateKbps = Math.round(((audioBytes - statsPrevRef.current.audioBytes) * 8) / dtSec / 1000);
          }
        }
        statsPrevRef.current = { ts: now, videoBytes, audioBytes };

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
      } catch {
        // ignore transient getStats errors
      }
    }, STATS_POLL_INTERVAL_MS);
  }, []);

  const handleRtcOffer = useCallback(
    async (rawSdp: string | { sdp: string }) => {
      const sdp = typeof rawSdp === 'string' ? rawSdp : rawSdp?.sdp;
      if (!sdp) return;

      if (offerWatchdogRef.current !== null) {
        window.clearTimeout(offerWatchdogRef.current);
        offerWatchdogRef.current = null;
      }

      closePeerConnection(true);
      setRtcStatus('connecting');

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

      const scheduleRecovery = (delayMs: number) => {
        if (rtcRetryTimerRef.current !== null) return;
        rtcRetryTimerRef.current = window.setTimeout(() => {
          rtcRetryTimerRef.current = null;
          if (pcRef.current === pc && cameraOnlineRef.current) {
            requestWatch('ice-recovery');
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
          setRtcStatus('live');
        } else if (st === 'disconnected') {
          setRtcStatus('reconnecting');
          scheduleRecovery(3_500);
        } else if (st === 'failed') {
          setRtcStatus('reconnecting');
          scheduleRecovery(1_200);
        }
      };

      pc.onconnectionstatechange = () => {
        if (pcRef.current !== pc) return;
        if (pc.connectionState === 'connected') {
          setRtcStatus('live');
          startStatsPolling(pc);
        } else if (pc.connectionState === 'failed') {
          setRtcStatus('reconnecting');
          scheduleRecovery(1_200);
        }
      };

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp });
        if (pcRef.current !== pc) return;

        const audioTransceiver = pc
          .getTransceivers()
          .find(
            (t) =>
              t.receiver.track?.kind === 'audio' ||
              t.sender.track?.kind === 'audio'
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
        setRtcStatus('failed');
        scheduleRecovery(2_000);
      }
    },
    [closePeerConnection, getOrCreateSilentTrack, requestWatch, sendWs, startStatsPolling]
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
    closePeerConnection(true);
    requestWatch('manual');
  }, [closePeerConnection, requestWatch]);

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
          sendWs({ type: 'ping', ts: Date.now() });
        }, HEARTBEAT_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return;
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

              const needsStream =
                !wasOnline ||
                (!pcRef.current && offerWatchdogRef.current === null) ||
                pcRef.current?.connectionState === 'failed' ||
                pcRef.current?.connectionState === 'closed';
              if (needsStream) {
                requestWatch('camera-online');
              }
            } else {
              setCamera(null);
              closePeerConnection(false);
              setRtcStatus('idle');
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
        cameraOnlineRef.current = false;
        setCameraOnline(false);
        setRtcStatus('idle');

        if (ev.code === 4001) {
          setWsStatus('auth_error');
          return;
        }
        if (ev.code === 4029) {
          setWsStatus('auth_error');
          pushToast('warning', 'Too many failed auth attempts — please wait a few minutes');
          return;
        }

        setWsStatus('reconnecting');
        const delay = Math.min(1000 * Math.pow(1.6, wsRetryCountRef.current), 8_000);
        wsRetryCountRef.current += 1;
        wsReconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose handles reconnection
      };
    };

    connect();

    return () => {
      disposed = true;
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
    addSnapshotLocal,
    closePeerConnection,
    config.serverUrl,
    config.token,
    handleRemoteIce,
    handleRtcOffer,
    pushToast,
    requestWatch,
    sendWs,
  ]);

  return {
    wsStatus,
    rtcStatus,
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
    refreshSnapshots,
    removeSnapshot,
    addSnapshotLocal,
  };
}
