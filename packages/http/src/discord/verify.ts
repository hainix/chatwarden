import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { ReplayCache } from '../webhooks/sign.js';

// Discord signs every interaction with Ed25519 over the timestamp header followed by the exact body bytes (K5 design 4.3 and 6.5). The check is the
// first thing the route does: nothing is parsed, read or acted on before it passes, and every way it can fail is the same `false`.

/** The request header that carries the signature: 128 hex characters. */
export const SIGNATURE_HEADER = 'x-signature-ed25519';
/** The request header that carries the signing time: unix seconds, a decimal string. */
export const TIMESTAMP_HEADER = 'x-signature-timestamp';
/** How far a signed timestamp may be from our clock, either way, unless the adopter says otherwise: 5 minutes. */
export const DEFAULT_TOLERANCE_MS = 300_000;

/** The fixed DER prefix of an Ed25519 public key (SubjectPublicKeyInfo); the 32 raw key bytes follow it. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const KEY_RE = /^[0-9a-fA-F]{64}$/;
const SIGNATURE_RE = /^[0-9a-fA-F]{128}$/;
const TIMESTAMP_RE = /^\d{1,15}$/;
/** Keys built so far, by lower-case hex. An adopter has one key; the bound is only a guard. */
const KEYS_MAX = 8;
const keys = new Map<string, KeyObject>();

/**
 * The public key object for 64 hex characters of raw Ed25519 key, built once per key. Null for anything else. Never throws.
 */
export function publicKeyOf(hex: unknown): KeyObject | null {
  if (typeof hex !== 'string' || !KEY_RE.test(hex)) return null;
  const id = hex.toLowerCase();
  const held = keys.get(id);
  if (held !== undefined) return held;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(id, 'hex')]), format: 'der', type: 'spki' });
    if (keys.size >= KEYS_MAX) {
      const oldest = keys.keys().next();
      if (oldest.done !== true) keys.delete(oldest.value);
    }
    keys.set(id, key);
    return key;
  } catch {
    return null;
  }
}

/**
 * Check a signed Discord request. True only when ALL hold, and every other case is false (nothing is recorded):
 * - `x-signature-timestamp` is a decimal string of unix seconds within `toleranceMs` of `now` either way;
 * - `x-signature-ed25519` is 128 hex characters (either case);
 * - it is the Ed25519 signature, under `publicKeyHex` (64 hex characters of raw key), of the timestamp text followed by `rawBody` exactly;
 * - this signature has not been accepted before (`replay`).
 * On success the signature is remembered until its timestamp leaves the window. `now` is epoch milliseconds; `headers` are lower-case named, as the
 * adapters supply them. Never throws.
 */
export function verifyInteraction(
  publicKeyHex: string,
  headers: Readonly<Record<string, string | undefined>>,
  rawBody: string,
  now: number,
  toleranceMs: number,
  replay: ReplayCache,
): boolean {
  try {
    if (typeof rawBody !== 'string' || !Number.isFinite(now) || !Number.isFinite(toleranceMs)) return false;
    const timestamp = headers[TIMESTAMP_HEADER];
    const signature = headers[SIGNATURE_HEADER];
    if (typeof timestamp !== 'string' || !TIMESTAMP_RE.test(timestamp)) return false;
    if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) return false;
    const signedAt = Number(timestamp) * 1000;
    if (Math.abs(now - signedAt) > toleranceMs) return false;
    const key = publicKeyOf(publicKeyHex);
    if (key === null) return false;
    // The timestamp and the body are joined as text, as Discord signs them; a body that is not valid UTF-8 was already changed by the adapter and fails here.
    if (!verify(null, Buffer.from(timestamp + rawBody, 'utf8'), key, Buffer.from(signature, 'hex'))) return false;
    const id = signature.toLowerCase();
    if (replay.has(id, now)) return false;
    replay.add(id, signedAt + toleranceMs, now);
    return true;
  } catch {
    return false;
  }
}
