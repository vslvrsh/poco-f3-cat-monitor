import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { extractClientIp, isExternalRequest } from "./network.js";
import {
  type AuthRateLimiter,
  constantTimeTokenEqual,
} from "./security.js";
import type { PurrCamStorage } from "./storage.js";
import type {
  CameraCapabilities,
  CameraState,
  CameraStatusMessage,
  CameraSummary,
  CommandAckMessage,
  CommandMessage,
  IceServerConfig,
  LensInfo,
  RemoteStatus,
  SnapshotMeta,
  StateUpdateMessage,
  Telemetry,
  TelemetryMessage,
  ViewerClientType,
  ViewerRegisterMessage,
  CameraRegisterMessage,
} from "./types.js";

const DEFAULT_CAPABILITIES: CameraCapabilities = {
  torch: false,
  audioIn: true,
  audioOut: false,
  root: false,
  chargeLimit: false,
};

interface PeerMeta {
  ws: WebSocket;
  role: "camera" | "viewer" | null;
  id: string | null;
  isAlive: boolean;
  lastSeen: number;
  connectedAt: number;
  isExternal: boolean;
  clientIp: string;
  urlToken?: string;
  registerTimer?: NodeJS.Timeout;
  replaced?: boolean;
}

interface CameraPeer extends PeerMeta {
  role: "camera";
  id: string;
  deviceId: string;
  deviceName: string;
  lenses: LensInfo[];
  capabilities: CameraCapabilities;
  state: CameraState;
  telemetry: Telemetry | null;
}

interface ViewerPeer extends PeerMeta {
  role: "viewer";
  id: string;
  clientName: string;
  clientType: ViewerClientType;
}

interface PendingCommand {
  commandId: string;
  viewerId: string;
  action: string;
  createdAt: number;
  timeout: NodeJS.Timeout;
}

export interface SignalingHubOptions {
  getToken: () => string;
  isStrictGlobalToken: () => boolean;
  getIceServers: () => IceServerConfig[];
  storage: PurrCamStorage;
  rateLimiter: AuthRateLimiter;
  onLog?: (msg: string) => void;
  heartbeatIntervalMs?: number;
  registerTimeoutMs?: number;
  commandTimeoutMs?: number;
}

function safeSend(ws: WebSocket, payload: unknown): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function normalizeCapabilities(
  caps?: Partial<CameraCapabilities>
): CameraCapabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    ...(caps ?? {}),
    torch: Boolean(caps?.torch ?? DEFAULT_CAPABILITIES.torch),
    audioIn: Boolean(caps?.audioIn ?? DEFAULT_CAPABILITIES.audioIn),
    audioOut: Boolean(caps?.audioOut ?? DEFAULT_CAPABILITIES.audioOut),
    root: Boolean(caps?.root ?? DEFAULT_CAPABILITIES.root),
    chargeLimit: Boolean(caps?.chargeLimit ?? DEFAULT_CAPABILITIES.chargeLimit),
  };
}

