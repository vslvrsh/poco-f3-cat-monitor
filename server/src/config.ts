import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ICE_SERVERS,
  hasTurnServer,
  parseIceServers,
  sanitizeIceServers,
} from "./network.js";
import { generateStrongToken } from "./security.js";
import type { IceServerConfig, PersistedConfig } from "./types.js";

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, json, "utf8");
  try {
    await fs.rename(tmpPath, filePath);
  } catch {
    await fs.writeFile(filePath, json, "utf8");
    await fs.unlink(tmpPath).catch(() => {});
  }
}

export function generateAccessToken(): string {
  // 24 random bytes -> 192-bit entropy, 32 URL-safe base64url characters
  return generateStrongToken();
}

export function normalizeCustomRemoteUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new Error("customRemoteUrl must be a string or null");
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("customRemoteUrl must be a valid http(s):// URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("customRemoteUrl must start with https:// or http://");
  }
  return trimmed.replace(/\/+$/, "");
}

function buildEnvTurnServer(
  env: NodeJS.ProcessEnv
): IceServerConfig | null {
  const url = env.TURN_URL?.trim();
  if (!url || !/^turns?:/i.test(url)) return null;
  const entry: IceServerConfig = { urls: url };
  if (env.TURN_USERNAME?.trim()) entry.username = env.TURN_USERNAME.trim();
  if (env.TURN_CREDENTIAL?.trim()) entry.credential = env.TURN_CREDENTIAL.trim();
  return entry;
}

function mergeIceServer(
  base: IceServerConfig[],
  extra: IceServerConfig | null
): IceServerConfig[] {
  const copy = base.map((s) => ({
    ...s,
    urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
  }));
  if (!extra) return copy;

  const extraUrl = Array.isArray(extra.urls) ? extra.urls[0] : extra.urls;
  const alreadyPresent = copy.some((s) => {
    const list = Array.isArray(s.urls) ? s.urls : [s.urls];
    return list.includes(extraUrl);
  });
  if (!alreadyPresent) {
    copy.push({ ...extra });
  }
  return copy;
}

export interface ConfigStoreOptions {
  dataDir: string;
  /** Strict token from env/constructor override (if non-empty, enforced globally). */
  strictToken?: string;
  /** Explicit ICE servers override (e.g. from constructor or ICE_SERVERS_JSON). */
  overrideIceServers?: IceServerConfig[];
  /** Environment object for reading TURN_URL / ICE_SERVERS_JSON / PURRCAM_REMOTE. */
  env?: NodeJS.ProcessEnv;
}

export class PurrCamConfigStore {
  readonly dataDir: string;
  readonly configFile: string;
  readonly strictToken: string;

  private readonly env: NodeJS.ProcessEnv;
  private readonly overrideIceServers?: IceServerConfig[];
  private writeChain: Promise<void> = Promise.resolve();

  private state: PersistedConfig = {
    token: "",
    customRemoteUrl: null,
    autoStartTunnel: false,
    iceServers: DEFAULT_ICE_SERVERS.map((s) => ({ ...s })),
  };

