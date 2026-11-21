import { Activity, Globe, Images, Video } from 'lucide-react';
import type { RemoteTunnelStatus, WsConnectionStatus } from '../types/protocol';

export type AppTab = 'live' | 'health' | 'gallery' | 'connect';
export type M3ColorSeed = 'lavender' | 'amber' | 'emerald' | 'ocean';

interface NavRailProps {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  colorSeed: M3ColorSeed;
  onSelectColorSeed: (seed: M3ColorSeed) => void;
  wsStatus: WsConnectionStatus;
  cameraOnline: boolean;
  healthAlertTone: 'red' | 'amber' | null;
  snapshotCount: number;
  remoteStatus: RemoteTunnelStatus | null;
}

const NAV_ITEMS: { id: AppTab; label: string; icon: typeof Video }[] = [
  { id: 'live', label: 'Live', icon: Video },
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'gallery', label: 'Gallery', icon: Images },
  { id: 'connect', label: 'Connect', icon: Globe },
];

const SEED_OPTIONS: { id: M3ColorSeed; label: string; swatch: string }[] = [
  { id: 'lavender', label: 'M3 Lavender (Monet)', swatch: '#D0BCFF' },
  { id: 'amber', label: 'Cat-Eye Amber', swatch: '#FFB951' },
  { id: 'emerald', label: 'Emerald Moss', swatch: '#83D6B1' },
  { id: 'ocean', label: 'Ocean Blue', swatch: '#A8C7FA' },
];

