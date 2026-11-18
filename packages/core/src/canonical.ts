// Canonical JSON ("chatwarden-json-1"): one byte sequence for one value, so a bundle can be signed and checked later, by anyone, with nothing but this file.
//
//   - object keys sorted by code point (not by UTF-16 unit), no whitespace anywhere;
//   - strings are `JSON.stringify`'s, numbers are written the way JavaScript writes them (an integer as an integer);
//   - `-0`, `NaN`, `Infinity`, `undefined`, a function, a symbol, a bigint, a `Date` and any object with a prototype other than `Object.prototype` or `null` are
//     REFUSED with a `TypeError` (a `toJSON` method is never called), as is a cycle or a nesting deeper than 64 levels.
//
// It is browser-safe and dependency-free, and `sha256Hex` / `hmacSha256Hex` are the kit's own. Nothing here reads a store.

import { hmacSha256Hex, sha256Hex } from './crypto.js';

/** The name of the rules above, written into a bundle so a reader knows how to check it. */
export const CANONICALIZATION = 'chatwarden-json-1';

const MAX_DEPTH = 64;

/** Code point order of two strings (the order of UTF-8 bytes), which `<` on UTF-16 strings is not for characters above U+FFFF. */
function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('canonicalJson: nested too deep (or a cycle)');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: a number must be finite');
      if (Object.is(value, -0)) throw new TypeError('canonicalJson: negative zero is refused');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!(i in value)) throw new TypeError('canonicalJson: a sparse array is refused');
          parts.push(write(value[i], depth + 1));
        }
        return `[${parts.join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects, arrays and primitives are allowed');
      const keys = Object.keys(value as Record<string, unknown>).sort(compareCodePoints);
      const parts: string[] = [];
      for (const k of keys) parts.push(`${JSON.stringify(k)}:${write((value as Record<string, unknown>)[k], depth + 1)}`);
      return `{${parts.join(',')}}`;
    }
    default:
      // undefined, function, symbol, bigint
      throw new TypeError(`canonicalJson: a ${typeof value} is refused`);
  }
}

/**
 * The canonical text of a JSON value (see the rules at the top of this file). Throws a `TypeError` for anything JSON cannot say exactly.
 */
export function canonicalJson(value: unknown): string {
  return write(value, 0);
}

/** The shortest secret `signBundle` accepts: the same rule as a webhook secret. */
export const BUNDLE_SECRET_MIN = 32;

/** What an evidence bundle's `integrity` says. */
export interface BundleIntegrity {
  algorithm: 'sha256';
  /** Hex SHA-256 of the canonical JSON of the bundle, `integrity` holding only `algorithm`, `signedAt` and `canonicalization`. */
  sha256: string;
  /** Hex HMAC-SHA256 of the same bytes under the adopter's `bundleSecret`; null when the bundle was made without one ("not signed"). */
  hmacSha256: string | null;
  /** Epoch ms the kit signed it (its own clock). Covered by both digests. */
  signedAt: number;
  canonicalization: typeof CANONICALIZATION;
}

/** The bytes both digests cover: the bundle with `integrity` cut down to its three plain fields. */
function signedText(bundle: { integrity: BundleIntegrity }): string {
  const { integrity, ...rest } = bundle as { integrity: BundleIntegrity } & Record<string, unknown>;
  return canonicalJson({ ...rest, integrity: { algorithm: integrity.algorithm, signedAt: integrity.signedAt, canonicalization: integrity.canonicalization } });
}

/**
 * Fill `integrity` of a bundle whose other fields are final. With a `secret` (at least 32 characters) the HMAC is set; without one it is null.
 * Returns a new object. The signature proves the file came from this kit and was not edited since; it is not a timestamp authority.
 */
export function signBundle<B extends { integrity: BundleIntegrity }>(bundle: B, secret: string | undefined, signedAt: number): B {
  if (secret !== undefined && secret.length < BUNDLE_SECRET_MIN) throw new RangeError(`signBundle: the secret must be at least ${BUNDLE_SECRET_MIN} characters`);
  const draft = { ...bundle, integrity: { algorithm: 'sha256' as const, sha256: '', hmacSha256: null, signedAt, canonicalization: CANONICALIZATION } } as B;
  const text = signedText(draft);
  return { ...draft, integrity: { ...draft.integrity, sha256: sha256Hex(text), hmacSha256: secret === undefined ? null : hmacSha256Hex(secret, text) } };
}

/** Constant-time comparison of two hex strings of the same length. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Check a bundle (an object parsed from the file). `sha256` says the content is what the kit wrote; `hmac` says the kit that holds `secret` wrote it: true, false,
 * or null when no secret is given (nothing to check against). A bundle whose integrity or fields cannot be read counts as failing, never as an error.
 */
export function verifyBundle(bundle: { integrity: BundleIntegrity }, secret?: string): { sha256: boolean; hmac: boolean | null } {
  try {
    const i = bundle.integrity;
    if (i.algorithm !== 'sha256' || i.canonicalization !== CANONICALIZATION) return { sha256: false, hmac: secret === undefined ? null : false };
    const text = signedText(bundle);
    const sha = typeof i.sha256 === 'string' && sameHex(sha256Hex(text), i.sha256);
    if (secret === undefined) return { sha256: sha, hmac: null };
    const hmac = typeof i.hmacSha256 === 'string' && sameHex(hmacSha256Hex(secret, text), i.hmacSha256);
    return { sha256: sha, hmac };
  } catch {
    return { sha256: false, hmac: secret === undefined ? null : false };
  }
}
