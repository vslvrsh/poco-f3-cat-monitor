import crypto from "node:crypto";
import type { BeaconStatus } from "./types.js";

export const DEFAULT_BEACON_ENDPOINTS = [
  "https://ntfy.sh",
  "https://ntfy.envs.net",
] as const;

export interface BeaconPlaintext {
  v: 1;
  url: string;
  wsUrl: string;
  provider: string;
  ts: number;
}

export interface BeaconEnvelope {
  v: 1;
  iv: string;
  ct: string;
}

/**
 * Derives the deterministic 40-char ntfy topic ID from the access token:
 *   "purrcam-" + hex(SHA-256(utf8("purrcam:beacon:topic:v1:" + token))).slice(0, 32)
 */
export function deriveBeaconTopicId(token: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`purrcam:beacon:topic:v1:${token}`, "utf8")
    .digest("hex");
  return `purrcam-${digest.slice(0, 32)}`;
}

/**
 * Derives the 32-byte AES-256-GCM key from the access token:
 *   SHA-256(utf8("purrcam:beacon:aes256:v1:" + token))
 */
export function deriveBeaconKey(token: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`purrcam:beacon:aes256:v1:${token}`, "utf8")
    .digest();
}

/**
 * Encrypts a BeaconPlaintext payload with AES-256-GCM (12-byte IV, no AAD,
 * standard Base64 ciphertext || 16-byte GCM auth tag) matching Protocol v1.2 §8.
 */
export function encryptBeaconPayload(
  token: string,
  payload: BeaconPlaintext,
  ivOverride?: Buffer
): BeaconEnvelope {
  if (!token) {
    throw new Error("Cannot encrypt beacon payload without an access token");
  }
  const iv = ivOverride ?? crypto.randomBytes(12);
  if (iv.length !== 12) {
    throw new Error("AES-256-GCM IV must be exactly 12 bytes");
  }
  const key = deriveBeaconKey(token);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([encrypted, tag]);

  return {
    v: 1,
    iv: iv.toString("base64"),
    ct: combined.toString("base64"),
  };
}

/**
 * Decrypts and validates a Protocol v1.2 §8 AES-256-GCM beacon envelope.
 * Returns null if decryption fails, auth tag is invalid, or URLs are unsafe.
 */
export function decryptBeaconPayload(
  token: string,
  input: string | BeaconEnvelope
): BeaconPlaintext | null {
  if (!token) return null;
  try {
    const env =
      typeof input === "string"
        ? (JSON.parse(input) as Partial<BeaconEnvelope>)
        : input;
    if (
      !env ||
      env.v !== 1 ||
      typeof env.iv !== "string" ||
      typeof env.ct !== "string"
    ) {
      return null;
    }

    const iv = Buffer.from(env.iv, "base64");
    const combined = Buffer.from(env.ct, "base64");
    if (iv.length !== 12 || combined.length < 17) {
      return null;
    }

    const ciphertext = combined.subarray(0, combined.length - 16);
    const tag = combined.subarray(combined.length - 16);
    const key = deriveBeaconKey(token);

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintextBuf = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const parsed = JSON.parse(
      plaintextBuf.toString("utf8")
    ) as Partial<BeaconPlaintext>;

    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.url !== "string" ||
      typeof parsed.wsUrl !== "string" ||
      typeof parsed.provider !== "string" ||
      typeof parsed.ts !== "number" ||
      !Number.isFinite(parsed.ts) ||
      !parsed.url.startsWith("https://") ||
      !parsed.wsUrl.startsWith("wss://")
    ) {
      return null;
    }

    return {
      v: 1,
      url: parsed.url,
      wsUrl: parsed.wsUrl,
      provider: parsed.provider,
      ts: parsed.ts,
    };
  } catch {
    return null;
  }
}

/**
 * Polls ntfy JSON endpoints for a given token, decrypts all valid beacon messages,
 * and returns the newest valid record (highest ts), or null if none found.
 */
export async function pollBeaconEndpoints(
  token: string,
  endpoints: readonly string[] = DEFAULT_BEACON_ENDPOINTS,
  timeoutMs = 8000
): Promise<BeaconPlaintext | null> {
  if (!token) return null;
  const topicId = deriveBeaconTopicId(token);

  const results = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const base = ep.replace(/\/+$/, "");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      try {
        const resp = await fetch(`${base}/${topicId}/json?poll=1&since=all`, {
          signal: controller.signal,
          headers: { "User-Agent": "PurrCam-Beacon/1.1" },
        });
        if (!resp.ok) return [] as BeaconPlaintext[];
        const text = await resp.text();
        const found: BeaconPlaintext[] = [];
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const obj = JSON.parse(line) as {
              event?: string;
              message?: string;
            };
            if (obj.event === "message" && typeof obj.message === "string") {
              const dec = decryptBeaconPayload(token, obj.message);
              if (dec) found.push(dec);
            }
          } catch {
            // ignore non-JSON lines
          }
        }
        return found;
      } finally {
        clearTimeout(timer);
      }
    })
  );

  let newest: BeaconPlaintext | null = null;
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    for (const item of res.value) {
      if (!newest || item.ts > newest.ts) {
        newest = item;
      }
    }
  }
  return newest;
}

