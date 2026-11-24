import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { PurrCamConfigStore } from "./config.js";
import { runAdbReverse, type ServerLogBuffer } from "./logger.js";
import {
  buildPairingLink,
  buildPrimaryWsUrl,
  extractClientIp,
  getLanIps,
  getTailscaleIp,
  httpUrlToWsUrl,
  isExternalRequest,
} from "./network.js";
import {
  type AuthRateLimiter,
  constantTimeTokenEqual,
  isValidJpegBuffer,
} from "./security.js";
import type { SignalingHub } from "./signaling.js";
import type { PurrCamStorage } from "./storage.js";
import type { RemoteTunnelManager } from "./tunnel.js";
import type {
  PersistedConfig,
  RemoteConfigResponse,
  ServerConfig,
  ServerInfoResponse,
} from "./types.js";

export const SERVER_VERSION = "1.1.0";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function isAdminPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/remote/") ||
    pathname === "/api/remote" ||
    pathname.startsWith("/api/system/") ||
    pathname === "/api/system"
  );
}

function setCorsHeaders(res: ServerResponse, adminRoute: boolean): void {
  if (!adminRoute) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS, HEAD"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-PurrCam-Token, X-Lens-Label"
  );
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function sendHtml(
  res: ServerResponse,
  statusCode: number,
  html: string,
  headOnly = false
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(html));
  res.setHeader("Cache-Control", "no-cache");
  res.end(headOnly ? undefined : html);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeHeaderValue(raw: string | string[] | undefined): string | null {
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (!val || !val.trim()) return null;
  const trimmed = val.trim();
  try {
    return decodeURIComponent(trimmed).trim() || null;
  } catch {
    return trimmed;
  }
}

function hasValidToken(
  req: IncomingMessage,
  url: URL,
  expectedToken: string
): boolean {
  if (!expectedToken) return false;

  const queryToken = url.searchParams.get("token");
  if (constantTimeTokenEqual(queryToken, expectedToken)) return true;

  const headerToken = req.headers["x-purrcam-token"];
  if (
    typeof headerToken === "string" &&
    constantTimeTokenEqual(headerToken, expectedToken)
  ) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && constantTimeTokenEqual(match[1], expectedToken)) return true;
  }

  return false;
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;

    const fail = (err: Error) => {
      if (finished) return;
      finished = true;
      reject(err);
    };

    req.on("data", (chunk: Buffer) => {
      if (finished) return;
      total += chunk.length;
      if (total > maxBytes) {
        req.pause();
        fail(
          new HttpError(413, `Request body exceeds limit of ${maxBytes} bytes`)
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks, total));
    });

    req.on("error", (err) => fail(err));
  });
}

function decodeBase64Image(input: string): Buffer {
  const stripped = input
    .trim()
    .replace(/^data:[^;]+;base64,/i, "")
    .replace(/\s+/g, "");
  if (!stripped) {
    throw new HttpError(400, "imageBase64 is empty");
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(stripped)) {
    throw new HttpError(400, "imageBase64 contains invalid base64 characters");
  }
  const normalized = stripped.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0) {
    throw new HttpError(400, "Decoded image data is empty");
  }
  return buffer;
}