export function NavRail({
  activeTab,
  onSelectTab,
  colorSeed,
  onSelectColorSeed,
  wsStatus,
  cameraOnline,
  healthAlertTone,
  snapshotCount,
  remoteStatus,
}: NavRailProps) {
  const tunnelRunning = remoteStatus?.status === 'running';

  return (
    <>
      {/* Desktop Material 3 Expressive 96px Navigation Rail */}
      <aside
        aria-label="Primary navigation"
        style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
        className="hidden h-screen w-[96px] shrink-0 flex-col items-center justify-between py-6 md:flex"
      >
        {/* Top Expressive 56x56px Squircle Logo Badge */}
        <button
          type="button"
          onClick={() => onSelectTab('live')}
          title="PurrCam"
          className="m3-spring group flex flex-col items-center gap-1.5 focus:outline-none"
        >
          <div
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
            className="m3-spring flex h-14 w-14 items-center justify-center rounded-[18px] shadow-md group-hover:rounded-[22px]"
          >
            <img src="/favicon.svg" alt="PurrCam" className="h-9 w-9" />
          </div>
          <span
            style={{ color: 'var(--md-sys-color-on-surface)' }}
            className="text-[11px] font-semibold tracking-tight"
          >
            PurrCam
          </span>
        </button>

        {/* Center Navigation Destinations with Signature 56x32px Stadium Active Pill */}
        <nav className="flex flex-col items-center gap-3.5">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSelectTab(id)}
                className="group flex flex-col items-center gap-1 focus:outline-none"
              >
                <div className="relative flex h-8 w-14 items-center justify-center">
                  {/* Animated 56x32px M3 Stadium Indicator Pill */}
                  <span
                    style={{
                      backgroundColor: active
                        ? 'var(--md-sys-color-secondary-container)'
                        : 'transparent',
                    }}
                    className={`m3-spring absolute inset-y-0 rounded-full ${
                      active
                        ? 'w-14 opacity-100'
                        : 'w-7 opacity-0 group-hover:w-14 group-hover:bg-[var(--md-sys-color-surface-container-high)] group-hover:opacity-100'
                    }`}
                  />
                  <Icon
                    style={{
                      color: active
                        ? 'var(--md-sys-color-on-secondary-container)'
                        : 'var(--md-sys-color-on-surface-variant)',
                    }}
                    className="relative z-10 h-[21px] w-[21px]"
                    strokeWidth={active ? 2.3 : 1.9}
                  />

                  {/* Contextual Status Dots */}
                  {id === 'live' && cameraOnline && (
                    <span
                      style={{ backgroundColor: 'var(--md-sysStatus, var(--md-sys-color-live))' }}
                      className="absolute top-1 right-2.5 z-20 h-2 w-2 rounded-full"
                    />
                  )}
                  {id === 'health' && healthAlertTone && (
                    <span
                      style={{
                        backgroundColor:
                          healthAlertTone === 'red'
                            ? 'var(--md-sys-color-error)'
                            : 'var(--md-sys-color-warn)',
                      }}
                      className={`absolute top-1 right-2.5 z-20 h-2 w-2 rounded-full ${
                        healthAlertTone === 'red' ? 'animate-pulse' : ''
                      }`}
                    />
                  )}
                  {id === 'gallery' && snapshotCount > 0 && (
                    <span
                      style={{
                        backgroundColor: 'var(--md-sys-color-tertiary-container)',
                        color: 'var(--md-sys-color-on-tertiary-container)',
                      }}
                      className="absolute -top-1 right-1 z-20 rounded-full px-1.5 py-0.2 font-mono text-[9px] font-bold tabular-nums"
                    >
                      {snapshotCount > 99 ? '99+' : snapshotCount}
                    </span>
                  )}
                  {id === 'connect' && tunnelRunning && (
                    <span
                      style={{ backgroundColor: 'var(--md-sys-color-live)' }}
                      className="absolute top-1 right-2.5 z-20 h-2 w-2 rounded-full"
                    />
                  )}
                </div>
                <span
                  style={{
                    color: active
                      ? 'var(--md-sys-color-on-surface)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  className={`text-xs transition-colors ${
                    active ? 'font-semibold' : 'font-medium'
                  }`}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Bottom: M3 Dynamic Color Seed Switcher (4 seeds) + Connection Indicator */}
        <div className="flex flex-col items-center gap-3">
          <div
            role="radiogroup"
            aria-label="Material 3 Dynamic Color Seed"
            style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
            className="grid grid-cols-2 gap-1.5 rounded-[18px] p-2"
          >
            {SEED_OPTIONS.map((seed) => {
              const active = colorSeed === seed.id;
              return (
                <button
                  key={seed.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={seed.label}
                  title={seed.label}
                  onClick={() => onSelectColorSeed(seed.id)}
                  style={{ backgroundColor: seed.swatch }}
                  className={`m3-spring h-4 w-4 ${
                    active
                      ? 'scale-110 rounded-[5px] ring-2 ring-[var(--md-sys-color-on-surface)]'
                      : 'rounded-full opacity-70 hover:opacity-100'
                  }`}
                />
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => onSelectTab('connect')}
            title={
              wsStatus === 'auth_error'
                ? 'Access token required'
                : wsStatus !== 'connected'
                  ? 'Reconnecting to server…'
                  : cameraOnline
                    ? 'Camera online'
                    : 'Server connected · Camera offline'
            }
            style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
            className="m3-spring flex items-center gap-1.5 rounded-full px-3 py-1.5"
          >
            <span
              style={{
                backgroundColor:
                  wsStatus === 'auth_error'
                    ? 'var(--md-sys-color-error)'
                    : wsStatus !== 'connected'
                      ? 'var(--md-sys-color-warn)'
                      : cameraOnline
                        ? 'var(--md-sys-color-live)'
                        : 'var(--md-sys-color-on-surface-variant)',
              }}
              className={`relative inline-block h-2 w-2 rounded-full ${
                cameraOnline && wsStatus === 'connected' ? 'live-pulse' : ''
              }`}
            />
            <span
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              className="text-[10px] font-semibold"
            >
              {wsStatus === 'auth_error'
                ? 'Auth'
                : wsStatus !== 'connected'
                  ? 'Sync'
                  : cameraOnline
                    ? 'Live'
                    : 'Idle'}
            </span>
          </button>
        </div>
      </aside>

      {/* Mobile Material 3 Expressive Bottom Navigation Bar */}
      <nav
        aria-label="Primary navigation"
        style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
        className="fixed inset-x-0 bottom-0 z-30 flex h-[78px] items-center justify-around px-2 pb-[env(safe-area-inset-bottom)] shadow-2xl md:hidden"
      >
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectTab(id)}
              className="flex flex-1 flex-col items-center justify-center gap-1 py-1.5 focus:outline-none"
            >
              <div className="relative flex h-8 w-16 items-center justify-center">
                <span
                  style={{
                    backgroundColor: active
                      ? 'var(--md-sys-color-secondary-container)'
                      : 'transparent',
                  }}
                  className={`m3-spring absolute inset-y-0 rounded-full ${
                    active ? 'w-14 opacity-100' : 'w-6 opacity-0'
                  }`}
                />
                <Icon
                  style={{
                    color: active
                      ? 'var(--md-sys-color-on-secondary-container)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  }}
                  className="relative z-10 h-5 w-5"
                  strokeWidth={active ? 2.3 : 1.9}
                />
                {id === 'health' && healthAlertTone && (
                  <span
                    style={{
                      backgroundColor:
                        healthAlertTone === 'red'
                          ? 'var(--md-sys-color-error)'
                          : 'var(--md-sys-color-warn)',
                    }}
                    className="absolute top-1 right-3 z-20 h-2 w-2 rounded-full"
                  />
                )}
                {id === 'connect' && tunnelRunning && (
                  <span
                    style={{ backgroundColor: 'var(--md-sys-color-live)' }}
                    className="absolute top-1 right-3 z-20 h-2 w-2 rounded-full"
                  />
                )}
              </div>
              <span
                style={{
                  color: active
                    ? 'var(--md-sys-color-on-surface)'
                    : 'var(--md-sys-color-on-surface-variant)',
                }}
                className={`text-[11px] ${active ? 'font-semibold' : 'font-medium'}`}
              >
                {label}
              </span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