  constructor(options: ConfigStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.configFile = path.join(this.dataDir, "config.json");
    this.strictToken = (options.strictToken ?? "").trim();
    this.overrideIceServers = options.overrideIceServers;
    this.env = options.env ?? process.env;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });

    let loadedFromDisk = false;
    try {
      const raw = await fs.readFile(this.configFile, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const loadedIce = sanitizeIceServers(parsed.iceServers);
        let customUrl: string | null = null;
        try {
          customUrl = normalizeCustomRemoteUrl(parsed.customRemoteUrl);
        } catch {
          customUrl = null;
        }
        this.state = {
          token: typeof parsed.token === "string" ? parsed.token.trim() : "",
          customRemoteUrl: customUrl,
          autoStartTunnel: Boolean(parsed.autoStartTunnel),
          iceServers:
            loadedIce.length > 0
              ? loadedIce
              : DEFAULT_ICE_SERVERS.map((s) => ({ ...s })),
        };
        loadedFromDisk = true;
      }
    } catch {
      loadedFromDisk = false;
    }

    // Seed from environment variables if not overridden or if first boot
    const envIceRaw = this.env.ICE_SERVERS_JSON || this.env.ICE_SERVERS;
    const envTurn = buildEnvTurnServer(this.env);

    if (!loadedFromDisk) {
      let seededIce = envIceRaw
        ? parseIceServers(envIceRaw)
        : DEFAULT_ICE_SERVERS.map((s) => ({ ...s }));
      seededIce = mergeIceServer(seededIce, envTurn);

      this.state = {
        token: this.strictToken || "",
        customRemoteUrl: null,
        autoStartTunnel:
          this.env.PURRCAM_REMOTE === "1" ||
          this.env.PURRCAM_REMOTE?.toLowerCase() === "true",
        iceServers: seededIce,
      };
    } else if (envTurn) {
      this.state.iceServers = mergeIceServer(this.state.iceServers, envTurn);
    }

    if (this.overrideIceServers && this.overrideIceServers.length > 0) {
      this.state.iceServers = this.overrideIceServers.map((s) => ({
        ...s,
        urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
      }));
    }

    if (this.strictToken) {
      this.state.token = this.strictToken;
    }
  }

  async close(): Promise<void> {
    await this.writeChain;
  }

  getConfig(): PersistedConfig {
    return {
      token: this.getEffectiveToken(),
      customRemoteUrl: this.state.customRemoteUrl,
      autoStartTunnel: this.state.autoStartTunnel,
      iceServers: this.getEffectiveIceServers(),
    };
  }

  getEffectiveToken(): string {
    return this.strictToken || this.state.token;
  }

  hasStrictGlobalToken(): boolean {
    return this.strictToken.length > 0;
  }

  getEffectiveIceServers(): IceServerConfig[] {
    const base =
      this.state.iceServers.length > 0
        ? this.state.iceServers
        : DEFAULT_ICE_SERVERS;
    return base.map((s) => ({
      ...s,
      urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
    }));
  }

  isTurnConfigured(): boolean {
    return hasTurnServer(this.getEffectiveIceServers());
  }

  async ensureToken(): Promise<string> {
    const existing = this.getEffectiveToken();
    if (existing) return existing;

    const generated = generateAccessToken();
    this.state.token = generated;
    await this.persist();
    return generated;
  }

  async updateConfig(
    patch: Partial<PersistedConfig>
  ): Promise<PersistedConfig> {
    const next: PersistedConfig = {
      ...this.state,
      iceServers: this.getEffectiveIceServers(),
    };

    if (patch.token !== undefined) {
      if (typeof patch.token !== "string") {
        throw new Error("token must be a string");
      }
      next.token = patch.token.trim();
    }

    if (patch.customRemoteUrl !== undefined) {
      next.customRemoteUrl = normalizeCustomRemoteUrl(patch.customRemoteUrl);
    }

    if (patch.autoStartTunnel !== undefined) {
      if (typeof patch.autoStartTunnel !== "boolean") {
        throw new Error("autoStartTunnel must be a boolean");
      }
      next.autoStartTunnel = patch.autoStartTunnel;
    }

    if (patch.iceServers !== undefined) {
      if (!Array.isArray(patch.iceServers)) {
        throw new Error("iceServers must be an array");
      }
      const cleaned = sanitizeIceServers(patch.iceServers);
      if (patch.iceServers.length > 0 && cleaned.length === 0) {
        throw new Error(
          "iceServers contains no valid stun:/stuns:/turn:/turns: entries"
        );
      }
      next.iceServers =
        cleaned.length > 0
          ? cleaned
          : DEFAULT_ICE_SERVERS.map((s) => ({ ...s }));
    }

    this.state = next;
    await this.persist();
    return this.getConfig();
  }

  private persist(): Promise<void> {
    const snapshot: PersistedConfig = {
      token: this.state.token,
      customRemoteUrl: this.state.customRemoteUrl,
      autoStartTunnel: this.state.autoStartTunnel,
      iceServers: this.getEffectiveIceServers(),
    };
    this.writeChain = this.writeChain
      .then(() => atomicWriteJson(this.configFile, snapshot))
      .catch((err) => {
        console.error("[config] Failed to persist config.json:", err);
      });
    return this.writeChain;
  }
}
