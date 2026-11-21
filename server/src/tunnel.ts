import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { normalizeCustomRemoteUrl, type PurrCamConfigStore } from "./config.js";
import { getTailscaleIp, httpUrlToWsUrl } from "./network.js";
import type { RemoteProvider, RemoteStatus } from "./types.js";

const execFileAsync = promisify(execFile);

export const CLOUDFLARED_WINDOWS_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface StartRemoteOptions {
  provider?: "cloudflare" | "custom" | "tailscale";
  customUrl?: string;
}

export interface TunnelManagerOptions {
  binDir: string;
  configStore: PurrCamConfigStore;
  getPort: () => number;
  onStatusChange?: (status: RemoteStatus) => void;
  onLog?: (msg: string) => void;
  startupTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export class RemoteTunnelManager {
  readonly binDir: string;
  readonly localBinaryPath: string;

  private readonly configStore: PurrCamConfigStore;
  private readonly getPort: () => number;
  private readonly onStatusChange?: (status: RemoteStatus) => void;
  private readonly onLog?: (msg: string) => void;
  private readonly startupTimeoutMs: number;
  private readonly downloadTimeoutMs: number;

  private child: ChildProcess | null = null;
  private stopping = false;
  private downloadPromise: Promise<string> | null = null;
  private startPromise: Promise<RemoteStatus> | null = null;

  private status: RemoteStatus = {
    enabled: false,
    status: "stopped",
    provider: "none",
    url: null,
    wsUrl: null,
    error: null,
  };

  constructor(options: TunnelManagerOptions) {
    this.binDir = path.resolve(options.binDir);
    const binName =
      process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    this.localBinaryPath = path.join(this.binDir, binName);
    this.configStore = options.configStore;
    this.getPort = options.getPort;
    this.onStatusChange = options.onStatusChange;
    this.onLog = options.onLog;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 45_000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000;
  }

  private log(msg: string): void {
    console.log(msg);
    this.onLog?.(msg);
  }

  getStatus(): RemoteStatus {
    return { ...this.status };
  }

  private setStatus(next: RemoteStatus): RemoteStatus {
    this.status = { ...next };
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
    return this.getStatus();
  }

  /**
   * Resolves an existing cloudflared executable from env, PATH, standard install dirs, or server/bin/.
   */
  async findCloudflaredBinary(): Promise<string | null> {
    const envPath = process.env.CLOUDFLARED_PATH?.trim();
    if (envPath && (await fileExists(envPath))) {
      return envPath;
    }

    // Check PATH
    try {
      const cmd = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(cmd, ["cloudflared"], {
        timeout: 4000,
      });
      const firstLine = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (firstLine && (await fileExists(firstLine))) {
        return firstLine;
      }
    } catch {
      // Not on PATH
    }

    // Check standard Windows install locations
    if (process.platform === "win32") {
      const candidates = [
        path.join(
          process.env.ProgramFiles || "C:\\Program Files",
          "cloudflared",
          "cloudflared.exe"
        ),
        path.join(
          process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
          "cloudflared",
          "cloudflared.exe"
        ),
        path.join(
          process.env.LOCALAPPDATA || "",
          "cloudflared",
          "cloudflared.exe"
        ),
      ];
      for (const candidate of candidates) {
        if (candidate && (await fileExists(candidate))) {
          return candidate;
        }
      }
    }

    // Check server/bin/cloudflared.exe
    if (await fileExists(this.localBinaryPath)) {
      return this.localBinaryPath;
    }

    return null;
  }

  /**
   * Ensures cloudflared binary is available, downloading the official Windows binary
   * into server/bin/cloudflared.exe if missing.
   */
  async ensureCloudflaredBinary(): Promise<string> {
    const existing = await this.findCloudflaredBinary();
    if (existing) return existing;

    if (process.platform !== "win32") {
      throw new Error(
        "cloudflared not found on PATH. Install cloudflared or set CLOUDFLARED_PATH."
      );
    }

    if (this.downloadPromise) {
      return this.downloadPromise;
    }

    this.downloadPromise = this.downloadCloudflaredWindows().finally(() => {
      this.downloadPromise = null;
    });
    return this.downloadPromise;
  }

  private async downloadCloudflaredWindows(): Promise<string> {
    await fsp.mkdir(this.binDir, { recursive: true });
    const tmpPath = `${this.localBinaryPath}.${process.pid}.${Date.now()}.tmp`;

    console.log(
      `[tunnel] cloudflared not found locally; downloading official binary to ${this.localBinaryPath}...`
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    timer.unref();

    try {
      const resp = await fetch(CLOUDFLARED_WINDOWS_URL, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "PurrCam-Server/1.1.0",
        },
      });

      if (!resp.ok || !resp.body) {
        throw new Error(
          `Failed to download cloudflared (HTTP ${resp.status} ${resp.statusText})`
        );
      }

      const fileStream = fs.createWriteStream(tmpPath);
      await pipeline(
        Readable.fromWeb(
          resp.body as unknown as Parameters<typeof Readable.fromWeb>[0]
        ),
        fileStream
      );

      // Verify downloaded PE binary looks valid (> 1 MB and starts with 'MZ')
      const stat = await fsp.stat(tmpPath);
      if (stat.size < 1024 * 1024) {
        throw new Error(
          `Downloaded cloudflared binary is unexpectedly small (${stat.size} bytes)`
        );
      }
      const fd = await fsp.open(tmpPath, "r");
      try {
        const header = Buffer.alloc(2);
        await fd.read(header, 0, 2, 0);
        if (header[0] !== 0x4d || header[1] !== 0x5a) {
          throw new Error("Downloaded cloudflared file is not a valid Windows executable");
        }
      } finally {
        await fd.close();
      }

      try {
        await fsp.rename(tmpPath, this.localBinaryPath);
      } catch {
        await fsp.copyFile(tmpPath, this.localBinaryPath);
        await fsp.unlink(tmpPath).catch(() => {});
      }

      console.log(
        `[tunnel] cloudflared downloaded successfully (${Math.round(stat.size / 1024 / 1024)} MB).`
      );
      return this.localBinaryPath;
    } catch (err) {
      await fsp.unlink(tmpPath).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async start(options: StartRemoteOptions = {}): Promise<RemoteStatus> {
    const provider = options.provider ?? "cloudflare";

    if (provider === "custom") {
      return this.startCustom(options.customUrl);
    }

    if (provider === "tailscale") {
      return this.startTailscale();
    }

    // Deduplicate concurrent Cloudflare starts
    if (this.startPromise) {
      return this.startPromise;
    }

    if (
      this.status.status === "running" &&
      this.status.provider === "cloudflare" &&
      this.child &&
      !this.child.killed
    ) {
      return this.getStatus();
    }

    this.startPromise = this.startCloudflareInternal().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startCustom(rawCustomUrl?: string): Promise<RemoteStatus> {
    await this.stopChildProcess();

    const candidate =
      rawCustomUrl !== undefined
        ? rawCustomUrl
        : this.configStore.getConfig().customRemoteUrl;
    const normalized = normalizeCustomRemoteUrl(candidate);
    if (!normalized) {
      throw new Error("A valid customRemoteUrl (https://...) is required");
    }

    await this.configStore.ensureToken();
    await this.configStore.updateConfig({ customRemoteUrl: normalized });

    const wsUrl = httpUrlToWsUrl(normalized);
    return this.setStatus({
      enabled: true,
      status: "running",
      provider: "custom",
      url: normalized,
      wsUrl,
      error: null,
    });
  }

  private async startTailscale(): Promise<RemoteStatus> {
    await this.stopChildProcess();

    const tsIp = getTailscaleIp();
    if (!tsIp) {
      throw new Error("No active Tailscale IPv4 address (100.64.0.0/10) detected");
    }

    await this.configStore.ensureToken();
    const port = this.getPort();
    const url = `http://${tsIp}:${port}`;
    const wsUrl = `ws://${tsIp}:${port}/ws`;

    return this.setStatus({
      enabled: true,
      status: "running",
      provider: "tailscale",
      url,
      wsUrl,
      error: null,
    });
  }

  private async startCloudflareInternal(): Promise<RemoteStatus> {
    await this.stopChildProcess();

    // Ensure a secure remote access token exists before exposing the server externally
    await this.configStore.ensureToken();

    this.setStatus({
      enabled: false,
      status: "starting",
      provider: "cloudflare",
      url: null,
      wsUrl: null,
      error: null,
    });

    let binPath: string;
    try {
      binPath = await this.ensureCloudflaredBinary();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus({
        enabled: false,
        status: "error",
        provider: "cloudflare",
        url: null,
        wsUrl: null,
        error: msg,
      });
      throw err;
    }

    const port = this.getPort();
    const targetUrl = `http://127.0.0.1:${port}`;
    const args = ["tunnel", "--url", targetUrl, "--no-autoupdate"];
    const protocolOverride = process.env.CLOUDFLARED_PROTOCOL?.trim();
    if (protocolOverride) {
      args.push("--protocol", protocolOverride);
    }

    this.log(`[tunnel] Starting Cloudflare Quick Tunnel -> ${targetUrl}`);
    this.stopping = false;

    const child = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    return new Promise<RemoteStatus>((resolve, reject) => {
      let settled = false;
      let lastErrorLine = "";

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const errMsg =
          lastErrorLine ||
          `Timed out waiting for Cloudflare Quick Tunnel URL (${Math.round(this.startupTimeoutMs / 1000)}s)`;
        void this.stopChildProcess();
        this.setStatus({
          enabled: false,
          status: "error",
          provider: "cloudflare",
          url: null,
          wsUrl: null,
          error: errMsg,
        });
        reject(new Error(errMsg));
      }, this.startupTimeoutMs);
      timer.unref();

      const handleChunk = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (/err|fail|error/i.test(trimmed)) {
            lastErrorLine = trimmed;
          }
          const match = TRYCLOUDFLARE_URL_RE.exec(trimmed);
          if (match && !settled) {
            settled = true;
            clearTimeout(timer);
            const publicUrl = match[0].replace(/\/+$/, "");
            const wsUrl = httpUrlToWsUrl(publicUrl);
            this.log(`[tunnel] Cloudflare Quick Tunnel live: ${publicUrl}`);
            const runningStatus = this.setStatus({
              enabled: true,
              status: "running",
              provider: "cloudflare",
              url: publicUrl,
              wsUrl,
              error: null,
            });
            resolve(runningStatus);
          }
        }
      };

      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);

      child.once("error", (err) => {
        if (this.child === child) this.child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.setStatus({
            enabled: false,
            status: "error",
            provider: "cloudflare",
            url: null,
            wsUrl: null,
            error: err.message,
          });
          reject(err);
        }
      });

      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const msg = this.stopping
            ? "Tunnel stopped before startup completed"
            : lastErrorLine ||
              `cloudflared exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`;
          this.setStatus({
            enabled: false,
            status: this.stopping ? "stopped" : "error",
            provider: this.stopping ? "none" : "cloudflare",
            url: null,
            wsUrl: null,
            error: this.stopping ? null : msg,
          });
          reject(new Error(msg));
          return;
        }

        if (!this.stopping) {
          const msg =
            lastErrorLine ||
            `cloudflared tunnel exited unexpectedly (code=${code ?? "null"})`;
          console.warn(`[tunnel] ${msg}`);
          this.setStatus({
            enabled: false,
            status: "error",
            provider: "cloudflare",
            url: null,
            wsUrl: null,
            error: msg,
          });
        }
      });
    });
  }

  async stop(): Promise<RemoteStatus> {
    await this.stopChildProcess();
    return this.setStatus({
      enabled: false,
      status: "stopped",
      provider: "none",
      url: null,
      wsUrl: null,
      error: null,
    });
  }

  private async stopChildProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;

    this.stopping = true;
    this.child = null;

    if (child.exitCode !== null || child.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      const killTimer = setTimeout(() => {
        try {
          if (process.platform === "win32" && child.pid) {
            void execFileAsync("taskkill", [
              "/PID",
              String(child.pid),
              "/T",
              "/F",
            ]).catch(() => {});
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // ignore
        }
        finish();
      }, 2000);
      killTimer.unref();

      child.once("exit", () => {
        clearTimeout(killTimer);
        finish();
      });

      try {
        child.kill();
      } catch {
        clearTimeout(killTimer);
        finish();
      }
    });
  }

  getActiveRemoteProvider(): RemoteProvider {
    return this.status.provider;
  }
}
