import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  loadConnectionConfig,
  saveConnectionConfig,
  type ConnectionConfig,
} from './lib/connection';
import { fetchServerInfo } from './lib/api';
import { usePurrCam } from './hooks/usePurrCam';
import { NavRail, type AppTab, type M3ColorSeed } from './components/NavRail';
import { LiveView } from './components/LiveView';
import { HealthView } from './components/HealthView';
import { GalleryView } from './components/GalleryView';
import { ConnectView } from './components/ConnectView';

const STORAGE_M3_SEED = 'purrcam.m3Seed';
const VALID_SEEDS: M3ColorSeed[] = ['lavender', 'amber', 'emerald', 'ocean'];

function loadSavedColorSeed(): M3ColorSeed {
  try {
    const raw = localStorage.getItem(STORAGE_M3_SEED) as M3ColorSeed | null;
    if (raw && VALID_SEEDS.includes(raw)) return raw;
  } catch {
    // ignore storage errors
  }
  return 'lavender';
}

export function App() {
  const [config, setConfig] = useState<ConnectionConfig>(() => loadConnectionConfig());
  const [activeTab, setActiveTab] = useState<AppTab>('live');
  const [colorSeed, setColorSeed] = useState<M3ColorSeed>(() => loadSavedColorSeed());

  const purr = usePurrCam(config);

  // Sync Material 3 Dynamic Color Seed attribute onto <html>
  useEffect(() => {
    document.documentElement.setAttribute('data-m3-seed', colorSeed);
    try {
      localStorage.setItem(STORAGE_M3_SEED, colorSeed);
    } catch {
      // ignore
    }
  }, [colorSeed]);

  // Hydrate initial remote tunnel badge state from /api/info on boot
  useEffect(() => {
    let cancelled = false;
    fetchServerInfo(config.serverUrl, config.token)
      .then((info) => {
        if (!cancelled && info.remote) {
          purr.setRemoteStatus(info.remote);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.serverUrl, config.token]);

  const handleApplyConfig = (next: ConnectionConfig) => {
    saveConnectionConfig(next);
    setConfig(next);
    purr.pushToast(
      'info',
      next.serverUrl ? `Connecting to ${next.serverUrl}` : 'Using current host server'
    );
  };

  // Compute health alert indicator for NavRail
  const batPct = purr.telemetry?.batteryPct;
  const batTemp = purr.telemetry?.batteryTempC;
  const cpuTemp = purr.telemetry?.cpuTempC;
  const isHot =
    (typeof batTemp === 'number' && batTemp > 45) ||
    (typeof cpuTemp === 'number' && cpuTemp > 45);
  const isWarm =
    !isHot &&
    ((typeof batTemp === 'number' && batTemp > 40) ||
      (typeof cpuTemp === 'number' && cpuTemp > 40));
  const isLowBat = typeof batPct === 'number' && batPct <= 20 && !purr.telemetry?.charging;
  const healthAlertTone: 'red' | 'amber' | null =
    isHot || isLowBat ? 'red' : isWarm ? 'amber' : null;

  return (
    <div
      data-m3-seed={colorSeed}
      style={{
        backgroundColor: 'var(--md-sys-color-surface)',
        color: 'var(--md-sys-color-on-surface)',
      }}
      className="flex min-h-screen w-full"
    >
      <NavRail
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        colorSeed={colorSeed}
        onSelectColorSeed={setColorSeed}
        wsStatus={purr.wsStatus}
        cameraOnline={purr.cameraOnline}
        healthAlertTone={healthAlertTone}
        snapshotCount={purr.snapshots.length}
        remoteStatus={purr.remoteStatus}
      />

      {/* Focused Single-View Stage (Live stays mounted so audio & .webm recordings persist across tab switches) */}
      <main className="min-w-0 flex-1 overflow-y-auto md:h-screen">
        <div className={activeTab === 'live' ? 'h-full' : 'hidden'}>
          <LiveView
            wsStatus={purr.wsStatus}
            rtcStatus={purr.rtcStatus}
            cameraOnline={purr.cameraOnline}
            camera={purr.camera}
            telemetry={purr.telemetry}
            remoteStream={purr.remoteStream}
            rtcStats={purr.rtcStats}
            talkbackActive={purr.talkbackActive}
            talkbackBusy={purr.talkbackBusy}
            pendingActions={purr.pendingActions}
            serverUrl={config.serverUrl}
            token={config.token}
            onSetTalkback={purr.setTalkback}
            onSendCommand={purr.sendCommand}
            onSnapshotUploaded={purr.addSnapshotLocal}
            onOpenConnect={() => setActiveTab('connect')}
            onReconnectStream={purr.reconnectStream}
            onNotify={purr.pushToast}
          />
        </div>

        {activeTab === 'health' && (
          <HealthView
            cameraOnline={purr.cameraOnline}
            camera={purr.camera}
            telemetry={purr.telemetry}
            telemetryHistory={purr.telemetryHistory}
            rtcStats={purr.rtcStats}
            pendingActions={purr.pendingActions}
            onSendCommand={purr.sendCommand}
          />
        )}

        {activeTab === 'gallery' && (
          <GalleryView
            snapshots={purr.snapshots}
            serverUrl={config.serverUrl}
            token={config.token}
            cameraOnline={purr.cameraOnline}
            onRefresh={purr.refreshSnapshots}
            onDelete={purr.removeSnapshot}
            onRequestCameraSnapshot={() => purr.sendCommand('request_snapshot', {})}
          />
        )}

        {activeTab === 'connect' && (
          <ConnectView
            config={config}
            wsStatus={purr.wsStatus}
            liveRemoteStatus={purr.remoteStatus}
            onRemoteStatusChange={purr.setRemoteStatus}
            onApplyConfig={handleApplyConfig}
            onNotify={purr.pushToast}
          />
        )}
      </main>

      {/* Material 3 Expressive Snackbars / Toasts */}
      {purr.toasts.length > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed right-4 bottom-24 z-50 flex max-w-sm flex-col gap-2 md:bottom-5"
        >
          {purr.toasts.map((toast) => (
            <div
              key={toast.id}
              style={{
                backgroundColor:
                  toast.tone === 'error'
                    ? 'var(--md-sys-color-error-container)'
                    : toast.tone === 'warning'
                      ? 'var(--md-sys-color-warn-container)'
                      : toast.tone === 'success'
                        ? 'var(--md-sys-color-live-container)'
                        : 'var(--md-sys-color-secondary-container)',
                color:
                  toast.tone === 'error'
                    ? 'var(--md-sys-color-on-error-container)'
                    : toast.tone === 'warning'
                      ? 'var(--md-sys-color-on-warn-container)'
                      : toast.tone === 'success'
                        ? 'var(--md-sys-color-on-live-container)'
                        : 'var(--md-sys-color-on-secondary-container)',
              }}
              className="pointer-events-auto flex items-center justify-between gap-3 rounded-[18px] px-4 py-3 text-xs font-semibold shadow-2xl"
            >
              <span>{toast.message}</span>
              <button
                type="button"
                onClick={() => purr.dismissToast(toast.id)}
                aria-label="Dismiss"
                className="opacity-70 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
