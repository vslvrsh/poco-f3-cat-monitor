import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  Bell,
  Camera,
  Cat,
  Circle,
  Expand,
  Flashlight,
  Globe,
  Loader2,
  Maximize,
  Mic,
  MicOff,
  Minimize,
  Moon,
  PictureInPicture2,
  Power,
  RefreshCw,
  RotateCcw,
  Shrink,
  SlidersHorizontal,
  Sparkles,
  Square,
  Sun,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  formatLensLabel,
  type CameraSummary,
  type CatSoundType,
  type CommandAction,
  type CommandPayloads,
  type RtcConnectionStatus,
  type SnapshotMeta,
  type Telemetry,
  type VideoResolution,
  type WebRtcLiveStats,
  type WsConnectionStatus,
} from '../types/protocol';
import { uploadSnapshotBlob } from '../lib/api';
import { M3ConnectedButtonGroup, M3Slider } from './M3Controls';

interface LiveViewProps {
  wsStatus: WsConnectionStatus;
  rtcStatus: RtcConnectionStatus;
  cameraOnline: boolean;
  camera: CameraSummary | null;
  telemetry: Telemetry | null;
  remoteStream: MediaStream | null;
  rtcStats: WebRtcLiveStats | null;
  talkbackActive: boolean;
  talkbackBusy: boolean;
  pendingActions: Record<string, boolean>;
  serverUrl: string;
  token: string;
  onSetTalkback: (active: boolean) => Promise<void>;
  onSendCommand: <A extends CommandAction>(
    action: A,
    payload: CommandPayloads[A],
    options?: { silent?: boolean }
  ) => string | null;
  onSnapshotUploaded: (snap: SnapshotMeta) => void;
  onOpenConnect: () => void;
  onReconnectStream: () => void;
  onNotify: (tone: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

const BITRATE_PRESETS = [
  { kbps: 800, label: '0.8M' },
  { kbps: 1800, label: '1.8M' },
  { kbps: 2800, label: '2.8M' },
  { kbps: 4000, label: '4.0M' },
];

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function pickRecorderMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

export function LiveView({
  wsStatus,
  rtcStatus,
  cameraOnline,
  camera,
  telemetry,
  remoteStream,
  rtcStats,
  talkbackActive,
  talkbackBusy,
  pendingActions,
  serverUrl,
  token,
  onSetTalkback,
  onSendCommand,
  onSnapshotUploaded,
  onOpenConnect,
  onReconnectStream,
  onNotify,
}: LiveViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const evTimerRef = useRef<number | null>(null);
  const zoomTimerRef = useRef<number | null>(null);
  const bitrateTimerRef = useRef<number | null>(null);

  const [hudVisible, setHudVisible] = useState(true);
  const [hudPinned, setHudPinned] = useState(false);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);

  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.85);
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [capturingSnapshot, setCapturingSnapshot] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  // Digital zoom & pan (1.0x - 4.0x)
  const [digitalZoom, setDigitalZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    dragging: boolean;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  }>({ dragging: false, startX: 0, startY: 0, originX: 0, originY: 0 });

  const state = camera?.state;
  const capabilities = camera?.capabilities;
  const lenses = camera?.lenses ?? [];
  const activeLens = lenses.find((l) => l.id === state?.activeLensId) ?? lenses[0] ?? null;
  const maxOpticalZoom = Math.max(1, Math.min(8, activeLens?.maxZoom ?? 4));
  const torchSupported =
    Boolean(capabilities?.torch) &&
    activeLens?.hasFlash !== false &&
    activeLens?.facing !== 'front';

  const [draftEv, setDraftEv] = useState<number>(state?.ev ?? 0);
  const [draftCamZoom, setDraftCamZoom] = useState<number>(state?.zoomRatio ?? 1);
  const [draftBitrate, setDraftBitrate] = useState<number>(state?.bitrateKbps ?? 1800);

  useEffect(() => {
    if (typeof state?.ev === 'number') setDraftEv(state.ev);
  }, [state?.ev]);

  useEffect(() => {
    if (typeof state?.zoomRatio === 'number') setDraftCamZoom(state.zoomRatio);
  }, [state?.zoomRatio]);

  useEffect(() => {
    if (typeof state?.bitrateKbps === 'number') setDraftBitrate(state.bitrateKbps);
  }, [state?.bitrateKbps]);

