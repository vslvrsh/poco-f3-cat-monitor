import crypto from "node:crypto";

/**
 * Constant-time token comparison using SHA-256 digests + crypto.timingSafeEqual
 * so both inputs are always 32 bytes (zero length leak, zero timing oracle).
 */
export function constantTimeTokenEqual(
  provided: string | undefined | null,
  expected: string | undefined | null
): boolean {
  if (
    typeof provided !== "string" ||
    typeof expected !== "string" ||
    provided.length === 0 ||
    expected.length === 0
  ) {
    return false;
  }
  const hashProvided = crypto.createHash("sha256").update(provided, "utf8").digest();
  const hashExpected = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}

/**
 * Generates a cryptographically secure 192-bit (32-char URL-safe base64url) access token.
 */
export function generateStrongToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Validates that a buffer starts with standard JPEG SOI + marker magic bytes (0xFF 0xD8 0xFF).
 */
export function isValidJpegBuffer(buffer: Buffer): boolean {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  );
}

export interface AuthRateLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  maxTrackedKeys?: number;
}

/**
 * In-memory per-IP sliding-window rate limiter for failed authentication attempts.
 */
export class AuthRateLimiter {
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly maxTrackedKeys: number;

  private readonly buckets = new Map<string, number[]>();

  constructor(options: AuthRateLimiterOptions = {}) {
    this.maxFailures = Math.max(1, options.maxFailures ?? 15);
    this.windowMs = Math.max(1000, options.windowMs ?? 5 * 60 * 1000);
    this.maxTrackedKeys = Math.max(100, options.maxTrackedKeys ?? 10_000);
  }

  private prune(key: string, now: number): number[] {
    const existing = this.buckets.get(key);
    if (!existing || existing.length === 0) return [];
    const cutoff = now - this.windowMs;
    const kept = existing.filter((ts) => ts > cutoff);
    if (kept.length === 0) {
      this.buckets.delete(key);
    } else if (kept.length !== existing.length) {
      this.buckets.set(key, kept);
    }
    return kept;
  }

  isRateLimited(key: string, now = Date.now()): boolean {
    const kept = this.prune(key, now);
    return kept.length >= this.maxFailures;
  }

  getRetryAfterSec(key: string, now = Date.now()): number {
    const kept = this.prune(key, now);
    if (kept.length < this.maxFailures) return 0;
    const oldest = kept[0];
    const remainingMs = Math.max(1000, oldest + this.windowMs - now);
    return Math.ceil(remainingMs / 1000);
  }

  recordFailure(key: string, now = Date.now()): boolean {
    const kept = this.prune(key, now);
    kept.push(now);

    if (!this.buckets.has(key) && this.buckets.size >= this.maxTrackedKeys) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey !== undefined) {
        this.buckets.delete(oldestKey);
      }
    }

    this.buckets.set(key, kept);
    return kept.length >= this.maxFailures;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }
}
