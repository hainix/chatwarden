// The chat box's HTTP routes (design 6.3, 6.4, 8.1, 11): a Server-Sent Events stream down and JSON `POST`s up, over a `RoomBroadcaster`. They
// guard the request (origin, content type, body shape, identity, rate limits, the game's `join`) and then hand it to a session; the line
// itself is judged by the kit alone. Browser-safe: no `node:` import, no `Buffer`, no `fetch`, no DOM.
import { errorClass, makeHasher, safeWarn } from '@chatwarden/core';
import type { Chatwarden, Logger, RawWho } from '@chatwarden/core';
import { bodyObject } from '../admin/validate.js';
import { HttpError, ValidationError, withErrors } from '../errors.js';
import { checkLimit, Limiter } from '../limiter.js';
import type { NamesRateLimit } from '../limiter.js';
import type { RouteTable } from '../router.js';
import type { KitRequest, KitResponse } from '../types.js';
import type { ChatMember, ChatSession, RoomBroadcaster } from './broadcaster.js';
import { randomHex } from './random.js';
import { encodeFrame, HEARTBEAT } from './sse.js';
import type { ChatFrame, WireRefusal } from './wire.js';

/** @experimental */
export interface ChatRoutesOptions {
  /** Who is calling. Exactly the `identify` of `playerRoutes`: the same function can be passed to both. A caller with neither `accountId` nor `clientKey` is `401 unauthorized` (an address alone cannot chat). */
  identify: (req: KitRequest) => RawWho | Promise<RawWho>;
  /** May this player enter this room, and under what name? `null` is `403 forbidden`. Required: the kit does not guess who may be where. */
  join: (req: KitRequest, roomId: string, who: RawWho) => ChatMember | null | Promise<ChatMember | null>;
  /** Lines, mutes and reports per player. Default 30 per 10 000 ms. (The kit's chat rate, 3 per 5 s, still applies underneath.) */
  actionRateLimit?: NamesRateLimit;
  /** Stream opens per player. Default 10 per 60 000 ms. */
  openRateLimit?: NamesRateLimit;
  /**
   * When given, a request with an `Origin` header not in this list is `403 forbidden`. A request with no `Origin` is allowed. Default: not checked
   * (the JSON content type, which a cross-site form cannot send, already stops a cross-site post).
   */
  allowedOrigins?: readonly string[];
  /** Where failures are logged (event and error class only). Default `console.warn`. */
  logger?: Logger;
  /** Epoch-ms clock for the limits. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_ACTION_LIMIT: NamesRateLimit = { max: 30, windowMs: 10_000 };
const DEFAULT_OPEN_LIMIT: NamesRateLimit = { max: 10, windowMs: 60_000 };

/** The longest line the route reads: longer is answered `length` without asking the kit (which would say the same at 200). */
const TEXT_MAX = 2000;
const ID_MAX = 64;
const REASON_MAX = 64;
const NOTE_MAX = 500;
/** What `retry-after` says (seconds) when a room or the process is full. */
const FULL_RETRY_AFTER_S = 5;

/** A line id or a mute token as the broadcaster issues them (and as a route param is accepted). */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

const known = (v: unknown): v is string => typeof v === 'string' && v !== '';

const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  // `no-transform`: a body-rewriting middleware (`compression`) or a proxy holds the first frames back otherwise.
  'cache-control': 'no-store, no-transform',
  'x-content-type-options': 'nosniff',
  'x-accel-buffering': 'no',
} as const;

/** A token field: a string of 1 to 64 characters of `A-Za-z0-9_-`, else a 400. */
function tokenField(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > ID_MAX || !TOKEN_RE.test(value)) throw new ValidationError();
  return value;
}

/** An optional text field of at most `max` characters, else a 400. */
function optionalText(body: Record<string, unknown>, key: string, max: number): string | undefined {
  if (!Object.hasOwn(body, key) || body[key] === undefined || body[key] === null) return undefined;
  const value = body[key];
  if (typeof value !== 'string' || value.length > max) throw new ValidationError();
  return value;
}

