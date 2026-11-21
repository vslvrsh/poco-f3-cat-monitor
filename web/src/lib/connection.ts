const STORAGE_SERVER_URL = 'purrcam.serverUrl';
const STORAGE_TOKEN = 'purrcam.token';
const STORAGE_CLIENT_ID = 'purrcam.clientId';

export interface ConnectionConfig {
  /** Custom server origin (e.g. "https://your-tunnel.example.com" or "http://192.168.1.100:8787"), "" = same origin */
  serverUrl: string;
  token: string;
}

/** Validates that an external URL strictly uses http: or https: (blocks javascript:, data:, etc.). */
export function isSafeHttpUrl(raw: string | null | undefined): boolean {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getOrCreateClientId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_CLIENT_ID);
    if (existing && existing.length >= 6) return existing;
    const generated =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? `web-${crypto.randomUUID().slice(0, 8)}`
        : `web-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(STORAGE_CLIENT_ID, generated);
    return generated;
  } catch {
    return `web-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Loads saved connection config and automatically captures `?token=...` (and optional `?server=...`)
 * from the page URL, immediately persisting them and stripping `token` via history.replaceState
 * so secrets never linger in browser history, screenshots, or address bar.
 */
export function loadConnectionConfig(): ConnectionConfig {
  let savedUrl = '';
  let savedToken = '';
  try {
    savedUrl = (localStorage.getItem(STORAGE_SERVER_URL) ?? '').trim();
    savedToken = (localStorage.getItem(STORAGE_TOKEN) ?? '').trim();
  } catch {
    // ignore storage errors
  }

  try {
    const params = new URLSearchParams(window.location.search);
    let urlChanged = false;
    let storageChanged = false;

    if (params.has('token')) {
      const urlToken = params.get('token')?.trim() ?? '';
      if (urlToken) {
        savedToken = urlToken;
        storageChanged = true;
      }
      params.delete('token');
      urlChanged = true;
    }

    if (params.has('server')) {
      const urlServer = params.get('server')?.trim() ?? '';
      if (urlServer) {
        savedUrl = normalizeServerUrlInput(urlServer);
        storageChanged = true;
      }
      params.delete('server');
      urlChanged = true;
    }

    if (storageChanged) {
      saveConnectionConfig({ serverUrl: savedUrl, token: savedToken });
    }
    if (urlChanged) {
      const nextSearch = params.toString();
      const nextHref =
        window.location.pathname +
        (nextSearch ? `?${nextSearch}` : '') +
        window.location.hash;
      window.history.replaceState({}, '', nextHref);
    }
  } catch {
    // ignore URL parse errors
  }

  return { serverUrl: savedUrl, token: savedToken };
}

export function saveConnectionConfig(config: ConnectionConfig): void {
  try {
    const cleanUrl = normalizeServerUrlInput(config.serverUrl);
    if (cleanUrl) {
      localStorage.setItem(STORAGE_SERVER_URL, cleanUrl);
    } else {
      localStorage.removeItem(STORAGE_SERVER_URL);
    }
    const cleanToken = config.token.trim();
    if (cleanToken) {
      localStorage.setItem(STORAGE_TOKEN, cleanToken);
    } else {
      localStorage.removeItem(STORAGE_TOKEN);
    }
  } catch {
    // ignore storage quota errors
  }
}

export function normalizeServerUrlInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  const hasExplicitScheme = /^(https?|wss?):\/\//i.test(trimmed);
  let candidate = trimmed;
  if (candidate.startsWith('ws://')) {
    candidate = 'http://' + candidate.slice(5);
  } else if (candidate.startsWith('wss://')) {
    candidate = 'https://' + candidate.slice(6);
  } else if (!hasExplicitScheme) {
    candidate = 'http://' + candidate;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    if (!hasExplicitScheme && !parsed.port) {
      parsed.port = '8787';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

export function getHttpBaseUrl(serverUrl: string): string {
  return normalizeServerUrlInput(serverUrl);
}

export function getWsUrl(serverUrl: string, token?: string): string {
  const normalized = normalizeServerUrlInput(serverUrl);
  let wsBase: string;

  if (normalized) {
    const url = new URL(normalized);
    const proto = url.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = `${proto}//${url.host}/ws`;
  } else {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = `${proto}//${window.location.host}/ws`;
  }

  if (token && token.trim()) {
    return `${wsBase}?token=${encodeURIComponent(token.trim())}`;
  }
  return wsBase;
}

export function getDisplayHost(serverUrl: string): string {
  const normalized = normalizeServerUrlInput(serverUrl);
  if (normalized) {
    try {
      return new URL(normalized).host;
    } catch {
      return normalized;
    }
  }
  return window.location.host || 'localhost:8787';
}
