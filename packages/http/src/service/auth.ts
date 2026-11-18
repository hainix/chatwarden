// Service keys (design 3.2): `Authorization: Bearer <key>`, compared by digest against every configured key, with a throttle on failures by address that only turns an invalid token away early: a valid key always passes. Browser-safe.
import { HttpError } from '../errors.js';
import { checkLimit, MAX_LIMITER_KEYS } from '../limiter.js';
import type { NamesRateLimit } from '../limiter.js';
import type { Authenticate } from '../auth.js';
import type { KitRequest } from '../types.js';
import { equalDigests, sha256, toHex } from './digest.js';

const KEY_RE = /^[A-Za-z0-9_\-.~+/=]{32,256}$/;
const BEARER_RE = /^bearer ([^\s]+)$/i;
/** A presented token longer than this cannot be a key: it is compared as empty (and so refused) without hashing a huge value. */
const TOKEN_MAX = 512;
const DEFAULT_FAILURES: NamesRateLimit = { max: 20, windowMs: 60_000 };

/**
 * The service keys, checked: one to five, each 32 to 256 characters of `A-Za-z0-9_-.~+/=`, none repeated. A `RangeError` whose message never carries a key. Returns a copy.
 */
export function parseKeys(keys: unknown): string[] {
  const fail = (): never => {
    throw new RangeError('service keys: give one to five keys of 32 to 256 characters of A-Z a-z 0-9 _ - . ~ + / =, none repeated');
  };
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 5) return fail();
  for (const key of keys as unknown[]) if (typeof key !== 'string' || !KEY_RE.test(key)) return fail();
  if (new Set(keys as string[]).size !== keys.length) return fail();
  return [...(keys as string[])];
}

/** Failures by address (also the staff sign-in's), in a bounded table: a fixed window from the first failure. Insertion order is window-start order, so the oldest is swept from the front. */
export class FailureThrottle {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: NamesRateLimit;
  constructor(limit: NamesRateLimit) {
    this.limit = limit;
  }

  private sweep(now: number): void {
    for (const [k, w] of this.windows) {
      if (now - w.start < this.limit.windowMs) break;
      this.windows.delete(k);
    }
  }

  /** 0 when the address may try; else the milliseconds until its window ends. */
  blockedFor(address: string, now: number): number {
    this.sweep(now);
    const w = this.windows.get(address);
    if (w === undefined || w.count < this.limit.max) return 0;
    return Math.max(1, w.start + this.limit.windowMs - now);
  }

  record(address: string, now: number): void {
    this.sweep(now);
    const w = this.windows.get(address);
    if (w !== undefined) {
      w.count++;
      return;
    }
    if (this.windows.size >= MAX_LIMITER_KEYS) {
      const oldest = this.windows.keys().next();
      if (oldest.done !== true) this.windows.delete(oldest.value);
    }
    this.windows.set(address, { start: now, count: 1 });
  }

  size(): number {
    return this.windows.size;
  }
}

/** What both kinds of authentication offer the wrapper: the caller's `kid` (8 hex characters, safe to log) or a thrown 401 or 429. */
export interface ServiceAuth {
  authenticate(req: KitRequest): Promise<string>;
  /** How many addresses the failure throttle holds (for tests and metrics). */
  throttled(): number;
}

export interface KeyAuthOptions {
  keys: readonly string[];
  now?: () => number;
  failureLimit?: NamesRateLimit;
  /** The digest comparison. Default constant-time. A test passes a spy to prove every digest is compared. */
  compare?: (a: Uint8Array, b: Uint8Array) => boolean;
}

export interface KeyAuth extends ServiceAuth {
  /** Replace the keys in force (a rotation). Takes effect for the next request. */
  replaceKeys(keys: readonly string[]): void;
}

const unauthorized = (): HttpError => new HttpError('unauthorized', { 'www-authenticate': 'Bearer' });
const tooMany = (waitMs: number): HttpError => new HttpError('rate_limited', { 'retry-after': String(Math.max(1, Math.ceil(waitMs / 1000))) });

/** Keys held as digests (never the key), the failure throttle over them. */
export function createKeyAuth(options: KeyAuthOptions): KeyAuth {
  const now = options.now ?? Date.now;
  const compare = options.compare ?? equalDigests;
  const throttle = new FailureThrottle(checkLimit(options.failureLimit, DEFAULT_FAILURES, 'serviceRoutes: authFailureLimit'));
  const digestsOf = (keys: readonly string[]): Promise<Uint8Array[]> => Promise.all(parseKeys(keys).map((key) => sha256(key)));
  let digests = digestsOf(options.keys);
  // A rejected start-up digest (no Web Crypto) is reported on the first request, not as an unhandled rejection here.
  digests.catch(() => undefined);

  return {
    replaceKeys(keys) {
      digests = digestsOf(keys);
      digests.catch(() => undefined);
    },
    throttled: () => throttle.size(),
    async authenticate(req) {
      const address = req.remoteAddress ?? '';
      const header = req.headers.authorization;
      let token = header === undefined ? '' : (BEARER_RE.exec(header)?.[1] ?? '');
      if (token.length > TOKEN_MAX) token = '';
      const presented = await sha256(token);
      let match = -1;
      const held = await digests;
      // Every digest is compared, whether or not an earlier one matched, so the time says nothing about which key it was.
      for (let i = 0; i < held.length; i++) if (compare(presented, held[i] as Uint8Array) && match === -1 && token !== '') match = i;
      if (match === -1) {
        // A valid key always passes (a stale-key server behind a shared address must not lock out the fleet); the throttle only turns an INVALID token away early.
        const blocked = throttle.blockedFor(address, now());
        if (blocked > 0) throw tooMany(blocked);
        throttle.record(address, now());
        throw unauthorized();
      }
      return toHex(held[match] as Uint8Array).slice(0, 8);
    },
  };
}

/** The adopter's own `Authenticate` hook in place of keys: a returned caller passes, `null` is 401. The `kid` is the first 8 hex characters of the digest of the actor. A throw is the hook's: a 500, no detail. */
export function createHookAuth(hook: Authenticate, options: { now?: () => number; failureLimit?: NamesRateLimit } = {}): ServiceAuth {
  const now = options.now ?? Date.now;
  const throttle = new FailureThrottle(checkLimit(options.failureLimit, DEFAULT_FAILURES, 'serviceRoutes: authFailureLimit'));
  return {
    throttled: () => throttle.size(),
    async authenticate(req) {
      const address = req.remoteAddress ?? '';
      const authz = await hook(req);
      const actor = (authz as { actor?: unknown } | null)?.actor;
      if (typeof actor !== 'string' || actor === '') {
        const blocked = throttle.blockedFor(address, now());
        if (blocked > 0) throw tooMany(blocked);
        throttle.record(address, now());
        throw unauthorized();
      }
      return toHex(await sha256(actor)).slice(0, 8);
    },
  };
}
