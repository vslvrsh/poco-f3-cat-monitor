import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { BeaconPublisher } from "./beacon.js";
import { normalizeCustomRemoteUrl, type PurrCamConfigStore } from "./config.js";
import { getTailscaleIp, httpUrlToWsUrl } from "./network.js";
import type {
  ActiveRemoteProvider,
  RemoteProvider,
  RemoteStatus,
} from "./types.js";

const execFileAsync = promisify(execFile);

export const CLOUDFLARED_WINDOWS_URL =
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

type ManagedBackend = "localhost.run" | "pinggy" | "cloudflare";

const AUTO_PROVIDER_CHAIN: readonly ManagedBackend[] = [
  "localhost.run",
  "pinggy",
  "cloudflare",
];

const RESTART_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000] as const;

const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

const LOCALHOST_RUN_URL_RE =
  /https:\/\/[a-z0-9-]+\.(?:app\.)?lhr\.life\b/i;

const PINGGY_URL_RE =
  /https:\/\/[a-z0-9-]+\.(?:free\.pinggy\.net|a\.free\.pinggy\.link|run\.pinggy-free\.link|pinggy-free\.link|pinggy\.link)\b/i;

const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export interface StartRemoteOptions {
  provider?: RemoteProvider;
  customUrl?: string;
}

export interface TunnelManagerOptions {
  binDir: string;
  configStore: PurrCamConfigStore;
  getPort: () => number;
  onStatusChange?: (status: RemoteStatus) => void;
  onLog?: (msg: string) => void;
  enableBeacon?: boolean;
  beaconEndpoints?: string[];
  healthProbeIntervalMs?: number;
  healthProbeTimeoutMs?: number;
  pinggyRefreshMs?: number;
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

export function stripAnsi(input: string): string {
  return input.replace(ANSI_ESCAPE_RE, "");
}

export function parseBackendTunnelUrl(
  backend: ManagedBackend,
  rawLine: string
): string | null {
  const cleaned = stripAnsi(rawLine).trim();
  if (!cleaned) return null;

  if (backend === "localhost.run") {
    if (cleaned.startsWith("{") && cleaned.endsWith("}")) {
      try {
        const obj = JSON.parse(cleaned) as {
          address?: unknown;
          status?: unknown;
        };
        if (typeof obj.address === "string" && obj.status !== "error") {
          const host = obj.address
            .trim()
            .replace(/^https?:\/\//i, "")
            .replace(/\/+$/, "");
          if (
            /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) &&
            !/^(?:admin|www|docs|status)\.localhost\.run$/i.test(host) &&
            host.toLowerCase() !== "localhost.run"
          ) {
            return `https://${host}`;
          }
        }
      } catch {
        // fall through to regex
      }
    }
    const m = LOCALHOST_RUN_URL_RE.exec(cleaned);
    return m ? m[0].replace(/\/+$/, "") : null;
  }

  if (backend === "pinggy") {
    const m = PINGGY_URL_RE.exec(cleaned);
    return m ? m[0].replace(/\/+$/, "") : null;
  }

  const cf = TRYCLOUDFLARE_URL_RE.exec(cleaned);
  return cf ? cf[0].replace(/\/+$/, "") : null;
}

export class RemoteTunnelManager {
  readonly binDir: string;
  readonly localBinaryPath: string;
  readonly beacon: BeaconPublisher;

  private readonly configStore: PurrCamConfigStore;
  private readonly getPort: () => number;
  private readonly onStatusChange?: (status: RemoteStatus) => void;
  private readonly onLog?: (msg: string) => void;
  private readonly healthProbeIntervalMs: number;
  private readonly healthProbeTimeoutMs: number;
  private readonly pinggyRefreshMs: number;
  private readonly downloadTimeoutMs: number;

  private child: ChildProcess | null = null;
  private generation = 0;
  private desiredRunning = false;
  private configuredProvider: RemoteProvider = "none";
  private autoIndex = 0;
  private consecutiveFailuresForCurrent = 0;
  private totalRestartAttempt = 0;
  private consecutiveProbeFailures = 0;

  private backoffTimer: NodeJS.Timeout | null = null;
  private healthProbeTimer: NodeJS.Timeout | null = null;
  private pinggyRefreshTimer: NodeJS.Timeout | null = null;
  private healthProbeInFlight = false;

  private downloadPromise: Promise<string> | null = null;
  private startPromise: Promise<RemoteStatus> | null = null;

