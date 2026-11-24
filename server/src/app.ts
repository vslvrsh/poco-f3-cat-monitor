import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PurrCamConfigStore } from "./config.js";
import { createHttpRequestHandler, SERVER_VERSION } from "./http.js";
import { ServerLogBuffer } from "./logger.js";
import { buildPrimaryWsUrl, getLanIps, getTailscaleIp } from "./network.js";
import { AuthRateLimiter } from "./security.js";
import { SignalingHub } from "./signaling.js";
import { PurrCamStorage } from "./storage.js";
import { RemoteTunnelManager } from "./tunnel.js";
import type { ServerConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, "..");

export function resolveConfig(
  overrides: Partial<ServerConfig> = {}
): ServerConfig {
  const envPort = process.env.PORT ? Number(process.env.PORT) : 8787;
  const port =
    overrides.port !== undefined
      ? overrides.port
      : Number.isFinite(envPort) && envPort >= 0
        ? envPort
        : 8787;

  const autoStartRemote =
    overrides.autoStartRemote !== undefined
      ? overrides.autoStartRemote
      : process.env.PURRCAM_REMOTE === "1" ||
        process.env.PURRCAM_REMOTE?.toLowerCase() === "true";

  return {
    port,
    host: overrides.host ?? process.env.HOST ?? "0.0.0.0",
    token: overrides.token ?? process.env.PURRCAM_TOKEN ?? "",
    iceServers: overrides.iceServers,
    autoStartRemote,
    dataDir:
      overrides.dataDir ??
      process.env.PURRCAM_DATA_DIR ??
      path.join(SERVER_ROOT, "data"),
    binDir:
      overrides.binDir ??
      process.env.PURRCAM_BIN_DIR ??
      path.join(SERVER_ROOT, "bin"),
    webDistDir:
      overrides.webDistDir ??
      process.env.PURRCAM_WEB_DIST ??
      path.resolve(SERVER_ROOT, "..", "web", "dist"),
    maxTelemetrySamples: overrides.maxTelemetrySamples ?? 720,
    telemetryFlushIntervalMs: overrides.telemetryFlushIntervalMs ?? 10_000,
    heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 15_000,
    heartbeatMaxMissed: overrides.heartbeatMaxMissed ?? 3,
    registerTimeoutMs: overrides.registerTimeoutMs ?? 15_000,
    maxSnapshotBytes: overrides.maxSnapshotBytes ?? 10 * 1024 * 1024,
    authRateLimitMaxFailures: overrides.authRateLimitMaxFailures ?? 15,
    authRateLimitWindowMs: overrides.authRateLimitWindowMs ?? 5 * 60 * 1000,
    enableBeacon: overrides.enableBeacon ?? true,
  };
}

export class PurrCamServer {
  readonly config: ServerConfig;
  readonly configStore: PurrCamConfigStore;
  readonly storage: PurrCamStorage;
  readonly signaling: SignalingHub;
  readonly tunnel: RemoteTunnelManager;
  readonly logBuffer: ServerLogBuffer;
  readonly rateLimiter: AuthRateLimiter;
  readonly httpServer: http.Server;

  private boundPort: number;
  private started = false;

