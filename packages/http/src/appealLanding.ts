import { createHash, randomBytes } from 'node:crypto';
import { errorClass, safeWarn } from '@chatwarden/core';
import type { AppealFileResult, Chatwarden, Logger } from '@chatwarden/core';
import { chooseLocale, noticeWordsFor } from '@chatwarden/core/notice-locales';
import { APPEAL_PAGE_CSP, renderAppealPage } from './appealPage.js';
import type { AppealPageError, AppealPageView } from './appealPage.js';
import { BODY_MAX_BYTES, parseJson, utf8ByteLength } from './body.js';
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
  /** `GET /appeal` and `GET /appeal/case` limit per address. Default 60 an hour. Both must be positive whole numbers (`RangeError`). */
  readRateLimit?: NamesRateLimit;
  /** `POST /appeal/case` limit per address AND per token. Default 10 an hour. Both must be positive whole numbers (`RangeError`). */
  appealsRateLimit?: NamesRateLimit;
}

/** Reads (the page and its json) per address per hour. */
export const APPEAL_LANDING_READ_LIMIT: NamesRateLimit = { max: 60, windowMs: 3_600_000 };
/** Writes (the form and its json) per address per hour, and per token per hour. */
export const APPEAL_LANDING_WRITE_LIMIT: NamesRateLimit = { max: 10, windowMs: 3_600_000 };

/** What a token may look like before the route looks at it at all: the base64url payload, a dot and the signature (and nothing a page could be tricked by). */
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,512}$/;
/** The codes a redirect may carry in `e`: only these are read back, so a hand-made query cannot put text on the page. */
const ERROR_CODES: ReadonlySet<string> = new Set<AppealPageError>(['invalid', 'already', 'rate', 'busy', 'not_appealable', 'failed']);
const SECONDS_RE = /^[0-9]{1,7}$/;
const ACCEPT_MAX_CHARS = 512;
const ACCEPT_MAX_TAGS = 10;
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
  const readLimiter = new Limiter(checkLimit(options.readRateLimit, APPEAL_LANDING_READ_LIMIT, 'appealLandingRoutes: readRateLimit'));
  const writeLimit = checkLimit(options.appealsRateLimit, APPEAL_LANDING_WRITE_LIMIT, 'appealLandingRoutes: appealsRateLimit');
  const writeByAddress = new Limiter(writeLimit);
  const writeByToken = new Limiter(writeLimit);
  // Per-instance, in memory only: the keys cannot be recomputed or compared across restarts or processes, and hold no address or token.
  const salt = randomBytes(32);
  const keyOf = (kind: 'ip' | 'tok', value: string): string => createHash('sha256').update(salt).update(`${kind}\0${value}`).digest('hex');
  const addressKey = (req: KitRequest): string => keyOf('ip', req.remoteAddress ?? 'unknown');

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
      const wait = readLimiter.hit(addressKey(req), now());
      if (wait > 0) return busyPage(req, wait);
      const s = speak(req.query.lang, req);
      const invalid = (): KitResponse => htmlPage(404, { state: 'invalid', locale: s.locale, words: s.words, contact: s.contact });
      const token = tokenOf(req.query.t);
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
      const wait = readLimiter.hit(addressKey(req), now());
      if (wait > 0) throw new HttpError('rate_limited', { 'retry-after': seconds(wait) });
      const token = tokenOf(req.query.t);
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
      // Counted before anything is read or checked, so a flood of forged or malformed requests is limited too.
      const addressWait = writeByAddress.hit(addressKey(req), now());
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
      const tokenWait = writeByToken.hit(keyOf('tok', token), now());
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
