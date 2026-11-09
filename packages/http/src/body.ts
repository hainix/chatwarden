import { HttpError } from './errors.js';

/** The largest request body, in bytes (UTF-8). */
export const BODY_MAX_BYTES = 65536;

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
 * - `undefined` or `''` -> `undefined` (a route that needs a body validates it itself).
 * - more than `max` bytes (UTF-8, not characters) -> 413 `payload_too_large`, before any parsing.
 * - not JSON -> 400 `invalid_json`.
 * - an object key `__proto__`, `constructor` or `prototype` anywhere -> 400 `forbidden_key`.
 * Errors are {@link HttpError}s with fixed messages: the body is never echoed.
 */
export function parseJson(rawBody: string | undefined, max: number = BODY_MAX_BYTES): unknown {
  if (rawBody === undefined || rawBody === '') return undefined;
  // A UTF-16 string has at most 3 UTF-8 bytes per unit, so a short one can skip the exact count.
  if (rawBody.length * 3 > max && Buffer.byteLength(rawBody, 'utf8') > max) throw new HttpError('payload_too_large');
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new HttpError('invalid_json');
  }
  if (hasForbiddenKey(value)) throw new HttpError('forbidden_key');
  return value;
}
