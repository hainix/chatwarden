import { createHash, randomBytes } from 'node:crypto';
import { errorClass, safeWarn } from '@chatwarden/core';
import type { AppealFileResult, Chatwarden, Logger } from '@chatwarden/core';
import { chooseLocale, noticeWordsFor } from '@chatwarden/core/notice-locales';
import { APPEAL_PAGE_CSP, renderAppealPage } from './appealPage.js';
import type { AppealPageError, AppealPageView } from './appealPage.js';
import { BODY_MAX_BYTES, parseJson, utf8ByteLength } from './body.js';
import { checkTrustProxy, clientAddressOf, isPrivateAddress } from './clientAddress.js';
import { HttpError, NotFoundError, ValidationError, withErrors } from './errors.js';
import { checkLimit, Limiter } from './limiter.js';
import type { NamesRateLimit } from './limiter.js';
import type { RouteTable } from './router.js';
import type { KitRequest, KitResponse } from './types.js';

/** What the landing routes take besides the kit. */
export interface AppealLandingOptions {
  /** Where failures are logged (event and error class only). */
  logger?: Logger;
  /** Epoch-ms clock for the limits and for the times on the page. Default `Date.now`. */
  now?: () => number;
  /** `GET /appeal` and `GET /appeal/case` limit per token, and per address when one is known. Default 60 an hour. Both must be positive whole numbers (`RangeError`). */
  readRateLimit?: NamesRateLimit;
  /** `POST /appeal/case` limit per token, and per address when one is known. Default 10 an hour. Both must be positive whole numbers (`RangeError`). */
  appealsRateLimit?: NamesRateLimit;
  /**
   * How many reverse proxies of your own are in front of this server (a whole number from 1 to 10; 0 or unset means none). With it set, the address a request is
   * limited as is the N-th entry from the right of `X-Forwarded-For` (the entries to its left are the client's own claim and are never read). Without it the address is
   * the socket peer, and behind a proxy that is the proxy: every person would share one limit, and the first 20 requests from one peer in an hour log
   * `chatwarden.landing_shared_address` once. Set it only when a proxy you run really sets the header: a client can send any header to a server nobody sits in front of.
   * Whatever the setting, the limits are always per token, and a request with no known address is not limited by address at all (never by one shared bucket).
   */
  trustProxy?: number;
}

/** Reads (the page and its json) per token per hour, and per address per hour when one is known. */
export const APPEAL_LANDING_READ_LIMIT: NamesRateLimit = { max: 60, windowMs: 3_600_000 };
/** Writes (the form and its json) per token per hour, and per address per hour when one is known. */
export const APPEAL_LANDING_WRITE_LIMIT: NamesRateLimit = { max: 10, windowMs: 3_600_000 };

/** What a token may look like before the route looks at it at all: the base64url payload, a dot and the signature (and nothing a page could be tricked by). */
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,512}$/;
/** The codes a redirect may carry in `e`: only these are read back, so a hand-made query cannot put text on the page. */
const ERROR_CODES: ReadonlySet<string> = new Set<AppealPageError>(['invalid', 'already', 'rate', 'busy', 'not_appealable', 'failed']);
const SECONDS_RE = /^[0-9]{1,7}$/;
const ACCEPT_MAX_CHARS = 512;
const ACCEPT_MAX_TAGS = 10;
/** One peer for this many requests in a window, and no proxy setting: it is probably a proxy, and the limits are then shared by everyone behind it. */
const SHARED_PEER_REQUESTS = 20;
const SHARED_PEER_WINDOW_MS = 3_600_000;
const TAG_MAX_CHARS = 35;

/** On every answer of both routes: nothing is stored, nothing is leaked in a referrer, nothing is indexed. */
const COMMON_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
} as const;
/** On every html answer: nothing loads, nothing runs, nothing frames it. */
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': APPEAL_PAGE_CSP,
  'x-frame-options': 'DENY',
} as const;

const seconds = (ms: number): string => String(Math.max(1, Math.ceil(ms / 1000)));

/** The language tags of an `Accept-Language` header, best first: at most 10, each at most 35 characters, `q=0` left out; a header over 512 characters counts as none. */
function acceptedTags(header: unknown): string[] {
  if (typeof header !== 'string' || header.length > ACCEPT_MAX_CHARS) return [];
  const entries: Array<{ tag: string; q: number; at: number }> = [];
  header
    .split(',')
    .slice(0, ACCEPT_MAX_TAGS)
    .forEach((part, at) => {
      const [raw, ...params] = part.split(';');
      const tag = (raw ?? '').trim();
      if (tag === '' || tag.length > TAG_MAX_CHARS) return;
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
        if (m !== null) q = Number(m[1]);
      }
      if (q > 0) entries.push({ tag, q, at });
    });
  return entries.sort((a, b) => b.q - a.q || a.at - b.at).map((e) => e.tag);
}

