/**
 * PurrCam Protocol v1.2 §8 — Encrypted Zero-Account Auto-Discovery Beacon.
 *
 * Uses standard WebCrypto AES-256-GCM + SHA-256 so outputs are byte-for-byte identical
 * across Node.js (`server`), Android JVM (`android`), and Web browsers (`web`).
 */

function isValidHttpsUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const BEACON_ENDPOINTS = ['https://ntfy.sh', 'https://ntfy.envs.net'] as const;

export interface BeaconPayload {
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

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Derives deterministic 40-char topic ID:
 * `purrcam-` + lowercase hex(SHA-256("purrcam:beacon:topic:v1:" + token)).slice(0, 32)
 */
export async function deriveBeaconTopicId(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`purrcam:beacon:topic:v1:${token}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return `purrcam-${bytesToHex(new Uint8Array(digest)).slice(0, 32)}`;
}

/**
 * Derives 256-bit AES-GCM CryptoKey:
 * SHA-256("purrcam:beacon:aes256:v1:" + token)
 */
export async function deriveBeaconAesKey(token: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`purrcam:beacon:aes256:v1:${token}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return globalThis.crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
}

/**
 * Decrypts and validates a single encrypted beacon envelope JSON string:
 * `{"v":1,"iv":"<base64-12B>","ct":"<base64-ciphertext||16B-tag>"}`
 */
export async function decryptBeaconEnvelope(
  envelopeJson: string,
  key: CryptoKey
): Promise<BeaconPayload | null> {
  let parsed: Partial<BeaconEnvelope>;
  try {
    parsed = JSON.parse(envelopeJson) as Partial<BeaconEnvelope>;
  } catch {
    return null;
  }

  if (parsed.v !== 1 || typeof parsed.iv !== 'string' || typeof parsed.ct !== 'string') {
    return null;
  }

  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = base64ToBytes(parsed.iv);
    ct = base64ToBytes(parsed.ct);
  } catch {
    return null;
  }

  // AES-256-GCM requires a 12-byte IV and at least a 16-byte authentication tag
  if (iv.length !== 12 || ct.length < 16) {
    return null;
  }

  try {
    const plainBuffer = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 },
      key,
      ct as BufferSource
    );
    const plainText = new TextDecoder().decode(plainBuffer);
    const payload = JSON.parse(plainText) as Partial<BeaconPayload>;

    if (
      payload.v !== 1 ||
      typeof payload.url !== 'string' ||
      typeof payload.wsUrl !== 'string' ||
      typeof payload.ts !== 'number' ||
      !Number.isFinite(payload.ts)
    ) {
      return null;
    }

    const cleanUrl = payload.url.trim();
    const cleanWsUrl = payload.wsUrl.trim();
    if (!cleanUrl.startsWith('https://') || !cleanWsUrl.startsWith('wss://')) {
      return null;
    }
    if (!isValidHttpsUrl(cleanUrl)) {
      return null;
    }

    return {
      v: 1,
      url: cleanUrl,
      wsUrl: cleanWsUrl,
      provider: typeof payload.provider === 'string' ? payload.provider : 'unknown',
      ts: payload.ts,
    };
  } catch {
    return null;
  }
}

async function pollSingleEndpoint(
  baseUrl: string,
  topicId: string,
  key: CryptoKey,
  outerSignal?: AbortSignal
): Promise<BeaconPayload | null> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 8_000);

  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) {
      globalThis.clearTimeout(timeout);
      return null;
    }
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    const res = await fetch(`${baseUrl}/${topicId}/json?poll=1&since=all`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const text = await res.text();
    const lines = text.split(/\r?\n/);
    let newest: BeaconPayload | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let eventObj: { event?: string; message?: string };
      try {
        eventObj = JSON.parse(trimmed) as { event?: string; message?: string };
      } catch {
        continue;
      }
      if (eventObj.event !== 'message' || typeof eventObj.message !== 'string') {
        continue;
      }

      const decrypted = await decryptBeaconEnvelope(eventObj.message, key);
      if (decrypted && (!newest || decrypted.ts > newest.ts)) {
        newest = decrypted;
      }
    }

    return newest;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Polls both public ntfy endpoints in parallel, decrypts all valid beacon entries using `token`,
 * and returns the freshest valid remote tunnel endpoint (highest `ts`), or null if none found.
 */
export async function discoverRemoteFromBeacon(
  token: string,
  signal?: AbortSignal
): Promise<BeaconPayload | null> {
  const trimmed = token.trim();
  if (!trimmed || typeof globalThis.crypto?.subtle === 'undefined') {
    return null;
  }

  try {
    const [topicId, key] = await Promise.all([
      deriveBeaconTopicId(trimmed),
      deriveBeaconAesKey(trimmed),
    ]);

    const results = await Promise.all(
      BEACON_ENDPOINTS.map((endpoint) => pollSingleEndpoint(endpoint, topicId, key, signal))
    );

    let best: BeaconPayload | null = null;
    for (const item of results) {
      if (item && (!best || item.ts > best.ts)) {
        best = item;
      }
    }
    return best;
  } catch {
    return null;
  }
}