  private status: RemoteStatus = {
    enabled: false,
    status: "stopped",
    provider: "none",
    activeProvider: "none",
    url: null,
    wsUrl: null,
    error: null,
    beacon: {
      enabled: false,
      lastPublishedAt: null,
      endpoints: [],
    },
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
    this.healthProbeIntervalMs = options.healthProbeIntervalMs ?? 30_000;
    this.healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? 8_000;
    this.pinggyRefreshMs = options.pinggyRefreshMs ?? 55 * 60 * 1000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 120_000;

    this.beacon = new BeaconPublisher({
      enabled: options.enableBeacon ?? true,
      endpoints: options.beaconEndpoints,
      onLog: (msg) => this.log(msg),
      onStatusChange: (beaconStatus) => {
        this.status = {
          ...this.status,
          beacon: beaconStatus,
        };
        this.onStatusChange?.(this.getStatus());
      },
    });
  }

  private log(msg: string): void {
    console.log(msg);
    this.onLog?.(msg);
  }

  getStatus(): RemoteStatus {
    return {
      ...this.status,
      beacon: {
        ...this.status.beacon,
        endpoints: [...this.status.beacon.endpoints],
      },
    };
  }

  private setStatus(
    next: Omit<RemoteStatus, "beacon"> & { beacon?: RemoteStatus["beacon"] }
  ): RemoteStatus {
    this.status = {
      ...next,
      beacon: next.beacon ? { ...next.beacon } : this.beacon.getStatus(),
    };
    this.onStatusChange?.(this.getStatus());
    return this.getStatus();
  }

  async republishBeacon(): Promise<void> {
    if (this.status.status === "running" && this.status.url && this.status.wsUrl) {
      await this.beacon.publishNow();
    }
  }

