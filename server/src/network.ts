import type { IncomingMessage } from "node:http";
import os from "node:os";
import type { IceServerConfig } from "./types.js";

export const DEFAULT_ICE_SERVERS: IceServerConfig[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

const VIRTUAL_IFACE_PATTERN =
  /vethernet|wsl|docker|hyper-v|virtualbox|vmware|vbox|loopback|bluetooth|(^|[-_\s])tun\d*($|[-_\s])|(^|[-_\s])tap\d*($|[-_\s])|wintun|wireguard|(^|[-_\s])wg\d*|openvpn|vpn|nordlynx|proton|mullvad|sing-?box|clash|nekoray|amnezia|v2ray|xray|mihomo|hamachi/i;

const OVERLAY_MESH_PATTERN = /tailscale|zerotier/i;

export function isPrivateLanIpv4(ip: string): boolean {
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("10.")) return true;
  const parts = ip.split(".").map(Number);
  if (
    parts.length === 4 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 172 &&
    parts[1] >= 16 &&
    parts[1] <= 31
  ) {
    return true;
  }
  return false;
}

export function isTailscaleCgnatIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 100 &&
    parts[1] >= 64 &&
    parts[1] <= 127
  );
}

function isLinkLocalIpv4(ip: string): boolean {
  return ip.startsWith("169.254.");
}

function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || ip === "127.0.0.1" || ip.startsWith("127.");
}

export function normalizeRemoteIp(raw?: string | null): string {
  if (!raw) return "";
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice("::ffff:".length);
  }
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) {
    ip = ip.slice(0, zoneIdx);
  }
  return ip;
}

const PROXY_HEADERS = [
  "cf-connecting-ip",
  "cf-ray",
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
] as const;

export function hasProxyHeaders(req: IncomingMessage): boolean {
  for (const headerName of PROXY_HEADERS) {
    const val = req.headers[headerName];
    if (typeof val === "string" && val.trim().length > 0) return true;
    if (Array.isArray(val) && val.some((v) => v.trim().length > 0)) return true;
  }
  return false;
}

/**
 * Returns true ONLY for loopback (127.0.0.0/8, ::1), RFC 1918 private LAN
 * (10/8, 172.16/12, 192.168/16), or IPv6 link-local/ULA addresses.
 */
export function isLocalIpAddress(rawIp?: string | null): boolean {
  const ip = normalizeRemoteIp(rawIp);
  if (!ip) return false;
  if (isLoopbackIp(ip)) return true;
  if (isPrivateLanIpv4(ip)) return true;
  // IPv6 link-local (fe80::/10) or unique local address (fc00::/7)
  if (/^fe[89ab][0-9a-f]:/i.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip)) {
    return true;
  }
  return false;
}

/**
 * Extracts a normalized client IP key for auth rate limiting.
 */
export function extractClientIp(req: IncomingMessage): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim()) {
    return normalizeRemoteIp(cfIp);
  }
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    const first = xff.split(",")[0]?.trim();
    if (first) return normalizeRemoteIp(first);
  }
  const xRealIp = req.headers["x-real-ip"];
  if (typeof xRealIp === "string" && xRealIp.trim()) {
    return normalizeRemoteIp(xRealIp);
  }
  return normalizeRemoteIp(req.socket?.remoteAddress) || "unknown";
}

/**
 * Returns true when an incoming HTTP/WS request arrived via a reverse tunnel/proxy
 * (Cloudflare / forwarded headers) or from a non-loopback, non-RFC1918 IP address.
 */
export function isExternalRequest(req: IncomingMessage): boolean {
  if (hasProxyHeaders(req)) return true;
  const remoteAddr = req.socket?.remoteAddress;
  return !isLocalIpAddress(remoteAddr);
}

interface CandidateIp {
  address: string;
  iface: string;
  isVirtual: boolean;
  isMesh: boolean;
  score: number;
}

/**
 * Discovers non-loopback IPv4 addresses on this machine, prioritizing
 * physical Wi-Fi / Ethernet LAN addresses (e.g. 192.168.x.x) ahead of
 * virtual/VPN TUN/TAP interfaces (filtering out unreachable TUN/TAP adapters
 * and Tailscale CGNAT IPs whenever at least one physical LAN IP is available).
 */