export class SignalingHub {
  readonly wss: WebSocketServer;
  private readonly getToken: () => string;
  private readonly isStrictGlobalToken: () => boolean;
  private readonly getIceServers: () => IceServerConfig[];
  private readonly storage: PurrCamStorage;
  private readonly rateLimiter: AuthRateLimiter;
  private readonly onLog?: (msg: string) => void;
  private readonly heartbeatIntervalMs: number;
  private readonly registerTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  private readonly peers = new Map<WebSocket, PeerMeta>();
  private camera: CameraPeer | null = null;
  private readonly viewers = new Map<string, ViewerPeer>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: SignalingHubOptions) {
    this.getToken = options.getToken;
    this.isStrictGlobalToken = options.isStrictGlobalToken;
    this.getIceServers = options.getIceServers;
    this.storage = options.storage;
    this.rateLimiter = options.rateLimiter;
    this.onLog = options.onLog;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.registerTimeoutMs = options.registerTimeoutMs ?? 15_000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeatSweep();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  isCameraOnline(): boolean {
    return this.camera !== null && this.camera.ws.readyState === WebSocket.OPEN;
  }

  getViewerCount(): number {
    return this.viewers.size;
  }

  getCameraSummary(): CameraSummary | null {
    if (!this.camera) return null;
    return {
      deviceId: this.camera.deviceId,
      deviceName: this.camera.deviceName,
      lenses: this.camera.lenses,
      capabilities: this.camera.capabilities,
      state: this.camera.state,
      telemetry: this.camera.telemetry,
    };
  }

  buildCameraStatusMessage(): CameraStatusMessage {
    return {
      type: "camera_status",
      online: this.isCameraOnline(),
      camera: this.getCameraSummary(),
      viewerCount: this.viewers.size,
    };
  }

  broadcastSnapshotSaved(snapshot: SnapshotMeta): void {
    this.broadcastToViewers({
      type: "snapshot_saved",
      snapshot,
    });
  }

  broadcastRemoteStatus(remote: RemoteStatus): void {
    this.broadcastToViewers({
      type: "remote_status",
      remote,
    });
  }

  close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingCommands.clear();

    for (const peer of this.peers.values()) {
      if (peer.registerTimer) clearTimeout(peer.registerTimer);
      try {
        peer.ws.terminate();
      } catch {
        // ignore
      }
    }
    this.peers.clear();
    this.viewers.clear();
    this.camera = null;

    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    let urlToken: string | undefined;
    try {
      const url = new URL(req.url ?? "/ws", "http://localhost");
      urlToken = url.searchParams.get("token") ?? undefined;
    } catch {
      urlToken = undefined;
    }

    const now = Date.now();
    const peer: PeerMeta = {
      ws,
      role: null,
      id: null,
      isAlive: true,
      lastSeen: now,
      connectedAt: now,
      isExternal: isExternalRequest(req),
      clientIp: extractClientIp(req),
      urlToken,
    };

    peer.registerTimer = setTimeout(() => {
      if (!peer.role && ws.readyState === WebSocket.OPEN) {
        safeSend(ws, {
          type: "error",
          code: "REGISTER_TIMEOUT",
          message: "Client did not register in time",
        });
        ws.close(4002, "Registration timeout");
      }
    }, this.registerTimeoutMs);
    peer.registerTimer.unref();

    this.peers.set(ws, peer);

    ws.on("pong", () => {
      peer.isAlive = true;
      peer.lastSeen = Date.now();
    });

    ws.on("message", (raw) => {
      peer.isAlive = true;
      peer.lastSeen = Date.now();
      this.handleRawMessage(peer, raw);
    });

    ws.on("close", () => {
      this.handleDisconnect(peer);
    });

    ws.on("error", () => {
      // 'close' event will follow and clean up the peer
    });
  }

  private handleRawMessage(peer: PeerMeta, raw: WebSocket.RawData): void {
    let parsed: Record<string, unknown>;
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const json = JSON.parse(text);
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        throw new Error("Expected JSON object");
      }
      parsed = json as Record<string, unknown>;
    } catch {
      safeSend(peer.ws, {
        type: "error",
        code: "BAD_MESSAGE",
        message: "Malformed JSON message",
      });
      return;
    }

    const type = parsed.type;
    if (typeof type !== "string") {
      safeSend(peer.ws, {
        type: "error",
        code: "BAD_MESSAGE",
        message: "Missing string field 'type'",
      });
      return;
    }

    // Heartbeat messages are allowed at any time
    if (type === "ping") {
      const ts = typeof parsed.ts === "number" ? parsed.ts : Date.now();
      safeSend(peer.ws, { type: "pong", ts });
      return;
    }
    if (type === "pong") {
      return;
    }

    if (type === "register") {
      this.handleRegister(peer, parsed);
      return;
    }

    if (!peer.role || !peer.id) {
      safeSend(peer.ws, {
        type: "error",
        code: "NOT_REGISTERED",
        message: "Must send 'register' before other messages",
      });
      return;
    }

    switch (type) {
      case "watch_request":
        this.handleWatchRequest(peer, parsed);
        break;
      case "watch_stop":
        this.handleWatchStop(peer);
        break;
      case "rtc_offer":
        this.handleRtcOffer(peer, parsed);
        break;
      case "rtc_answer":
        this.handleRtcAnswer(peer, parsed);
        break;
      case "rtc_ice":
        this.handleRtcIce(peer, parsed);
        break;
      case "telemetry":
        this.handleTelemetry(peer, parsed as unknown as TelemetryMessage);
        break;
      case "state_update":
        this.handleStateUpdate(peer, parsed as unknown as StateUpdateMessage);
        break;
      case "command":
        this.handleCommand(peer, parsed as unknown as CommandMessage);
        break;
      case "command_ack":
        this.handleCommandAck(peer, parsed as unknown as CommandAckMessage);
        break;
      default:
        safeSend(peer.ws, {
          type: "error",
          code: "UNKNOWN_TYPE",
          message: `Unknown message type '${type}'`,
        });
    }
  }

  private handleRegister(peer: PeerMeta, msg: Record<string, unknown>): void {
    const activeToken = this.getToken();
    const mustAuth = peer.isExternal || this.isStrictGlobalToken();
    const providedToken =
      typeof msg.token === "string" && msg.token.length > 0
        ? msg.token
        : peer.urlToken;

    if (mustAuth) {
      if (this.rateLimiter.isRateLimited(peer.clientIp)) {
        safeSend(peer.ws, {
          type: "error",
          code: "RATE_LIMITED",
          message: "Too many failed authentication attempts",
        });
        peer.ws.close(4029, "Too Many Requests");
        return;
      }

      if (!constantTimeTokenEqual(providedToken, activeToken)) {
        const nowLimited = this.rateLimiter.recordFailure(peer.clientIp);
        if (nowLimited) {
          safeSend(peer.ws, {
            type: "error",
            code: "RATE_LIMITED",
            message: "Too many failed authentication attempts",
          });
          peer.ws.close(4029, "Too Many Requests");
          return;
        }
        safeSend(peer.ws, {
          type: "error",
          code: "UNAUTHORIZED",
          message: "Invalid token",
        });
        peer.ws.close(4001, "Unauthorized");
        return;
      }

      this.rateLimiter.reset(peer.clientIp);
    }

    const role = msg.role;
    if (role !== "camera" && role !== "viewer") {
      safeSend(peer.ws, {
        type: "error",
        code: "BAD_MESSAGE",
        message: "Role must be 'camera' or 'viewer'",
      });
      return;
    }

    if (peer.registerTimer) {
      clearTimeout(peer.registerTimer);
      peer.registerTimer = undefined;
    }

    if (role === "camera") {
      this.registerCamera(peer, msg as unknown as CameraRegisterMessage);
    } else {
      this.registerViewer(peer, msg as unknown as ViewerRegisterMessage);
    }
  }

  private registerCamera(peer: PeerMeta, msg: CameraRegisterMessage): void {
    // If this socket was previously registered as a viewer, detach it
    if (peer.role === "viewer" && peer.id) {
      this.viewers.delete(peer.id);
    }

    // Replace existing camera connection gracefully
    if (this.camera && this.camera.ws !== peer.ws) {
      const oldCamera = this.camera;
      oldCamera.replaced = true;
      this.failPendingCommands("Camera reconnected");
      try {
        oldCamera.ws.close(4000, "Replaced by new camera connection");
      } catch {
        // ignore
      }
    }

    const deviceId =
      typeof msg.deviceId === "string" && msg.deviceId.trim()
        ? msg.deviceId.trim()
        : `camera-${crypto.randomBytes(4).toString("hex")}`;
    const deviceName =
      typeof msg.deviceName === "string" && msg.deviceName.trim()
        ? msg.deviceName.trim()
        : "PurrCam Camera";
    const lenses = Array.isArray(msg.lenses) ? msg.lenses : [];
    const capabilities = normalizeCapabilities(msg.capabilities);
    const state: CameraState =
      msg.state && typeof msg.state === "object" ? { ...msg.state } : {};

    let telemetry: Telemetry | null = null;
    if (msg.telemetry && typeof msg.telemetry === "object") {
      telemetry = this.storage.addTelemetry(msg.telemetry);
    }

    const cameraPeer: CameraPeer = Object.assign(peer, {
      role: "camera" as const,
      id: deviceId,
      deviceId,
      deviceName,
      lenses,
      capabilities,
      state,
      telemetry,
    });

    this.camera = cameraPeer;
    this.onLog?.(
      `[Signaling] Camera connected: ${deviceName} (${deviceId}, ${lenses.length} lenses)`
    );

    safeSend(cameraPeer.ws, {
      type: "registered",
      id: cameraPeer.id,
      serverTime: Date.now(),
      iceServers: this.getIceServers(),
    });

    // Notify camera about viewers already connected
    for (const viewer of this.viewers.values()) {
      safeSend(cameraPeer.ws, {
        type: "viewer_joined",
        viewerId: viewer.id,
        clientName: viewer.clientName,
        clientType: viewer.clientType,
      });
    }

    this.broadcastCameraStatus();
  }

  private registerViewer(peer: PeerMeta, msg: ViewerRegisterMessage): void {
    // If this socket was somehow previously registered, clean up old viewer id
    if (peer.role === "viewer" && peer.id && this.viewers.get(peer.id) === peer) {
      this.viewers.delete(peer.id);
    }

    const requestedId =
      typeof msg.clientId === "string" && msg.clientId.trim()
        ? msg.clientId.trim()
        : `viewer-${crypto.randomBytes(4).toString("hex")}`;

    let viewerId = requestedId;
    if (this.viewers.has(viewerId)) {
      viewerId = `${requestedId}-${crypto.randomBytes(3).toString("hex")}`;
    }

    const clientName =
      typeof msg.clientName === "string" && msg.clientName.trim()
        ? msg.clientName.trim()
        : "Monitor";
    const clientType: ViewerClientType =
      msg.clientType === "android" ? "android" : "web";

    const viewerPeer: ViewerPeer = Object.assign(peer, {
      role: "viewer" as const,
      id: viewerId,
      clientName,
      clientType,
    });

    this.viewers.set(viewerId, viewerPeer);
    this.onLog?.(
      `[Signaling] Viewer connected: ${clientName} (${clientType}, id=${viewerId})`
    );

    safeSend(viewerPeer.ws, {
      type: "registered",
      id: viewerId,
      serverTime: Date.now(),
      iceServers: this.getIceServers(),
    });

    // Immediately send camera status to newly registered viewer
    safeSend(viewerPeer.ws, this.buildCameraStatusMessage());

    // Notify camera of the newly joined viewer
    if (this.camera && this.camera.ws.readyState === WebSocket.OPEN) {
      safeSend(this.camera.ws, {
        type: "viewer_joined",
        viewerId,
        clientName,
        clientType,
      });
    }
  }

  private handleWatchRequest(
    peer: PeerMeta,
    msg: Record<string, unknown>
  ): void {
    if (peer.role !== "viewer" || !peer.id) {
      safeSend(peer.ws, {
        type: "error",
        code: "forbidden",
        message: "Only viewers can send watch_request",
      });
      return;
    }

    if (!this.camera || this.camera.ws.readyState !== WebSocket.OPEN) {
      safeSend(peer.ws, {
        type: "error",
        code: "camera_offline",
        message: "Camera is currently offline",
      });
      return;
    }

    safeSend(this.camera.ws, {
      ...msg,
      type: "watch_request",
      viewerId: peer.id,
    });
  }

  private handleWatchStop(peer: PeerMeta): void {
    if (peer.role !== "viewer" || !peer.id) return;
    if (this.camera && this.camera.ws.readyState === WebSocket.OPEN) {
      safeSend(this.camera.ws, {
        type: "watch_stop",
        viewerId: peer.id,
      });
    }
  }

  private handleRtcOffer(peer: PeerMeta, msg: Record<string, unknown>): void {
    if (msg.sdp === undefined) {
      safeSend(peer.ws, {
        type: "error",
        code: "invalid_message",
        message: "rtc_offer requires 'sdp'",
      });
      return;
    }

    if (peer.role === "camera") {
      const targetId = typeof msg.viewerId === "string" ? msg.viewerId : "";
      const viewer = this.viewers.get(targetId);
      if (!viewer) {
        safeSend(peer.ws, {
          type: "error",
          code: "viewer_not_found",
          message: `Viewer '${targetId}' is not connected`,
        });
        return;
      }
      safeSend(viewer.ws, {
        type: "rtc_offer",
        viewerId: viewer.id,
        sdp: msg.sdp,
      });
    } else if (peer.role === "viewer" && peer.id) {
      if (!this.camera) return;
      safeSend(this.camera.ws, {
        type: "rtc_offer",
        viewerId: peer.id,
        sdp: msg.sdp,
      });
    }
  }

  private handleRtcAnswer(peer: PeerMeta, msg: Record<string, unknown>): void {
    if (msg.sdp === undefined) {
      safeSend(peer.ws, {
        type: "error",
        code: "invalid_message",
        message: "rtc_answer requires 'sdp'",
      });
      return;
    }

    if (peer.role === "viewer" && peer.id) {
      if (!this.camera || this.camera.ws.readyState !== WebSocket.OPEN) {
        safeSend(peer.ws, {
          type: "error",
          code: "camera_offline",
          message: "Camera is currently offline",
        });
        return;
      }
      safeSend(this.camera.ws, {
        type: "rtc_answer",
        viewerId: peer.id,
        sdp: msg.sdp,
      });
    } else if (peer.role === "camera") {
      const targetId = typeof msg.viewerId === "string" ? msg.viewerId : "";
      const viewer = this.viewers.get(targetId);
      if (!viewer) return;
      safeSend(viewer.ws, {
        type: "rtc_answer",
        viewerId: viewer.id,
        sdp: msg.sdp,
      });
    }
  }

  private handleRtcIce(peer: PeerMeta, msg: Record<string, unknown>): void {
    if (msg.candidate === undefined) {
      safeSend(peer.ws, {
        type: "error",
        code: "invalid_message",
        message: "rtc_ice requires 'candidate'",
      });
      return;
    }

    if (peer.role === "camera") {
      const targetId = typeof msg.viewerId === "string" ? msg.viewerId : "";
      const viewer = this.viewers.get(targetId);
      if (!viewer) return;
      safeSend(viewer.ws, {
        type: "rtc_ice",
        viewerId: viewer.id,
        candidate: msg.candidate,
      });
    } else if (peer.role === "viewer" && peer.id) {
      if (!this.camera || this.camera.ws.readyState !== WebSocket.OPEN) return;
      safeSend(this.camera.ws, {
        type: "rtc_ice",
        viewerId: peer.id,
        candidate: msg.candidate,
      });
    }
  }

  private handleTelemetry(peer: PeerMeta, msg: TelemetryMessage): void {
    if (peer.role !== "camera" || this.camera?.ws !== peer.ws) {
      safeSend(peer.ws, {
        type: "error",
        code: "forbidden",
        message: "Only the active camera can send telemetry",
      });
      return;
    }

    const rawData =
      msg.data && typeof msg.data === "object"
        ? msg.data
        : (msg as unknown as Telemetry);
    const saved = this.storage.addTelemetry(rawData);
    this.camera.telemetry = saved;

    this.broadcastToViewers({
      type: "telemetry",
      data: saved,
    });
  }

  private handleStateUpdate(peer: PeerMeta, msg: StateUpdateMessage): void {
    if (peer.role !== "camera" || this.camera?.ws !== peer.ws) {
      safeSend(peer.ws, {
        type: "error",
        code: "forbidden",
        message: "Only the active camera can send state_update",
      });
      return;
    }

    if (msg.state && typeof msg.state === "object") {
      this.camera.state = {
        ...this.camera.state,
        ...msg.state,
      };
    }

    let lensesUpdated = false;
    if (Array.isArray(msg.lenses)) {
      this.camera.lenses = msg.lenses;
      lensesUpdated = true;
    }

    this.broadcastToViewers({
      type: "state_update",
      state: this.camera.state,
      ...(lensesUpdated ? { lenses: this.camera.lenses } : {}),
    });

    this.broadcastCameraStatus();
  }

  private handleCommand(peer: PeerMeta, msg: CommandMessage): void {
    if (peer.role !== "viewer" || !peer.id) {
      safeSend(peer.ws, {
        type: "error",
        code: "forbidden",
        message: "Only viewers can send commands",
      });
      return;
    }

    const action = typeof msg.action === "string" ? msg.action.trim() : "";
    const commandId =
      typeof msg.commandId === "string" && msg.commandId.trim()
        ? msg.commandId.trim()
        : `cmd-${crypto.randomBytes(6).toString("hex")}`;

    if (!action) {
      safeSend(peer.ws, {
        type: "command_ack",
        commandId,
        ok: false,
        error: "Missing command action",
      });
      return;
    }

    if (!this.camera || this.camera.ws.readyState !== WebSocket.OPEN) {
      safeSend(peer.ws, {
        type: "command_ack",
        commandId,
        ok: false,
        error: "Camera offline",
      });
      return;
    }

    const existing = this.pendingCommands.get(commandId);
    if (existing) clearTimeout(existing.timeout);

    const viewerId = peer.id;
    const timeout = setTimeout(() => {
      const pending = this.pendingCommands.get(commandId);
      if (!pending) return;
      this.pendingCommands.delete(commandId);
      const viewer = this.viewers.get(pending.viewerId);
      if (viewer) {
        safeSend(viewer.ws, {
          type: "command_ack",
          commandId,
          ok: false,
          error: "Command timed out waiting for camera acknowledgement",
        });
      }
    }, this.commandTimeoutMs);
    timeout.unref();

    this.pendingCommands.set(commandId, {
      commandId,
      viewerId,
      action,
      createdAt: Date.now(),
      timeout,
    });

    safeSend(this.camera.ws, {
      type: "command",
      commandId,
      action,
      payload:
        msg.payload && typeof msg.payload === "object" ? msg.payload : {},
    });
  }

  private handleCommandAck(peer: PeerMeta, msg: CommandAckMessage): void {
    if (peer.role !== "camera" || this.camera?.ws !== peer.ws) {
      safeSend(peer.ws, {
        type: "error",
        code: "forbidden",
        message: "Only the active camera can send command_ack",
      });
      return;
    }

    const commandId = typeof msg.commandId === "string" ? msg.commandId : "";
    const pending = commandId ? this.pendingCommands.get(commandId) : undefined;
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingCommands.delete(commandId);
    }

    const hasState = msg.state && typeof msg.state === "object";
    if (hasState) {
      this.camera.state = {
        ...this.camera.state,
        ...msg.state,
      };
    }

    const ok = Boolean(msg.ok);
    const ackPayload: CommandAckMessage = {
      type: "command_ack",
      commandId,
      ok,
      error: ok
        ? null
        : typeof msg.error === "string" && msg.error
          ? msg.error
          : "Command failed",
      ...(hasState ? { state: this.camera.state } : {}),
    };

    if (pending) {
      const targetViewer = this.viewers.get(pending.viewerId);
      if (targetViewer) {
        safeSend(targetViewer.ws, ackPayload);
      }
    } else {
      // Unsolicited or timed-out ack — broadcast so interested viewers can see it
      this.broadcastToViewers(ackPayload);
    }

    if (hasState) {
      this.broadcastToViewers({
        type: "state_update",
        state: this.camera.state,
      });
      this.broadcastCameraStatus();
    }
  }

  private handleDisconnect(peer: PeerMeta): void {
    if (peer.registerTimer) {
      clearTimeout(peer.registerTimer);
      peer.registerTimer = undefined;
    }
    this.peers.delete(peer.ws);

    if (peer.role === "camera") {
      if (!peer.replaced && this.camera?.ws === peer.ws) {
        this.onLog?.(`[Signaling] Camera disconnected (${peer.id})`);
        this.camera = null;
        this.failPendingCommands("Camera disconnected");
        this.broadcastCameraStatus();
      }
      return;
    }

    if (peer.role === "viewer" && peer.id) {
      const current = this.viewers.get(peer.id);
      if (current && current.ws === peer.ws) {
        this.viewers.delete(peer.id);
        this.onLog?.(`[Signaling] Viewer disconnected (${peer.id})`);
        for (const [cmdId, pending] of this.pendingCommands.entries()) {
          if (pending.viewerId === peer.id) {
            clearTimeout(pending.timeout);
            this.pendingCommands.delete(cmdId);
          }
        }
        if (this.camera && this.camera.ws.readyState === WebSocket.OPEN) {
          safeSend(this.camera.ws, {
            type: "viewer_left",
            viewerId: peer.id,
          });
        }
      }
    }
  }

  private failPendingCommands(reason: string): void {
    for (const [cmdId, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timeout);
      const viewer = this.viewers.get(pending.viewerId);
      if (viewer) {
        safeSend(viewer.ws, {
          type: "command_ack",
          commandId: cmdId,
          ok: false,
          error: reason,
        });
      }
    }
    this.pendingCommands.clear();
  }

  private broadcastCameraStatus(): void {
    this.broadcastToViewers(this.buildCameraStatusMessage());
  }

  private broadcastToViewers(payload: unknown): void {
    for (const viewer of this.viewers.values()) {
      safeSend(viewer.ws, payload);
    }
  }

  private runHeartbeatSweep(): void {
    for (const [ws, peer] of this.peers.entries()) {
      if (!peer.isAlive) {
        ws.terminate();
        continue;
      }
      peer.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }
}