function buildFallbackStatusHtml(info: ServerInfoResponse): string {
  const statusColor = info.cameraOnline ? "#7DD3A8" : "#94A3B8";
  const statusText = info.cameraOnline
    ? "Camera Online"
    : "Waiting for Camera";
  const urlsList =
    info.lanIps.length > 0
      ? info.lanIps
          .map(
            (ip) =>
              `<li><code>http://${escapeHtml(ip)}:${info.port}</code> &middot; <code>ws://${escapeHtml(ip)}:${info.port}/ws</code></li>`
          )
          .join("")
      : `<li><code>http://localhost:${info.port}</code> &middot; <code>ws://localhost:${info.port}/ws</code></li>`;

  const remoteRow = info.remote.url
    ? `<p><strong>Remote Access (${escapeHtml(info.remote.provider)}):</strong> <code>${escapeHtml(info.remote.url)}</code></p>`
    : `<p><strong>Remote Access:</strong> ${escapeHtml(info.remote.status)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PurrCam · Server Running</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #0E1116;
      color: #E6EAF2;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    }
    .card {
      width: 100%;
      max-width: 580px;
      background: #161A22;
      border-radius: 28px;
      padding: 32px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
    }
    h1 { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
    .accent { color: #A8C7FA; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 500;
      background: #1F2530;
      color: ${statusColor};
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${statusColor};
    }
    p, li { color: #A5B0C2; line-height: 1.55; font-size: 14px; }
    ul { padding-left: 18px; margin: 8px 0 18px; }
    code {
      color: #E6EAF2;
      background: #1F2530;
      border-radius: 8px;
      padding: 2px 7px;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 13px;
    }
    .meta {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      margin: 18px 0;
    }
    .stat {
      background: #1F2530;
      border-radius: 18px;
      padding: 14px 16px;
    }
    .stat-label { font-size: 12px; color: #A5B0C2; }
    .stat-val { font-size: 20px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
    a { color: #A8C7FA; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <h1><span class="accent">PurrCam</span> Hub</h1>
      <span class="badge"><span class="dot"></span>${statusText}</span>
    </div>
    <p>Signaling, telemetry, and remote access server is running (v${escapeHtml(info.version)}), but the web UI (<code>web/dist</code>) has not been built yet.</p>
    <div class="meta">
      <div class="stat">
        <div class="stat-label">Connected Viewers</div>
        <div class="stat-val">${info.viewerCount}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Server Port</div>
        <div class="stat-val">${info.port}</div>
      </div>
    </div>
    <p><strong>Local Network Addresses:</strong></p>
    <ul>${urlsList}</ul>
    ${remoteRow}
    <p>Build the web client:</p>
    <p><code>cd web &amp;&amp; npm.cmd install &amp;&amp; npm.cmd run build</code></p>
    <p>API: <a href="/api/info">/api/info</a> &middot; <a href="/api/telemetry/history">/api/telemetry/history</a> &middot; <a href="/api/snapshots">/api/snapshots</a></p>
  </main>
</body>
</html>`;
}

export interface HttpHandlerDeps {
  config: ServerConfig;
  configStore: PurrCamConfigStore;
  tunnel: RemoteTunnelManager;
  storage: PurrCamStorage;
  signaling: SignalingHub;
  logBuffer: ServerLogBuffer;
  rateLimiter: AuthRateLimiter;
  getPort: () => number;
}

