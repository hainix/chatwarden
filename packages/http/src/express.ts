import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { safeWarn } from '@chatwarden/core';
import type { Logger } from '@chatwarden/core';
import { BODY_MAX_BYTES } from './body.js';
import { errorResponse, withErrors } from './errors.js';
import { createRouter } from './router.js';
import type { RouteTable } from './router.js';
import type { KitRequest, KitResponse } from './types.js';

export interface ExpressOptions {
  /**
   * The largest request body the adapter will read, in bytes. A positive whole number; default 65536 (the same cap
   * `parseJson` enforces). More than that is a 413 in the kit's error shape, and the adapter stops reading. Raising it
   * does not raise the routes' own 64 KiB JSON cap.
   */
  maxBody?: number;
  /** Where the adapter logs (event and error class only). Defaults to `console.warn`. */
  logger?: Logger;
}

type Query = Record<string, string>;

/** The first value of each query key, strings only. Nested values (an extended parser's objects) are dropped. */
function queryOf(raw: unknown): Query {
  const out: Query = Object.create(null) as Query;
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw)) {
    const first: unknown = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') out[key] = first;
  }
  return out;
}

/** The request headers, lowercased, with an array (a repeated `set-cookie`) joined by ", ". */
function headersOf(raw: Request['headers']): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** True when something already read (or parsed) the request body, so the raw bytes are gone. */
const consumed = (req: Request): boolean =>
  (req.body as unknown) !== undefined || req.readableEnded || req.readableDidRead || req.destroyed;

/** What reading the body came to: the text, "too big", or "the client went away". */
type Read = { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'aborted' };

function readBody(req: Request, max: number): Promise<Read> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > max) {
    return Promise.resolve({ kind: 'too_large' });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: Read): void => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onGone);
      req.off('close', onClose);
      if (result.kind === 'too_large') req.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buf.length;
      if (size > max) {
        finish({ kind: 'too_large' });
        return;
      }
      chunks.push(buf);
    };
    const onEnd = (): void => finish({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    const onGone = (): void => finish({ kind: 'aborted' });
    const onClose = (): void => {
      if (!req.readableEnded) finish({ kind: 'aborted' });
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onGone);
    req.on('close', onClose);
  });
}

/** Send a KitResponse: its status and headers; a string body raw, anything else as JSON. */
function send(res: Response, kit: KitResponse): void {
  res.status(kit.status);
  for (const [name, value] of Object.entries(kit.headers ?? {})) res.setHeader(name, value);
  if (typeof kit.body === 'string') {
    if (!res.hasHeader('content-type')) res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.send(kit.body);
  } else {
    res.json(kit.body);
  }
}

/**
 * Mount kit routes (`adminRoutes`, `playerRoutes`, `healthRoutes`, or a table of your own) on an Express app:
 * `app.use('/admin', toExpress(adminRoutes(cw, { authorize })))`.
 *
 * - Mount it BEFORE any body parser. The adapter reads the raw body itself (so a webhook can verify a signature over the
 *   exact bytes) and routes parse it with the kit's own `parseJson`. If `express.json()` (or `raw`, `text`) already ran
 *   for the request, the bytes are gone: the answer is 500 `internal`, and `chatwarden.http_body_already_parsed` is
 *   logged once per adapter. If your app needs `express.json()`, mount it on your own routes, not globally.
 * - It answers EVERYTHING under its mount point: an unknown path is the kit's 404 and a wrong method its 405. Mounted at
 *   `/`, put it after your own routes.
 * - `path` is relative to the mount point; `query` holds the first string value of each key; header names are
 *   lowercased and an array is joined with ", ".
 * - A body over `maxBody` bytes is 413 `payload_too_large`; the adapter stops reading and closes the connection.
 * - A `KitResponse` becomes status + headers; a string body is sent raw (with its own `content-type`, `text/plain` if
 *   none), anything else as JSON. A handler's own error is the kit's 500 `internal`; an error that escapes the mapping
 *   (an invalid status, say) goes to `next(err)`.
 *
 * `express` is a peer dependency (^5): this module imports `Router` from it, so import `@chatwarden/http/express` only
 * in an Express app.
 */
export function toExpress(routes: RouteTable, options: ExpressOptions = {}): Router {
  if (typeof routes !== 'object' || routes === null || Array.isArray(routes)) {
    throw new TypeError('toExpress: routes must be a route table');
  }
  const { logger } = options;
  const max = options.maxBody ?? BODY_MAX_BYTES;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1) {
    throw new RangeError('toExpress: maxBody must be a positive whole number of bytes');
  }
  const handle = withErrors(createRouter(routes), logger);
  let warnedParsed = false;

  const router = Router();
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (consumed(req)) {
        if (!warnedParsed) {
          warnedParsed = true;
          safeWarn(logger, 'chatwarden.http_body_already_parsed');
        }
        send(res, { status: 500, body: { error: 'internal' } });
        return;
      }
      const body = await readBody(req, max);
      if (body.kind === 'aborted') return;
      if (body.kind === 'too_large') {
        res.setHeader('connection', 'close');
        send(res, errorResponse('payload_too_large'));
        return;
      }
      const kit: KitRequest = {
        method: req.method,
        path: req.path,
        query: queryOf(req.query),
        headers: headersOf(req.headers),
        body: undefined,
        rawBody: body.text,
      };
      send(res, await handle(kit));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
