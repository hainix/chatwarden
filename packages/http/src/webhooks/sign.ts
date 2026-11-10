import { createHmac, timingSafeEqual } from 'node:crypto';

// The signing format shared by `webhooksOut` and `webhookIn`:
//
//   x-chatwarden-timestamp: <unix seconds, a decimal string>
//   x-chatwarden-signature: v1=<lowercase hex of HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
//
// A receiver rejects a timestamp more than 5 minutes from its clock and a signature it has already accepted.

/** The request header that carries the signing time (unix seconds, a decimal string). */
export const TIMESTAMP_HEADER = 'x-chatwarden-timestamp';
/** The request header that carries the signature, `v1=<64 lowercase hex>`. */
export const SIGNATURE_HEADER = 'x-chatwarden-signature';
/** The request header an outgoing delivery carries so a receiver can deduplicate (the same value on every retry). */
export const DELIVERY_HEADER = 'x-chatwarden-delivery';
/** How far a signed timestamp may be from the receiver's clock, either way: 5 minutes. */
export const SIGNATURE_WINDOW_MS = 300_000;
/** The shortest secret accepted, in characters. A shorter one throws when it is first used. */
export const MIN_SECRET_LENGTH = 32;
/** How many signatures the default {@link ReplayCache} remembers. */
export const REPLAY_CACHE_SIZE = 10_000;

const SIGNATURE_RE = /^v1=[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{1,15}$/;

/** Throws `RangeError` unless `secret` is a string of at least 32 characters. The message never contains the secret. */
export function checkSecret(secret: unknown, what = 'webhook secret'): asserts secret is string {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new RangeError(`${what} must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  }
}

/** The signature for a body: `v1=<lowercase hex>` over `${timestamp}.${body}`. `timestamp` is unix seconds. */
export function sign(secret: string, timestamp: number | string, body: string): string {
  checkSecret(secret);
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

/**
 * A bounded memory of the signatures a receiver has accepted, so the same signed request cannot be sent twice inside
 * the window. An LRU: at capacity the least recently used signature is forgotten (a replay of it would then pass, which
 * is what bounded memory costs). An entry also expires on its own, when its timestamp leaves the window.
 */
export class ReplayCache {
  private readonly max: number;
  /** Signature -> when it may be forgotten (epoch ms). Map order is recency: oldest first. */
  private readonly entries = new Map<string, number>();

  constructor(max: number = REPLAY_CACHE_SIZE) {
    if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1) {
      throw new RangeError('ReplayCache: capacity must be a positive whole number');
    }
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  /** True when `signature` is held and not expired at `now`. A hit makes it the most recently used. */
  has(signature: string, now: number): boolean {
    const expiresAt = this.entries.get(signature);
    if (expiresAt === undefined) return false;
    if (now > expiresAt) {
      this.entries.delete(signature);
      return false;
    }
    this.entries.delete(signature);
    this.entries.set(signature, expiresAt);
    return true;
  }

  /** Hold `signature` until `expiresAt` (epoch ms), after dropping what has expired and, at capacity, the least recently used. */
  add(signature: string, expiresAt: number, now: number): void {
    this.entries.delete(signature);
    for (const [held, until] of this.entries) {
      if (now <= until) break;
      this.entries.delete(held);
    }
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(signature, expiresAt);
  }
}

/**
 * Check a signed request. True only when ALL hold; every other case is false, and nothing is recorded:
 * - `x-chatwarden-timestamp` is a decimal string of unix seconds, within 300 s of `now` either way
 * - `x-chatwarden-signature` is `v1=` plus 64 lowercase hex characters
 * - it equals the HMAC-SHA256 of `${timestamp}.${rawBody}` under `secret` (compared in constant time)
 * - this signature has not been accepted before (`seen`)
 * On success the signature is remembered in `seen` until its timestamp leaves the window, so verifying the same request
 * again returns false. `now` is epoch milliseconds; `headers` are lowercase-named, as the adapters supply them. Throws
 * `RangeError` for a secret under 32 characters (a programming error, not a bad request).
 */
export function verify(
  secret: string,
  headers: Readonly<Record<string, string | undefined>>,
  rawBody: string,
  now: number,
  seen: ReplayCache,
): boolean {
  checkSecret(secret);
  if (typeof rawBody !== 'string' || !Number.isFinite(now)) return false;
  const timestamp = headers[TIMESTAMP_HEADER];
  const signature = headers[SIGNATURE_HEADER];
  if (typeof timestamp !== 'string' || !TIMESTAMP_RE.test(timestamp)) return false;
  if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return false;
  const signedAt = Number(timestamp) * 1000;
  if (Math.abs(now - signedAt) > SIGNATURE_WINDOW_MS) return false;

  const expected = Buffer.from(sign(secret, timestamp, rawBody).slice(3), 'hex');
  const given = Buffer.from(signature.slice(3), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;

  if (seen.has(signature, now)) return false;
  seen.add(signature, signedAt + SIGNATURE_WINDOW_MS, now);
  return true;
}
