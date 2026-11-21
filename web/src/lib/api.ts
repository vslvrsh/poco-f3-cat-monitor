import type {
  IceServerConfig,
  RemoteConfig,
  RemoteTunnelStatus,
  ServerInfo,
  SnapshotMeta,
  Telemetry,
} from '../types/protocol';
import { getHttpBaseUrl, isSafeHttpUrl } from './connection';

export class ApiHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiHttpError';
    this.status = status;
  }
}

function buildHeaders(token?: string, extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { ...extra };
  if (token && token.trim()) {
    headers['Authorization'] = `Bearer ${token.trim()}`;
    headers['X-PurrCam-Token'] = token.trim();
  }
  return headers;
}

async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; message?: string; output?: string };
    if (typeof data.error === 'string' && data.error) return data.error;
    if (typeof data.message === 'string' && data.message) return data.message;
    if (typeof data.output === 'string' && data.output) return data.output;
  } catch {
    // ignore JSON parse failure
  }
  return `${fallback} (HTTP ${res.status})`;
}

export async function fetchServerInfo(serverUrl: string, token?: string): Promise<ServerInfo> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/info`, {
    headers: buildHeaders(token),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Failed to fetch server info'));
  }
  return (await res.json()) as ServerInfo;
}

export async function fetchTelemetryHistory(
  serverUrl: string,
  limit = 120,
  token?: string
): Promise<Telemetry[]> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/telemetry/history?limit=${limit}`, {
    headers: buildHeaders(token),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Failed to load telemetry'));
  }
  const data = (await res.json()) as { items?: Telemetry[] };
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchSnapshots(serverUrl: string, token?: string): Promise<SnapshotMeta[]> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/snapshots`, {
    headers: buildHeaders(token),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Failed to load snapshots'));
  }
  const data = (await res.json()) as { items?: SnapshotMeta[] };
  return Array.isArray(data.items) ? data.items : [];
}

export async function uploadSnapshotBlob(
  serverUrl: string,
  blob: Blob,
  lensLabel?: string,
  token?: string
): Promise<SnapshotMeta> {
  const base = getHttpBaseUrl(serverUrl);
  const extra: Record<string, string> = {
    'Content-Type': 'image/jpeg',
  };
  if (lensLabel) {
    extra['X-Lens-Label'] = encodeURIComponent(lensLabel);
  }
  const res = await fetch(`${base}/api/snapshots`, {
    method: 'POST',
    headers: buildHeaders(token, extra),
    body: blob,
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Could not save snapshot'));
  }
  return (await res.json()) as SnapshotMeta;
}

export async function deleteSnapshotById(
  serverUrl: string,
  id: string,
  token?: string
): Promise<void> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/snapshots/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: buildHeaders(token),
  });
  if (!res.ok && res.status !== 404) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Could not delete snapshot'));
  }
}

export function resolveSnapshotUrl(
  serverUrl: string,
  snapshot: SnapshotMeta,
  token?: string
): string {
  const base = getHttpBaseUrl(serverUrl);
  const rawPath = (snapshot.url || '').trim();
  const safeFallback = `/snapshots/${encodeURIComponent(snapshot.filename)}`;

  let full: string;
  if (rawPath && isSafeHttpUrl(rawPath)) {
    full = rawPath;
  } else if (rawPath && rawPath.startsWith('/') && !rawPath.startsWith('//')) {
    full = `${base}${rawPath}`;
  } else {
    full = `${base}${safeFallback}`;
  }

  if (token && token.trim()) {
    const sep = full.includes('?') ? '&' : '?';
    return `${full}${sep}token=${encodeURIComponent(token.trim())}`;
  }
  return full;
}

// --- Remote Access & Tunnel Management API (Local-Only Admin Endpoints) ---

export async function fetchRemoteConfig(
  serverUrl: string,
  token?: string
): Promise<RemoteConfig> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/remote/config`, {
    headers: buildHeaders(token),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Failed to fetch remote config'));
  }
  return (await res.json()) as RemoteConfig;
}

export interface UpdateRemoteConfigPayload {
  token?: string;
  customRemoteUrl?: string | null;
  autoStartTunnel?: boolean;
  iceServers?: IceServerConfig[];
}

export async function updateRemoteConfig(
  serverUrl: string,
  payload: UpdateRemoteConfigPayload,
  token?: string
): Promise<RemoteConfig> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/remote/config`, {
    method: 'PUT',
    headers: buildHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Failed to update remote config'));
  }
  return (await res.json()) as RemoteConfig;
}

export async function startRemoteTunnel(
  serverUrl: string,
  options?: { provider?: 'cloudflare' | 'custom'; customUrl?: string },
  token?: string
): Promise<{ remote: RemoteTunnelStatus; pairingLink?: string; token?: string }> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/remote/start`, {
    method: 'POST',
    headers: buildHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(options ?? { provider: 'cloudflare' }),
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Failed to start remote tunnel'));
  }
  const data = (await res.json()) as
    | { remote: RemoteTunnelStatus; pairingLink?: string; token?: string }
    | RemoteTunnelStatus;
  if ('remote' in data && data.remote) {
    return data;
  }
  return { remote: data as RemoteTunnelStatus };
}

export async function stopRemoteTunnel(
  serverUrl: string,
  token?: string
): Promise<RemoteTunnelStatus> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/remote/stop`, {
    method: 'POST',
    headers: buildHeaders(token),
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Failed to stop remote tunnel'));
  }
  const data = (await res.json()) as { remote?: RemoteTunnelStatus } & Partial<RemoteTunnelStatus>;
  return data.remote ?? (data as RemoteTunnelStatus);
}

// --- PC System Tools (Local-Only Admin Endpoints: ADB Reverse & Live Server Logs) ---

export interface AdbReverseResult {
  ok: boolean;
  output: string;
  status: number;
}

export async function triggerAdbReverse(
  serverUrl: string,
  token?: string
): Promise<AdbReverseResult> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/system/adb-reverse`, {
    method: 'POST',
    headers: buildHeaders(token),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<AdbReverseResult> & {
    error?: string;
  };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      output: data.output || data.error || `HTTP ${res.status}`,
    };
  }
  return {
    ok: Boolean(data.ok ?? true),
    status: res.status,
    output: typeof data.output === 'string' ? data.output : 'ADB USB port reverse active',
  };
}

export async function fetchSystemLogs(
  serverUrl: string,
  limit = 120,
  token?: string
): Promise<string[]> {
  const base = getHttpBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/system/logs?limit=${limit}`, {
    headers: buildHeaders(token),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiHttpError(res.status, await readErrorMessage(res, 'Failed to fetch system logs'));
  }
  const data = (await res.json()) as { lines?: string[] };
  return Array.isArray(data.lines) ? data.lines : [];
}