export function getLanIps(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  const candidates: CandidateIp[] = [];

  for (const [ifaceName, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      const isIpv4 = addr.family === "IPv4" || (addr.family as unknown) === 4;
      if (!isIpv4 || addr.internal) continue;
      if (isLinkLocalIpv4(addr.address)) continue;

      let score = 0;
      const isVirtual = VIRTUAL_IFACE_PATTERN.test(ifaceName);
      const isMesh =
        OVERLAY_MESH_PATTERN.test(ifaceName) ||
        isTailscaleCgnatIpv4(addr.address);

      if (!isVirtual && !isMesh) score += 100;
      else if (isMesh) score += 40;

      if (/wi-?fi|wlan|wireless/i.test(ifaceName)) score += 30;
      else if (/ethernet|eth|en\d/i.test(ifaceName)) score += 25;

      if (addr.address.startsWith("192.168.")) score += 20;
      else if (addr.address.startsWith("10.")) score += 15;
      else if (isPrivateLanIpv4(addr.address)) score += 10;

      candidates.push({
        address: addr.address,
        iface: ifaceName,
        isVirtual,
        isMesh,
        score,
      });
    }
  }

  const hasPhysical = candidates.some((c) => !c.isVirtual && !c.isMesh);
  const filtered = hasPhysical
    ? candidates.filter((c) => !c.isVirtual && !c.isMesh)
    : candidates.filter((c) => !c.isVirtual).length > 0
      ? candidates.filter((c) => !c.isVirtual)
      : candidates;

  filtered.sort(
    (a, b) => b.score - a.score || a.address.localeCompare(b.address)
  );

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of filtered) {
    if (!seen.has(item.address)) {
      seen.add(item.address);
      result.push(item.address);
    }
  }
  return result;
}

/**
 * Detects an active Tailscale IPv4 address (100.64.0.0/10 CGNAT range),
 * prioritizing interfaces named after Tailscale.
 */
export function getTailscaleIp(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string | null {
  let fallback: string | null = null;

  for (const [ifaceName, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      const isIpv4 = addr.family === "IPv4" || (addr.family as unknown) === 4;
      if (!isIpv4 || addr.internal) continue;
      if (!isTailscaleCgnatIpv4(addr.address)) continue;

      if (/tailscale/i.test(ifaceName)) {
        return addr.address;
      }
      if (!fallback) {
        fallback = addr.address;
      }
    }
  }

  return fallback;
}

/**
 * Builds the primary WebSocket URL clients on the LAN should connect to.
 */
export function buildPrimaryWsUrl(lanIps: string[], port: number): string {
  const host = lanIps[0] ?? "localhost";
  return `ws://${host}:${port}/ws`;
}

/**
 * Converts an HTTP(S) base URL to a WebSocket /ws URL.
 */
export function httpUrlToWsUrl(httpUrl: string): string {
  const parsed = new URL(httpUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = cleanPath.endsWith("/ws") ? cleanPath : `${cleanPath}/ws`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Builds a purrcam://connect pairing deep link with local WS URL, optional remote WS URL, and optional token.
 */
export function buildPairingLink(params: {
  localWsUrl: string;
  remoteWsUrl?: string | null;
  token?: string | null;
}): string {
  const query = new URLSearchParams();
  query.set("local", params.localWsUrl);
  if (params.remoteWsUrl && params.remoteWsUrl.trim()) {
    query.set("remote", params.remoteWsUrl.trim());
  }
  if (params.token && params.token.trim()) {
    query.set("token", params.token.trim());
  }
  return `purrcam://connect?${query.toString()}`;
}

/**
 * Validates and sanitizes an array of RTCIceServer entries.
 */
export function sanitizeIceServers(input: unknown): IceServerConfig[] {
  if (!Array.isArray(input)) return [];
  const result: IceServerConfig[] = [];

  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    let urls: string | string[] | null = null;

    if (typeof raw.urls === "string" && /^(stuns?|turns?):/i.test(raw.urls.trim())) {
      urls = raw.urls.trim();
    } else if (Array.isArray(raw.urls)) {
      const validUrls = raw.urls
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter((u) => /^(stuns?|turns?):/i.test(u));
      if (validUrls.length > 0) {
        urls = validUrls.length === 1 ? validUrls[0] : validUrls;
      }
    }

    if (!urls) continue;

    const entry: IceServerConfig = { urls };
    if (typeof raw.username === "string" && raw.username.length > 0) {
      entry.username = raw.username;
    }
    if (typeof raw.credential === "string" && raw.credential.length > 0) {
      entry.credential = raw.credential;
    }
    result.push(entry);
  }

  return result;
}

/**
 * Returns true if any ICE server entry contains a TURN/TURNS URL.
 */
export function hasTurnServer(iceServers: IceServerConfig[]): boolean {
  return iceServers.some((s) => {
    const list = Array.isArray(s.urls) ? s.urls : [s.urls];
    return list.some((u) => /^turns?:/i.test(u.trim()));
  });
}

/**
 * Parses ICE_SERVERS / ICE_SERVERS_JSON env var as either:
 * - JSON array of RTCIceServer objects (`[{"urls":"turn:...","username":"...","credential":"..."}]`)
 * - Comma-separated list of STUN/TURN URLs (`stun:a:3478,turn:b:3478`)
 */
export function parseIceServers(raw?: string): IceServerConfig[] {
  if (!raw || !raw.trim()) {
    return DEFAULT_ICE_SERVERS.map((s) => ({ ...s }));
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      const valid = sanitizeIceServers(parsed);
      if (valid.length > 0) return valid;
    } catch {
      // Fall back to comma-separated parsing or default
    }
  }

  const urls = trimmed
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^(stuns?|turns?):/i.test(u));

  if (urls.length > 0) {
    return urls.map((urlsItem) => ({ urls: urlsItem }));
  }

  return DEFAULT_ICE_SERVERS.map((s) => ({ ...s }));
}