export function createHttpRequestHandler(deps: HttpHandlerDeps) {
  const {
    config,
    configStore,
    tunnel,
    storage,
    signaling,
    logBuffer,
    rateLimiter,
    getPort,
  } = deps;
  const webDistDir = path.resolve(config.webDistDir);
  const webDistPrefix = webDistDir.endsWith(path.sep)
    ? webDistDir
    : webDistDir + path.sep;

  const getServerInfo = (externalCaller = false): ServerInfoResponse => {
    const port = getPort();
    const lanIps = getLanIps();
    const effectiveToken = configStore.getEffectiveToken();
    return {
      name: "PurrCam",
      version: SERVER_VERSION,
      lanIps,
      tailscaleIp: getTailscaleIp(),
      port,
      wsUrl: buildPrimaryWsUrl(lanIps, port),
      cameraOnline: signaling.isCameraOnline(),
      camera: signaling.getCameraSummary(),
      viewerCount: signaling.getViewerCount(),
      tokenRequired: externalCaller || effectiveToken.length > 0,
      turnConfigured: configStore.isTurnConfigured(),
      remote: tunnel.getStatus(),
    };
  };

  const buildCurrentPairingLink = (): string => {
    const port = getPort();
    const lanIps = getLanIps();
    const localWsUrl = buildPrimaryWsUrl(lanIps, port);
    const remoteStatus = tunnel.getStatus();
    const persisted = configStore.getConfig();

    let remoteWsUrl = remoteStatus.wsUrl;
    if (!remoteWsUrl && persisted.customRemoteUrl) {
      try {
        remoteWsUrl = httpUrlToWsUrl(persisted.customRemoteUrl);
      } catch {
        remoteWsUrl = null;
      }
    }

    return buildPairingLink({
      localWsUrl,
      remoteWsUrl,
      token: persisted.token || null,
    });
  };

  const buildRemoteConfigResponse = (): RemoteConfigResponse => ({
    ...configStore.getConfig(),
    pairingLink: buildCurrentPairingLink(),
  });

  const checkRequestAuth = (
    req: IncomingMessage,
    url: URL
  ): "ok" | "unauthorized" | "rate_limited" => {
    const external = isExternalRequest(req);
    const mustAuth = external || configStore.hasStrictGlobalToken();
    if (!mustAuth) return "ok";

    const clientIp = extractClientIp(req);
    if (rateLimiter.isRateLimited(clientIp)) {
      return "rate_limited";
    }

    const effectiveToken = configStore.getEffectiveToken();
    if (hasValidToken(req, url, effectiveToken)) {
      rateLimiter.reset(clientIp);
      return "ok";
    }

    const nowLimited = rateLimiter.recordFailure(clientIp);
    return nowLimited ? "rate_limited" : "unauthorized";
  };

  async function serveStaticFile(
    filePath: string,
    res: ServerResponse,
    headOnly: boolean,
    cacheControl: string
  ): Promise<boolean> {
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return false;
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Cache-Control", cacheControl);
      if (headOnly) {
        res.end();
        return true;
      }
      await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        let settled = false;
        const done = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };
        stream.on("error", (err) => done(err));
        res.once("finish", () => done());
        res.once("close", () => {
          if (!res.writableEnded) {
            stream.destroy();
          }
          done();
        });
        stream.pipe(res);
      });
      return true;
    } catch {
      return false;
    }
  }

  async function handleStatic(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
    headOnly: boolean
  ): Promise<void> {
    const indexPath = path.join(webDistDir, "index.html");
    let hasWebDist = false;
    try {
      const st = await fsp.stat(indexPath);
      hasWebDist = st.isFile();
    } catch {
      hasWebDist = false;
    }

    if (!hasWebDist) {
      sendHtml(
        res,
        200,
        buildFallbackStatusHtml(getServerInfo(isExternalRequest(req))),
        headOnly
      );
      return;
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 400, { error: "Invalid URL encoding" });
      return;
    }

    if (decodedPath.includes("\0")) {
      sendJson(res, 400, { error: "Invalid path" });
      return;
    }

    const relative = decodedPath.replace(/^\/+/, "");
    if (relative) {
      const candidate = path.resolve(webDistDir, relative);
      if (candidate.startsWith(webDistPrefix)) {
        const isImmutableAsset =
          relative.startsWith("assets/") || /\.[0-9a-f]{8,}\./i.test(relative);
        const cacheHeader = isImmutableAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        const served = await serveStaticFile(
          candidate,
          res,
          headOnly,
          cacheHeader
        );
        if (served) return;
      } else {
        sendJson(res, 403, { error: "Forbidden" });
        return;
      }
    }

    // SPA fallback to index.html
    const servedIndex = await serveStaticFile(
      indexPath,
      res,
      headOnly,
      "no-cache"
    );
    if (!servedIndex) {
      sendHtml(
        res,
        200,
        buildFallbackStatusHtml(getServerInfo(isExternalRequest(req))),
        headOnly
      );
    }
  }

  async function readJsonObject(
    req: IncomingMessage,
    allowEmpty = false
  ): Promise<Record<string, unknown>> {
    const rawBody = await readRequestBody(req, 64 * 1024);
    const text = rawBody.toString("utf8").trim();
    if (!text) {
      if (allowEmpty) return {};
      throw new HttpError(400, "Empty JSON request body");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, "Expected JSON object body");
    }
    return parsed as Record<string, unknown>;
  }

  async function handlePostSnapshot(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    let imageBuffer: Buffer;
    let lensLabel: string | null = null;

    if (contentType.includes("application/json")) {
      const maxJsonBytes = Math.ceil(config.maxSnapshotBytes * 1.4) + 8192;
      const rawBody = await readRequestBody(req, maxJsonBytes);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new HttpError(400, "Invalid JSON body");
      }
      if (typeof parsed.imageBase64 !== "string") {
        throw new HttpError(400, "Missing string field 'imageBase64'");
      }
      imageBuffer = decodeBase64Image(parsed.imageBase64);
      if (imageBuffer.length > config.maxSnapshotBytes) {
        throw new HttpError(
          413,
          `Snapshot exceeds limit of ${config.maxSnapshotBytes} bytes`
        );
      }
      lensLabel =
        typeof parsed.lensLabel === "string" && parsed.lensLabel.trim()
          ? parsed.lensLabel.trim()
          : decodeHeaderValue(req.headers["x-lens-label"]);
    } else if (
      contentType.includes("image/jpeg") ||
      contentType.includes("image/jpg") ||
      contentType.includes("application/octet-stream") ||
      !contentType
    ) {
      imageBuffer = await readRequestBody(req, config.maxSnapshotBytes);
      if (imageBuffer.length === 0) {
        throw new HttpError(400, "Empty image body");
      }
      lensLabel = decodeHeaderValue(req.headers["x-lens-label"]);
    } else {
      throw new HttpError(
        415,
        "Unsupported Content-Type; use 'image/jpeg' or 'application/json'"
      );
    }

    if (!isValidJpegBuffer(imageBuffer)) {
      throw new HttpError(
        400,
        "Invalid JPEG image data (missing JPEG magic bytes)"
      );
    }

    const meta = await storage.saveSnapshot({
      buffer: imageBuffer,
      lensLabel,
    });
    logBuffer.append(
      `[Storage] Snapshot saved: ${meta.filename} (${meta.sizeBytes} bytes)`
    );
    signaling.broadcastSnapshotSaved(meta);
    sendJson(res, 201, meta);
  }

  return async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    setSecurityHeaders(res);

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      setCorsHeaders(res, false);
      sendJson(res, 400, { error: "Malformed request URL" });
      return;
    }

    const pathname = url.pathname;
    const adminRoute = isAdminPath(pathname);
    setCorsHeaders(res, adminRoute);

    const method = (req.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      // Public server discovery & health endpoints (never leak token or TURN credentials)
      if (pathname === "/api/info" && (method === "GET" || method === "HEAD")) {
        const info = getServerInfo(isExternalRequest(req));
        if (method === "HEAD") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end();
          return;
        }
        sendJson(res, 200, info);
        return;
      }

      if (pathname === "/api/health" && method === "GET") {
        sendJson(res, 200, {
          ok: true,
          cameraOnline: signaling.isCameraOnline(),
          viewerCount: signaling.getViewerCount(),
          remoteStatus: tunnel.getStatus().status,
          uptimeSec: Math.floor(process.uptime()),
        });
        return;
      }

      // Strict local-only gate for admin endpoints (/api/remote/* and /api/system/*)
      // Always returns 403 Forbidden on ANY proxied/external request, even with a valid viewer token!
      if (adminRoute && isExternalRequest(req)) {
        sendJson(res, 403, {
          error: "Admin endpoints are restricted to local network access only",
        });
        return;
      }

      // Auth & rate-limit gate for all protected API and snapshot media endpoints
      const isApiRoute = pathname.startsWith("/api/");
      const isSnapshotFileRoute = pathname.startsWith("/snapshots/");

      if (isApiRoute || isSnapshotFileRoute) {
        const authStatus = checkRequestAuth(req, url);
        if (authStatus === "rate_limited") {
          const retryAfter = rateLimiter.getRetryAfterSec(extractClientIp(req));
          if (retryAfter > 0) {
            res.setHeader("Retry-After", String(retryAfter));
          }
          sendJson(res, 429, {
            error: "Too many failed authentication attempts",
          });
          return;
        }
        if (authStatus === "unauthorized") {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
      }

      // --- Remote Access Config & Tunnel Management (Local or Authenticated Admin Only) ---

      if (pathname === "/api/remote/config" && method === "GET") {
        sendJson(res, 200, buildRemoteConfigResponse());
        return;
      }

      if (pathname === "/api/remote/config" && method === "PUT") {
        const body = await readJsonObject(req, false);
        try {
          const patch: Partial<PersistedConfig> = {};
          if ("token" in body) patch.token = body.token as string;
          if ("customRemoteUrl" in body) {
            patch.customRemoteUrl = body.customRemoteUrl as string | null;
          }
          if ("autoStartTunnel" in body) {
            patch.autoStartTunnel = body.autoStartTunnel as boolean;
          }
          if ("iceServers" in body) {
            patch.iceServers = body.iceServers as PersistedConfig["iceServers"];
          }

          await configStore.updateConfig(patch);

          if ("token" in patch) {
            void tunnel.republishBeacon();
          }

          if (
            "customRemoteUrl" in patch &&
            !patch.customRemoteUrl &&
            tunnel.getStatus().provider === "custom"
          ) {
            await tunnel.stop();
          }
        } catch (err) {
          throw new HttpError(
            400,
            err instanceof Error ? err.message : "Invalid remote configuration"
          );
        }

        sendJson(res, 200, buildRemoteConfigResponse());
        return;
      }

      if (pathname === "/api/remote/start" && method === "POST") {
        const body = await readJsonObject(req, true);
        const rawProvider = body.provider;
        const provider =
          rawProvider === undefined || rawProvider === null || rawProvider === ""
            ? "auto"
            : rawProvider;

        if (
          provider !== "auto" &&
          provider !== "localhost.run" &&
          provider !== "pinggy" &&
          provider !== "cloudflare" &&
          provider !== "custom" &&
          provider !== "tailscale"
        ) {
          throw new HttpError(
            400,
            "provider must be 'auto', 'localhost.run', 'pinggy', 'cloudflare', 'custom', or 'tailscale'"
          );
        }

        const customUrl =
          typeof body.customUrl === "string" ? body.customUrl : undefined;

        try {
          const remote = await tunnel.start({ provider, customUrl });
          sendJson(res, 200, {
            remote,
            token: configStore.getEffectiveToken(),
            pairingLink: buildCurrentPairingLink(),
          });
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Failed to start remote access";
          const isBadInput =
            provider === "custom" && /url|required/i.test(msg);
          sendJson(res, isBadInput ? 400 : 502, {
            error: msg,
            remote: tunnel.getStatus(),
          });
        }
        return;
      }

      if (pathname === "/api/remote/stop" && method === "POST") {
        const remote = await tunnel.stop();
        logBuffer.append("[Tunnel] Remote tunnel stopped.");
        sendJson(res, 200, { remote });
        return;
      }

      // --- PC System Endpoints (ADB Reverse & Live Server Logs) ---

      if (pathname === "/api/system/adb-reverse" && method === "POST") {
        const result = await runAdbReverse(getPort(), logBuffer);
        sendJson(res, 200, result);
        return;
      }

      if (pathname === "/api/system/logs" && method === "GET") {
        const rawLimit = url.searchParams.get("limit");
        const parsedLimit = rawLimit ? Number(rawLimit) : 120;
        const limit =
          Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 120;
        sendJson(res, 200, {
          lines: logBuffer.getLines(limit),
        });
        return;
      }

      // --- Telemetry & Snapshots ---

      if (pathname === "/api/telemetry/history" && method === "GET") {
        const rawLimit = url.searchParams.get("limit");
        const parsedLimit = rawLimit ? Number(rawLimit) : 120;
        const limit =
          Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 120;
        sendJson(res, 200, {
          items: storage.getTelemetryHistory(limit),
        });
        return;
      }

      if (pathname === "/api/snapshots" && method === "GET") {
        sendJson(res, 200, {
          items: storage.listSnapshots(),
        });
        return;
      }

      if (pathname === "/api/snapshots" && method === "POST") {
        await handlePostSnapshot(req, res);
        return;
      }

      if (pathname.startsWith("/api/snapshots/") && method === "DELETE") {
        const rawId = pathname.slice("/api/snapshots/".length);
        let id: string;
        try {
          id = decodeURIComponent(rawId);
        } catch {
          sendJson(res, 400, { error: "Invalid snapshot ID" });
          return;
        }
        if (!id || id.includes("/") || id.includes("\\")) {
          sendJson(res, 400, { error: "Invalid snapshot ID" });
          return;
        }
        const removed = await storage.deleteSnapshot(id);
        if (!removed) {
          sendJson(res, 404, { error: "Snapshot not found" });
          return;
        }
        sendJson(res, 200, { deleted: true, id: removed.id });
        return;
      }

      if (isSnapshotFileRoute && (method === "GET" || method === "HEAD")) {
        const rawFilename = pathname.slice("/snapshots/".length);
        let filename: string;
        try {
          filename = decodeURIComponent(rawFilename);
        } catch {
          sendJson(res, 400, { error: "Invalid filename encoding" });
          return;
        }

        const resolved = storage.resolveSnapshotPath(filename);
        if (!resolved) {
          sendJson(res, 400, { error: "Invalid snapshot filename" });
          return;
        }

        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        res.setHeader("X-Content-Type-Options", "nosniff");

        const served = await serveStaticFile(
          resolved,
          res,
          method === "HEAD",
          "public, max-age=31536000, immutable"
        );
        if (!served) {
          sendJson(res, 404, { error: "Snapshot not found" });
        }
        return;
      }

      // Unknown /api/* or /snapshots/* routes never fall back to SPA
      if (isApiRoute || isSnapshotFileRoute) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (method === "GET" || method === "HEAD") {
        await handleStatic(pathname, req, res, method === "HEAD");
        return;
      }

      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.statusCode, { error: err.message });
        return;
      }
      console.error("[http] Unhandled request error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  };
}
