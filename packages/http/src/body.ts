import { HttpError } from './errors.js';

/** The largest request body, in bytes (UTF-8). */
export const BODY_MAX_BYTES = 65536;

/**
 * The length of `text` in UTF-8 bytes, counted over its UTF-16 code units: no `Buffer` (so it runs in a browser) and no
 * encoded copy. 1, 2 or 3 bytes a unit; a surrogate pair is 4 bytes; a lone surrogate is 3 (the encoder writes U+FFFD),
 * the same as `Buffer.byteLength` and `TextEncoder`.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** True when any object key, at any depth and inside arrays, is one that can poison a prototype. Iterative: depth is attacker-chosen. */
function hasForbiddenKey(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.has(key)) return true;
      stack.push((node as Record<string, unknown>)[key]);
    }
  }
  return false;
}

/**
 * Read a JSON request body.
 * - `max` must be a positive integer, else `RangeError` (a programming error, not a request error).
 * - `undefined` or `''` -> `undefined` (a route that needs a body validates it itself).
 * - more than `max` bytes (UTF-8, not characters) -> 413 `payload_too_large`, before any parsing.
 * - not JSON -> 400 `invalid_json`.
 * - an object key `__proto__`, `constructor` or `prototype` anywhere -> 400 `forbidden_key`.
 * Errors are {@link HttpError}s with fixed messages: the body is never echoed.
 */
export function parseJson(rawBody: string | undefined, max: number = BODY_MAX_BYTES): unknown {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('parseJson: max must be a positive integer');
  if (rawBody === undefined || rawBody === '') return undefined;
  // A UTF-16 string has at most 3 UTF-8 bytes per unit, so a short one can skip the exact count.
  if (rawBody.length * 3 > max && utf8ByteLength(rawBody) > max) throw new HttpError('payload_too_large');
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new HttpError('invalid_json');
  }
  if (hasForbiddenKey(value)) throw new HttpError('forbidden_key');
  return value;
}
