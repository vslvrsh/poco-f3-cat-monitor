import { useId, useMemo, useState } from 'react';
import type { Telemetry } from '../types/protocol';
import { M3ConnectedButtonGroup } from './M3Controls';

interface TelemetryChartProps {
  history: Telemetry[];
}

type ChartMode = 'temp' | 'battery';

function formatTimeShort(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function TelemetryChart({ history }: TelemetryChartProps) {
  const uid = useId().replace(/:/g, '');
  const [mode, setMode] = useState<ChartMode>('temp');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 640;
  const height = 186;
  const pad = { top: 16, right: 16, bottom: 26, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const samples = useMemo(() => history.slice(-120), [history]);

  const geometry = useMemo(() => {
    if (samples.length === 0) return null;

    const getX = (i: number) =>
      samples.length === 1
        ? pad.left + plotW / 2
        : pad.left + (i / (samples.length - 1)) * plotW;

    if (mode === 'battery') {
      const minY = 0;
      const maxY = 100;
      const getY = (val: number) =>
        pad.top + plotH - ((Math.max(minY, Math.min(maxY, val)) - minY) / (maxY - minY)) * plotH;

      const pts = samples.map((s, i) => ({
        x: getX(i),
        y: getY(typeof s.batteryPct === 'number' ? s.batteryPct : 0),
        sample: s,
      }));

      const linePath = pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
        .join(' ');
      const areaPath =
        pts.length > 0
          ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`
          : '';

      return {
        pts,
        linePath,
        areaPath,
        secondaryLinePath: '',
        ticks: [0, 25, 50, 80, 100],
        getY,
      };
    }

    const temps: number[] = [];
    for (const s of samples) {
      if (typeof s.batteryTempC === 'number') temps.push(s.batteryTempC);
      if (typeof s.cpuTempC === 'number') temps.push(s.cpuTempC);
    }
    const minY = Math.min(20, Math.floor((Math.min(...temps, 25) - 3) / 5) * 5);
    const maxY = Math.max(50, Math.ceil((Math.max(...temps, 46) + 3) / 5) * 5);
    const getY = (val: number) =>
      pad.top + plotH - ((Math.max(minY, Math.min(maxY, val)) - minY) / (maxY - minY)) * plotH;

    const pts = samples.map((s, i) => ({
      x: getX(i),
      y: getY(typeof s.batteryTempC === 'number' ? s.batteryTempC : minY),
      cpuY: typeof s.cpuTempC === 'number' ? getY(s.cpuTempC) : null,
      sample: s,
    }));

    const linePath = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');
    const areaPath =
      pts.length > 0
        ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(pad.top + plotH).toFixed(1)} Z`
        : '';

    const cpuSegments: string[] = [];
    let drawing = false;
    pts.forEach((p) => {
      if (p.cpuY !== null) {
        cpuSegments.push(`${drawing ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.cpuY.toFixed(1)}`);
        drawing = true;
      } else {
        drawing = false;
      }
    });

    return {
      pts,
      linePath,
      areaPath,
      secondaryLinePath: cpuSegments.join(' '),
      ticks: [minY, 30, 40, 45, maxY].filter(
        (v, idx, arr) => v >= minY && v <= maxY && arr.indexOf(v) === idx
      ),
      getY,
    };
  }, [mode, pad.left, pad.top, plotH, plotW, samples]);

  const activePoint =
    geometry && hoverIdx !== null && geometry.pts[hoverIdx]
      ? geometry.pts[hoverIdx]
      : geometry && geometry.pts.length > 0
        ? geometry.pts[geometry.pts.length - 1]
        : null;

  return (
    <div
      style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
      className="rounded-[32px] p-6"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3
            style={{ color: 'var(--md-sys-color-on-surface)' }}
            className="text-base font-semibold tracking-tight"
          >
            Telemetry History
          </h3>
          {activePoint ? (
            <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-xs tabular-nums">
              <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
                {formatTimeShort(activePoint.sample.ts)}
              </span>
              {mode === 'temp' ? (
                <>
                  <span
                    style={{ color: 'var(--md-sys-color-primary)' }}
                    className="flex items-center gap-1.5 font-semibold"
                  >
                    <span
                      style={{ backgroundColor: 'var(--md-sys-color-primary)' }}
                      className="h-2 w-2 rounded-full"
                    />
                    Battery:{' '}
                    {typeof activePoint.sample.batteryTempC === 'number'
                      ? `${activePoint.sample.batteryTempC.toFixed(1)}°C`
                      : '—'}
                  </span>
                  {typeof activePoint.sample.cpuTempC === 'number' && (
                    <span
                      style={{ color: 'var(--md-sys-color-tertiary)' }}
                      className="flex items-center gap-1.5 font-semibold"
                    >
                      <span
                        style={{ backgroundColor: 'var(--md-sys-color-tertiary)' }}
                        className="h-2 w-2 rounded-full"
                      />
                      CPU: {activePoint.sample.cpuTempC.toFixed(1)}°C
                    </span>
                  )}
                </>
              ) : (
                <span
                  style={{ color: 'var(--md-sys-color-live)' }}
                  className="flex items-center gap-1.5 font-semibold"
                >
                  <span
                    style={{ backgroundColor: 'var(--md-sys-color-live)' }}
                    className="h-2 w-2 rounded-full"
                  />
                  Battery:{' '}
                  {typeof activePoint.sample.batteryPct === 'number'
                    ? `${Math.round(activePoint.sample.batteryPct)}%`
                    : '—'}
                  {activePoint.sample.charging ? ' · Charging' : ''}
                </span>
              )}
            </div>
          ) : (
            <p
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              className="mt-0.5 text-xs"
            >
              Live thermal and battery trends over time
            </p>
          )}
        </div>

        {/* M3 Expressive Connected Button Group */}
        <M3ConnectedButtonGroup
          value={mode}
          onChange={setMode}
          size="sm"
          options={[
            { value: 'temp', label: 'Temperature' },
            { value: 'battery', label: 'Battery' },
          ]}
        />
      </div>

      {!geometry || samples.length === 0 ? (
        <div
          style={{
            backgroundColor: 'var(--md-sys-color-surface-container-low)',
            color: 'var(--md-sys-color-on-surface-variant)',
          }}
          className="flex h-[180px] items-center justify-center rounded-[24px] text-sm"
        >
          Waiting for telemetry samples from Poco F3…
        </div>
      ) : (
        <div className="relative w-full">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-[196px] w-full overflow-visible"
            onMouseLeave={() => setHoverIdx(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * width;
              const ratio = Math.max(0, Math.min(1, (relX - pad.left) / plotW));
              const idx = Math.round(ratio * (samples.length - 1));
              setHoverIdx(idx);
            }}
          >
            <defs>
              <linearGradient id={`grad-temp-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--md-sys-color-primary)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--md-sys-color-primary)" stopOpacity="0.0" />
              </linearGradient>
              <linearGradient id={`grad-bat-${uid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--md-sys-color-live)" stopOpacity="0.32" />
                <stop offset="100%" stopColor="var(--md-sys-color-live)" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {geometry.ticks.map((tick) => {
              const y = geometry.getY(tick);
              const isDanger = mode === 'temp' && tick === 45;
              const isWarn = mode === 'temp' && tick === 40;
              const isLimit = mode === 'battery' && tick === 80;
              return (
                <g key={tick}>
                  <line
                    x1={pad.left}
                    x2={width - pad.right}
                    y1={y}
                    y2={y}
                    stroke={
                      isDanger
                        ? 'var(--md-sys-color-error)'
                        : isWarn
                          ? 'var(--md-sys-color-warn)'
                          : isLimit
                            ? 'var(--md-sys-color-live)'
                            : 'var(--md-sys-color-surface-container-highest)'
                    }
                    strokeOpacity={isDanger || isWarn || isLimit ? 0.55 : 0.7}
                    strokeWidth={1}
                    strokeDasharray={isDanger || isWarn || isLimit ? '4 4' : undefined}
                  />
                  <text
                    x={pad.left - 8}
                    y={y + 3.5}
                    textAnchor="end"
                    style={{ fill: 'var(--md-sys-color-on-surface-variant)' }}
                    className="font-mono text-[10px] tabular-nums"
                  >
                    {mode === 'temp' ? `${tick}°` : `${tick}%`}
                  </text>
                </g>
              );
            })}

            <path
              d={geometry.areaPath}
              fill={mode === 'temp' ? `url(#grad-temp-${uid})` : `url(#grad-bat-${uid})`}
            />

            {mode === 'temp' && geometry.secondaryLinePath && (
              <path
                d={geometry.secondaryLinePath}
                fill="none"
                stroke="var(--md-sys-color-tertiary)"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeOpacity={0.9}
              />
            )}

            <path
              d={geometry.linePath}
              fill="none"
              stroke={
                mode === 'temp'
                  ? 'var(--md-sys-color-primary)'
                  : 'var(--md-sys-color-live)'
              }
              strokeWidth={2.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {activePoint && (
              <g>
                {hoverIdx !== null && (
                  <line
                    x1={activePoint.x}
                    x2={activePoint.x}
                    y1={pad.top}
                    y2={pad.top + plotH}
                    stroke="var(--md-sys-color-on-surface-variant)"
                    strokeOpacity={0.4}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                )}
                <circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r={5}
                  fill={
                    mode === 'temp'
                      ? 'var(--md-sys-color-primary)'
                      : 'var(--md-sys-color-live)'
                  }
                  stroke="var(--md-sys-color-surface-container)"
                  strokeWidth={2}
                />
              </g>
            )}

            <text
              x={pad.left}
              y={height - 4}
              textAnchor="start"
              style={{ fill: 'var(--md-sys-color-on-surface-variant)' }}
              className="font-mono text-[10px] tabular-nums"
            >
              {formatTimeShort(samples[0].ts)}
            </text>
            <text
              x={width - pad.right}
              y={height - 4}
              textAnchor="end"
              style={{ fill: 'var(--md-sys-color-on-surface-variant)' }}
              className="font-mono text-[10px] tabular-nums"
            >
              {formatTimeShort(samples[samples.length - 1].ts)}
            </text>
          </svg>
        </div>
      )}
    </div>
  );
}
