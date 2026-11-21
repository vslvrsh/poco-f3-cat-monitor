import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isValidJpegBuffer } from "./security.js";
import type { SnapshotMeta, Telemetry } from "./types.js";

const SAFE_SNAPSHOT_FILENAME_RE = /^[a-zA-Z0-9._-]+\.(jpg|jpeg|png|webp)$/i;

export interface StorageOptions {
  dataDir: string;
  maxTelemetrySamples?: number;
  telemetryFlushIntervalMs?: number;
  maxSnapshotBytes?: number;
}

export interface SaveSnapshotInput {
  buffer: Buffer;
  lensLabel?: string | null;
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, json, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch {
    // Windows fallback if destination is briefly locked by AV/indexer
    await fs.writeFile(filePath, json, "utf8");
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export class PurrCamStorage {
  readonly dataDir: string;
  readonly snapshotsDir: string;
  readonly telemetryFile: string;
  readonly snapshotsIndexFile: string;
  readonly maxTelemetrySamples: number;
  readonly telemetryFlushIntervalMs: number;
  readonly maxSnapshotBytes: number;

  private telemetryBuffer: Telemetry[] = [];
  private telemetryDirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;

  private snapshots: SnapshotMeta[] = [];
  private snapshotsWriteChain: Promise<void> = Promise.resolve();

  constructor(options: StorageOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.snapshotsDir = path.join(this.dataDir, "snapshots");
    this.telemetryFile = path.join(this.dataDir, "telemetry.json");
    this.snapshotsIndexFile = path.join(this.dataDir, "snapshots.json");
    this.maxTelemetrySamples = Math.max(1, options.maxTelemetrySamples ?? 720);
    this.telemetryFlushIntervalMs = Math.max(
      1000,
      options.telemetryFlushIntervalMs ?? 10_000
    );
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 10 * 1024 * 1024;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    await this.loadTelemetry();
    await this.loadSnapshots();

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    this.flushTimer = setInterval(() => {
      void this.flushTelemetry();
    }, this.telemetryFlushIntervalMs);
    this.flushTimer.unref();
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushTelemetry();
    await this.snapshotsWriteChain;
  }

  // --- Telemetry ---

  private async loadTelemetry(): Promise<void> {
    try {
      const raw = await fs.readFile(this.telemetryFile, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (item): item is Telemetry =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as Telemetry).ts === "number"
        );
        this.telemetryBuffer = valid.slice(-this.maxTelemetrySamples);
      }
    } catch {
      this.telemetryBuffer = [];
    }
  }

  addTelemetry(sample: Telemetry): Telemetry {
    const normalized: Telemetry = {
      ...sample,
      ts: typeof sample.ts === "number" && Number.isFinite(sample.ts) ? sample.ts : Date.now(),
    };
    this.telemetryBuffer.push(normalized);
    if (this.telemetryBuffer.length > this.maxTelemetrySamples) {
      this.telemetryBuffer.splice(
        0,
        this.telemetryBuffer.length - this.maxTelemetrySamples
      );
    }
    this.telemetryDirty = true;
    return normalized;
  }

  getTelemetryHistory(limit = 120): Telemetry[] {
    const clamped = Math.max(
      1,
      Math.min(this.maxTelemetrySamples, Math.floor(limit) || 120)
    );
    return this.telemetryBuffer.slice(-clamped);
  }

  getLatestTelemetry(): Telemetry | null {
    return this.telemetryBuffer.length > 0
      ? this.telemetryBuffer[this.telemetryBuffer.length - 1]
      : null;
  }

  async flushTelemetry(): Promise<void> {
    if (!this.telemetryDirty) return;
    if (this.flushPromise) return this.flushPromise;

    this.telemetryDirty = false;
    const snapshot = [...this.telemetryBuffer];
    this.flushPromise = atomicWriteJson(this.telemetryFile, snapshot)
      .catch((err) => {
        // Restore dirty flag so next tick retries
        this.telemetryDirty = true;
        console.error("[storage] Failed to persist telemetry:", err);
      })
      .finally(() => {
        this.flushPromise = null;
      });
    return this.flushPromise;
  }

  // --- Snapshots ---

