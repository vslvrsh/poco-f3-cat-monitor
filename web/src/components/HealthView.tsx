import { useEffect, useRef, useState } from 'react';
import {
  Battery,
  BatteryCharging,
  BatteryWarning,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
  Moon,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Thermometer,
  Wifi,
  Zap,
} from 'lucide-react';
import type {
  CameraSummary,
  CommandAction,
  CommandPayloads,
  Telemetry,
  WebRtcLiveStats,
} from '../types/protocol';
import { M3Slider, M3Switch } from './M3Controls';
import { TelemetryChart } from './TelemetryChart';

interface HealthViewProps {
  cameraOnline: boolean;
  camera: CameraSummary | null;
  telemetry: Telemetry | null;
  telemetryHistory: Telemetry[];
  rtcStats: WebRtcLiveStats | null;
  pendingActions: Record<string, boolean>;
  onSendCommand: <A extends CommandAction>(
    action: A,
    payload: CommandPayloads[A],
    options?: { silent?: boolean }
  ) => string | null;
}

function getTempStyle(tempC: number | null | undefined) {
  if (typeof tempC !== 'number') {
    return {
      cardBg: 'var(--md-sys-color-surface-container)',
      valueColor: 'var(--md-sys-color-on-surface-variant)',
      chipBg: 'var(--md-sys-color-surface-container-high)',
      chipColor: 'var(--md-sys-color-on-surface-variant)',
      label: 'No Data',
    };
  }
  if (tempC > 45) {
    return {
      cardBg: 'var(--md-sys-color-error-container)',
      valueColor: 'var(--md-sys-color-on-error-container)',
      chipBg: 'var(--md-sys-color-error)',
      chipColor: 'var(--md-sys-color-on-error)',
      label: 'Hot',
    };
  }
  if (tempC > 40) {
    return {
      cardBg: 'var(--md-sys-color-warn-container)',
      valueColor: 'var(--md-sys-color-on-warn-container)',
      chipBg: 'var(--md-sys-color-warn)',
      chipColor: '#2B1B05',
      label: 'Warm',
    };
  }
  return {
    cardBg: 'var(--md-sys-color-surface-container)',
    valueColor: 'var(--md-sys-color-on-surface)',
    chipBg: 'var(--md-sys-color-live-container)',
    chipColor: 'var(--md-sys-color-on-live-container)',
    label: 'Normal',
  };
}