/**
 * The chat routes over a broadcaster. Mount them with `createRouter` / `toExpress`, under `/chat` for example:
 * - `GET /rooms/:room/stream`: `200 text/event-stream`, an open response of `ChatFrame`s (the first is `hello`). `401`, `403`, `429`.
 * - `POST /rooms/:room/lines { text }`: `200 SendResult` (a refusal is an answer, not an error). `400`, `401`, `403`, `413`, `429`.
 * - `POST /rooms/:room/mute { lineId | ref, on }`: `200 { ok, hiddenIds }` (the ids of the lines it hid from this player; see `MuteResult`).
 * - `POST /rooms/:room/report { lineId, reason?, note? }`: `200 ReportOutcome`.
 * POST bodies must be `application/json`; any other content type is `400`, which is what stops a cross-site form from making a player speak.
 * Every response is `cache-control: no-store` (the stream's is `no-store, no-transform`, so a body-rewriting middleware leaves it alone).
 * No route returns a seat, a subject, a report id or a moderator field. A restriction in the `hello` and `state` frames reads a stored automatic
 * timeout as a moderator's (`WireRestriction.byModerator`); the refusal of a line is exact.
 * @experimental
 */
export function chatRoutes(cw: Chatwarden, broadcaster: RoomBroadcaster, options: ChatRoutesOptions): RouteTable {
  if (typeof cw !== 'object' || cw === null) throw new TypeError('chatRoutes: cw must be the kit');
  if (typeof broadcaster !== 'object' || broadcaster === null || typeof broadcaster.session !== 'function') {
    throw new TypeError('chatRoutes: broadcaster must be a room broadcaster');
  }
  if (typeof options !== 'object' || options === null) throw new TypeError('chatRoutes: options must be an object');
  if (typeof options.identify !== 'function') throw new TypeError('chatRoutes: identify must be a function');
  if (typeof options.join !== 'function') throw new TypeError('chatRoutes: join must be a function');
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('chatRoutes: now must be a function');
  if (options.logger !== undefined && (typeof options.logger !== 'object' || options.logger === null || typeof options.logger.warn !== 'function')) {
    throw new TypeError('chatRoutes: logger must have a warn function');
  }
  let origins: ReadonlySet<string> | undefined;
  if (options.allowedOrigins !== undefined) {
    if (!Array.isArray(options.allowedOrigins) || !options.allowedOrigins.every(known)) {
      throw new TypeError('chatRoutes: allowedOrigins must be a list of origins');
    }
    origins = new Set(options.allowedOrigins);
  }
  const { logger } = options;
  const identifyHook = options.identify;
  const joinHook = options.join;
  const now = options.now ?? Date.now;
  const actions = new Limiter(checkLimit(options.actionRateLimit, DEFAULT_ACTION_LIMIT, 'chatRoutes: actionRateLimit'));
  const opens = new Limiter(checkLimit(options.openRateLimit, DEFAULT_OPEN_LIMIT, 'chatRoutes: openRateLimit'));
  // Limiter keys: a salted hash of the caller's identity, per instance and in memory only. The same shape as a seat id; never a credential.
  const hasher = makeHasher(randomHex(16));
  // A frame is encoded once however many streams it goes to: the broadcaster hands every non-author stream the same frame object.
  const encoded = new WeakMap<object, string>();
  const encode = (frame: ChatFrame): string => {
    let text = encoded.get(frame);
    if (text === undefined) {
      text = encodeFrame(frame);
      encoded.set(frame, text);
    }
    return text;
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

  const keyOf = (who: RawWho): string | null => {
    if (known(who.accountId)) return `s${hasher.clientKey(`account\0${who.accountId}`)}`;
    if (known(who.clientKey)) return `s${hasher.clientKey(`key\0${who.clientKey}`)}`;
    return null;
  };

  /** Every response: no-store and nosniff, whatever else it carries. */
  const route = (handler: (req: KitRequest, params: Record<string, string>) => KitResponse | Promise<KitResponse>) => {
    const guarded = withErrors(handler, logger);
    return async (req: KitRequest, params: Record<string, string>): Promise<KitResponse> => {
      const res = await guarded(req, params);
      return { ...res, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...res.headers } };
    };
  };

  const tooMany = (waitMs: number): HttpError => new HttpError('rate_limited', { 'retry-after': String(Math.ceil(waitMs / 1000)) });

  const checkOrigin = (req: KitRequest): void => {
    if (origins === undefined) return;
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) throw new HttpError('forbidden');
  };

  /** A POST must say `application/json` (a cross-site HTML form cannot). */
  const requireJson = (req: KitRequest): void => {
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') throw new ValidationError();
  };

  /** Who is calling, and may they act now: identity (401), then the rate limit (429). */
  const caller = async (req: KitRequest, limiter: Limiter): Promise<RawWho> => {
    const who = await identify(req);
    const key = keyOf(who);
    if (key === null) throw new HttpError('unauthorized');
    const wait = limiter.hit(key, now());
    if (wait > 0) throw tooMany(wait);
    return who;
  };

  /** The session for a caller: the game's `join` (403), then the broadcaster (401, 429, or a ban the route turns into an answer). */
  const enter = async (req: KitRequest, roomId: string, who: RawWho): Promise<ChatSession | { banned: WireRefusal }> => {
    const member = await joinHook(req, roomId, who);
    if (typeof member !== 'object' || member === null) throw new HttpError('forbidden');
    const session = broadcaster.session(roomId, who, member);
    if (!('refused' in session)) return session;
    switch (session.refused.reason) {
      case 'banned':
        return { banned: session.refused };
      case 'unauthorized':
        throw new HttpError('unauthorized');
      case 'internal':
        // A failure inside the broadcaster is the server's, not a capacity problem: 500 (it is logged, class only, where it happened).
        throw new Error('chat session failed');
      default:
        throw new HttpError('rate_limited', { 'retry-after': String(FULL_RETRY_AFTER_S) });
    }
  };

  const ok = (body: unknown): KitResponse => ({ status: 200, body });

  return {
    'GET /rooms/:room/stream': route(async (req, params) => {
      // The router runs this for a HEAD too, and the adapter never starts the stream: no identity work, no seat, no open-limit hit.
      if (req.method === 'HEAD') return { status: 200, headers: { ...STREAM_HEADERS }, body: undefined, stream: { start: () => () => undefined } };
      checkOrigin(req);
      const who = await caller(req, opens);
      const entered = await enter(req, params.room as string, who);
      if ('banned' in entered) {
        const until = entered.banned.until;
        return {
          status: 200,
          headers: { ...STREAM_HEADERS },
          body: undefined,
          stream: {
            start(sink) {
              sink.write(encodeFrame(until === undefined ? { type: 'bye', reason: 'banned' } : { type: 'bye', reason: 'banned', until }));
              sink.end();
              return () => undefined;
            },
          },
        };
      }
      if (!entered.canOpen()) throw new HttpError('rate_limited', { 'retry-after': String(FULL_RETRY_AFTER_S) });
      return {
        status: 200,
        headers: { ...STREAM_HEADERS },
        body: undefined,
        stream: {
          start(sink) {
            let opened: ReturnType<ChatSession['open']>;
            try {
              opened = entered.open({
                write: (frame) => sink.write(encode(frame)),
                ping: () => sink.write(HEARTBEAT),
                end: () => sink.end(),
              });
            } catch (err) {
              // Nothing this `start` took is left held (a throwing `start` gets no cancel): end the response and let the client retry.
              safeWarn(logger, 'chatwarden.chat_stream_failed', { error: errorClass(err) });
              sink.end();
              return () => undefined;
            }
            // Someone else took the last place between the check and now: end the response, the client backs off and retries.
            if ('refused' in opened) {
              sink.end();
              return () => undefined;
            }
            return () => opened.close();
          },
        },
      };
    }),

    'POST /rooms/:room/lines': route(async (req, params) => {
      checkOrigin(req);
      requireJson(req);
      const text = bodyObject(req).text;
      if (typeof text !== 'string') throw new ValidationError();
      const who = await caller(req, actions);
      // Far too long to be a line: say so without asking the kit.
      if (text.length > TEXT_MAX) return ok({ ok: false, refused: { reason: 'length' } });
      const entered = await enter(req, params.room as string, who);
      if ('banned' in entered) return ok({ ok: false, refused: entered.banned });
      return ok(entered.send({ text }));
    }),

    'POST /rooms/:room/mute': route(async (req, params) => {
      checkOrigin(req);
      requireJson(req);
      const body = bodyObject(req);
      const hasLine = Object.hasOwn(body, 'lineId');
      const hasRef = Object.hasOwn(body, 'ref');
      if (hasLine === hasRef || typeof body.on !== 'boolean') throw new ValidationError();
      const target = hasLine ? { lineId: tokenField(body.lineId) } : { ref: tokenField(body.ref) };
      const who = await caller(req, actions);
      const entered = await enter(req, params.room as string, who);
      if ('banned' in entered) return ok({ ok: false, hiddenIds: [] });
      return ok(entered.muteResult({ ...target, on: body.on }));
    }),

    'POST /rooms/:room/report': route(async (req, params) => {
      checkOrigin(req);
      requireJson(req);
      const body = bodyObject(req);
      const lineId = tokenField(body.lineId);
      const reason = optionalText(body, 'reason', REASON_MAX);
      const note = optionalText(body, 'note', NOTE_MAX);
      const who = await caller(req, actions);
      const entered = await enter(req, params.room as string, who);
      if ('banned' in entered) return ok({ ok: false, refused: 'off' });
      return ok(await entered.report({ lineId, ...(reason === undefined ? {} : { reason }), ...(note === undefined ? {} : { note }) }));
    }),
  };
}