  async findSshBinary(): Promise<string | null> {
    const envSsh = process.env.PURRCAM_SSH_PATH?.trim();
    if (envSsh && (await fileExists(envSsh))) return envSsh;

    if (process.platform === "win32") {
      const sysRoot = process.env.SystemRoot || "C:\\Windows";
      const builtin = path.join(sysRoot, "System32", "OpenSSH", "ssh.exe");
      if (await fileExists(builtin)) return builtin;
    }

    try {
      const cmd = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(cmd, ["ssh"], { timeout: 4000 });
      const firstLine = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (firstLine && (await fileExists(firstLine))) return firstLine;
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Resolves an existing cloudflared executable from env, PATH, standard install dirs, or server/bin/.
   */
  async findCloudflaredBinary(): Promise<string | null> {
    const envPath = process.env.CLOUDFLARED_PATH?.trim();
    if (envPath && (await fileExists(envPath))) {
      return envPath;
    }

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

    this.log(
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
          throw new Error(
            "Downloaded cloudflared file is not a valid Windows executable"
          );
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

      this.log(
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
    const provider: RemoteProvider =
      options.provider && options.provider !== "none"
        ? options.provider
        : "auto";

    if (provider === "custom") {
      return this.startCustom(options.customUrl);
    }

    if (provider === "tailscale") {
      return this.startTailscale();
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (
      this.status.status === "running" &&
      this.configuredProvider === provider &&
      this.child &&
      !this.child.killed
    ) {
      return this.getStatus();
    }

    this.startPromise = this.startManagedTunnel(provider).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startCustom(rawCustomUrl?: string): Promise<RemoteStatus> {
    this.clearWatchdogTimers();
    this.desiredRunning = false;
    this.generation += 1;
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
    this.configuredProvider = "custom";

    this.setStatus({
      enabled: true,
      status: "running",
      provider: "custom",
      activeProvider: "custom",
      url: normalized,
      wsUrl,
      error: null,
    });

    if (normalized.startsWith("https://")) {
      await this.beacon.activate({
        getToken: () => this.configStore.getEffectiveToken(),
        url: normalized,
        wsUrl,
        provider: "custom",
      });
    } else {
      this.beacon.stop();
    }

    return this.getStatus();
  }

  private async startTailscale(): Promise<RemoteStatus> {
    this.clearWatchdogTimers();
    this.desiredRunning = false;
    this.generation += 1;
    await this.stopChildProcess();
    this.beacon.stop();

    const tsIp = getTailscaleIp();
    if (!tsIp) {
      throw new Error(
        "No active Tailscale IPv4 address (100.64.0.0/10) detected"
      );
    }

    await this.configStore.ensureToken();
    const port = this.getPort();
    const url = `http://${tsIp}:${port}`;
    const wsUrl = `ws://${tsIp}:${port}/ws`;
    this.configuredProvider = "tailscale";

    return this.setStatus({
      enabled: true,
      status: "running",
      provider: "tailscale",
      activeProvider: "tailscale",
      url,
      wsUrl,
      error: null,
    });
  }

  private async startManagedTunnel(
    provider: "auto" | ManagedBackend
  ): Promise<RemoteStatus> {
    this.clearWatchdogTimers();
    this.generation += 1;
    const myGen = this.generation;
    await this.stopChildProcess();
    this.beacon.stop();

    // Ensure a 192-bit URL-safe token exists BEFORE opening external access
    await this.configStore.ensureToken();

    this.desiredRunning = true;
    this.configuredProvider = provider;
    this.autoIndex = 0;
    this.consecutiveFailuresForCurrent = 0;
    this.totalRestartAttempt = 0;
    this.consecutiveProbeFailures = 0;

    this.setStatus({
      enabled: false,
      status: "starting",
      provider,
      activeProvider: "none",
      url: null,
      wsUrl: null,
      error: null,
    });

    const candidates: readonly ManagedBackend[] =
      provider === "auto" ? AUTO_PROVIDER_CHAIN : [provider];

    const errors: string[] = [];

    for (let i = 0; i < candidates.length; i++) {
      if (!this.desiredRunning || this.generation !== myGen) {
        throw new Error("Tunnel start cancelled");
      }
      const backend = candidates[i];
      if (provider === "auto") {
        this.autoIndex = i;
      }

      try {
        const result = await this.launchBackend(backend, myGen);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${backend}: ${msg}`);
        this.log(`[tunnel] Provider ${backend} failed: ${msg}`);
        await this.stopChildProcess();
      }
    }

    const combinedErr = errors.join(" | ") || "All tunnel providers failed";
    this.desiredRunning = false;
    this.setStatus({
      enabled: false,
      status: "error",
      provider,
      activeProvider: "none",
      url: null,
      wsUrl: null,
      error: combinedErr,
    });
    throw new Error(combinedErr);
  }

  private async launchBackend(
    backend: ManagedBackend,
    myGen: number
  ): Promise<RemoteStatus> {
    const port = this.getPort();
    let command: string;
    let args: string[];
    let startupTimeoutMs: number;

    const nullDev = process.platform === "win32" ? "NUL" : "/dev/null";

    if (backend === "localhost.run") {
      const sshBin = await this.findSshBinary();
      if (!sshBin) {
        throw new Error("OpenSSH client (ssh.exe) not found");
      }
      command = sshBin;
      args = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        `UserKnownHostsFile=${nullDev}`,
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=20",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ExitOnForwardFailure=yes",
        "-R",
        `80:127.0.0.1:${port}`,
        "nokey@localhost.run",
        "--",
        "--output",
        "json",
      ];
      startupTimeoutMs = 15_000;
    } else if (backend === "pinggy") {
      const sshBin = await this.findSshBinary();
      if (!sshBin) {
        throw new Error("OpenSSH client (ssh.exe) not found");
      }
      command = sshBin;
      args = [
        "-T",
        "-p",
        "443",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        `UserKnownHostsFile=${nullDev}`,
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=20",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ExitOnForwardFailure=yes",
        `-R0:127.0.0.1:${port}`,
        "a.pinggy.io",
      ];
      startupTimeoutMs = 15_000;
    } else {
      command = await this.ensureCloudflaredBinary();
      const protocolOverride = process.env.CLOUDFLARED_PROTOCOL?.trim() || "http2";
      args = [
        "tunnel",
        "--protocol",
        protocolOverride,
        "--url",
        `http://127.0.0.1:${port}`,
        "--no-autoupdate",
      ];
      startupTimeoutMs = 20_000;
    }

    if (!this.desiredRunning || this.generation !== myGen) {
      throw new Error("Tunnel start cancelled");
    }

    this.log(
      `[tunnel] Starting ${backend} tunnel -> http://127.0.0.1:${port}`
    );

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const publicUrl = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let lastErrorLine = "";
      let stdoutBuf = "";
      let stderrBuf = "";

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            lastErrorLine ||
              `Timed out waiting for ${backend} public URL (${Math.round(startupTimeoutMs / 1000)}s)`
          )
        );
      }, startupTimeoutMs);
      timer.unref();

      const processLine = (line: string) => {
        const cleaned = stripAnsi(line).trim();
        if (!cleaned) return;
        if (/err|fail|denied|refused|reset|closed|timeout/i.test(cleaned)) {
          lastErrorLine = cleaned.slice(0, 220);
        }
        if (!settled) {
          const parsedUrl = parseBackendTunnelUrl(backend, cleaned);
          if (parsedUrl) {
            settled = true;
            clearTimeout(timer);
            resolve(parsedUrl);
          }
        }
      };

      const feedChunk = (isErr: boolean, chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (isErr) {
          stderrBuf += text;
          const parts = stderrBuf.split(/\r?\n/);
          stderrBuf = parts.pop() ?? "";
          for (const p of parts) processLine(p);
          if (stderrBuf) {
            const immediate = parseBackendTunnelUrl(backend, stderrBuf);
            if (immediate && !settled) {
              settled = true;
              clearTimeout(timer);
              resolve(immediate);
            }
          }
        } else {
          stdoutBuf += text;
          const parts = stdoutBuf.split(/\r?\n/);
          stdoutBuf = parts.pop() ?? "";
          for (const p of parts) processLine(p);
          if (stdoutBuf) {
            const immediate = parseBackendTunnelUrl(backend, stdoutBuf);
            if (immediate && !settled) {
              settled = true;
              clearTimeout(timer);
              resolve(immediate);
            }
          }
        }
      };

      child.stdout?.on("data", (c: Buffer) => feedChunk(false, c));
      child.stderr?.on("data", (c: Buffer) => feedChunk(true, c));

      child.once("error", (err) => {
        if (this.child === child) this.child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              lastErrorLine ||
                `${backend} exited before tunnel came online (code=${code ?? "null"}, signal=${signal ?? "null"})`
            )
          );
          return;
        }

        // Unexpected exit AFTER tunnel was already running -> self-healing watchdog!
        if (this.desiredRunning && this.generation === myGen) {
          const reason =
            lastErrorLine ||
            `${backend} tunnel disconnected (code=${code ?? "null"}, signal=${signal ?? "null"})`;
          this.log(`[tunnel] ${reason} — scheduling automatic recovery...`);
          this.scheduleWatchdogRestart(myGen, reason);
        }
      });
    });

    if (!this.desiredRunning || this.generation !== myGen) {
      await this.stopChildProcess();
      throw new Error("Tunnel start cancelled");
    }

    const wsUrl = httpUrlToWsUrl(publicUrl);
    this.consecutiveFailuresForCurrent = 0;
    this.totalRestartAttempt = 0;
    this.consecutiveProbeFailures = 0;

    this.log(`[tunnel] ${backend} tunnel live: ${publicUrl}`);

    this.setStatus({
      enabled: true,
      status: "running",
      provider: this.configuredProvider,
      activeProvider: backend,
      url: publicUrl,
      wsUrl,
      error: null,
    });

    // Publish encrypted URL to auto-discovery beacon (non-fatal if ntfy unreachable)
    await this.beacon
      .activate({
        getToken: () => this.configStore.getEffectiveToken(),
        url: publicUrl,
        wsUrl,
        provider: backend,
      })
      .catch((err) => {
        this.log(
          `[beacon] Publish error: ${err instanceof Error ? err.message : String(err)}`
        );
      });

    this.startHealthProbe(myGen, publicUrl);
    if (backend === "pinggy") {
      this.schedulePinggyProactiveRefresh(myGen);
    }

    return this.getStatus();
  }

  private startHealthProbe(myGen: number, publicUrl: string): void {
    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer);
      this.healthProbeTimer = null;
    }

    this.healthProbeTimer = setInterval(() => {
      void this.runHealthProbeTick(myGen, publicUrl);
    }, this.healthProbeIntervalMs);
    this.healthProbeTimer.unref();
  }

  private async runHealthProbeTick(
    myGen: number,
    publicUrl: string
  ): Promise<void> {
    if (
      !this.desiredRunning ||
      this.generation !== myGen ||
      this.status.status !== "running" ||
      this.healthProbeInFlight
    ) {
      return;
    }

    this.healthProbeInFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.healthProbeTimeoutMs);
    timer.unref();

    try {
      const resp = await fetch(`${publicUrl}/api/info`, {
        signal: controller.signal,
        headers: { "User-Agent": "PurrCam-HealthProbe/1.1" },
      });
      if (resp.ok) {
        const body = (await resp.json()) as { name?: string };
        if (body && body.name === "PurrCam") {
          this.consecutiveProbeFailures = 0;
          return;
        }
      }
      this.consecutiveProbeFailures += 1;
      this.log(
        `[tunnel] Health probe failed (${this.consecutiveProbeFailures}/2): HTTP ${resp.status}`
      );
    } catch (err) {
      this.consecutiveProbeFailures += 1;
      this.log(
        `[tunnel] Health probe error (${this.consecutiveProbeFailures}/2): ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
      this.healthProbeInFlight = false;
    }

    if (
      this.consecutiveProbeFailures >= 2 &&
      this.desiredRunning &&
      this.generation === myGen
    ) {
      this.log(
        "[tunnel] 2 consecutive live health probes failed (zombie tunnel); restarting immediately..."
      );
      this.consecutiveProbeFailures = 0;
      const nextGen = ++this.generation;
      await this.stopChildProcess();
      this.scheduleWatchdogRestart(nextGen, "Health probe failed twice", true);
    }
  }

  private schedulePinggyProactiveRefresh(myGen: number): void {
    if (this.pinggyRefreshTimer) {
      clearTimeout(this.pinggyRefreshTimer);
      this.pinggyRefreshTimer = null;
    }

    this.pinggyRefreshTimer = setTimeout(() => {
      if (
        !this.desiredRunning ||
        this.generation !== myGen ||
        this.status.activeProvider !== "pinggy"
      ) {
        return;
      }
      this.log(
        "[tunnel] Proactively refreshing Pinggy tunnel before 60-minute free session cutoff..."
      );
      const nextGen = ++this.generation;
      void this.stopChildProcess().then(() => {
        this.scheduleWatchdogRestart(
          nextGen,
          "Proactive Pinggy 55-minute session refresh",
          true
        );
      });
    }, this.pinggyRefreshMs);
    this.pinggyRefreshTimer.unref();
  }

  private scheduleWatchdogRestart(
    myGen: number,
    reason: string,
    immediate = false
  ): void {
    if (!this.desiredRunning || this.generation !== myGen) return;

    this.clearWatchdogTimers();

    const delayMs = immediate
      ? 500
      : RESTART_BACKOFF_MS[
          Math.min(this.totalRestartAttempt, RESTART_BACKOFF_MS.length - 1)
        ];

    this.setStatus({
      enabled: false,
      status: "starting",
      provider: this.configuredProvider,
      activeProvider: "none",
      url: null,
      wsUrl: null,
      error: `Reconnecting (${reason})`,
    });

    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      void this.runWatchdogReconnect(myGen);
    }, delayMs);
    this.backoffTimer.unref();
  }

  private async runWatchdogReconnect(myGen: number): Promise<void> {
    if (!this.desiredRunning || this.generation !== myGen) return;

    const backend: ManagedBackend =
      this.configuredProvider === "auto"
        ? AUTO_PROVIDER_CHAIN[this.autoIndex % AUTO_PROVIDER_CHAIN.length]
        : (this.configuredProvider as ManagedBackend);

    try {
      await this.launchBackend(backend, myGen);
    } catch (err) {
      if (!this.desiredRunning || this.generation !== myGen) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[tunnel] Watchdog reconnect (${backend}) failed: ${msg}`);
      await this.stopChildProcess();

      this.totalRestartAttempt += 1;
      this.consecutiveFailuresForCurrent += 1;

      if (
        this.configuredProvider === "auto" &&
        this.consecutiveFailuresForCurrent >= 2
      ) {
        this.autoIndex = (this.autoIndex + 1) % AUTO_PROVIDER_CHAIN.length;
        this.consecutiveFailuresForCurrent = 0;
        this.log(
          `[tunnel] Failing over to next provider: ${AUTO_PROVIDER_CHAIN[this.autoIndex]}`
        );
      }

      this.scheduleWatchdogRestart(myGen, msg, false);
    }
  }

  async stop(): Promise<RemoteStatus> {
    this.desiredRunning = false;
    this.generation += 1;
    this.configuredProvider = "none";
    this.clearWatchdogTimers();
    this.beacon.stop();
    await this.stopChildProcess();

    return this.setStatus({
      enabled: false,
      status: "stopped",
      provider: "none",
      activeProvider: "none",
      url: null,
      wsUrl: null,
      error: null,
    });
  }

  private clearWatchdogTimers(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer);
      this.healthProbeTimer = null;
    }
    if (this.pinggyRefreshTimer) {
      clearTimeout(this.pinggyRefreshTimer);
      this.pinggyRefreshTimer = null;
    }
  }

  private async stopChildProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;

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

  getActiveRemoteProvider(): ActiveRemoteProvider {
    return this.status.activeProvider;
  }
}