export interface BeaconPublisherOptions {
  enabled?: boolean;
  endpoints?: string[];
  keepaliveIntervalMs?: number;
  requestTimeoutMs?: number;
  onLog?: (msg: string) => void;
  onStatusChange?: (status: BeaconStatus) => void;
}

export class BeaconPublisher {
  private readonly enabledFlag: boolean;
  private readonly endpoints: string[];
  private readonly keepaliveIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onLog?: (msg: string) => void;
  private readonly onStatusChange?: (status: BeaconStatus) => void;

  private keepaliveTimer: NodeJS.Timeout | null = null;
  private activeTarget: {
    getToken: () => string;
    url: string;
    wsUrl: string;
    provider: string;
  } | null = null;

  private status: BeaconStatus = {
    enabled: false,
    lastPublishedAt: null,
    endpoints: [],
  };

  constructor(options: BeaconPublisherOptions = {}) {
    this.enabledFlag = options.enabled ?? true;
    this.endpoints = (
      options.endpoints && options.endpoints.length > 0
        ? options.endpoints
        : [...DEFAULT_BEACON_ENDPOINTS]
    ).map((e) => e.replace(/\/+$/, ""));
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? 10 * 60 * 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.onLog = options.onLog;
    this.onStatusChange = options.onStatusChange;
  }

  getStatus(): BeaconStatus {
    return {
      enabled: this.status.enabled,
      lastPublishedAt: this.status.lastPublishedAt,
      endpoints: [...this.status.endpoints],
    };
  }

  private setStatus(next: BeaconStatus): void {
    const unchanged =
      this.status.enabled === next.enabled &&
      this.status.lastPublishedAt === next.lastPublishedAt &&
      this.status.endpoints.length === next.endpoints.length &&
      this.status.endpoints.every((v, i) => v === next.endpoints[i]);
    if (unchanged) return;
    this.status = {
      enabled: next.enabled,
      lastPublishedAt: next.lastPublishedAt,
      endpoints: [...next.endpoints],
    };
    this.onStatusChange?.(this.getStatus());
  }

  /**
   * Starts/updates the beacon for a live HTTPS/WSS tunnel URL and schedules the 10-min keepalive.
   */
  async activate(params: {
    getToken: () => string;
    url: string;
    wsUrl: string;
    provider: string;
  }): Promise<BeaconStatus> {
    this.clearKeepalive();

    if (
      !this.enabledFlag ||
      !params.url.startsWith("https://") ||
      !params.wsUrl.startsWith("wss://")
    ) {
      this.activeTarget = null;
      this.setStatus({
        enabled: false,
        lastPublishedAt: null,
        endpoints: [],
      });
      return this.getStatus();
    }

    this.activeTarget = params;
    await this.publishNow();

    this.keepaliveTimer = setInterval(() => {
      void this.publishNow();
    }, this.keepaliveIntervalMs);
    this.keepaliveTimer.unref();

    return this.getStatus();
  }

  /**
   * Re-publishes the currently active tunnel URL (e.g. after token rotation or keepalive tick).
   */
  async publishNow(): Promise<BeaconStatus> {
    const target = this.activeTarget;
    if (!target || !this.enabledFlag) return this.getStatus();

    const token = target.getToken();
    if (!token) return this.getStatus();

    const topicId = deriveBeaconTopicId(token);
    const ts = Date.now();
    const envelope = encryptBeaconPayload(token, {
      v: 1,
      url: target.url,
      wsUrl: target.wsUrl,
      provider: target.provider,
      ts,
    });
    const body = JSON.stringify(envelope);

    const settled = await Promise.allSettled(
      this.endpoints.map(async (ep) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
        timer.unref();
        try {
          const resp = await fetch(`${ep}/${topicId}`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "X-Cache": "yes",
              "User-Agent": "PurrCam-Beacon/1.1",
            },
            body,
          });
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
          }
          return ep;
        } finally {
          clearTimeout(timer);
        }
      })
    );

    const succeeded: string[] = [];
    const failures: string[] = [];
    settled.forEach((res, idx) => {
      if (res.status === "fulfilled") {
        succeeded.push(res.value);
      } else {
        failures.push(
          `${this.endpoints[idx]} (${res.reason instanceof Error ? res.reason.message : String(res.reason)})`
        );
      }
    });

    if (succeeded.length > 0) {
      this.onLog?.(
        `[beacon] Published encrypted tunnel URL (${target.provider}) to ${succeeded.join(", ")}`
      );
      this.setStatus({
        enabled: true,
        lastPublishedAt: ts,
        endpoints: succeeded,
      });
    } else {
      this.onLog?.(
        `[beacon] Failed to publish to all beacon endpoints: ${failures.join("; ")}`
      );
      this.setStatus({
        enabled: true,
        lastPublishedAt: this.status.lastPublishedAt,
        endpoints: [],
      });
    }

    return this.getStatus();
  }

  stop(): void {
    this.clearKeepalive();
    this.activeTarget = null;
    this.setStatus({
      enabled: false,
      lastPublishedAt: null,
      endpoints: [],
    });
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
