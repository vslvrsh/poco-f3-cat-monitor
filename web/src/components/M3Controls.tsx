import type { ReactNode } from 'react';

/**
 * Authentic Material 3 Expressive 52x32px Stadium Switch:
 * - Track: surfaceContainerHighest (off) -> primary (on)
 * - Thumb: 16x16px circle (off) -> morphs & scales to 24x24px circle with crisp checkmark SVG (on)
 */
export function M3Switch({
  checked,
  disabled,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      style={{
        backgroundColor: checked
          ? 'var(--md-sys-color-primary)'
          : 'var(--md-sys-color-surface-container-highest)',
      }}
      className="m3-spring relative inline-flex h-8 w-[52px] shrink-0 cursor-pointer items-center rounded-full px-1.5 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        style={{
          backgroundColor: checked
            ? 'var(--md-sys-color-on-primary)'
            : 'var(--md-sys-color-on-surface-variant)',
          color: 'var(--md-sys-color-primary)',
        }}
        className={`m3-spring flex items-center justify-center rounded-full shadow-sm ${
          checked ? 'h-6 w-6 translate-x-[18px]' : 'h-4 w-4 translate-x-0.5'
        }`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          className={`m3-spring h-3.5 w-3.5 ${
            checked ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
          }`}
        >
          <path
            d="M3.5 8.3L6.6 11.4L12.6 4.8"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  );
}

/**
 * Authentic Material 3 Expressive Thick-Track Slider:
 * - 16px-tall split rounded track (`primary` active left fill + `surfaceContainerHighest` inactive right track)
 * - 4px x 28px vertical pill handle bar in the split gap
 * - Native <input type="range"> overlay for full keyboard, pointer, and touch accessibility
 */
export function M3Slider({
  min,
  max,
  step = 1,
  value,
  disabled,
  onChange,
  ariaLabel,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  disabled?: boolean;
  onChange: (next: number) => void;
  ariaLabel: string;
}) {
  const span = max - min;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((value - min) / span) * 100)) : 0;

  return (
    <div
      className={`group relative flex h-8 w-full items-center select-none ${
        disabled ? 'opacity-40' : ''
      }`}
    >
      {/* Split M3 Expressive 16px Track */}
      <div className="pointer-events-none relative flex h-4 w-full items-center">
        {/* Left active track */}
        <div
          style={{
            width: `calc(${pct}% - 6px)`,
            backgroundColor: 'var(--md-sys-color-primary)',
          }}
          className="h-4 min-w-0 rounded-l-full rounded-r-[4px] transition-[width] duration-75"
        />

        {/* Vertical 4x28px Pill Handle in the gap */}
        <div
          style={{
            left: `${pct}%`,
            backgroundColor: 'var(--md-sys-color-primary)',
          }}
          className="m3-spring absolute top-1/2 h-7 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md group-hover:scale-y-110 group-active:scale-x-125"
        />

        {/* Right inactive track */}
        <div
          style={{
            width: `calc(${100 - pct}% - 6px)`,
            backgroundColor: 'var(--md-sys-color-surface-container-highest)',
          }}
          className="ml-auto h-4 min-w-0 rounded-l-[4px] rounded-r-full transition-[width] duration-75"
        />
      </div>

      {/* Native accessible range input overlay */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
    </div>
  );
}

export interface M3ButtonGroupOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * Authentic Material 3 Expressive Connected Button Group:
 * - Outer group has stadium rounded-full ends, adjacent buttons have 8px inner corners
 * - Active item morphs into an 18px rounded squircle with primary/secondaryContainer fill & bouncy spring
 */
export function M3ConnectedButtonGroup<T extends string | number>({
  options,
  value,
  onChange,
  variant = 'primary',
  size = 'md',
}: {
  options: M3ButtonGroupOption<T>[];
  value: T;
  onChange: (next: T) => void;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}) {
  const padClass = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-xs';

  return (
    <div className="inline-flex items-center gap-1 rounded-full p-0.5">
      {options.map((opt, idx) => {
        const active = opt.value === value;
        const isFirst = idx === 0;
        const isLast = idx === options.length - 1;

        const cornerClass = active
          ? 'rounded-[16px]'
          : isFirst && isLast
            ? 'rounded-full'
            : isFirst
              ? 'rounded-l-full rounded-r-[8px]'
              : isLast
                ? 'rounded-r-full rounded-l-[8px]'
                : 'rounded-[8px]';

        const activeBg =
          variant === 'primary'
            ? 'var(--md-sys-color-primary)'
            : 'var(--md-sys-color-secondary-container)';
        const activeFg =
          variant === 'primary'
            ? 'var(--md-sys-color-on-primary)'
            : 'var(--md-sys-color-on-secondary-container)';

        return (
          <button
            key={String(opt.value)}
            type="button"
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            style={{
              backgroundColor: active
                ? activeBg
                : 'var(--md-sys-color-surface-container-high)',
              color: active ? activeFg : 'var(--md-sys-color-on-surface-variant)',
            }}
            className={`m3-spring flex flex-1 items-center justify-center gap-1.5 font-semibold whitespace-nowrap disabled:opacity-40 ${padClass} ${cornerClass}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
