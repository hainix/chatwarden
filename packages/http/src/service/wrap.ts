// The wrapper every /v1 route goes through (design 3.2): request id, authentication, the per-key rate limit, the body cap, idempotency, the shared headers and the request line.
// Browser-safe: nothing here imports `node:`.
import { safeWarn } from '@chatwarden/core';
import type { Logger } from '@chatwarden/core';
import { parseJson, BODY_MAX_BYTES } from '../body.js';
import { HttpError, ValidationError, withErrors } from '../errors.js';
import { checkLimit, Limiter } from '../limiter.js';
import type { NamesRateLimit } from '../limiter.js';
import type { Authenticate } from '../auth.js';
import type { RouteHandler } from '../router.js';
import type { KitRequest, KitResponse, RouteParams } from '../types.js';
import { createHookAuth, createKeyAuth } from './auth.js';
import type { ServiceAuth } from './auth.js';
import { requestIdFor, withServiceHeaders } from './contract.js';
import { createIdempotencyStore, fingerprintOf } from './idempotency.js';

/** The largest `maxBody` accepted, in bytes (the same ceiling as the fetch adapter). */
const MAX_BODY_LIMIT = 16 * 1024 * 1024;
const DEFAULT_RATE: NamesRateLimit = { max: 3000, windowMs: 10_000 };
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** What the wrapper needs. `serviceRoutes` passes its own options through. */
export interface ServiceWrapperOptions {
  /** One to five service keys, or the adopter's own `Authenticate` hook. */
  keys: readonly string[] | Authenticate;
  /** Requests per key. Default 3000 per 10 000 ms. */
  rateLimit?: NamesRateLimit;
  /** Failed authentications per address before it is refused for the rest of the window. Default 20 per 60 000 ms. */
  authFailureLimit?: NamesRateLimit;
  /** The largest body in bytes. Default 65536 (`BODY_MAX_BYTES`). */
  maxBody?: number;
  /** Epoch-ms clock. Default `Date.now`. */
  now?: () => number;
  /** Where the request line and unexpected failures go (event and class only). With none, a request line is not written and a failure goes to `console.warn`. */
  logger?: Logger;
}

/** What a service handler is given: the request, its (decoded, unchecked) route params, the parsed body and who the caller is by key id. */
export interface ServiceCall {
  req: KitRequest;
  params: RouteParams;
  /** The parsed JSON body of a POST or PUT, or `undefined` when there was none. Checked for the byte cap and forbidden keys, not for shape. */
  body: unknown;
  /** The first 8 hex characters of the key's digest: safe to log. */
  kid: string;
  /** The request id (the caller's own when valid, else random). */
  rid: string;
}

export type ServiceHandler = (call: ServiceCall) => KitResponse | Promise<KitResponse>;

/** Wrap a handler for `route` (`'POST /rooms/:room~room/seats/:seat~room/lines'`: the method and the pattern, for the log). `idempotent` honours an `Idempotency-Key` header. */
export type Svc = (route: string, handler: ServiceHandler, options?: { idempotent?: boolean }) => RouteHandler;

export interface ServiceWrapper {
  svc: Svc;
  auth: ServiceAuth;
}

/** Validate the options and build `svc`. A bad option is a `RangeError` or `TypeError` at start-up that never repeats a value. */
export function createServiceWrapper(options: ServiceWrapperOptions): ServiceWrapper {
  if (typeof options !== 'object' || options === null) throw new TypeError('serviceRoutes: options must be an object');
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('serviceRoutes: now must be a function');
  if (options.logger !== undefined && (typeof options.logger !== 'object' || options.logger === null || typeof options.logger.warn !== 'function')) {
    throw new TypeError('serviceRoutes: logger must have a warn function');
  }
  const maxBody = options.maxBody ?? BODY_MAX_BYTES;
  if (typeof maxBody !== 'number' || !Number.isSafeInteger(maxBody) || maxBody < 1 || maxBody > MAX_BODY_LIMIT) {
    throw new RangeError('serviceRoutes: maxBody must be a whole number of bytes from 1 to 16 MiB');
  }
  const now = options.now ?? Date.now;
  const { logger } = options;
  const limiter = new Limiter(checkLimit(options.rateLimit, DEFAULT_RATE, 'serviceRoutes: rateLimit'));
  const authOptions = { now, ...(options.authFailureLimit === undefined ? {} : { failureLimit: options.authFailureLimit }) };
  const auth: ServiceAuth = typeof options.keys === 'function' ? createHookAuth(options.keys, authOptions) : createKeyAuth({ keys: options.keys, ...authOptions });
  const store = createIdempotencyStore({ now });

  const svc: Svc = (route, handler, routeOptions = {}) => {
    const method = route.split(' ', 1)[0] as string;
    const idempotent = routeOptions.idempotent === true;

    return async (req, params) => {
      const started = now();
      const rid = requestIdFor(req.headers['x-request-id']);
      let kid: string | undefined;

      const run = async (): Promise<KitResponse> => {
        // The service does not answer HEAD: a probe is told which method the route has (after the shared headers, before anything else).
        if (req.method.toUpperCase() === 'HEAD') throw new HttpError('method_not_allowed', { allow: method });
        kid = await auth.authenticate(req);
        const wait = limiter.hit(kid, now());
        if (wait > 0) throw new HttpError('rate_limited', { 'retry-after': String(Math.max(1, Math.ceil(wait / 1000))) });

        let body: unknown;
        if (method === 'POST' || method === 'PUT') {
          const hasBody = req.rawBody !== undefined && req.rawBody !== '';
          if (method === 'POST' || hasBody) {
            const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
            if (type !== 'application/json') throw new ValidationError();
          }
          body = parseJson(req.rawBody, maxBody);
        }

        let token: ReturnType<typeof store.begin> | undefined;
        if (idempotent) {
          const key = req.headers['idempotency-key'];
          if (key !== undefined) {
            if (!IDEMPOTENCY_KEY_RE.test(key)) throw new HttpError('invalid_idempotency_key');
            const path = req.path.split('?', 1)[0] as string;
            token = store.begin(`${kid}|${method}|${path}`, key, await fingerprintOf(body));
            if (token.kind === 'replay') return { status: token.status, body: token.body, headers: { 'idempotent-replay': 'true' } };
            if (token.kind === 'mismatch') throw new HttpError('idempotency_mismatch');
            if (token.kind === 'in_progress') throw new HttpError('in_progress');
          }
        }

        try {
          const res = await handler({ req, params, body, kid, rid });
          if (token?.kind === 'new') store.finish(token.token, res.status, res.body);
          return res;
        } catch (err) {
          if (token?.kind === 'new') store.abandon(token.token);
          throw err;
        }
      };

      const res = withServiceHeaders(await withErrors(run, logger)(), rid);
      if (logger !== undefined) safeWarn(logger, 'chatwarden.service_request', { rid, ...(kid === undefined ? {} : { kid }), route, status: res.status, ms: Math.max(0, now() - started) });
      return res;
    };
  };

  return { svc, auth };
}
