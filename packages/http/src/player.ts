import { createHash, randomBytes } from 'node:crypto';
import { errorClass, playerReporting, safeWarn } from '@chatwarden/core';
import type { Chatwarden, DocumentFormat, Logger, RawWho } from '@chatwarden/core';
import { bodyObject } from './admin/validate.js';
import { DEFAULT_GAME_NAME } from './admin/policy.js';
import { HttpError, ValidationError, withErrors } from './errors.js';
import type { RouteTable } from './router.js';
import type { KitRequest, KitResponse } from './types.js';

/** The names rate limit: at most `max` checks per `windowMs` per identity. */
export interface NamesRateLimit {
  max: number;
  windowMs: number;
}

/** What the adopter gives the player API. */
export interface PlayerOptions {
  /**
   * Who is calling, as the doors take it: the client token, account or address. May be async. The raw `clientKey` is
   * a credential: the kit hashes it (core) and keeps nothing raw past the request. A hook that throws, rejects or
   * returns a non-object is treated as "nobody": empty lists, `{ ok: false }` on ack, and a log of the error class only.
   */
  identify: (req: KitRequest) => RawWho | Promise<RawWho>;
  /** Named in the code of conduct. Default `Our game`. */
  gameName?: string;
  /** Where a player can contest a decision (an http(s) URL; anything else is left out of the document). */
  contactUrl?: string;
  /** `POST /names/check` limit per identity. Default 20 per minute. Both must be positive whole numbers (`RangeError`). */
  namesRateLimit?: NamesRateLimit;
  /** Where failures are logged (event and error class only). Defaults to `console.warn`. */
  logger?: Logger;
  /** Epoch-ms clock for the rate limit. Default `Date.now`. */
  now?: () => number;
}

/** The names limiter never holds more keys than this. */
const MAX_LIMITER_KEYS = 10_000;
const DEFAULT_NAMES_LIMIT: NamesRateLimit = { max: 20, windowMs: 60_000 };
const NAME_MAX = 64;

const NO_STORE = { 'cache-control': 'no-store' } as const;
/**
 * The `content-security-policy` of the HTML code of conduct: it may load nothing and run nothing; its one inline style
 * block is the only thing allowed. Exported so an example server serving the same page uses this value, not a copy.
 */
export const CODE_OF_CONDUCT_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const CONTENT_TYPES: Readonly<Record<DocumentFormat, string>> = {
  html: 'text/html; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  text: 'text/plain; charset=utf-8',
};

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

function checkLimit(limit: unknown): NamesRateLimit {
  if (limit === undefined) return DEFAULT_NAMES_LIMIT;
  const l = limit as { max?: unknown; windowMs?: unknown } | null;
  if (typeof l !== 'object' || l === null || !isPositiveInt(l.max) || !isPositiveInt(l.windowMs)) {
    throw new RangeError('playerRoutes: namesRateLimit needs a positive whole max and windowMs');
  }
  return { max: l.max, windowMs: l.windowMs };
}

/**
 * A fixed-window counter per key, bounded. Entries live in insertion order, which is also window-start order (a reset
 * re-inserts), so expired ones are swept from the front in O(1) each. At the cap, the oldest live key goes.
 */
class Limiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: NamesRateLimit;
  constructor(limit: NamesRateLimit) {
    this.limit = limit;
  }

  /** 0 when the call is allowed (and counted); otherwise the milliseconds until the window reopens. */
  hit(key: string, now: number): number {
    const { max, windowMs } = this.limit;
    for (const [k, w] of this.windows) {
      if (now - w.start < windowMs) break;
      this.windows.delete(k);
    }
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= windowMs) {
      this.windows.delete(key);
      if (this.windows.size >= MAX_LIMITER_KEYS) {
        const oldest = this.windows.keys().next();
        if (oldest.done !== true) this.windows.delete(oldest.value);
      }
      this.windows.set(key, { start: now, count: 1 });
      return 0;
    }
    if (w.count < max) {
      w.count++;
      return 0;
    }
    return Math.min(windowMs, Math.max(1, w.start + windowMs - now));
  }
}

const known = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * The player API as a route table: hand it to `createRouter` beside the staff routes. Every response is built from
 * the core's player-facing values only: no subject id, key or IP hash, room, group, moderator or reason.
 * - `GET /notices` -> `{ notices }`: notices not yet acknowledged, oldest first.
 * - `POST /notices/:id/ack` -> `{ ok }`. `ok: false` (still 200) for a notice that is not the caller's, an unknown id,
 *   or an unknown caller, so ids cannot be probed.
 * - `GET /record` -> `{ record }`: the caller's sanction notices that still apply.
 * - `GET /rules` -> `{ summary, rules, reporting }`: active rules as `{ number, title, text }`, and `reporting`: `{ flow, reasons, thanks }`,
 *   what the report screen shows: the flow (`one_tap`, `reason_first` or `reason_required`), the ENABLED reasons in order as
 *   `{ id, label, hint, group, asksNote }` (no rule mapping, no staff field) and the thank-you copy. Public, and live.
 * - `GET /code-of-conduct?format=html|markdown|text` (default markdown; anything else 400). The string body goes out
 *   with the `content-type` given here. HTML is a full document with a CSP of `default-src 'none'; style-src
 *   'unsafe-inline'`; every format has `x-content-type-options: nosniff`.
 * - `POST /names/check { name }` -> the core's answer. `name` is a string of 1..64 characters. Limited per identity
 *   (default 20 a minute): 429 `rate_limited` with `retry-after` in seconds. The limiter holds a salted SHA-256 of the
 *   identity (account, else client key, else address; one shared bucket for nobody), never a raw value.
 * An unknown, IP-only or failed identity gets empty lists and 200.
 */
