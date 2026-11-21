import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  Cable,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FileTerminal,
  Globe,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Terminal,
  Trash2,
  Wifi,
} from 'lucide-react';
import type {
  IceServerConfig,
  RemoteConfig,
  RemoteTunnelStatus,
  ServerInfo,
  WsConnectionStatus,
} from '../types/protocol';
import {
  ApiHttpError,
  fetchRemoteConfig,
  fetchServerInfo,
  fetchSystemLogs,
  startRemoteTunnel,
  stopRemoteTunnel,
  triggerAdbReverse,
  updateRemoteConfig,
} from '../lib/api';
import {
  isSafeHttpUrl,
  normalizeServerUrlInput,
  type ConnectionConfig,
} from '../lib/connection';
import { M3ConnectedButtonGroup, M3Switch } from './M3Controls';

interface ConnectViewProps {
  config: ConnectionConfig;
  wsStatus: WsConnectionStatus;
  liveRemoteStatus: RemoteTunnelStatus | null;
  onRemoteStatusChange: (status: RemoteTunnelStatus | null) => void;
  onApplyConfig: (next: ConnectionConfig) => void;
  onNotify: (tone: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

type QrTab = 'remote' | 'local' | 'usb';

interface TurnRow {
  id: string;
  url: string;
  username: string;
  credential: string;
}

function generateSecureToken(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

function isTurnServer(entry: IceServerConfig): boolean {
  const first = Array.isArray(entry.urls) ? entry.urls[0] ?? '' : entry.urls;
  return /^turns?:/i.test(first.trim());
}

export function ConnectView({
  config,
  wsStatus,
  liveRemoteStatus,
  onRemoteStatusChange,
  onApplyConfig,
  onNotify,
}: ConnectViewProps) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [remoteCfg, setRemoteCfg] = useState<RemoteConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [savingRemote, setSavingRemote] = useState(false);
  const [remoteCfgUnavailable, setRemoteCfgUnavailable] = useState(false);
  const [localAdminForbidden, setLocalAdminForbidden] = useState(false);

  // Pairing & QR tabs
  const [qrTab, setQrTab] = useState<QrTab>('remote');
  const [remoteQrKind, setRemoteQrKind] = useState<'app' | 'web'>('app');
  const [localQrKind, setLocalQrKind] = useState<'http' | 'ws'>('http');
  const [selectedIp, setSelectedIp] = useState<string>('');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Access token & auto-start editor
  const [showToken, setShowToken] = useState(false);
  const [draftAccessToken, setDraftAccessToken] = useState('');
  const [draftAutoStart, setDraftAutoStart] = useState(false);

  // PC USB ADB Reverse & Live Server Logs
  const [adbBusy, setAdbBusy] = useState(false);
  const [adbStatus, setAdbStatus] = useState<{ ok: boolean; output: string } | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [systemLogs, setSystemLogs] = useState<string[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Collapsible TURN Relay settings
  const [turnOpen, setTurnOpen] = useState(false);
  const [turnRows, setTurnRows] = useState<TurnRow[]>([]);
  const [stunServers, setStunServers] = useState<IceServerConfig[]>([]);

  // Collapsible Client / Browser Override
  const [clientOpen, setClientOpen] = useState(wsStatus === 'auth_error');
  const [draftClientUrl, setDraftClientUrl] = useState(config.serverUrl);
  const [draftClientToken, setDraftClientToken] = useState(config.token);

  useEffect(() => {
    setDraftClientUrl(config.serverUrl);
    setDraftClientToken(config.token);
  }, [config.serverUrl, config.token]);

  useEffect(() => {
    if (wsStatus === 'auth_error') setClientOpen(true);
  }, [wsStatus]);

  const hydrateTurnRows = useCallback((servers: IceServerConfig[]) => {
    const stuns: IceServerConfig[] = [];
    const turns: TurnRow[] = [];
    servers.forEach((entry, idx) => {
      if (isTurnServer(entry)) {
        turns.push({
          id: `turn-${idx}-${Date.now()}`,
          url: Array.isArray(entry.urls) ? entry.urls[0] ?? '' : entry.urls,
          username: entry.username ?? '',
          credential: entry.credential ?? '',
        });
      } else {
        stuns.push(entry);
      }
    });
    setStunServers(stuns);
    setTurnRows(turns);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const serverInfo = await fetchServerInfo(config.serverUrl, config.token);
      setInfo(serverInfo);
      if (serverInfo.remote) {
        onRemoteStatusChange(serverInfo.remote);
      }
      if (serverInfo.lanIps.length > 0) {
        setSelectedIp((prev) => (serverInfo.lanIps.includes(prev) ? prev : serverInfo.lanIps[0]));
      }

      try {
        const cfg = await fetchRemoteConfig(config.serverUrl, config.token);
        setRemoteCfg(cfg);
        setRemoteCfgUnavailable(false);
        setLocalAdminForbidden(false);
        setDraftAccessToken(cfg.token ?? '');
        setDraftAutoStart(Boolean(cfg.autoStartTunnel));
        hydrateTurnRows(Array.isArray(cfg.iceServers) ? cfg.iceServers : []);
      } catch (err) {
        setRemoteCfgUnavailable(true);
        if (err instanceof ApiHttpError && err.status === 403) {
          setLocalAdminForbidden(true);
          setLogsOpen(false);
        } else {
          setLocalAdminForbidden(false);
        }
      }
    } catch {
      setInfo(null);
    } finally {
      setLoading(false);
    }
  }, [config.serverUrl, config.token, hydrateTurnRows, onRemoteStatusChange]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const refreshSystemLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const lines = await fetchSystemLogs(config.serverUrl, 120, config.token);
      setSystemLogs(lines);
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 403) {
        setLocalAdminForbidden(true);
        setRemoteCfgUnavailable(true);
        setLogsOpen(false);
      }
    } finally {
      setLoadingLogs(false);
    }
  }, [config.serverUrl, config.token]);

  useEffect(() => {
    if (!logsOpen) return;
    void refreshSystemLogs();
    const timer = window.setInterval(() => {
      void refreshSystemLogs();
    }, 3_500);
    return () => window.clearInterval(timer);
  }, [logsOpen, refreshSystemLogs]);

  const remoteStatus: RemoteTunnelStatus = liveRemoteStatus ??
    info?.remote ?? {
      enabled: false,
      status: 'stopped',
      provider: 'none',
      url: null,
      wsUrl: null,
      error: null,
    };

  const isTunnelRunning = remoteStatus.status === 'running' && Boolean(remoteStatus.url);
  const isTunnelStarting = remoteStatus.status === 'starting';

  const activeHostIp = useMemo(() => {
    if (selectedIp) return selectedIp;
    if (info?.lanIps?.[0]) return info.lanIps[0];
    return window.location.hostname || '127.0.0.1';
  }, [selectedIp, info]);

  const activePort = info?.port ?? (Number(window.location.port) || 8787);
  const localHttpUrl = `http://${activeHostIp}:${activePort}`;
  const localWsUrl = `ws://${activeHostIp}:${activePort}/ws`;
  const activeToken = remoteCfg?.token ?? config.token ?? '';

  const remoteWebWithToken = useMemo(() => {
    if (!remoteStatus.url || !isSafeHttpUrl(remoteStatus.url)) return '';
    const base = remoteStatus.url.trim().replace(/\/+$/, '');
    return activeToken ? `${base}/?token=${encodeURIComponent(activeToken)}` : base;
  }, [remoteStatus.url, activeToken]);

  const pairingLink = useMemo(() => {
    if (remoteCfg?.pairingLink) return remoteCfg.pairingLink;
    const params = new URLSearchParams();
    params.set('local', localWsUrl);
    if (remoteStatus.wsUrl) params.set('remote', remoteStatus.wsUrl);
    if (activeToken) params.set('token', activeToken);
    return `purrcam://connect?${params.toString()}`;
  }, [remoteCfg?.pairingLink, localWsUrl, remoteStatus.wsUrl, activeToken]);

  const qrPayload = useMemo(() => {
    if (qrTab === 'remote') {
      if (!isTunnelRunning) return '';
      return remoteQrKind === 'web' ? remoteWebWithToken : pairingLink;
    }
    if (qrTab === 'local') {
      return localQrKind === 'ws' ? localWsUrl : localHttpUrl;
    }
    return `ws://127.0.0.1:${activePort}/ws`;
  }, [
    qrTab,
    isTunnelRunning,
    remoteQrKind,
    remoteWebWithToken,
    pairingLink,
    localQrKind,
    localWsUrl,
    localHttpUrl,
    activePort,
  ]);

  useEffect(() => {
    if (!qrPayload) {
      setQrDataUrl('');
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(qrPayload, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#141218', light: '#F8FAFC' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl('');
      });
    return () => {
      cancelled = true;
    };
  }, [qrPayload]);

  const copyText = async (key: string, text: string, label?: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      if (label) onNotify('success', `${label} copied`);
      window.setTimeout(() => setCopiedKey(null), 1_600);
    } catch {
      onNotify('warning', 'Clipboard access blocked by browser');
    }
  };

  const handleToggleTunnel = async () => {
    setTunnelBusy(true);
    try {
      if (isTunnelRunning || isTunnelStarting) {
        const stopped = await stopRemoteTunnel(config.serverUrl, config.token);
        onRemoteStatusChange(stopped);
        onNotify('info', 'Remote tunnel stopped');
        await loadAll();
      } else {
        onNotify('info', 'Starting Cloudflare remote tunnel…');
        const res = await startRemoteTunnel(
          config.serverUrl,
          { provider: 'cloudflare' },
          config.token
        );
        onRemoteStatusChange(res.remote);
        if (res.token && !config.token) {
          onApplyConfig({ serverUrl: config.serverUrl, token: res.token });
        }
        onNotify('success', 'Remote 4G/5G tunnel is live');
        await loadAll();
      }
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 403) {
        setLocalAdminForbidden(true);
        setRemoteCfgUnavailable(true);
      } else {
        onNotify('error', err instanceof Error ? err.message : 'Tunnel action failed');
      }
    } finally {
      setTunnelBusy(false);
    }
  };

  const handleRunAdbReverse = async () => {
    setAdbBusy(true);
    try {
      const res = await triggerAdbReverse(config.serverUrl, config.token);
      if (res.status === 403) {
        setLocalAdminForbidden(true);
        setRemoteCfgUnavailable(true);
        setAdbStatus(null);
        return;
      }
      setAdbStatus({ ok: res.ok, output: res.output });
      if (res.ok) {
        onNotify('success', 'USB ADB Reverse tunnel active');
      } else {
        onNotify('warning', res.output || 'ADB reverse failed');
      }
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 403) {
        setLocalAdminForbidden(true);
        setRemoteCfgUnavailable(true);
        setAdbStatus(null);
      } else {
        const msg = err instanceof Error ? err.message : 'ADB reverse request failed';
        setAdbStatus({ ok: false, output: msg });
        onNotify('error', msg);
      }
    } finally {
      setAdbBusy(false);
    }
  };

  const handleSaveTokenAndAutoStart = async (nextAutoStart?: boolean) => {
    setSavingRemote(true);
    try {
      const updated = await updateRemoteConfig(
        config.serverUrl,
        {
          token: draftAccessToken.trim(),
          autoStartTunnel: nextAutoStart ?? draftAutoStart,
        },
        config.token
      );
      setRemoteCfg(updated);
      setDraftAccessToken(updated.token);
      setDraftAutoStart(updated.autoStartTunnel);
      if (updated.token && updated.token !== config.token) {
        onApplyConfig({ serverUrl: config.serverUrl, token: updated.token });
      }
      onNotify('success', 'Remote security settings saved');
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 403) {
        setLocalAdminForbidden(true);
        setRemoteCfgUnavailable(true);
      } else {
        onNotify('error', err instanceof Error ? err.message : 'Could not update settings');
      }
    } finally {
      setSavingRemote(false);
    }
  };

  const handleSaveTurnServers = async () => {
    setSavingRemote(true);
    try {
      const cleanedTurns: IceServerConfig[] = turnRows
        .filter((r) => r.url.trim().length > 0)
        .map((r) => ({
          urls: r.url.trim(),
          ...(r.username.trim() ? { username: r.username.trim() } : {}),
          ...(r.credential.trim() ? { credential: r.credential.trim() } : {}),
        }));

      const baseStuns =
        stunServers.length > 0
          ? stunServers
          : [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun.cloudflare.com:3478' },
            ];

      const updated = await updateRemoteConfig(
        config.serverUrl,
        { iceServers: [...baseStuns, ...cleanedTurns] },
        config.token
      );
      setRemoteCfg(updated);
      hydrateTurnRows(updated.iceServers);
      onNotify('success', 'ICE / TURN relay configuration saved');
      await loadAll();
    } catch (err) {
      if (err instanceof ApiHttpError && err.status === 403) {
        setLocalAdminForbidden(true);
        setRemoteCfgUnavailable(true);
      } else {
        onNotify('error', err instanceof Error ? err.message : 'Could not save TURN config');
      }
    } finally {
      setSavingRemote(false);
    }
  };

  const handleApplyClientSettings = (e: React.FormEvent) => {
    e.preventDefault();
    onApplyConfig({
      serverUrl: normalizeServerUrlInput(draftClientUrl),
      token: draftClientToken.trim(),
    });
  };

  const adbCommand = `adb reverse tcp:${activePort} tcp:${activePort}`;
  const turnConfigured = Boolean(info?.turnConfigured || turnRows.some((r) => r.url.trim()));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 pb-28 sm:px-6 md:py-8 md:pb-10">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1
            style={{ color: 'var(--md-sys-color-on-surface)' }}
            className="text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            Connect & Remote Access
          </h1>
          <p
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            className="mt-1 text-sm"
          >
            Pair your Poco F3 or monitor phone on Wi-Fi, USB ADB, or anywhere over 4G/5G
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadAll()}
          style={{
            backgroundColor: 'var(--md-sys-color-surface-container-high)',
            color: 'var(--md-sys-color-on-surface)',
          }}
          className="m3-morph-pill flex items-center gap-2 px-4 py-2 text-xs font-semibold"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Calm M3 Info Banner when viewing remotely over 4G/5G (403 on local-only admin endpoints) */}
      {localAdminForbidden && (
        <div
          style={{
            backgroundColor: 'var(--md-sys-color-secondary-container)',
            color: 'var(--md-sys-color-on-secondary-container)',
          }}
          className="mb-5 rounded-[28px] p-5"
        >
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">Remote Viewer Mode</h2>
              <p className="mt-1 text-xs leading-relaxed opacity-90">
                Server &amp; USB management is only available on the local PC/LAN for security.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Prominent Token Sign-In Prompt if Remote Client Got 4001 */}
      {wsStatus === 'auth_error' && (
        <div
          style={{
            backgroundColor: 'var(--md-sys-color-error-container)',
            color: 'var(--md-sys-color-on-error-container)',
          }}
          className="mb-5 rounded-[32px] p-5"
        >
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">Access Token Required</h2>
              <p className="mt-1 text-xs opacity-90">
                Enter your PurrCam access token below in Browser Connection Settings to sign in over
                the remote tunnel.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Main 2-Column Expressive Grid */}
      <div className="mb-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        {/* CARD 1: Remote Access (4G / 5G Cloudflare Tunnel + Token + Pairing Link) */}
        <div
          style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
          className="flex flex-col justify-between rounded-[32px] p-6"
        >
          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <div
                  style={{
                    backgroundColor: isTunnelRunning
                      ? 'var(--md-sys-color-live-container)'
                      : 'var(--md-sys-color-primary-container)',
                    color: isTunnelRunning
                      ? 'var(--md-sys-color-on-live-container)'
                      : 'var(--md-sys-color-on-primary-container)',
                  }}
                  className="flex h-12 w-12 items-center justify-center rounded-[18px]"
                >
                  <Cloud className="h-5 w-5" />
                </div>
                <div>
                  <h2
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="text-base font-semibold"
                  >
                    Remote Access (4G / 5G)
                  </h2>
                  <p
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                    className="text-xs"
                  >
                    Cloudflare HTTPS/WSS tunnel outside your home Wi-Fi
                  </p>
                </div>
              </div>

              <span
                style={{
                  backgroundColor: isTunnelRunning
                    ? 'var(--md-sys-color-live-container)'
                    : isTunnelStarting
                      ? 'var(--md-sys-color-warn-container)'
                      : remoteStatus.status === 'error'
                        ? 'var(--md-sys-color-error-container)'
                        : 'var(--md-sys-color-surface-container-high)',
                  color: isTunnelRunning
                    ? 'var(--md-sys-color-on-live-container)'
                    : isTunnelStarting
                      ? 'var(--md-sys-color-on-warn-container)'
                      : remoteStatus.status === 'error'
                        ? 'var(--md-sys-color-on-error-container)'
                        : 'var(--md-sys-color-on-surface-variant)',
                }}
                className="rounded-full px-3 py-1 text-xs font-semibold"
              >
                {isTunnelRunning
                  ? 'Live'
                  : isTunnelStarting
                    ? 'Starting…'
                    : remoteStatus.status === 'error'
                      ? 'Error'
                      : 'Stopped'}
              </span>
            </div>

            {remoteStatus.error && (
              <div
                style={{
                  backgroundColor: 'var(--md-sys-color-error-container)',
                  color: 'var(--md-sys-color-on-error-container)',
                }}
                className="mb-4 rounded-[20px] px-4 py-3 text-xs"
              >
                {remoteStatus.error}
              </div>
            )}

            {/* Primary Start / Stop Tunnel Action */}
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                data-active={isTunnelRunning}
                disabled={tunnelBusy || remoteCfgUnavailable}
                onClick={() => void handleToggleTunnel()}
                style={{
                  backgroundColor:
                    isTunnelRunning || isTunnelStarting
                      ? 'var(--md-sys-color-error-container)'
                      : 'var(--md-sys-color-primary)',
                  color:
                    isTunnelRunning || isTunnelStarting
                      ? 'var(--md-sys-color-on-error-container)'
                      : 'var(--md-sys-color-on-primary)',
                }}
                className="m3-morph-pill flex flex-1 items-center justify-center gap-2 px-5 py-3.5 text-sm font-semibold shadow-md disabled:opacity-45"
              >
                {tunnelBusy || isTunnelStarting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Globe className="h-4 w-4" />
                )}
                <span>
                  {isTunnelRunning
                    ? 'Stop Tunnel'
                    : isTunnelStarting
                      ? 'Starting Cloudflare Tunnel…'
                      : 'Start Remote Tunnel (Cloudflare)'}
                </span>
              </button>

              {isTunnelRunning && remoteWebWithToken && (
                <a
                  href={remoteWebWithToken}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    backgroundColor: 'var(--md-sys-color-secondary-container)',
                    color: 'var(--md-sys-color-on-secondary-container)',
                  }}
                  className="m3-morph-pill flex items-center gap-1.5 px-4 py-3.5 text-xs font-semibold"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Open</span>
                </a>
              )}
            </div>

            {/* Live Tunnel URL Readout */}
            {isTunnelRunning && remoteStatus.url && (
              <div
                style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
                className="mt-4 space-y-2 rounded-[22px] p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div
                      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                      className="text-[11px]"
                    >
                      Remote HTTPS URL
                    </div>
                    <div
                      style={{ color: 'var(--md-sys-color-live)' }}
                      className="truncate font-mono text-xs font-medium"
                    >
                      {remoteStatus.url}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText('remote-url', remoteWebWithToken, 'Remote link with token')
                    }
                    style={{
                      backgroundColor: 'var(--md-sys-color-surface-container-high)',
                      color: 'var(--md-sys-color-on-surface)',
                    }}
                    className="m3-morph-pill flex shrink-0 items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold"
                  >
                    {copiedKey === 'remote-url' ? (
                      <Check
                        style={{ color: 'var(--md-sys-color-live)' }}
                        className="h-3.5 w-3.5"
                      />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    <span>Copy Link</span>
                  </button>
                </div>
              </div>
            )}

            {/* Access Token & Auto-Start (Available from LAN / Authenticated) */}
            {!remoteCfgUnavailable ? (
              <div className="mt-4 space-y-3">
                <div
                  style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
                  className="rounded-[24px] p-4"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                      className="flex items-center gap-1.5 text-xs font-semibold"
                    >
                      <ShieldCheck
                        style={{ color: 'var(--md-sys-color-live)' }}
                        className="h-4 w-4"
                      />
                      Remote Access Token
                    </span>
                    <button
                      type="button"
                      onClick={() => setDraftAccessToken(generateSecureToken(32))}
                      style={{ color: 'var(--md-sys-color-primary)' }}
                      className="text-[11px] font-semibold hover:underline"
                    >
                      Generate new
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showToken ? 'text' : 'password'}
                        value={draftAccessToken}
                        onChange={(e) => setDraftAccessToken(e.target.value)}
                        placeholder="Auto-generated when tunnel starts"
                        style={{
                          backgroundColor: 'var(--md-sys-color-surface-container-low)',
                          color: 'var(--md-sys-color-on-surface)',
                        }}
                        className="w-full rounded-full py-2 pr-9 pl-4 font-mono text-xs outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken((s) => !s)}
                        aria-label={showToken ? 'Hide token' : 'Show token'}
                        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                        className="absolute top-1/2 right-3 -translate-y-1/2"
                      >
                        {showToken ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={!draftAccessToken}
                      onClick={() => void copyText('token', draftAccessToken, 'Access token')}
                      title="Copy token"
                      style={{
                        backgroundColor: 'var(--md-sys-color-surface-container-low)',
                        color: 'var(--md-sys-color-on-surface)',
                      }}
                      className="m3-morph-pill flex h-9 w-9 shrink-0 items-center justify-center disabled:opacity-40"
                    >
                      {copiedKey === 'token' ? (
                        <Check
                          style={{ color: 'var(--md-sys-color-live)' }}
                          className="h-3.5 w-3.5"
                        />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>

                    <button
                      type="button"
                      disabled={savingRemote}
                      onClick={() => void handleSaveTokenAndAutoStart()}
                      style={{
                        backgroundColor: 'var(--md-sys-color-primary-container)',
                        color: 'var(--md-sys-color-on-primary-container)',
                      }}
                      className="m3-morph-pill px-4 py-2 text-xs font-semibold disabled:opacity-40"
                    >
                      Save
                    </button>
                  </div>
                </div>

                {/* Auto-start tunnel toggle with authentic M3Switch */}
                <div
                  style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
                  className="flex items-center justify-between gap-3 rounded-[24px] px-4 py-3.5"
                >
                  <div>
                    <div
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                      className="text-xs font-semibold"
                    >
                      Auto-start remote tunnel on server launch
                    </div>
                    <div
                      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                      className="text-[11px]"
                    >
                      Automatically brings up Cloudflare HTTPS access when PurrCam starts
                    </div>
                  </div>
                  <M3Switch
                    checked={draftAutoStart}
                    disabled={savingRemote}
                    ariaLabel="Auto-start remote tunnel on server launch"
                    onToggle={() => {
                      const next = !draftAutoStart;
                      setDraftAutoStart(next);
                      void handleSaveTokenAndAutoStart(next);
                    }}
                  />
                </div>
              </div>
            ) : (
              <div
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-low)',
                  color: 'var(--md-sys-color-on-surface-variant)',
                }}
                className="mt-4 rounded-[22px] p-4 text-xs"
              >
                {localAdminForbidden
                  ? 'Server & USB management is only available on the local PC/LAN for security.'
                  : 'Manage tunnel and token settings from a local PC/LAN session.'}
              </div>
            )}
          </div>

          {/* One-Tap Android Pairing Link Button */}
          <div className="mt-4 pt-2">
            <button
              type="button"
              onClick={() =>
                void copyText('pairing', pairingLink, 'purrcam:// pairing link')
              }
              style={{
                backgroundColor: 'var(--md-sys-color-secondary-container)',
                color: 'var(--md-sys-color-on-secondary-container)',
              }}
              className="m3-morph-pill flex w-full items-center justify-center gap-2 px-5 py-3 text-xs font-semibold"
            >
              {copiedKey === 'pairing' ? (
                <Check className="h-4 w-4" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
              <span>Copy purrcam:// Pairing Link for Android App</span>
            </button>
          </div>
        </div>

        {/* CARD 2: Scannable QR Code (Remote 4G/5G | Local Wi-Fi | USB ADB) */}
        <div
          style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
          className="flex flex-col justify-between rounded-[32px] p-6"
        >
          <div>
            {/* M3 Expressive Connected Button Group for QR Mode */}
            <div className="mb-4 flex justify-center">
              <M3ConnectedButtonGroup<QrTab>
                value={qrTab}
                onChange={setQrTab}
                options={[
                  { value: 'remote', label: 'Remote (4G/5G)' },
                  { value: 'local', label: 'Local Wi-Fi' },
                  { value: 'usb', label: 'USB ADB' },
                ]}
              />
            </div>

            {qrTab === 'remote' && (
              <div className="flex flex-col items-center">
                {isTunnelRunning ? (
                  <>
                    <div className="mb-3">
                      <M3ConnectedButtonGroup<'app' | 'web'>
                        size="sm"
                        variant="secondary"
                        value={remoteQrKind}
                        onChange={setRemoteQrKind}
                        options={[
                          { value: 'app', label: 'Android App' },
                          { value: 'web', label: 'Phone Browser' },
                        ]}
                      />
                    </div>

                    <div className="flex h-[204px] w-[204px] items-center justify-center rounded-[28px] bg-[#F8FAFC] p-3 shadow-inner">
                      {qrDataUrl ? (
                        <img src={qrDataUrl} alt="Remote pairing QR" className="h-full w-full" />
                      ) : (
                        <Loader2 className="h-6 w-6 animate-spin text-[#141218]" />
                      )}
                    </div>

                    <p
                      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                      className="mt-3 text-center text-xs"
                    >
                      {remoteQrKind === 'app'
                        ? 'Scan with PurrCam Android to save both Wi-Fi & 4G/5G failover + token.'
                        : 'Scan with your phone camera to open PurrCam signed-in over 4G/5G.'}
                    </p>
                  </>
                ) : (
                  <div
                    style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
                    className="flex h-[256px] w-full flex-col items-center justify-center rounded-[28px] px-5 text-center"
                  >
                    <Smartphone
                      style={{ color: 'var(--md-sys-color-primary)' }}
                      className="mb-3 h-8 w-8"
                    />
                    <div
                      style={{ color: 'var(--md-sys-color-on-surface)' }}
                      className="text-sm font-semibold"
                    >
                      Remote Tunnel Offline
                    </div>
                    <p
                      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                      className="mt-1.5 text-xs"
                    >
                      Start the Cloudflare Remote Tunnel on the left to generate a 4G/5G QR code.
                    </p>
                  </div>
                )}
              </div>
            )}

            {qrTab === 'local' && (
              <div className="flex flex-col items-center">
                <div className="mb-3 flex flex-wrap items-center justify-center gap-1.5">
                  {(info?.lanIps ?? [activeHostIp]).map((ip) => {
                    const active = activeHostIp === ip;
                    return (
                      <button
                        key={ip}
                        type="button"
                        data-active={active}
                        onClick={() => setSelectedIp(ip)}
                        style={{
                          backgroundColor: active
                            ? 'var(--md-sys-color-primary)'
                            : 'var(--md-sys-color-surface-container-high)',
                          color: active
                            ? 'var(--md-sys-color-on-primary)'
                            : 'var(--md-sys-color-on-surface-variant)',
                        }}
                        className="m3-morph-pill px-3 py-1 font-mono text-[11px] font-semibold"
                      >
                        {ip}
                      </button>
                    );
                  })}
                  {info?.tailscaleIp && (
                    <button
                      type="button"
                      data-active={activeHostIp === info.tailscaleIp}
                      onClick={() => setSelectedIp(info.tailscaleIp!)}
                      style={{
                        backgroundColor:
                          activeHostIp === info.tailscaleIp
                            ? 'var(--md-sys-color-secondary-container)'
                            : 'var(--md-sys-color-surface-container-high)',
                        color: 'var(--md-sys-color-on-surface)',
                      }}
                      className="m3-morph-pill px-3 py-1 font-mono text-[11px] font-semibold"
                    >
                      Tailscale · {info.tailscaleIp}
                    </button>
                  )}
                </div>

                <div className="flex h-[196px] w-[196px] items-center justify-center rounded-[28px] bg-[#F8FAFC] p-3 shadow-inner">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt="Local Wi-Fi QR" className="h-full w-full" />
                  ) : (
                    <Loader2 className="h-6 w-6 animate-spin text-[#141218]" />
                  )}
                </div>

                <div
                  style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
                  className="mt-3 flex w-full items-center justify-between gap-2 rounded-full px-3.5 py-2"
                >
                  <button
                    type="button"
                    onClick={() => setLocalQrKind((k) => (k === 'http' ? 'ws' : 'http'))}
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="flex min-w-0 items-center gap-1.5 font-mono text-xs"
                    title="Switch between HTTP and WebSocket URL"
                  >
                    <Wifi
                      style={{ color: 'var(--md-sys-color-live)' }}
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="truncate">
                      {localQrKind === 'ws' ? localWsUrl : localHttpUrl}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(
                        'local-url',
                        localQrKind === 'ws' ? localWsUrl : localHttpUrl,
                        'Local URL'
                      )
                    }
                    style={{
                      backgroundColor: 'var(--md-sys-color-surface-container-high)',
                      color: 'var(--md-sys-color-on-surface)',
                    }}
                    className="m3-morph-pill shrink-0 px-3 py-1 text-[11px] font-semibold"
                  >
                    {copiedKey === 'local-url' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            {qrTab === 'usb' && (
              <div
                style={{ backgroundColor: 'var(--md-sys-color-surface-container-low)' }}
                className="flex h-[256px] flex-col justify-between rounded-[28px] p-5"
              >
                <div>
                  <div
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="mb-2 flex items-center gap-2 text-sm font-semibold"
                  >
                    <Terminal
                      style={{ color: 'var(--md-sys-color-primary)' }}
                      className="h-4 w-4"
                    />
                    <span>Zero-Latency USB Tunnel</span>
                  </div>
                  <p
                    style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                    className="text-xs leading-relaxed"
                  >
                    Connect Poco F3 via USB and click the one-tap button below (or copy the ADB
                    command). Set the phone server URL to{' '}
                    <code
                      style={{ color: 'var(--md-sys-color-primary)' }}
                      className="font-mono font-semibold"
                    >
                      127.0.0.1:{activePort}
                    </code>
                    .
                  </p>
                </div>

                <button
                  type="button"
                  disabled={adbBusy || localAdminForbidden}
                  onClick={() => void handleRunAdbReverse()}
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary)',
                    color: 'var(--md-sys-color-on-primary)',
                  }}
                  className="m3-morph-pill flex w-full items-center justify-center gap-2 py-3 text-xs font-semibold shadow-md disabled:opacity-45"
                >
                  {adbBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Cable className="h-4 w-4" />
                  )}
                  <span>
                    {localAdminForbidden
                      ? 'Available on Local PC Only'
                      : 'Connect Poco F3 via USB (ADB Reverse)'}
                  </span>
                </button>

                <div
                  style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
                  className="flex items-center justify-between gap-2 rounded-full px-4 py-2"
                >
                  <code
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="truncate font-mono text-xs"
                  >
                    {adbCommand}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyText('adb', adbCommand, 'ADB command')}
                    style={{
                      backgroundColor: 'var(--md-sys-color-secondary-container)',
                      color: 'var(--md-sys-color-on-secondary-container)',
                    }}
                    className="m3-morph-pill flex shrink-0 items-center gap-1 px-3 py-1 text-[11px] font-semibold"
                  >
                    {copiedKey === 'adb' ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    <span>Copy</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* CARD 3: PC USB & Server Tools (One-tap ADB Reverse + Live Server & Tunnel Logs) */}
      <div
        style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
        className="mb-4 rounded-[32px] p-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              style={{
                backgroundColor: 'var(--md-sys-color-tertiary-container)',
                color: 'var(--md-sys-color-on-tertiary-container)',
              }}
              className="flex h-11 w-11 items-center justify-center rounded-[16px]"
            >
              <Cable className="h-5 w-5" />
            </div>
            <div>
              <h2
                style={{ color: 'var(--md-sys-color-on-surface)' }}
                className="text-base font-semibold"
              >
                PC USB &amp; Server Tools
              </h2>
              <p
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="text-xs"
              >
                {localAdminForbidden
                  ? 'Server & USB management is only available on the local PC/LAN for security'
                  : 'One-tap ADB port forwarding and live PC hub diagnostics'}
              </p>
            </div>
          </div>

          {!localAdminForbidden && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={adbBusy || remoteCfgUnavailable}
                onClick={() => void handleRunAdbReverse()}
                style={{
                  backgroundColor: 'var(--md-sys-color-primary)',
                  color: 'var(--md-sys-color-on-primary)',
                }}
                className="m3-morph-pill flex items-center gap-2 px-5 py-2.5 text-xs font-semibold shadow-sm disabled:opacity-45"
              >
                {adbBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Cable className="h-3.5 w-3.5" />
                )}
                <span>Connect Poco F3 via USB (ADB Reverse)</span>
              </button>

              <button
                type="button"
                data-active={logsOpen}
                onClick={() => setLogsOpen((o) => !o)}
                style={{
                  backgroundColor: logsOpen
                    ? 'var(--md-sys-color-secondary-container)'
                    : 'var(--md-sys-color-surface-container-high)',
                  color: logsOpen
                    ? 'var(--md-sys-color-on-secondary-container)'
                    : 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold"
              >
                <FileTerminal className="h-3.5 w-3.5" />
                <span>{logsOpen ? 'Hide Server Logs' : 'Live Server Logs'}</span>
              </button>
            </div>
          )}
        </div>

        {adbStatus && (
          <div
            style={{
              backgroundColor: adbStatus.ok
                ? 'var(--md-sys-color-live-container)'
                : 'var(--md-sys-color-warn-container)',
              color: adbStatus.ok
                ? 'var(--md-sys-color-on-live-container)'
                : 'var(--md-sys-color-on-warn-container)',
            }}
            className="mt-4 flex items-center justify-between gap-2 rounded-[20px] px-4 py-3 font-mono text-xs"
          >
            <span>{adbStatus.output}</span>
            <span className="rounded-full bg-black/20 px-2.5 py-0.5 text-[10px] font-semibold">
              {adbStatus.ok ? 'USB Ready' : 'Notice'}
            </span>
          </div>
        )}

        {logsOpen && (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="text-xs font-semibold"
              >
                Live Server & Tunnel Output ({systemLogs.length} lines)
              </span>
              <button
                type="button"
                onClick={() => void refreshSystemLogs()}
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                  color: 'var(--md-sys-color-on-surface)',
                }}
                className="m3-morph-pill flex items-center gap-1 px-3 py-1 text-[11px] font-semibold"
              >
                <RefreshCw className={`h-3 w-3 ${loadingLogs ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>
            <div
              style={{
                backgroundColor: 'var(--md-sys-color-surface-container-lowest)',
                color: 'var(--md-sys-color-on-surface-variant)',
              }}
              className="max-h-56 overflow-y-auto rounded-[24px] p-4 font-mono text-[11px] leading-relaxed"
            >
              {systemLogs.length > 0 ? (
                systemLogs.map((line, i) => (
                  <div key={i} className="break-all whitespace-pre-wrap">
                    {line}
                  </div>
                ))
              ) : (
                <div className=" opacity-70">No server log entries available yet.</div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* COLLAPSIBLE CARD 4: TURN Relay (4G / 5G Strict CGNAT) */}
      {!remoteCfgUnavailable && (
        <div
          style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
          className="mb-4 rounded-[32px]"
        >
          <button
            type="button"
            onClick={() => setTurnOpen((o) => !o)}
            className="flex w-full items-center justify-between gap-3 px-6 py-5 text-left"
          >
            <div className="flex items-center gap-3">
              <div
                style={{
                  backgroundColor: 'var(--md-sys-color-secondary-container)',
                  color: 'var(--md-sys-color-on-secondary-container)',
                }}
                className="flex h-11 w-11 items-center justify-center rounded-[16px]"
              >
                <Server className="h-5 w-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    style={{ color: 'var(--md-sys-color-on-surface)' }}
                    className="text-sm font-semibold"
                  >
                    TURN Relay (4G / 5G Strict CGNAT)
                  </span>
                  <span
                    style={{
                      backgroundColor: turnConfigured
                        ? 'var(--md-sys-color-live-container)'
                        : 'var(--md-sys-color-surface-container-high)',
                      color: turnConfigured
                        ? 'var(--md-sys-color-on-live-container)'
                        : 'var(--md-sys-color-on-surface-variant)',
                    }}
                    className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                  >
                    {turnConfigured ? 'Configured' : 'STUN Only'}
                  </span>
                </div>
                <p
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  className="mt-0.5 text-xs"
                >
                  Optional WebRTC media relay for carrier-grade NAT mobile networks
                </p>
              </div>
            </div>
            {turnOpen ? (
              <ChevronUp
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="h-5 w-5 shrink-0"
              />
            ) : (
              <ChevronDown
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="h-5 w-5 shrink-0"
              />
            )}
          </button>

          {turnOpen && (
            <div className="px-6 pt-2 pb-6">
              <div
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-low)',
                  color: 'var(--md-sys-color-on-surface-variant)',
                }}
                className="mb-4 rounded-[22px] p-4 text-xs leading-relaxed"
              >
                <strong style={{ color: 'var(--md-sys-color-on-surface)' }}>
                  Quick setup tips:
                </strong>{' '}
                Most home Wi-Fi & many 4G/5G links connect directly via built-in STUN servers. If
                video stalls on strict cellular NAT, add a TURN relay from{' '}
                <span style={{ color: 'var(--md-sys-color-primary)' }}>
                  Cloudflare Calls TURN
                </span>
                ,{' '}
                <span style={{ color: 'var(--md-sys-color-primary)' }}>
                  Metered.ca Open Relay
                </span>
                , or self-hosted <code className="font-mono">coturn</code>.
              </div>

              <div className="space-y-3">
                {turnRows.map((row, idx) => (
                  <div
                    key={row.id}
                    style={{ backgroundColor: 'var(--md-sys-color-surface-container-high)' }}
                    className="grid gap-2.5 rounded-[22px] p-3.5 md:grid-cols-[1.6fr_1fr_1fr_auto]"
                  >
                    <input
                      type="text"
                      value={row.url}
                      onChange={(e) =>
                        setTurnRows((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, url: e.target.value } : r))
                        )
                      }
                      placeholder="turn:turn.example.com:3478?transport=udp"
                      style={{
                        backgroundColor: 'var(--md-sys-color-surface-container-low)',
                        color: 'var(--md-sys-color-on-surface)',
                      }}
                      className="rounded-full px-3.5 py-2 font-mono text-xs outline-none"
                    />
                    <input
                      type="text"
                      value={row.username}
                      onChange={(e) =>
                        setTurnRows((prev) =>
                          prev.map((r, i) => (i === idx ? { ...r, username: e.target.value } : r))
                        )
                      }
                      placeholder="Username"
                      style={{
                        backgroundColor: 'var(--md-sys-color-surface-container-low)',
                        color: 'var(--md-sys-color-on-surface)',
                      }}
                      className="rounded-full px-3.5 py-2 font-mono text-xs outline-none"
                    />
                    <input
                      type="password"
                      value={row.credential}
                      onChange={(e) =>
                        setTurnRows((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, credential: e.target.value } : r
                          )
                        )
                      }
                      placeholder="Credential"
                      style={{
                        backgroundColor: 'var(--md-sys-color-surface-container-low)',
                        color: 'var(--md-sys-color-on-surface)',
                      }}
                      className="rounded-full px-3.5 py-2 font-mono text-xs outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setTurnRows((prev) => prev.filter((_, i) => i !== idx))}
                      title="Remove TURN server"
                      style={{
                        backgroundColor: 'var(--md-sys-color-error-container)',
                        color: 'var(--md-sys-color-on-error-container)',
                      }}
                      className="m3-morph-pill flex h-9 w-9 items-center justify-center"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-2.5">
                <button
                  type="button"
                  onClick={() =>
                    setTurnRows((prev) => [
                      ...prev,
                      {
                        id: `turn-new-${Date.now()}`,
                        url: 'turn:',
                        username: '',
                        credential: '',
                      },
                    ])
                  }
                  style={{
                    backgroundColor: 'var(--md-sys-color-surface-container-high)',
                    color: 'var(--md-sys-color-on-surface)',
                  }}
                  className="m3-morph-pill flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add TURN Server</span>
                </button>

                <button
                  type="button"
                  disabled={savingRemote}
                  onClick={() => void handleSaveTurnServers()}
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary)',
                    color: 'var(--md-sys-color-on-primary)',
                  }}
                  className="m3-morph-pill px-5 py-2 text-xs font-semibold disabled:opacity-40"
                >
                  {savingRemote ? 'Saving…' : 'Save ICE / TURN Config'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* COLLAPSIBLE CARD 5: Browser / PWA Client Connection Override */}
      <div
        style={{ backgroundColor: 'var(--md-sys-color-surface-container)' }}
        className="rounded-[32px]"
      >
        <button
          type="button"
          onClick={() => setClientOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 px-6 py-5 text-left"
        >
          <div className="flex items-center gap-3">
            <div
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
              }}
              className="flex h-11 w-11 items-center justify-center rounded-[16px]"
            >
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <div
                style={{ color: 'var(--md-sys-color-on-surface)' }}
                className="text-sm font-semibold"
              >
                Browser Connection Settings
              </div>
              <p
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                className="mt-0.5 text-xs"
              >
                Connect this browser/PWA to a custom server URL or sign in with an access token
              </p>
            </div>
          </div>
          {clientOpen ? (
            <ChevronUp
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              className="h-5 w-5 shrink-0"
            />
          ) : (
            <ChevronDown
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              className="h-5 w-5 shrink-0"
            />
          )}
        </button>

        {clientOpen && (
          <form onSubmit={handleApplyClientSettings} className="space-y-3 px-6 pt-2 pb-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  className="mb-1.5 block text-xs font-semibold"
                >
                  Server URL (blank = current host {window.location.host})
                </label>
                <input
                  type="text"
                  value={draftClientUrl}
                  onChange={(e) => setDraftClientUrl(e.target.value)}
                  placeholder="https://your-tunnel.example.com or http://192.168.1.100:8787"
                  style={{
                    backgroundColor: 'var(--md-sys-color-surface-container-high)',
                    color: 'var(--md-sys-color-on-surface)',
                  }}
                  className="w-full rounded-full px-4 py-2.5 font-mono text-xs outline-none"
                />
              </div>

              <div>
                <label
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                  className="mb-1.5 block text-xs font-semibold"
                >
                  Access Token
                </label>
                <input
                  type="password"
                  value={draftClientToken}
                  onChange={(e) => setDraftClientToken(e.target.value)}
                  placeholder="Optional on LAN · Required remotely"
                  style={{
                    backgroundColor: 'var(--md-sys-color-surface-container-high)',
                    color: 'var(--md-sys-color-on-surface)',
                  }}
                  className="w-full rounded-full px-4 py-2.5 font-mono text-xs outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setDraftClientUrl('');
                  setDraftClientToken('');
                }}
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                  color: 'var(--md-sys-color-on-surface-variant)',
                }}
                className="m3-morph-pill px-4 py-2 text-xs font-semibold"
              >
                Reset to Default
              </button>
              <button
                type="submit"
                style={{
                  backgroundColor: 'var(--md-sys-color-primary)',
                  color: 'var(--md-sys-color-on-primary)',
                }}
                className="m3-morph-pill px-5 py-2 text-xs font-semibold"
              >
                Apply & Reconnect
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