function formatUptime(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || sec < 0) return '—';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${Math.floor(sec % 60)}s`;
}

function formatMb(mb: number | null | undefined): string {
  if (typeof mb !== 'number') return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function getWifiQuality(rssi: number | null | undefined): { label: string; bars: number } {
  if (typeof rssi !== 'number') return { label: 'Unknown', bars: 0 };
  if (rssi >= -55) return { label: 'Excellent', bars: 4 };
  if (rssi >= -67) return { label: 'Good', bars: 3 };
  if (rssi >= -77) return { label: 'Fair', bars: 2 };
  return { label: 'Weak', bars: 1 };
}

function formatChargeSource(source?: string): string {
  switch (source) {
    case 'ac':
      return 'AC Power';
    case 'usb':
      return 'USB';
    case 'wireless':
      return 'Wireless';
    default:
      return 'On Battery';
  }
}

export function HealthView({
  cameraOnline,
  camera,
  telemetry,
  telemetryHistory,
  rtcStats,
  pendingActions,
  onSendCommand,
}: HealthViewProps) {
  const state = camera?.state;
  const capabilities = camera?.capabilities;
  const batPct = telemetry?.batteryPct;
  const batTempStyle = getTempStyle(telemetry?.batteryTempC);
  const cpuTempStyle = getTempStyle(telemetry?.cpuTempC);
  const wifiInfo = getWifiQuality(telemetry?.wifiRssi);
  const lowBattery = typeof batPct === 'number' && batPct <= 20 && !telemetry?.charging;
  const rootDisplaySupported = Boolean(capabilities?.root || capabilities?.rootDisplayOff);

  const [draftMaxPct, setDraftMaxPct] = useState<number>(state?.chargeLimitMaxPct ?? 80);
  const limitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof state?.chargeLimitMaxPct === 'number') {
      setDraftMaxPct(state.chargeLimitMaxPct);
    }
  }, [state?.chargeLimitMaxPct]);

  useEffect(() => {
    return () => {
      if (limitTimerRef.current) window.clearTimeout(limitTimerRef.current);
    };
  }, []);

  const handleChargeLimitPctChange = (maxPct: number) => {
    setDraftMaxPct(maxPct);
    if (limitTimerRef.current) window.clearTimeout(limitTimerRef.current);
    limitTimerRef.current = window.setTimeout(() => {
      onSendCommand(
        'set_charge_limit',
        {
          enabled: Boolean(state?.chargeLimitEnabled),
          maxPct,
        },
        { silent: true }
      );
    }, 150);
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 pb-28 sm:px-6 md:py-8 md:pb-10">
      {/* Expressive Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1
            style={{ color: 'var(--md-sys-color-on-surface)' }}
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            Device Health
          </h1>
          <p
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            className="mt-1 text-sm"
          >
            Live battery, thermal safety, and OLED power controls for your Poco F3
          </p>
        </div>

        <div
          style={{
            backgroundColor: cameraOnline
              ? 'var(--md-sys-color-live-container)'
              : 'var(--md-sys-color-surface-container-high)',
            color: cameraOnline
              ? 'var(--md-sys-color-on-live-container)'
              : 'var(--md-sys-color-on-surface-variant)',
          }}
          className="flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold"
        >
          <span
            style={{
              backgroundColor: cameraOnline
                ? 'var(--md-sys-color-live)'
                : 'var(--md-sys-color-on-surface-variant)',
            }}
            className="h-2 w-2 rounded-full"
          />
          <span>
            {cameraOnline ? `${camera?.deviceName || 'Poco F3'} · Online` : 'Camera Offline'}
          </span>
        </div>
      </div>

      {/* Primary Row: Battery Hero + AMOLED & Power */}
      <div className="mb-4 grid gap-4 md:grid-cols-2">
        {/* Battery & Root Charge Guard Card */}
        <div
          style={{
            backgroundColor: lowBattery
              ? 'var(--md-sys-color-error-container)'
              : 'var(--md-sys-color-surface-container)',
          }}
          className="flex flex-col justify-between rounded-[32px] p-6"
        >
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  style={{
                    backgroundColor: telemetry?.charging
                      ? 'var(--md-sys-color-live-container)'
                      : 'var(--md-sys-color-primary-container)',
                    color: telemetry?.charging
                      ? 'var(--md-sys-color-on-live-container)'
                      : 'var(--md-sys-color-on-primary-container)',
                  }}
                  className="flex h-12 w-12 items-center justify-center rounded-[18px]"
                >
                  {telemetry?.charging ? (
                    <BatteryCharging className="h-5 w-5" />
                  ) : lowBattery ? (
                    <BatteryWarning className="h-5 w-5" />
                  ) : (
                    <Battery className="h-5 w-5" />
                  )}
                </div>
                <div>
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="text-base font-semibold"
                  >
                    Battery
                  </div>
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                    className="text-xs"
                  >
                    {telemetry?.chargePaused
                      ? 'Charging Paused (Guard)'
                      : telemetry?.charging
                        ? `Charging · ${formatChargeSource(telemetry.chargeSource)}`
                        : formatChargeSource(telemetry?.chargeSource)}
                  </div>
                </div>
              </div>

              <div
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="text-right font-mono text-xs tabular-nums"
              >
                <div
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  className="flex items-center justify-end gap-1 font-semibold"
                >
                  <Zap
                    style={{ color: 'var(--md-sys-color-primary)' }}
                    className="h-3.5 w-3.5"
                  />
                  <span>
                    {typeof telemetry?.currentMa === 'number'
                      ? `${telemetry.currentMa > 0 ? '+' : ''}${Math.round(telemetry.currentMa)} mA`
                      : '— mA'}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px]">
                  {typeof telemetry?.voltageMv === 'number'
                    ? `${(telemetry.voltageMv / 1000).toFixed(2)} V`
                    : '— V'}
                </div>
              </div>
            </div>

            <div className="mt-5 flex items-baseline gap-2.5">
              <span
                style={{ color: 'var(--md-sys-color-on-surface)' }}
                className="font-mono text-4xl font-semibold tracking-tight tabular-nums"
              >
                {typeof batPct === 'number' ? `${Math.round(batPct)}%` : '—'}
              </span>
              {state?.chargeLimitEnabled && (
                <span
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary-container)',
                    color: 'var(--md-sys-color-on-primary-container)',
                  }}
                  className="rounded-full px-3 py-0.5 text-xs font-semibold"
                >
                  Guard {draftMaxPct}%
                </span>
              )}
            </div>

            {/* Expressive Split Battery Track */}
            <div
              style={{ backgroundColor: 'var(--md-sys-color-surface-container-highest)' }}
              className="relative mt-4 h-3.5 w-full overflow-hidden rounded-full"
            >
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, batPct ?? 0))}%`,
                  backgroundColor: lowBattery
                    ? 'var(--md-sys-color-error)'
                    : telemetry?.charging
                      ? 'var(--md-sys-color-live)'
                      : 'var(--md-sys-color-primary)',
                }}
                className="h-full rounded-full transition-all duration-500"
              />
              {state?.chargeLimitEnabled && (
                <div
                  className="absolute inset-y-0 w-0.5 bg-white/80"
                  style={{ left: `${draftMaxPct}%` }}
                />
              )}
            </div>
          </div>

          {/* Root Charge Guard Switch + M3 Expressive Threshold Slider */}
          <div
            style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
            className="mt-5 space-y-3 rounded-[24px] p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <ShieldCheck
                  style={{ color: 'var(--md-sys-color-primary)' }}
                  className="h-5 w-5 shrink-0"
                />
                <div className="min-w-0">
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="text-sm font-semibold"
                  >
                    Root {draftMaxPct}% Charge Guard
                  </div>
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                    className="text-xs"
                  >
                    {capabilities?.chargeLimit
                      ? 'Pauses charging at limit for 24/7 plugged-in safety'
                      : 'Available when KernelSU root is granted on Poco F3'}
                  </div>
                </div>
              </div>
              <M3Switch
                checked={Boolean(state?.chargeLimitEnabled)}
                disabled={
                  !cameraOnline ||
                  !capabilities?.chargeLimit ||
                  pendingActions['set_charge_limit']
                }
                ariaLabel="Root 80% Charge Guard"
                onToggle={() =>
                  onSendCommand('set_charge_limit', {
                    enabled: !state?.chargeLimitEnabled,
                    maxPct: draftMaxPct,
                  })
                }
              />
            </div>

            <div className="pt-1">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
                  Charge Limit Threshold
                </span>
                <span
                  style={{ color: 'var(--md-sys-color-primary)' }}
                  className="font-mono font-semibold tabular-nums"
                >
                  {draftMaxPct}%
                </span>
              </div>
              <M3Slider
                min={60}
                max={95}
                step={5}
                value={draftMaxPct}
                disabled={!cameraOnline || !capabilities?.chargeLimit}
                ariaLabel="Charge limit threshold percent"
                onChange={handleChargeLimitPctChange}
              />
            </div>
          </div>
        </div>

        {/* AMOLED Screen & System Card */}
        <div
          style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
          className="flex flex-col justify-between rounded-[32px] p-6"
        >
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  style={{
                    backgroundColor: 'var(--md-sys-color-secondary-container)',
                    color: 'var(--md-sys-color-on-secondary-container)',
                  }}
                  className="flex h-12 w-12 items-center justify-center rounded-[18px]"
                >
                  <Moon className="h-5 w-5" />
                </div>
                <div>
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="text-base font-semibold"
                  >
                    AMOLED Display Guard
                  </div>
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                    className="text-xs"
                  >
                    Prevent OLED burn-in & save power
                  </div>
                </div>
              </div>
              {state?.blackout && (
                <span
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary-container)',
                    color: 'var(--md-sys-color-on-primary-container)',
                  }}
                  className="rounded-full px-3 py-1 text-xs font-semibold"
                >
                  {state.rootDisplayOff ? '0-nit Off' : 'Blackout On'}
                </span>
              )}
            </div>

            <div className="space-y-3">
              <div
                style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
                className="flex items-center justify-between gap-3 rounded-[24px] px-4 py-3.5"
              >
                <div className="min-w-0">
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="text-sm font-semibold"
                  >
                    AMOLED Blackout
                  </div>
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                    className="text-xs"
                  >
                    True pitch-black overlay with cat-proof unlock
                  </div>
                </div>
                <M3Switch
                  checked={Boolean(state?.blackout)}
                  disabled={!cameraOnline || pendingActions['set_blackout']}
                  ariaLabel="AMOLED Blackout"
                  onToggle={() =>
                    onSendCommand('set_blackout', {
                      enabled: !state?.blackout,
                      rootDisplayOff: !state?.blackout ? Boolean(state?.rootDisplayOff) : false,
                    })
                  }
                />
              </div>

              <div
                style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
                className="flex items-center justify-between gap-3 rounded-[24px] px-4 py-3.5"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <ShieldAlert
                    style={{ color: 'var(--md-sys-color-tertiary)' }}
                    className="h-4 w-4 shrink-0"
                  />
                  <div className="min-w-0">
                    <div
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                      className="text-sm font-semibold"
                    >
                      Root 0-nit Backlight Off
                    </div>
                    <div
                      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                      className="text-xs"
                    >
                      {rootDisplaySupported
                        ? 'Hardware panel brightness set to 0 via sysfs'
                        : 'Requires KernelSU root access'}
                    </div>
                  </div>
                </div>
                <M3Switch
                  checked={Boolean(state?.rootDisplayOff)}
                  disabled={
                    !cameraOnline || !rootDisplaySupported || pendingActions['set_blackout']
                  }
                  ariaLabel="Root 0-nit Backlight Off"
                  onToggle={() => {
                    const nextRoot = !state?.rootDisplayOff;
                    onSendCommand('set_blackout', {
                      enabled: nextRoot ? true : Boolean(state?.blackout),
                      rootDisplayOff: nextRoot,
                    });
                  }}
                />
              </div>
            </div>
          </div>

          {/* Uptime / RAM / Storage strip */}
          <div className="mt-4 grid grid-cols-3 gap-2.5">
            <div
              style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
              className="rounded-[20px] p-3.5"
            >
              <div
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="flex items-center gap-1.5 text-[11px]"
              >
                <Clock
                  style={{ color: 'var(--md-sys-color-primary)' }}
                  className="h-3.5 w-3.5"
                />
                <span>Uptime</span>
              </div>
              <div
                style={{ color: 'var(--md-sys-color-on-surface)' }}
                className="mt-1 font-mono text-sm font-semibold tabular-nums"
              >
                {formatUptime(telemetry?.uptimeSec)}
              </div>
            </div>

            <div
              style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
              className="rounded-[20px] p-3.5"
            >
              <div
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="flex items-center gap-1.5 text-[11px]"
              >
                <MemoryStick
                  style={{ color: 'var(--md-sys-color-live)' }}
                  className="h-3.5 w-3.5"
                />
                <span>Free RAM</span>
              </div>
              <div
                style={{ color: 'var(--md-sys-color-on-surface)' }}
                className="mt-1 font-mono text-sm font-semibold tabular-nums"
              >
                {formatMb(telemetry?.freeRamMb)}
              </div>
            </div>

            <div
              style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
              className="rounded-[20px] p-3.5"
            >
              <div
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="flex items-center gap-1.5 text-[11px]"
              >
                <HardDrive
                  style={{ color: 'var(--md-sys-color-tertiary)' }}
                  className="h-3.5 w-3.5"
                />
                <span>Storage</span>
              </div>
              <div
                style={{ color: 'var(--md-sys-color-on-surface)' }}
                className="mt-1 font-mono text-sm font-semibold tabular-nums"
              >
                {formatMb(telemetry?.freeStorageMb)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Thermal & Connectivity Row */}
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        {/* Battery Temp */}
        <div
          style={{ backgroundColor: batTempStyle.cardBg }}
          className="rounded-[28px] p-5"
        >
          <div className="flex items-center justify-between">
            <div
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              className="flex items-center gap-2 text-xs font-medium"
            >
              <Thermometer
                style={{ color: 'var(--md-sys-color-primary)' }}
                className="h-4 w-4"
              />
              <span>Battery Temp</span>
            </div>
            <span
              style={{
                backgroundColor: batTempStyle.chipBg,
                color: batTempStyle.chipColor,
              }}
              className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            >
              {batTempStyle.label}
            </span>
          </div>
          <div
            style={{ color: batTempStyle.valueColor }}
            className="mt-3 font-mono text-3xl font-semibold tabular-nums"
          >
            {typeof telemetry?.batteryTempC === 'number'
              ? `${telemetry.batteryTempC.toFixed(1)}°C`
              : '—'}
          </div>
          <div
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            className="mt-1 text-xs"
          >
            Alerts above 40°C / 45°C
          </div>
        </div>

        {/* CPU Temp */}
        <div
          style={{ backgroundColor: cpuTempStyle.cardBg }}
          className="rounded-[28px] p-5"
        >
          <div className="flex items-center justify-between">
            <div
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              className="flex items-center gap-2 text-xs font-medium"
            >
              <Cpu
                style={{ color: 'var(--md-sys-color-tertiary)' }}
                className="h-4 w-4"
              />
              <span>CPU / SoC</span>
            </div>
            <span
              style={{
                backgroundColor: cpuTempStyle.chipBg,
                color: cpuTempStyle.chipColor,
              }}
              className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
            >
              {cpuTempStyle.label}
            </span>
          </div>
          <div
            style={{ color: cpuTempStyle.valueColor }}
            className="mt-3 font-mono text-3xl font-semibold tabular-nums"
          >
            {typeof telemetry?.cpuTempC === 'number'
              ? `${telemetry.cpuTempC.toFixed(1)}°C`
              : '—'}
          </div>
          <div
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            className="mt-1 text-xs"
          >
            Snapdragon 870 thermal
          </div>
        </div>

        {/* Wi-Fi & Stream Link */}
        <div
          style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
          className="rounded-[28px] p-5"
        >
          <div className="flex items-center justify-between">
            <div
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              className="flex items-center gap-2 text-xs font-medium"
            >
              <Wifi
                style={{ color: 'var(--md-sys-color-live)' }}
                className="h-4 w-4"
              />
              <span>Wi-Fi & Stream</span>
            </div>
            <div className="flex items-end gap-0.5">
              {[1, 2, 3, 4].map((bar) => (
                <span
                  key={bar}
                  style={{
                    height: `${bar * 3 + 3}px`,
                    backgroundColor:
                      bar <= wifiInfo.bars
                        ? 'var(--md-sys-color-live)'
                        : 'var(--md-sys-color-surface-container-highest)',
                  }}
                  className="w-1 rounded-full"
                />
              ))}
            </div>
          </div>
          <div
            style={{ color: 'var(--md-sys-color-on-surface)' }}
            className="mt-3 font-mono text-3xl font-semibold tabular-nums"
          >
            {typeof telemetry?.wifiRssi === 'number' ? `${telemetry.wifiRssi}` : '—'}
            {typeof telemetry?.wifiRssi === 'number' && (
              <span
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="ml-1 text-sm font-normal"
              >
                dBm
              </span>
            )}
          </div>
          <div
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            className="mt-1 flex items-center gap-2 text-xs"
          >
            <span style={{ color: 'var(--md-sys-color-live)' }}>{wifiInfo.label}</span>
            {rtcStats && rtcStats.width > 0 && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1 font-mono tabular-nums">
                  <Radio
                    style={{ color: 'var(--md-sys-color-live)' }}
                    className="h-3 w-3"
                  />
                  {rtcStats.fps} fps
                  {rtcStats.rttMs !== null ? ` · ${rtcStats.rttMs} ms` : ''}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Telemetry History Chart */}
      <TelemetryChart history={telemetryHistory} />
    </div>
  );
}