  constructor(overrides: Partial<ServerConfig> = {}) {
    this.config = resolveConfig(overrides);
    this.boundPort = this.config.port;
    this.logBuffer = new ServerLogBuffer(500);
    this.rateLimiter = new AuthRateLimiter({
      maxFailures: this.config.authRateLimitMaxFailures,
      windowMs: this.config.authRateLimitWindowMs,
    });

    this.configStore = new PurrCamConfigStore({
      dataDir: this.config.dataDir,
      strictToken: this.config.token,
      overrideIceServers: this.config.iceServers,
    });

    this.storage = new PurrCamStorage({
      dataDir: this.config.dataDir,
      maxTelemetrySamples: this.config.maxTelemetrySamples,
      telemetryFlushIntervalMs: this.config.telemetryFlushIntervalMs,
      maxSnapshotBytes: this.config.maxSnapshotBytes,
    });

    this.signaling = new SignalingHub({
      getToken: () => this.configStore.getEffectiveToken(),
      isStrictGlobalToken: () => this.configStore.hasStrictGlobalToken(),
      getIceServers: () => this.configStore.getEffectiveIceServers(),
      storage: this.storage,
      rateLimiter: this.rateLimiter,
      onLog: (msg) => this.logBuffer.append(msg),
      heartbeatIntervalMs: this.config.heartbeatIntervalMs,
      heartbeatMaxMissed: this.config.heartbeatMaxMissed,
      registerTimeoutMs: this.config.registerTimeoutMs,
    });

    this.tunnel = new RemoteTunnelManager({
      binDir: this.config.binDir,
      configStore: this.configStore,
      getPort: () => this.port,
      enableBeacon: this.config.enableBeacon,
      onLog: (msg) => this.logBuffer.append(msg),
      onStatusChange: (status) => {
        this.signaling.broadcastRemoteStatus(status);
      },
    });

    const requestHandler = createHttpRequestHandler({
      config: this.config,
      configStore: this.configStore,
      tunnel: this.tunnel,
      storage: this.storage,
      signaling: this.signaling,
      logBuffer: this.logBuffer,
      rateLimiter: this.rateLimiter,
      getPort: () => this.port,
    });

    this.httpServer = http.createServer((req, res) => {
      void requestHandler(req, res);
    });

    this.httpServer.on("upgrade", (req, socket, head) => {
      let pathname = "";
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        pathname = url.pathname;
      } catch {
        socket.destroy();
        return;
      }

      if (pathname !== "/ws") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.signaling.wss.handleUpgrade(req, socket, head, (ws) => {
        this.signaling.wss.emit("connection", ws, req);
      });
    });
  }

  get port(): number {
    return this.boundPort;
  }

  get lanIps(): string[] {
    return getLanIps();
  }

  get tailscaleIp(): string | null {
    return getTailscaleIp();
  }

  get wsUrl(): string {
    return buildPrimaryWsUrl(this.lanIps, this.boundPort);
  }

  async start(): Promise<{
    port: number;
    host: string;
    lanIps: string[];
    tailscaleIp: string | null;
    wsUrl: string;
  }> {
    if (this.started) {
      return {
        port: this.boundPort,
        host: this.config.host,
        lanIps: this.lanIps,
        tailscaleIp: this.tailscaleIp,
        wsUrl: this.wsUrl,
      };
    }

    await this.configStore.init();
    await this.storage.init();

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.httpServer.off("error", onError);
        const addr = this.httpServer.address();
        if (addr && typeof addr === "object") {
          this.boundPort = (addr as AddressInfo).port;
        }
        this.started = true;
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(this.config.port, this.config.host);
    });

    this.logBuffer.append(
      `[PurrCam] Server v${SERVER_VERSION} listening on port ${this.boundPort} (LAN: ${this.lanIps.join(", ") || "localhost"}, WS: ${this.wsUrl})`
    );

    // Auto-start VPN-free remote tunnel (auto failover chain) if requested
    if (
      this.config.autoStartRemote ||
      this.configStore.getConfig().autoStartTunnel
    ) {
      void this.tunnel.start({ provider: "auto" }).catch((err) => {
        console.error(
          "[purrcam] Failed to auto-start remote tunnel:",
          err instanceof Error ? err.message : err
        );
      });
    }

    return {
      port: this.boundPort,
      host: this.config.host,
      lanIps: this.lanIps,
      tailscaleIp: this.tailscaleIp,
      wsUrl: this.wsUrl,
    };
  }

  async stop(): Promise<void> {
    if (!this.started) {
      await this.tunnel.stop();
      await this.signaling.close();
      await this.storage.close();
      await this.configStore.close();
      return;
    }
    this.started = false;

    await this.tunnel.stop();
    await this.signaling.close();

    await new Promise<void>((resolve) => {
      this.httpServer.close(() => resolve());
      if (typeof this.httpServer.closeIdleConnections === "function") {
        this.httpServer.closeIdleConnections();
      }
    });

    await this.storage.close();
    await this.configStore.close();
  }
}
