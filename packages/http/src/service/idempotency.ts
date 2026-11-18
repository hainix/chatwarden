// `Idempotency-Key` (design 3.2): the answer of a finished call, kept in memory for ten minutes (at most 20 000 entries), so a retry is not judged twice. Browser-safe.
import { ValidationError } from '../errors.js';
import { sha256Hex } from './digest.js';

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX = 20_000;
/** A body nested deeper than this is refused rather than walked. */
const DEPTH_MAX = 64;

interface Entry {
  at: number;
  fingerprint: string;
  done: boolean;
  status: number;
  body: unknown;
}

/** What `finish` and `abandon` take back: the reservation this call made. */
export interface IdempotencyToken {
  readonly id: string;
  readonly entry: Entry;
}

export type IdempotencyBegin =
  | { kind: 'new'; token: IdempotencyToken }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' }
  | { kind: 'in_progress' };

export interface IdempotencyStore {
  /** Reserve `(scope, key)` for a call with this body fingerprint, or say what is already there. */
  begin(scope: string, key: string, fingerprint: string): IdempotencyBegin;
  /** The call finished: keep its answer, unless it is a 5xx, a 401 or a 429 (the retry may succeed): then the key is free again. */
  finish(token: IdempotencyToken, status: number, body: unknown): void;
  /** The call did not finish (it threw): the key is free again. */
  abandon(token: IdempotencyToken): void;
  size(): number;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

export function createIdempotencyStore(options: { now: () => number; ttlMs?: number; max?: number }): IdempotencyStore {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const max = options.max ?? DEFAULT_MAX;
  if (!positive(ttl) || !positive(max)) throw new RangeError('idempotency: ttlMs and max must be positive whole numbers');
  const entries = new Map<string, Entry>();

  const sweep = (now: number): void => {
    for (const [id, entry] of entries) {
      if (now - entry.at < ttl) break;
      entries.delete(id);
    }
  };

  return {
    size: () => entries.size,
    begin(scope, key, fingerprint) {
      const now = options.now();
      sweep(now);
      const id = JSON.stringify([scope, key]);
      const found = entries.get(id);
      if (found !== undefined) {
        if (found.fingerprint !== fingerprint) return { kind: 'mismatch' };
        if (!found.done) return { kind: 'in_progress' };
        return { kind: 'replay', status: found.status, body: found.body };
      }
      while (entries.size >= max) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      const entry: Entry = { at: now, fingerprint, done: false, status: 0, body: undefined };
      entries.set(id, entry);
      return { kind: 'new', token: { id, entry } };
    },
    finish(token, status, body) {
      if (entries.get(token.id) !== token.entry) return;
      if (status >= 500 || status === 401 || status === 429) {
        entries.delete(token.id);
        return;
      }
      token.entry.done = true;
      token.entry.status = status;
      token.entry.body = body;
    },
    abandon(token) {
      if (entries.get(token.id) === token.entry) entries.delete(token.id);
    },
  };
}

/** The body as canonical JSON: object keys sorted at every depth. A body nested deeper than 64 levels is 400 `invalid_request`. */
function canonical(value: unknown, depth: number): string {
  if (depth > DEPTH_MAX) throw new ValidationError();
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k], depth + 1)}`)
    .join(',')}}`;
}

/** The SHA-256 (64 hex characters) of the canonical form of a parsed body: the same for the same content whatever the key order. */
export function fingerprintOf(body: unknown): Promise<string> {
  return sha256Hex(canonical(body, 0));
}