export function playerRoutes(cw: Chatwarden, options: PlayerOptions): RouteTable {
  const { logger } = options;
  if (typeof options.identify !== 'function') throw new TypeError('playerRoutes: identify must be a function');
  const identifyHook = options.identify;
  const limit = checkLimit(options.namesRateLimit);
  const now = options.now ?? Date.now;
  const gameName = options.gameName ?? DEFAULT_GAME_NAME;
  const contact = options.contactUrl === undefined ? {} : { contactUrl: options.contactUrl };
  // Fail at start-up, not on the first request, when the game name cannot head a document (RangeError).
  cw.documents.codeOfConduct({ format: 'markdown', gameName, ...contact });

  const limiter = new Limiter(limit);
  // Per-instance, in memory only: the limiter keys cannot be recomputed or compared across restarts or processes.
  const salt = randomBytes(32);
  const keyFor = (who: RawWho): string => {
    const ip = known(who.ip) && who.ip !== 'unknown' ? who.ip : undefined;
    const [kind, value] = known(who.accountId)
      ? (['account', who.accountId] as const)
      : known(who.clientKey)
        ? (['key', who.clientKey] as const)
        : ip !== undefined
          ? (['ip', ip] as const)
          : (['anonymous', ''] as const);
    return createHash('sha256').update(salt).update(`${kind}\0${value}`).digest('hex');
  };

  /** The caller, as a fresh object of the known fields only. Fails closed to nobody. */
  const identify = async (req: KitRequest): Promise<RawWho> => {
    let raw: unknown;
    try {
      raw = await identifyHook(req);
    } catch (err) {
      safeWarn(logger, 'chatwarden.http_identify_failed', { error: errorClass(err) });
      return {};
    }
    if (typeof raw !== 'object' || raw === null) return {};
    const r = raw as Record<string, unknown>;
    const who: RawWho = {};
    if (typeof r.clientKey === 'string') who.clientKey = r.clientKey;
    if (typeof r.accountId === 'string') who.accountId = r.accountId;
    if (typeof r.ip === 'string') who.ip = r.ip;
    return who;
  };

  const personal = (body: unknown): KitResponse => ({ status: 200, headers: { ...NO_STORE }, body });
  const route = (handler: (req: KitRequest, params: Record<string, string>) => KitResponse | Promise<KitResponse>) =>
    withErrors(handler, logger);

  return {
    'GET /notices': route(async (req) => personal({ notices: cw.notices.pending(await identify(req)) })),

    'GET /record': route(async (req) => personal({ record: cw.notices.record(await identify(req)) })),

    'POST /notices/:id/ack': route(async (req, params) =>
      personal({ ok: cw.notices.ack(await identify(req), params.id as string) }),
    ),

    'GET /rules': route(() => ({
      status: 200,
      body: {
        summary: cw.summary,
        // The public shape: number, title, text. (`retired` is dropped: only active rules are listed.)
        rules: cw.rules.active().map((r) => ({ number: r.number, title: r.title, text: r.text })),
        // What the report screen needs; `playerReporting` copies each field by name, so nothing of the staff side can leak in.
        reporting: playerReporting(cw.profile.reporting),
      },
    })),

    'GET /code-of-conduct': route((req) => {
      const raw = req.query.format;
      if (raw !== undefined && !Object.hasOwn(CONTENT_TYPES, raw)) throw new HttpError('invalid_query');
      const format = (raw ?? 'markdown') as DocumentFormat;
      const doc = cw.documents.codeOfConduct({ format, gameName, ...contact });
      const headers: Record<string, string> = {
        'content-type': CONTENT_TYPES[format],
        'x-content-type-options': 'nosniff',
      };
      if (format !== 'html') return { status: 200, headers, body: doc };
      headers['content-security-policy'] = CODE_OF_CONDUCT_CSP;
      return {
        status: 200,
        headers,
        body:
          '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<title>Code of conduct</title>' +
          '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem}' +
          'table{border-collapse:collapse}th,td{border:1px solid #888;padding:.25rem .5rem;text-align:left}</style>' +
          `</head><body>${doc}</body></html>`,
      };
    }),

    'POST /names/check': route(async (req) => {
      const who = await identify(req);
      // Limit first, so malformed and refused requests count too.
      const wait = limiter.hit(keyFor(who), now());
      if (wait > 0) throw new HttpError('rate_limited', { 'retry-after': String(Math.ceil(wait / 1000)) });
      const name = bodyObject(req).name;
      if (typeof name !== 'string' || name.length < 1 || name.length > NAME_MAX) throw new ValidationError();
      return personal(cw.names.check(name));
    }),
  };
}