/** The route table of the appeal landing page and its json (0.2.1): `GET /appeal`, `GET /appeal/case`, `POST /appeal/case`, `OPTIONS /appeal/case`. See `playerRoutes`. */
export function appealLandingRoutes(cw: Chatwarden, options: AppealLandingOptions = {}): RouteTable {
  const { logger } = options;
  const now = options.now ?? Date.now;
  const readLimit = checkLimit(options.readRateLimit, APPEAL_LANDING_READ_LIMIT, 'appealLandingRoutes: readRateLimit');
  const writeLimit = checkLimit(options.appealsRateLimit, APPEAL_LANDING_WRITE_LIMIT, 'appealLandingRoutes: appealsRateLimit');
  const trustProxy = checkTrustProxy(options.trustProxy, 'appealLandingRoutes: trustProxy');
  const readByAddress = new Limiter(readLimit);
  const readByToken = new Limiter(readLimit);
  const writeByAddress = new Limiter(writeLimit);
  const writeByToken = new Limiter(writeLimit);
  // Per-instance, in memory only: the keys cannot be recomputed or compared across restarts or processes, and hold no address or token.
  const salt = randomBytes(32);
  const keyOf = (kind: 'ip' | 'tok', value: string): string => createHash('sha256').update(salt).update(`${kind}\0${value}`).digest('hex');

  // The socket peers of the current window: how many requests, and whether more than one peer was seen. Only keys, never an address.
  const peers = { start: 0, requests: 0, first: '', several: false, warned: false };
  const watchPeer = (req: KitRequest): void => {
    if (trustProxy !== undefined && trustProxy > 0) return;
    if (typeof req.remoteAddress !== 'string' || req.remoteAddress === '' || peers.warned) return;
    const at = now();
    if (peers.requests === 0 || at - peers.start >= SHARED_PEER_WINDOW_MS) Object.assign(peers, { start: at, requests: 0, first: '', several: false });
    const key = keyOf('ip', req.remoteAddress);
    if (peers.requests === 0) peers.first = key;
    else if (key !== peers.first) peers.several = true;
    peers.requests++;
    if (!peers.several && peers.requests >= SHARED_PEER_REQUESTS) {
      peers.warned = true;
      safeWarn(logger, 'chatwarden.landing_shared_address', { requests: peers.requests });
    }
  };
  /**
   * The key a request is limited by as an address, or undefined when no real client address is known (then there is no address limit: never a shared bucket).
   * With no proxy setting, a loopback or private socket peer is almost always your own proxy, so it is not a client address either (per-token limits only).
   */
  const addressKey = (req: KitRequest): string | undefined => {
    watchPeer(req);
    const address = clientAddressOf(req, trustProxy);
    if (address === undefined) return undefined;
    if ((trustProxy === undefined || trustProxy === 0) && isPrivateAddress(address)) return undefined;
    return keyOf('ip', address);
  };
  /** 0 when allowed, else the wait: the address limit first (when an address is known), then the token limit (when the request names a well-formed token). */
  const limited = (byAddress: Limiter, byToken: Limiter, address: string | undefined, token: string | undefined): number => {
    const at = now();
    const addressWait = address === undefined ? 0 : byAddress.hit(address, at);
    if (addressWait > 0) return addressWait;
    return token === undefined ? 0 : byToken.hit(keyOf('tok', token), at);
  };

  const tokenOf = (raw: unknown): string | undefined => (typeof raw === 'string' && TOKEN_RE.test(raw) ? raw : undefined);
  const header = (req: KitRequest, name: string): string | undefined => {
    const v = req.headers[name];
    return typeof v === 'string' ? v : undefined;
  };

  /** The language, the words for it and the game's contact line: `lang` first, then the header, then English. */
  const speak = (lang: unknown, req: KitRequest) => {
    const overrides = cw.profile.appeals.words;
    const locale = chooseLocale([lang, ...acceptedTags(header(req, 'accept-language'))], overrides);
    const { words } = noticeWordsFor(locale, overrides);
    return { locale, words, contact: cw.profile.appeals.contact };
  };

  /** Every answer of the landing routes, errors included, carries the common headers. */
  const landing = (handler: (req: KitRequest) => KitResponse | Promise<KitResponse>) => {
    const guarded = withErrors(handler, logger);
    return async (req: KitRequest): Promise<KitResponse> => {
      const res = await guarded(req);
      return { ...res, headers: { ...res.headers, ...COMMON_HEADERS } };
    };
  };
  /** The same for the routes a browser page of the game may call: `vary: origin`, and the allow-origin for an exact origin the game listed. Never `*`, never credentials. */
  const withCors = (handler: (req: KitRequest) => KitResponse | Promise<KitResponse>) => {
    const inner = landing(handler);
    return async (req: KitRequest): Promise<KitResponse> => {
      const res = await inner(req);
      return { ...res, headers: { ...res.headers, ...corsHeaders(req) } };
    };
  };
  const listedOrigin = (req: KitRequest): string | undefined => {
    const origin = header(req, 'origin');
    return origin !== undefined && cw.appeals.landingOrigins().includes(origin) ? origin : undefined;
  };
  const corsHeaders = (req: KitRequest): Record<string, string> => {
    const origin = listedOrigin(req);
    return { vary: 'origin', ...(origin === undefined ? {} : { 'access-control-allow-origin': origin }) };
  };

  const htmlPage = (status: number, view: AppealPageView, extra: Record<string, string> = {}): KitResponse => ({
    status,
    headers: { ...PAGE_HEADERS, ...extra },
    body: renderAppealPage(view),
  });
  const failed = (err: unknown): void => safeWarn(logger, 'chatwarden.landing_failed', { error: errorClass(err) });

  /** Over a read limit: the page in the person's words, 429 with the seconds to wait. */
  const busyPage = (req: KitRequest, wait: number): KitResponse => {
    const s = speak(req.query.lang, req);
    return htmlPage(429, { state: 'busy', locale: s.locale, words: s.words, contact: s.contact }, { 'retry-after': seconds(wait) });
  };

  const location = (token: string | undefined, locale: string, e?: AppealPageError, retrySeconds?: number): KitResponse => {
    const p = new URLSearchParams();
    if (token !== undefined) p.set('t', token);
    p.set('lang', locale);
    if (e !== undefined) p.set('e', e);
    if (retrySeconds !== undefined) p.set('r', String(retrySeconds));
    return { status: 303, headers: { location: `../appeal?${p.toString()}` }, body: '' };
  };

  /** What a POST carried, after the content type picked how to read it. */
  type Fields = { t: unknown; statement: string; lang: unknown };
  const mediaType = (req: KitRequest): 'json' | 'form' | 'other' => {
    const type = (header(req, 'content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    return type === 'application/json' ? 'json' : type === 'application/x-www-form-urlencoded' ? 'form' : 'other';
  };
  const formFields = (req: KitRequest): URLSearchParams => {
    const raw = req.rawBody ?? '';
    if (utf8ByteLength(raw) > BODY_MAX_BYTES) throw new HttpError('payload_too_large');
    return new URLSearchParams(raw);
  };
  const readFields = (req: KitRequest, mode: 'json' | 'form'): Fields => {
    if (mode === 'form') {
      const p = formFields(req);
      return { t: p.get('t') ?? undefined, statement: p.get('statement') ?? '', lang: p.get('lang') ?? undefined };
    }
    const body = parseJson(req.rawBody);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError();
    const o = body as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length !== 2 || !Object.hasOwn(o, 't') || !Object.hasOwn(o, 'statement') || typeof o.t !== 'string' || typeof o.statement !== 'string') throw new ValidationError();
    return { t: o.t, statement: o.statement, lang: undefined };
  };

  return {
    'GET /appeal': landing((req) => {
      // Off reads as no route at all: nothing is counted and nothing else is looked at.
      if (!cw.appeals.enabled()) throw new NotFoundError();
      const token = tokenOf(req.query.t);
      const wait = limited(readByAddress, readByToken, addressKey(req), token);
      if (wait > 0) return busyPage(req, wait);
      const s = speak(req.query.lang, req);
      const invalid = (): KitResponse => htmlPage(404, { state: 'invalid', locale: s.locale, words: s.words, contact: s.contact });
      if (token === undefined) return invalid();
      try {
        const res = cw.appeals.caseByLink(token);
        if (!res.ok) return invalid();
        const e = typeof req.query.e === 'string' && ERROR_CODES.has(req.query.e) ? (req.query.e as AppealPageError) : undefined;
        const r = typeof req.query.r === 'string' && SECONDS_RE.test(req.query.r) ? Number(req.query.r) * 1000 : undefined;
        return htmlPage(200, {
          state: 'case',
          locale: s.locale,
          words: s.words,
          token,
          case: res.case,
          now: now(),
          ...(e === undefined ? {} : { error: e }),
          ...(e === 'rate' && r !== undefined ? { retryAfterMs: r } : {}),
        });
      } catch (err) {
        failed(err);
        return invalid();
      }
    }),

    'GET /appeal/case': withCors((req) => {
      if (!cw.appeals.enabled()) throw new NotFoundError();
      const token = tokenOf(req.query.t);
      const wait = limited(readByAddress, readByToken, addressKey(req), token);
      if (wait > 0) throw new HttpError('rate_limited', { 'retry-after': seconds(wait) });
      if (token === undefined) throw new NotFoundError();
      let res: ReturnType<Chatwarden['appeals']['caseByLink']>;
      try {
        res = cw.appeals.caseByLink(token);
      } catch (err) {
        failed(err);
        throw new NotFoundError();
      }
      if (!res.ok) throw new NotFoundError();
      return { status: 200, body: res.case };
    }),

    'POST /appeal/case': withCors((req) => {
      if (!cw.appeals.enabled()) throw new NotFoundError();
      const mode = mediaType(req);
      // Counted before anything is read or checked, so a flood of forged or malformed requests is limited too (by address when one is known, and by token once the token is read).
      const addressWait = limited(writeByAddress, writeByToken, addressKey(req), undefined);
      if (addressWait > 0) {
        if (mode !== 'form') throw new HttpError('rate_limited', { 'retry-after': seconds(addressWait) });
        return location(tokenOf(formFields(req).get('t')), speak(formFields(req).get('lang'), req).locale, 'busy');
      }
      if (mode === 'other') throw new ValidationError();
      const fields = readFields(req, mode);
      const locale = speak(fields.lang, req).locale;
      const token = tokenOf(fields.t);
      if (token === undefined) {
        if (mode === 'form') return location(undefined, locale);
        throw new NotFoundError();
      }
      const tokenWait = limited(writeByAddress, writeByToken, undefined, token);
      if (tokenWait > 0) {
        if (mode === 'form') return location(token, locale, 'busy');
        throw new HttpError('rate_limited', { 'retry-after': seconds(tokenWait) });
      }
      let result: AppealFileResult;
      try {
        result = cw.appeals.fileByLink(token, { statement: fields.statement });
      } catch (err) {
        failed(err);
        return mode === 'form' ? location(token, locale, 'failed') : { status: 500, body: { error: 'internal' } };
      }
      if (mode === 'form') {
        if (result.ok) return location(token, locale);
        switch (result.refused) {
          case 'statement_invalid':
            return location(token, locale, 'invalid');
          case 'already_appealed':
            return location(token, locale, 'already');
          case 'rate':
            return location(token, locale, 'rate', Math.min(9_999_999, Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1000))));
          case 'not_appealable':
            return location(token, locale, 'not_appealable');
          default:
            // not_found and off: a bad link has no code, and the page it lands on says the link is invalid.
            return location(token, locale);
        }
      }
      if (result.ok) {
        let fresh: ReturnType<Chatwarden['appeals']['caseByLink']>;
        try {
          fresh = cw.appeals.caseByLink(token);
        } catch (err) {
          failed(err);
          return { status: 500, body: { error: 'internal' } };
        }
        if (!fresh.ok) throw new NotFoundError();
        return { status: 200, body: fresh.case };
      }
      switch (result.refused) {
        case 'statement_invalid':
          throw new HttpError('invalid_statement');
        case 'already_appealed':
          throw new HttpError('already_appealed');
        case 'rate':
          throw new HttpError('rate_limited', { 'retry-after': seconds(result.retryAfterMs ?? 0) });
        default:
          // off, not_found and not_appealable: one answer, so a link cannot be probed.
          throw new NotFoundError();
      }
    }),

    'OPTIONS /appeal/case': withCors((req) => {
      if (!cw.appeals.enabled()) throw new NotFoundError();
      // The same status for a listed and an unlisted origin: only the CORS headers differ, so the list is not revealed by a status.
      const preflight: Record<string, string> =
        listedOrigin(req) === undefined ? {} : { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
      return { status: 200, body: '', headers: preflight };
    }),
  };
}