  private async loadSnapshots(): Promise<void> {
    let loaded: SnapshotMeta[] = [];
    try {
      const raw = await fs.readFile(this.snapshotsIndexFile, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        loaded = parsed.filter(
          (item): item is SnapshotMeta =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as SnapshotMeta).id === "string" &&
            typeof (item as SnapshotMeta).filename === "string"
        );
      }
    } catch {
      loaded = [];
    }

    // Reconcile against actual files on disk
    const valid: SnapshotMeta[] = [];
    for (const meta of loaded) {
      const resolved = this.resolveSnapshotPath(meta.filename);
      if (!resolved) continue;
      try {
        const stat = await fs.stat(resolved);
        if (stat.isFile()) {
          valid.push({
            id: meta.id,
            filename: meta.filename,
            url: `/snapshots/${meta.filename}`,
            createdAt: meta.createdAt,
            sizeBytes: stat.size,
            lensLabel: typeof meta.lensLabel === "string" ? meta.lensLabel : null,
          });
        }
      } catch {
        // File missing on disk; omit stale metadata entry
      }
    }

    valid.sort((a, b) => b.createdAt - a.createdAt);
    this.snapshots = valid;
  }

  private persistSnapshots(): Promise<void> {
    const copy = [...this.snapshots];
    this.snapshotsWriteChain = this.snapshotsWriteChain
      .then(() => atomicWriteJson(this.snapshotsIndexFile, copy))
      .catch((err) => {
        console.error("[storage] Failed to persist snapshots index:", err);
      });
    return this.snapshotsWriteChain;
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<SnapshotMeta> {
    const { buffer, lensLabel } = input;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("Snapshot image data is empty");
    }
    if (!isValidJpegBuffer(buffer)) {
      throw new Error("Invalid JPEG image data (missing JPEG magic bytes)");
    }
    if (buffer.length > this.maxSnapshotBytes) {
      throw new Error(
        `Snapshot exceeds max allowed size of ${this.maxSnapshotBytes} bytes`
      );
    }

    const now = Date.now();
    const rand = crypto.randomBytes(2).toString("hex");
    const id = `snap-${now}-${rand}`;
    const filename = `${id}.jpg`;
    const filePath = path.join(this.snapshotsDir, filename);

    await fs.writeFile(filePath, buffer);

    const trimmedLabel =
      typeof lensLabel === "string" && lensLabel.trim()
        ? lensLabel.trim()
        : null;

    const meta: SnapshotMeta = {
      id,
      filename,
      url: `/snapshots/${filename}`,
      createdAt: now,
      sizeBytes: buffer.length,
      lensLabel: trimmedLabel,
    };

    this.snapshots.unshift(meta);
    await this.persistSnapshots();
    return meta;
  }

  listSnapshots(): SnapshotMeta[] {
    return [...this.snapshots];
  }

  getSnapshotById(id: string): SnapshotMeta | undefined {
    return this.snapshots.find((s) => s.id === id);
  }

  async deleteSnapshot(id: string): Promise<SnapshotMeta | null> {
    const index = this.snapshots.findIndex((s) => s.id === id);
    if (index === -1) return null;

    const [removed] = this.snapshots.splice(index, 1);
    const resolved = this.resolveSnapshotPath(removed.filename);
    if (resolved) {
      await fs.unlink(resolved).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") {
          console.error("[storage] Failed to unlink snapshot file:", err);
        }
      });
    }
    await this.persistSnapshots();
    return removed;
  }

  /**
   * Resolves a snapshot filename safely within snapshotsDir.
   * Rejects path traversal, separators, null bytes, and unexpected extensions.
   */
  resolveSnapshotPath(filename: string): string | null {
    if (!filename || typeof filename !== "string") return null;
    if (
      filename.includes("/") ||
      filename.includes("\\") ||
      filename.includes("..") ||
      filename.includes("\0")
    ) {
      return null;
    }
    if (!SAFE_SNAPSHOT_FILENAME_RE.test(filename)) {
      return null;
    }
    const resolved = path.resolve(this.snapshotsDir, filename);
    const prefix = this.snapshotsDir.endsWith(path.sep)
      ? this.snapshotsDir
      : this.snapshotsDir + path.sep;
    if (!resolved.startsWith(prefix)) {
      return null;
    }
    return resolved;
  }
}