  useEffect(() => {
    return () => {
      if (evTimerRef.current) window.clearTimeout(evTimerRef.current);
      if (zoomTimerRef.current) window.clearTimeout(zoomTimerRef.current);
      if (bitrateTimerRef.current) window.clearTimeout(bitrateTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== remoteStream) {
      video.srcObject = remoteStream;
    }
    if (remoteStream) {
      void video.play().catch(() => {});
    }
  }, [remoteStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    video.volume = volume;
  }, [muted, volume]);

  const bumpHud = useCallback(() => {
    setHudVisible(true);
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      setHudVisible(false);
    }, 3_800);
  }, []);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnterPip = () => setIsPip(true);
    const onLeavePip = () => setIsPip(false);
    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
    };
  }, []);

  const clampPan = useCallback((x: number, y: number, zoom: number) => {
    if (zoom <= 1.01) return { x: 0, y: 0 };
    const rect = containerRef.current?.getBoundingClientRect();
    const maxX = rect ? ((zoom - 1) * rect.width) / 2 : 300;
    const maxY = rect ? ((zoom - 1) * rect.height) / 2 : 200;
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }, []);

  const updateDigitalZoom = useCallback(
    (nextZoom: number) => {
      const clamped = Math.max(1, Math.min(4, Math.round(nextZoom * 10) / 10));
      setDigitalZoom(clamped);
      setPan((prev) => clampPan(prev.x, prev.y, clamped));
    },
    [clampPan]
  );

  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!remoteStream) return;
    if ((e.target as HTMLElement).closest('[data-tune-sheet]')) return;
    e.preventDefault();
    bumpHud();
    updateDigitalZoom(digitalZoom + (e.deltaY < 0 ? 0.25 : -0.25));
  };

  const handleMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (digitalZoom <= 1.01 || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, a, [data-tune-sheet]')) return;
    dragRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: pan.x,
      originY: pan.y,
    };
  };

  const handleMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    bumpHud();
    if (!dragRef.current.dragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPan(clampPan(dragRef.current.originX + dx, dragRef.current.originY + dy, digitalZoom));
  };

  const handleMouseUp = () => {
    dragRef.current.dragging = false;
  };

  const handleDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!remoteStream) return;
    if ((e.target as HTMLElement).closest('button, input, a, [data-tune-sheet]')) return;
    updateDigitalZoom(digitalZoom > 1.05 ? 1 : 2);
  };

  const stopRecording = useCallback(() => {
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    recorderRef.current = null;
    setIsRecording(false);
  }, []);

  useEffect(() => {
    if (!remoteStream && isRecording) stopRecording();
  }, [remoteStream, isRecording, stopRecording]);

  useEffect(() => () => stopRecording(), [stopRecording]);

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
      return;
    }
    if (!remoteStream || typeof MediaRecorder === 'undefined') {
      onNotify('warning', 'Recording requires an active live stream');
      return;
    }

    try {
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(remoteStream, { mimeType })
        : new MediaRecorder(remoteStream);

      recordedChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };

      recorder.onstop = () => {
        const chunks = recordedChunksRef.current;
        recordedChunksRef.current = [];
        if (chunks.length === 0) return;

        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        const url = URL.createObjectURL(blob);
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
          now.getDate()
        ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(
          now.getMinutes()
        ).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

        const a = document.createElement('a');
        a.href = url;
        a.download = `purrcam-${stamp}.webm`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        onNotify('success', `Recording saved (${(blob.size / (1024 * 1024)).toFixed(1)} MB)`);
      };

      recorder.start(1_000);
      recorderRef.current = recorder;
      setRecordSeconds(0);
      setIsRecording(true);
      recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1_000);
      onNotify('info', 'Local .webm recording started');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'MediaRecorder error';
      onNotify('error', `Recording failed: ${msg}`);
    }
  };

  const handleSnapshot = async () => {
    if (capturingSnapshot) return;
    const video = videoRef.current;

    if (!video || !remoteStream || video.videoWidth === 0 || video.videoHeight === 0) {
      if (cameraOnline) {
        onSendCommand('request_snapshot', {});
        onNotify('info', 'Requested snapshot from Poco F3…');
      } else {
        onNotify('warning', 'No active video stream for snapshot');
      }
      return;
    }

    setCapturingSnapshot(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.92)
      );
      if (!blob) throw new Error('JPEG encoding failed');

      const meta = await uploadSnapshotBlob(
        serverUrl,
        blob,
        activeLens ? formatLensLabel(activeLens) : undefined,
        token
      );
      onSnapshotUploaded(meta);
    } catch (err) {
      if (cameraOnline) {
        onSendCommand('request_snapshot', {});
        onNotify('info', 'Requested HD snapshot from Poco F3');
      } else {
        onNotify('error', err instanceof Error ? err.message : 'Failed to save snapshot');
      }
    } finally {
      setCapturingSnapshot(false);
    }
  };

  const toggleFullscreen = async () => {
    const el = containerRef.current;
    if (!el) return;
    try {
      if (!document.fullscreenElement) await el.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
      onNotify('warning', 'Fullscreen is unavailable in this browser');
    }
  };

  const togglePip = async () => {
    const video = videoRef.current;
    if (!video || !remoteStream) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if ('requestPictureInPicture' in video) await video.requestPictureInPicture();
      else onNotify('warning', 'Picture-in-Picture is not supported');
    } catch {
      onNotify('warning', 'Could not open Picture-in-Picture');
    }
  };

  const handleEvSlider = (ev: number) => {
    setDraftEv(ev);
    if (evTimerRef.current) window.clearTimeout(evTimerRef.current);
    evTimerRef.current = window.setTimeout(() => {
      onSendCommand('set_exposure', { ev }, { silent: true });
    }, 120);
  };

  const handleOpticalZoomSlider = (ratio: number) => {
    setDraftCamZoom(ratio);
    if (zoomTimerRef.current) window.clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = window.setTimeout(() => {
      onSendCommand('set_zoom', { ratio }, { silent: true });
    }, 120);
  };

  const handleBitrateChange = (kbps: number) => {
    setDraftBitrate(kbps);
    if (bitrateTimerRef.current) window.clearTimeout(bitrateTimerRef.current);
    bitrateTimerRef.current = window.setTimeout(() => {
      onSendCommand('set_video_config', { bitrateKbps: kbps }, { silent: true });
    }, 150);
  };

  const sendSound = (sound: CatSoundType) => onSendCommand('play_sound', { sound });

  const hasVideo = Boolean(remoteStream && cameraOnline);
  const showOverlay =
    hudVisible ||
    hudPinned ||
    tuneOpen ||
    !remoteStream ||
    talkbackActive ||
    isRecording ||
    rtcStatus !== 'live';

  const closestBitratePreset =
    BITRATE_PRESETS.reduce((best, cur) =>
      Math.abs(cur.kbps - draftBitrate) < Math.abs(best.kbps - draftBitrate) ? cur : best
    ).kbps;

  return (
    <div className="flex h-[calc(100vh-78px)] w-full flex-col p-3 sm:p-4 md:h-screen md:p-5">
      <section
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onDoubleClick={handleDoubleClick}
        onClick={() => bumpHud()}
        style={{ backgroundColor: 'var(--md-sys-color-surface-container-lowest)' }}
        className={`relative flex flex-1 flex-col overflow-hidden shadow-2xl select-none ${
          isFullscreen ? 'rounded-none' : 'rounded-[36px]'
        } ${digitalZoom > 1.01 ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        {/* Stream Video Element — ALWAYS preserves aspect ratio (`object-contain` default, toggleable to `object-cover`) */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${digitalZoom})`,
            transition: dragRef.current.dragging
              ? 'none'
              : 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          className={`h-full w-full will-change-transform ${
            fitMode === 'cover' ? 'object-cover' : 'object-contain'
          } ${hasVideo ? 'opacity-100' : 'opacity-0'}`}
        />

        {/* Calm M3 Expressive Standby State when Camera is Offline */}
        {!cameraOnline && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
            <div
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
              }}
              className="mb-5 flex h-24 w-24 items-center justify-center rounded-[28px] shadow-xl"
            >
              <img src="/favicon.svg" alt="PurrCam" className="h-14 w-14" />
            </div>
            <h1
              style={{ color: 'var(--md-sys-color-on-surface)' }}
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              {wsStatus === 'auth_error'
                ? 'Access Token Required'
                : wsStatus === 'connected'
                  ? 'Waiting for Poco F3'
                  : 'Connecting to PurrCam…'}
            </h1>
            <p
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              className="mt-2.5 max-w-md text-sm leading-relaxed"
            >
              {wsStatus === 'auth_error'
                ? 'This server requires an access token. Open Connect to sign in or paste your pairing link.'
                : wsStatus === 'connected'
                  ? 'Open PurrCam on your Poco F3 in Camera Mode, or pair over Wi-Fi, USB ADB, or 4G/5G tunnel.'
                  : 'Looking for your PurrCam server. Check that it is running or set a custom URL in Connect.'}
            </p>
            <button
              type="button"
              onClick={onOpenConnect}
              style={{
                backgroundColor: 'var(--md-sys-color-primary)',
                color: 'var(--md-sys-color-on-primary)',
              }}
              className="m3-morph-pill mt-7 flex items-center gap-2.5 px-7 py-3.5 text-sm font-semibold shadow-lg"
            >
              <Globe className="h-4 w-4" />
              <span>Open Connect</span>
            </button>
          </div>
        )}

        {/* Reconnecting / Handshake Overlay */}
        {cameraOnline &&
          (!remoteStream ||
            rtcStatus === 'requesting' ||
            rtcStatus === 'connecting' ||
            rtcStatus === 'reconnecting') && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-sm">
              <div
                style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
                className="pointer-events-auto flex flex-col items-center gap-3.5 rounded-[32px] px-8 py-7 shadow-2xl"
              >
                <Loader2
                  style={{ color: 'var(--md-sys-color-primary)' }}
                  className="h-8 w-8 animate-spin"
                />
                <div className="text-center">
                  <p
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="text-sm font-semibold"
                  >
                    {rtcStatus === 'reconnecting'
                      ? 'Reconnecting stream…'
                      : 'Starting live video…'}
                  </p>
                  <p
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                    className="mt-0.5 text-xs"
                  >
                    {camera?.deviceName || 'Poco F3'}
                    {activeLens ? ` · ${formatLensLabel(activeLens)}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onReconnectStream}
                  style={{
                    backgroundColor: 'var(--md-sys-color-secondary-container)',
                    color: 'var(--md-sys-color-on-secondary-container)',
                  }}
                  className="m3-morph-pill mt-1 flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Retry</span>
                </button>
              </div>
            </div>
          )}

        {/* MINIMAL TOP FLOATING STATUS PILL */}
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-5 transition-opacity duration-300 ${
            showOverlay ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {/* Single sleek M3 tonal status capsule */}
          <div className="pointer-events-auto flex flex-wrap items-center gap-2">
            {cameraOnline && (
              <div
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                  color: 'var(--md-sys-color-on-surface)',
                }}
                className="flex items-center gap-2.5 rounded-full px-4 py-2 text-xs font-medium shadow-xl"
              >
                <span className="flex items-center gap-1.5 font-semibold tracking-wide">
                  <span
                    style={{
                      backgroundColor:
                        rtcStatus === 'live'
                          ? 'var(--md-sys-color-live)'
                          : 'var(--md-sys-color-warn)',
                    }}
                    className={`h-2 w-2 rounded-full ${
                      rtcStatus === 'live' ? 'animate-pulse' : ''
                    }`}
                  />
                  <span
                    style={{
                      color:
                        rtcStatus === 'live'
                          ? 'var(--md-sys-color-live)'
                          : 'var(--md-sys-color-warn)',
                    }}
                  >
                    {rtcStatus === 'live' ? 'LIVE' : 'SYNC'}
                  </span>
                </span>

                {rtcStats && rtcStats.width > 0 && (
                  <>
                    <span className="opacity-40">·</span>
                    <span className="font-mono tabular-nums">{rtcStats.fps} fps</span>
                    {rtcStats.rttMs !== null && (
                      <>
                        <span className="opacity-40">·</span>
                        <span
                          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                          className="font-mono tabular-nums"
                        >
                          {rtcStats.rttMs} ms
                        </span>
                      </>
                    )}
                  </>
                )}

                {telemetry && typeof telemetry.batteryPct === 'number' && (
                  <>
                    <span className="hidden opacity-40 sm:inline">·</span>
                    <span
                      style={{
                        color:
                          telemetry.batteryPct <= 20 && !telemetry.charging
                            ? 'var(--md-sys-color-error)'
                            : 'var(--md-sys-color-on-surface-variant)',
                      }}
                      className="hidden font-mono tabular-nums sm:inline"
                    >
                      {Math.round(telemetry.batteryPct)}%
                      {typeof telemetry.batteryTempC === 'number'
                        ? ` · ${telemetry.batteryTempC.toFixed(1)}°C`
                        : ''}
                    </span>
                  </>
                )}
              </div>
            )}

            {camera?.state.blackout && (
              <div
                style={{
                  backgroundColor: 'var(--md-sys-color-secondary-container)',
                  color: 'var(--md-sys-color-on-secondary-container)',
                }}
                className="flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold shadow-lg"
              >
                <Moon className="h-3.5 w-3.5" />
                <span>{camera.state.rootDisplayOff ? '0-nit Off' : 'Blackout'}</span>
              </div>
            )}
          </div>

          {/* Right subtle pills: REC, Zoom Reset, Fit/Fill, PiP, Fullscreen */}
          <div className="pointer-events-auto flex items-center gap-2">
            {isRecording && (
              <div
                style={{
                  backgroundColor: 'var(--md-sys-color-error-container)',
                  color: 'var(--md-sys-color-on-error-container)',
                }}
                className="flex items-center gap-1.5 rounded-full px-3.5 py-2 font-mono text-xs font-semibold tabular-nums shadow-lg"
              >
                <span
                  style={{ backgroundColor: 'var(--md-sys-color-error)' }}
                  className="h-2 w-2 animate-pulse rounded-full"
                />
                <span>REC {formatDuration(recordSeconds)}</span>
              </div>
            )}

            {digitalZoom > 1.01 && (
              <button
                type="button"
                onClick={() => updateDigitalZoom(1)}
                title="Reset digital zoom"
                style={{
                  backgroundColor: 'var(--md-sys-color-primary-container)',
                  color: 'var(--md-sys-color-on-primary-container)',
                }}
                className="m3-morph-pill flex items-center gap-1 px-3.5 py-2 font-mono text-xs font-semibold tabular-nums shadow-lg"
              >
                <span>{digitalZoom.toFixed(1)}×</span>
                <RotateCcw className="h-3 w-3" />
              </button>
            )}

            <div
              style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
              className="flex items-center gap-1 rounded-full p-1 shadow-xl"
            >
              <button
                type="button"
                disabled={!hasVideo}
                onClick={() => setFitMode((m) => (m === 'contain' ? 'cover' : 'contain'))}
                title={fitMode === 'contain' ? 'Switch to Fill' : 'Switch to Fit'}
                data-active={fitMode === 'cover'}
                style={{
                  backgroundColor:
                    fitMode === 'cover'
                      ? 'var(--md-sys-color-secondary-container)'
                      : 'transparent',
                  color:
                    fitMode === 'cover'
                      ? 'var(--md-sys-color-on-secondary-container)'
                      : 'var(--md-sys-color-on-surface-variant)',
                }}
                className="m3-morph-pill flex h-9 w-9 items-center justify-center disabled:opacity-35"
              >
                {fitMode === 'contain' ? (
                  <Expand className="h-4 w-4" />
                ) : (
                  <Shrink className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                disabled={!hasVideo}
                onClick={() => void togglePip()}
                title="Picture-in-Picture"
                data-active={isPip}
                style={{
                  backgroundColor: isPip
                    ? 'var(--md-sys-color-primary-container)'
                    : 'transparent',
                  color: isPip
                    ? 'var(--md-sys-color-on-primary-container)'
                    : 'var(--md-sys-color-on-surface-variant)',
                }}
                className="m3-morph-pill flex h-9 w-9 items-center justify-center disabled:opacity-35"
              >
                <PictureInPicture2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                data-active={isFullscreen}
                style={{
                  backgroundColor: isFullscreen
                    ? 'var(--md-sys-color-secondary-container)'
                    : 'transparent',
                  color: 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex h-9 w-9 items-center justify-center"
              >
                {isFullscreen ? (
                  <Minimize className="h-4 w-4" />
                ) : (
                  <Maximize className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Talkback Active Floating Indicator */}
        {talkbackActive && (
          <div className="pointer-events-none absolute top-18 left-1/2 z-10 -translate-x-1/2">
            <div
              style={{
                backgroundColor: 'var(--md-sys-color-primary)',
                color: 'var(--md-sys-color-on-primary)',
              }}
              className="flex items-center gap-2.5 rounded-[18px] px-4 py-2 text-xs font-semibold shadow-xl"
            >
              <div className="flex h-3.5 items-center gap-0.5">
                <span className="talk-bar-1 h-full w-0.5 rounded-full bg-current" />
                <span className="talk-bar-2 h-full w-0.5 rounded-full bg-current" />
                <span className="talk-bar-3 h-full w-0.5 rounded-full bg-current" />
              </div>
              <span>Talking to Poco F3 speaker</span>
            </div>
          </div>
        )}

        {/* BOTTOM FLOATING M3 EXPRESSIVE LENS DOCK + 56px FLOATING ACTION TOOLBAR */}
        {cameraOnline && (
          <div
            onMouseEnter={() => setHudPinned(true)}
            onMouseLeave={() => {
              setHudPinned(false);
              bumpHud();
            }}
            className={`absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 bg-gradient-to-t from-black/85 via-black/35 to-transparent px-3 pt-12 pb-5 transition-opacity duration-300 sm:px-6 sm:pb-6 ${
              showOverlay ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            {/* Floating M3 Expressive Tune Sheet */}
            {tuneOpen && (
              <div
                data-tune-sheet
                style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
                className="mb-1 w-full max-w-lg rounded-[32px] p-6 shadow-2xl"
              >
                <div className="mb-4 flex items-center justify-between">
                  <span
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="text-base font-semibold"
                  >
                    Camera & Sound Controls
                  </span>
                  <button
                    type="button"
                    onClick={() => setTuneOpen(false)}
                    aria-label="Close controls"
                    style={{
                      backgroundColor: 'var(--md-sys-color-surface-container-high)',
                      color: 'var(--md-sys-color-on-surface-variant)',
                    }}
                    className="m3-morph-pill flex h-9 w-9 items-center justify-center"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* Cat Attention Sounds — Connected Pill Group */}
                <div className="mb-4">
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                    className="mb-2 text-xs font-semibold"
                  >
                    Cat Cues
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => sendSound('psps')}
                      style={{
                        backgroundColor: 'var(--md-sys-color-secondary-container)',
                        color: 'var(--md-sys-color-on-secondary-container)',
                      }}
                      className="m3-morph-pill flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold"
                    >
                      <Cat className="h-3.5 w-3.5" />
                      <span>Psps</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => sendSound('chime')}
                      style={{
                        backgroundColor: 'var(--md-sys-color-secondary-container)',
                        color: 'var(--md-sys-color-on-secondary-container)',
                      }}
                      className="m3-morph-pill flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold"
                    >
                      <Bell className="h-3.5 w-3.5" />
                      <span>Chime</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => sendSound('whistle')}
                      style={{
                        backgroundColor: 'var(--md-sys-color-secondary-container)',
                        color: 'var(--md-sys-color-on-secondary-container)',
                      }}
                      className="m3-morph-pill flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Whistle</span>
                    </button>
                  </div>
                </div>

                {/* M3 Expressive Thick-Track Sliders: Exposure EV, Optical Zoom, Digital Zoom, Volume */}
                <div className="space-y-3">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span
                        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                        className="flex items-center gap-1.5 font-medium"
                      >
                        <Sun
                          style={{ color: 'var(--md-sys-color-primary)' }}
                          className="h-3.5 w-3.5"
                        />
                        Exposure (EV)
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span
                          style={{ color: 'var(--md-sys-color-primary)' }}
                          className="font-mono font-semibold tabular-nums"
                        >
                          {draftEv > 0 ? `+${draftEv.toFixed(1)}` : draftEv.toFixed(1)} EV
                        </span>
                        {draftEv !== 0 && (
                          <button
                            type="button"
                            onClick={() => handleEvSlider(0)}
                            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                            className="rounded-full p-0.5"
                            title="Reset EV"
                          >
                            <RotateCcw className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </div>
                    <M3Slider
                      min={-3}
                      max={3}
                      step={0.5}
                      value={Math.max(-3, Math.min(3, draftEv))}
                      ariaLabel="Exposure compensation EV"
                      onChange={handleEvSlider}
                    />
                  </div>

                  <div className="grid gap-3.5 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span
                          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                          className="flex items-center gap-1.5 font-medium"
                        >
                          <ZoomIn
                            style={{ color: 'var(--md-sys-color-primary)' }}
                            className="h-3.5 w-3.5"
                          />
                          Camera Zoom
                        </span>
                        <span
                          style={{ color: 'var(--md-sys-color-primary)' }}
                          className="font-mono font-semibold tabular-nums"
                        >
                          {draftCamZoom.toFixed(1)}×
                        </span>
                      </div>
                      <M3Slider
                        min={1}
                        max={maxOpticalZoom}
                        step={0.1}
                        value={Math.min(draftCamZoom, maxOpticalZoom)}
                        disabled={maxOpticalZoom <= 1}
                        ariaLabel="Camera2 optical zoom"
                        onChange={handleOpticalZoomSlider}
                      />
                    </div>

                    <div>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span
                          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                          className="font-medium"
                        >
                          Digital Zoom
                        </span>
                        <span
                          style={{ color: 'var(--md-sys-color-primary)' }}
                          className="font-mono font-semibold tabular-nums"
                        >
                          {digitalZoom.toFixed(1)}×
                        </span>
                      </div>
                      <M3Slider
                        min={1}
                        max={4}
                        step={0.1}
                        value={digitalZoom}
                        ariaLabel="Digital zoom"
                        onChange={updateDigitalZoom}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span
                        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                        className="flex items-center gap-1.5 font-medium"
                      >
                        <Volume2
                          style={{ color: 'var(--md-sys-color-primary)' }}
                          className="h-3.5 w-3.5"
                        />
                        Speaker Volume
                      </span>
                      <span
                        style={{ color: 'var(--md-sys-color-on-surface)' }}
                        className="font-mono font-semibold tabular-nums"
                      >
                        {muted ? 'Muted' : `${Math.round(volume * 100)}%`}
                      </span>
                    </div>
                    <M3Slider
                      min={0}
                      max={1}
                      step={0.05}
                      value={muted ? 0 : volume}
                      ariaLabel="Speaker volume"
                      onChange={(v) => {
                        setVolume(v);
                        if (v > 0 && muted) setMuted(false);
                        if (v === 0 && !muted) setMuted(true);
                      }}
                    />
                  </div>
                </div>

                {/* Video Profile — M3 Connected Button Groups */}
                <div
                  style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
                  className="mt-4 space-y-2.5 rounded-[24px] p-3.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                      className="text-xs font-semibold"
                    >
                      Profile
                    </span>
                    <M3ConnectedButtonGroup<VideoResolution>
                      size="sm"
                      value={state?.resolution ?? '720p'}
                      onChange={(resolution) =>
                        onSendCommand('set_video_config', { resolution })
                      }
                      options={[
                        { value: '480p', label: '480p' },
                        { value: '720p', label: '720p' },
                        { value: '1080p', label: '1080p' },
                      ]}
                    />
                    <M3ConnectedButtonGroup<number>
                      size="sm"
                      variant="secondary"
                      value={state?.fps ?? 24}
                      onChange={(fps) => onSendCommand('set_video_config', { fps })}
                      options={[
                        { value: 15, label: '15 fps' },
                        { value: 24, label: '24 fps' },
                        { value: 30, label: '30 fps' },
                      ]}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                      className="text-xs font-semibold"
                    >
                      Bitrate
                    </span>
                    <M3ConnectedButtonGroup<number>
                      size="sm"
                      value={closestBitratePreset}
                      onChange={handleBitrateChange}
                      options={BITRATE_PRESETS.map((p) => ({
                        value: p.kbps,
                        label: p.label,
                      }))}
                    />
                  </div>
                </div>

                {/* Footer utility actions */}
                <div className="mt-4 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onSendCommand('request_snapshot', {})}
                    style={{
                      backgroundColor: 'var(--md-sys-color-surface-container-high)',
                      color: 'var(--md-sys-color-on-surface)',
                    }}
                    className="m3-morph-pill flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
                  >
                    <Camera
                      style={{ color: 'var(--md-sys-color-primary)' }}
                      className="h-3.5 w-3.5"
                    />
                    <span>HD Still (F3)</span>
                  </button>

                  {confirmReboot ? (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmReboot(false);
                        onSendCommand('reboot_camera', {});
                      }}
                      onMouseLeave={() => setConfirmReboot(false)}
                      style={{
                        backgroundColor: 'var(--md-sys-color-error-container)',
                        color: 'var(--md-sys-color-on-error-container)',
                      }}
                      className="m3-morph-pill flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
                    >
                      <Power className="h-3.5 w-3.5" />
                      <span>Confirm Restart</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmReboot(true)}
                      style={{
                        backgroundColor: 'var(--md-sys-color-surface-container-high)',
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                      className="m3-morph-pill flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
                    >
                      <Power className="h-3.5 w-3.5" />
                      <span>Restart Camera</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Floating M3 Expressive Shape-Morphing Lens Dock (matches Android ExpressiveLensDock 1:1) */}
            {lenses.length > 0 && (
              <div
                style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
                className="flex flex-wrap items-center justify-center gap-1.5 rounded-full p-1.5 shadow-xl"
              >
                {lenses.map((lens) => {
                  const isActive = lens.id === state?.activeLensId;
                  return (
                    <button
                      key={lens.id}
                      type="button"
                      data-active={isActive}
                      disabled={pendingActions['switch_lens']}
                      onClick={() => onSendCommand('switch_lens', { lensId: lens.id })}
                      style={{
                        backgroundColor: isActive
                          ? 'var(--md-sys-color-primary)'
                          : 'transparent',
                        color: isActive
                          ? 'var(--md-sys-color-on-primary)'
                          : 'var(--md-sys-color-on-surface)',
                      }}
                      className="m3-morph-pill px-4 py-2 text-xs font-semibold disabled:opacity-50"
                    >
                      {formatLensLabel(lens)}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Floating M3 Expressive Action Toolbar (56px tall expressive buttons in stadium capsule) */}
            <div
              style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
              className="flex flex-wrap items-center justify-center gap-2 rounded-full p-2 shadow-2xl"
            >
              {/* Talkback FAB-style Squircle */}
              <button
                type="button"
                data-active="true"
                disabled={!hasVideo || talkbackBusy}
                onClick={() => void onSetTalkback(!talkbackActive)}
                title="Talk through Poco F3 speaker"
                style={{
                  backgroundColor: talkbackActive
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-primary-container)',
                  color: talkbackActive
                    ? 'var(--md-sys-color-on-primary)'
                    : 'var(--md-sys-color-on-primary-container)',
                }}
                className="m3-morph-pill flex h-12 items-center gap-2 px-5 text-xs font-semibold shadow-md disabled:opacity-40"
              >
                {talkbackBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : talkbackActive ? (
                  <Mic className="h-4 w-4" />
                ) : (
                  <MicOff className="h-4 w-4" />
                )}
                <span>{talkbackActive ? 'Talking' : 'Talk'}</span>
              </button>

              {/* Audio Listen */}
              <button
                type="button"
                data-active={!muted && hasVideo}
                disabled={!hasVideo}
                onClick={() => setMuted((m) => !m)}
                title={muted ? 'Unmute camera audio' : 'Mute audio'}
                style={{
                  backgroundColor:
                    !muted && hasVideo
                      ? 'var(--md-sys-color-secondary-container)'
                      : 'var(--md-sys-color-surface-container)',
                  color:
                    !muted && hasVideo
                      ? 'var(--md-sys-color-on-secondary-container)'
                      : 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex h-12 items-center gap-1.5 px-4 text-xs font-semibold disabled:opacity-40"
              >
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                <span className="hidden sm:inline">Audio</span>
              </button>

              {/* Snapshot */}
              <button
                type="button"
                disabled={capturingSnapshot}
                onClick={() => void handleSnapshot()}
                title="Capture Snapshot"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                  color: 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex h-12 items-center gap-1.5 px-4 text-xs font-semibold disabled:opacity-40"
              >
                {capturingSnapshot ? (
                  <Loader2
                    style={{ color: 'var(--md-sys-color-primary)' }}
                    className="h-4 w-4 animate-spin"
                  />
                ) : (
                  <Camera className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">Snapshot</span>
              </button>

              {/* Local Record */}
              <button
                type="button"
                data-active={isRecording}
                disabled={!hasVideo && !isRecording}
                onClick={toggleRecording}
                title={isRecording ? 'Stop recording (.webm)' : 'Record video locally (.webm)'}
                style={{
                  backgroundColor: isRecording
                    ? 'var(--md-sys-color-error-container)'
                    : 'var(--md-sys-color-surface-container)',
                  color: isRecording
                    ? 'var(--md-sys-color-on-error-container)'
                    : 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex h-12 items-center gap-1.5 px-4 text-xs font-semibold disabled:opacity-40"
              >
                {isRecording ? (
                  <Square
                    style={{ color: 'var(--md-sys-color-error)' }}
                    className="h-3.5 w-3.5 fill-current"
                  />
                ) : (
                  <Circle
                    style={{ color: 'var(--md-sys-color-error)' }}
                    className="h-3.5 w-3.5 fill-current"
                  />
                )}
                <span className="hidden sm:inline">{isRecording ? 'Stop' : 'Record'}</span>
              </button>

              {/* Torch */}
              <button
                type="button"
                data-active={Boolean(state?.torch)}
                disabled={!torchSupported || pendingActions['set_torch']}
                onClick={() => onSendCommand('set_torch', { enabled: !state?.torch })}
                title="Toggle LED Torch"
                style={{
                  backgroundColor: state?.torch
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-surface-container)',
                  color: state?.torch
                    ? 'var(--md-sys-color-on-primary)'
                    : 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex h-12 items-center gap-1.5 px-4 text-xs font-semibold disabled:opacity-35"
              >
                <Flashlight className="h-4 w-4" />
                <span className="hidden md:inline">Torch</span>
              </button>

              {/* AMOLED Blackout */}
              <button
                type="button"
                data-active={Boolean(state?.blackout)}
                disabled={pendingActions['set_blackout']}
                onClick={() =>
                  onSendCommand('set_blackout', {
                    enabled: !state?.blackout,
                    rootDisplayOff: !state?.blackout ? Boolean(state?.rootDisplayOff) : false,
                  })
                }
                title="Toggle AMOLED Blackout on Poco F3"
                style={{
                  backgroundColor: state?.blackout
                    ? 'var(--md-sys-color-secondary-container)'
                    : 'var(--md-sys-color-surface-container)',
                  color: state?.blackout
                    ? 'var(--md-sys-color-on-secondary-container)'
                    : 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex h-12 items-center gap-1.5 px-4 text-xs font-semibold disabled:opacity-40"
              >
                <Moon className="h-4 w-4" />
                <span className="hidden md:inline">Blackout</span>
              </button>

              {/* Tune Popover Toggle */}
              <button
                type="button"
                data-active={tuneOpen}
                onClick={() => setTuneOpen((o) => !o)}
                title="Exposure, Zoom, Cat Cues & Quality"
                style={{
                  backgroundColor: tuneOpen
                    ? 'var(--md-sys-color-tertiary-container)'
                    : 'var(--md-sys-color-surface-container)',
                  color: tuneOpen
                    ? 'var(--md-sys-color-on-tertiary-container)'
                    : 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex h-12 items-center gap-1.5 px-4 text-xs font-semibold"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span className="hidden sm:inline">Tune</span>
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
