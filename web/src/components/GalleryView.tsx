import { useEffect, useState } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Download,
  Images,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { SnapshotMeta } from '../types/protocol';
import { resolveSnapshotUrl } from '../lib/api';

interface GalleryViewProps {
  snapshots: SnapshotMeta[];
  serverUrl: string;
  token: string;
  cameraOnline: boolean;
  onRefresh: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRequestCameraSnapshot: () => void;
}

function formatSnapshotDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function normalizeLensChip(raw?: string | null): string | null {
  if (!raw) return null;
  if (/ширик/i.test(raw)) return '0.6× Wide';
  if (/осн/i.test(raw)) return '1× Main';
  if (/макро/i.test(raw)) return 'Macro';
  if (/фронт/i.test(raw)) return 'Front';
  return raw;
}

export function GalleryView({
  snapshots,
  serverUrl,
  token,
  cameraOnline,
  onRefresh,
  onDelete,
  onRequestCameraSnapshot,
}: GalleryViewProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const selected = selectedIndex !== null ? snapshots[selectedIndex] ?? null : null;

  useEffect(() => {
    if (selectedIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedIndex(null);
      } else if (e.key === 'ArrowLeft') {
        setSelectedIndex((idx) => (idx !== null && idx > 0 ? idx - 1 : idx));
      } else if (e.key === 'ArrowRight') {
        setSelectedIndex((idx) => (idx !== null && idx < snapshots.length - 1 ? idx + 1 : idx));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIndex, snapshots.length]);

  useEffect(() => {
    if (selectedIndex !== null && selectedIndex >= snapshots.length) {
      setSelectedIndex(snapshots.length > 0 ? snapshots.length - 1 : null);
    }
  }, [selectedIndex, snapshots.length]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await onDelete(id);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 pb-28 sm:px-6 md:py-8 md:pb-10">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1
              style={{ color: 'var(--md-sys-color-on-surface)' }}
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              Gallery
            </h1>
            <span
              style={{
                backgroundColor: 'var(--md-sys-color-secondary-container)',
                color: 'var(--md-sys-color-on-secondary-container)',
              }}
              className="rounded-full px-3 py-1 font-mono text-xs font-semibold tabular-nums"
            >
              {snapshots.length}
            </span>
          </div>
          <p
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            className="mt-1 text-sm"
          >
            Snapshots captured from Live view or high-resolution Poco F3 stills
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            disabled={!cameraOnline}
            onClick={onRequestCameraSnapshot}
            style={{
              backgroundColor: 'var(--md-sys-color-primary)',
              color: 'var(--md-sys-color-on-primary)',
            }}
            className="m3-morph-pill flex items-center gap-2 px-5 py-2.5 text-sm font-semibold shadow-md disabled:opacity-40"
          >
            <Camera className="h-4 w-4" />
            <span>Capture HD</span>
          </button>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            title="Refresh Gallery"
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
              color: 'var(--md-sys-color-on-surface)',
            }}
            className="m3-morph-pill flex h-10 w-10 items-center justify-center"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Empty State or Photo Grid */}
      {snapshots.length === 0 ? (
        <div
          style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
          className="flex flex-col items-center justify-center rounded-[32px] px-6 py-20 text-center"
        >
          <div
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
              color: 'var(--md-sys-color-on-surface-variant)',
            }}
            className="mb-4 flex h-16 w-16 items-center justify-center rounded-[22px]"
          >
            <Images className="h-7 w-7" />
          </div>
          <h2
            style={{ color: 'var(--md-sys-color-on-surface)' }}
            className="text-lg font-semibold"
          >
            No snapshots yet
          </h2>
          <p
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            className="mt-1.5 max-w-sm text-sm"
          >
            Tap Snapshot while watching your cat on the Live tab, or click Capture HD above.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {snapshots.map((snap, idx) => {
            const imgUrl = resolveSnapshotUrl(serverUrl, snap, token);
            const lensChip = normalizeLensChip(snap.lensLabel);
            return (
              <div
                key={snap.id}
                style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
                className="m3-spring group relative overflow-hidden rounded-[28px]"
              >
                <button
                  type="button"
                  onClick={() => setSelectedIndex(idx)}
                  style={{ backgroundColor: 'var(--md-sys-color-surface-container-lowest)' }}
                  className="block aspect-video w-full overflow-hidden text-left"
                >
                  <img
                    src={imgUrl}
                    alt={`Snapshot ${formatSnapshotDate(snap.createdAt)}`}
                    loading="lazy"
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                  />
                </button>

                {/* Hover quick actions */}
                <div className="absolute top-3 right-3 flex items-center gap-1.5 opacity-0 transition group-hover:opacity-100">
                  <a
                    href={imgUrl}
                    download={snap.filename}
                    title="Download JPEG"
                    style={{
                      backgroundColor: 'var(--md-sys-color-surface-container-high)',
                      color: 'var(--md-sys-color-on-surface)',
                    }}
                    className="m3-morph-pill flex h-9 w-9 items-center justify-center shadow-lg"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                  <button
                    type="button"
                    disabled={deletingId === snap.id}
                    onClick={() => void handleDelete(snap.id)}
                    title="Delete snapshot"
                    style={{
                      backgroundColor: 'var(--md-sys-color-error-container)',
                      color: 'var(--md-sys-color-on-error-container)',
                    }}
                    className="m3-morph-pill flex h-9 w-9 items-center justify-center shadow-lg disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* Metadata */}
                <div className="flex items-center justify-between gap-2 px-4 py-3.5">
                  <div className="min-w-0">
                    <div
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                      className="truncate font-mono text-xs font-medium tabular-nums"
                    >
                      {formatSnapshotDate(snap.createdAt)}
                    </div>
                    <div
                      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                      className="mt-0.5 font-mono text-[11px] tabular-nums"
                    >
                      {formatFileSize(snap.sizeBytes)}
                    </div>
                  </div>
                  {lensChip && (
                    <span
                      style={{
                        backgroundColor: 'var(--md-sys-color-primary-container)',
                        color: 'var(--md-sys-color-on-primary-container)',
                      }}
                      className="shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold"
                    >
                      {lensChip}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Lightbox Modal */}
      {selected && selectedIndex !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Snapshot preview"
          onClick={() => setSelectedIndex(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/88 p-4 backdrop-blur-xl"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
            className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-[32px] shadow-2xl"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
              <div className="flex flex-wrap items-center gap-2.5 text-sm">
                <span
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                  className="font-mono font-semibold tabular-nums"
                >
                  {formatSnapshotDate(selected.createdAt)}
                </span>
                {normalizeLensChip(selected.lensLabel) && (
                  <span
                    style={{
                      backgroundColor: 'var(--md-sys-color-primary-container)',
                      color: 'var(--md-sys-color-on-primary-container)',
                    }}
                    className="rounded-full px-3 py-0.5 text-xs font-semibold"
                  >
                    {normalizeLensChip(selected.lensLabel)}
                  </span>
                )}
                <span
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  className="font-mono text-xs tabular-nums"
                >
                  {formatFileSize(selected.sizeBytes)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <a
                  href={resolveSnapshotUrl(serverUrl, selected, token)}
                  download={selected.filename}
                  style={{
                    backgroundColor: 'var(--md-sys-color-surface-container-high)',
                    color: 'var(--md-sys-color-on-surface)',
                  }}
                  className="m3-morph-pill flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Download</span>
                </a>
                <button
                  type="button"
                  disabled={deletingId === selected.id}
                  onClick={() => void handleDelete(selected.id)}
                  style={{
                    backgroundColor: 'var(--md-sys-color-error-container)',
                    color: 'var(--md-sys-color-on-error-container)',
                  }}
                  className="m3-morph-pill flex items-center gap-1.5 px-4 py-2 text-xs font-semibold disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Delete</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIndex(null)}
                  aria-label="Close preview"
                  style={{
                    backgroundColor: 'var(--md-sys-color-surface-container-high)',
                    color: 'var(--md-sys-color-on-surface)',
                  }}
                  className="m3-morph-pill flex h-9 w-9 items-center justify-center"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div
              style={{ backgroundColor: 'var(--md-sys-color-surface-container-lowest)' }}
              className="relative flex flex-1 items-center justify-center overflow-hidden p-4"
            >
              <img
                src={resolveSnapshotUrl(serverUrl, selected, token)}
                alt={selected.filename}
                className="max-h-[76vh] w-auto max-w-full rounded-[20px] object-contain"
              />

              {selectedIndex > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedIndex(selectedIndex - 1)}
                  aria-label="Previous snapshot"
                  style={{
                    backgroundColor: 'var(--md-sys-color-surface-container-high)',
                    color: 'var(--md-sys-color-on-surface)',
                  }}
                  className="m3-morph-pill absolute left-4 flex h-11 w-11 items-center justify-center shadow-xl"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
              )}

              {selectedIndex < snapshots.length - 1 && (
                <button
                  type="button"
                  onClick={() => setSelectedIndex(selectedIndex + 1)}
                  aria-label="Next snapshot"
                  style={{
                    backgroundColor: 'var(--md-sys-color-surface-container-high)',
                    color: 'var(--md-sys-color-on-surface)',
                  }}
                  className="m3-morph-pill absolute right-4 flex h-11 w-11 items-center justify-center shadow-xl"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
