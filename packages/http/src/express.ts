import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { errorClass, safeWarn } from '@chatwarden/core';
import type { Logger } from '@chatwarden/core';
import { BODY_MAX_BYTES } from './body.js';
import { errorResponse, withErrors } from './errors.js';
import { compileRoutes } from './router.js';
import type { RouteTable } from './router.js';
import type { KitRequest, KitResponse, KitStream } from './types.js';

export interface ExpressOptions {
  /**
   * The largest request body the adapter will read, in bytes. A positive whole number; default 65536 (the same cap
   * `parseJson` enforces). More than that is a 413 in the kit's error shape, and the adapter stops reading. At most
   * 16 MiB (`RangeError` above). Raising it does not raise the routes' own 64 KiB JSON cap.
   */
  maxBody?: number;
  /** Where the adapter logs (event and error class only). Defaults to `console.warn`. */
  logger?: Logger;
  /**
   * What happens to a request whose path matches none of the kit's routes. Default `true`: the adapter calls `next()` before
   * it reads the body, so the rest of your app (your own routes, a later `express.json()`) sees the request untouched. With
   * `false` the kit answers it itself with its 404 `{ error: 'not_found' }`, so nothing mounted after it is reached.
   * Either way a path that matches a route under another method is the kit's 405, and a handler that answers 404 (an
   * unknown id) is the kit's 404: those are answers, not "no route". The exception is `OPTIONS` with `true`: unless the
   * table has an `OPTIONS` route for the path it goes on too, so your CORS middleware (mounted BEFORE the kit) can answer
   * the preflight. Must be a boolean (`TypeError`).
   */
  fallthrough?: boolean;
}

/** The largest `maxBody` the adapter accepts: the body is buffered and decoded to a single string. */
const MAX_BODY_LIMIT = 16 * 1024 * 1024;

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

/** True when something already read (or parsed) the request body, so the raw bytes are gone. (A destroyed request is checked apart.) */
const consumed = (req: Request): boolean => (req.body as unknown) !== undefined || req.readableEnded || req.readableDidRead;

/** What reading the body came to: the text, "too big", or "the client went away". */
type Read = { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'aborted' };

/**
 * Read the raw body. Every listener runs inside a try/catch that REJECTS the promise, so a throw in a stream listener (a
 * decoder failure, say) reaches the caller's catch instead of escaping as an uncaught exception with the request hanging.
 */
function readBody(req: Request, max: number): Promise<Read> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > max) {
    return Promise.resolve({ kind: 'too_large' });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const detach = (): void => {
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onGone);
      req.off('close', onClose);
    };
    const finish = (result: Read): void => {
      if (done) return;
      detach();
      if (result.kind === 'too_large') req.pause();
      resolve(result);
    };
    const fail = (err: unknown): void => {
      if (done) return;
      detach();
      req.pause();
      reject(err);
    };
    const onData = (chunk: Buffer | string): void => {
      try {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        size += buf.length;
        if (size > max) {
          finish({ kind: 'too_large' });
          return;
        }
        chunks.push(buf);
      } catch (err) {
        fail(err);
      }
    };
    const onEnd = (): void => {
      try {
        finish({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
      } catch (err) {
        fail(err);
      }
    };
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

/**
 * Send a KitResponse with `status().end(payload)`: no `res.send` or `res.json`, so no ETag, no 304 and no guessing of a
 * content type. `applied` collects the header names set, so a failure can take them back off. For `head` the payload is
 * built exactly as for a GET (same content type, and its byte length as `content-length`) but not written.
 */
function send(res: Response, kit: KitResponse, applied: string[], head = false): void {
  res.status(kit.status);
  for (const [name, value] of Object.entries(kit.headers ?? {})) {
    res.setHeader(name, value);
    applied.push(name);
  }
  const set = (name: string, value: string): void => {
    if (res.hasHeader(name)) return;
    res.setHeader(name, value);
    applied.push(name);
  };
  let payload: string | undefined;
  if (typeof kit.body === 'string') {
    set('content-type', 'text/plain; charset=utf-8');
    payload = kit.body;
  } else {
    // `undefined` has no payload; anything else is JSON. JSON.stringify can throw: the caller handles it.
    payload = kit.body === undefined ? undefined : JSON.stringify(kit.body);
    set('content-type', 'application/json; charset=utf-8');
  }
  if (head) {
    if (payload !== undefined) set('content-length', String(Buffer.byteLength(payload, 'utf8')));
    res.end();
  } else if (payload === undefined) res.end();
  else res.end(payload, 'utf8');
}

/**
 * Send a response that stays open (`KitResponse.stream`). The status and headers are set as for any response, plus `cache-control:
 * no-store`, `x-accel-buffering: no` and `content-type: text/event-stream; charset=utf-8` for each one the route left out. A HEAD gets
 * those and no body, and `start` is not called. Otherwise `start` is called once with a sink over `res`, and the cancel it returns
 * is called exactly once: when the client goes away, or when the sink ends the response, whichever comes first.
 *
 * The headers go out with the first write, or right after `start` returns if it wrote nothing, so a `start` that throws before any
 * byte is still the kit's 500; once a byte has gone out, the caller destroys the connection.
 */
function sendStream(req: Request, res: Response, kit: KitResponse, stream: KitStream, applied: string[], head: boolean, logger: Logger | undefined): void {
  if (typeof stream.start !== 'function') throw new TypeError('KitResponse.stream.start must be a function');
  res.status(kit.status);
  for (const [name, value] of Object.entries(kit.headers ?? {})) {
    res.setHeader(name, value);
    applied.push(name);
  }
  const set = (name: string, value: string): void => {
    if (res.hasHeader(name)) return;
    res.setHeader(name, value);
    applied.push(name);
  };
  set('cache-control', 'no-store');
  set('x-accel-buffering', 'no');
  set('content-type', 'text/event-stream; charset=utf-8');
  if (head) {
    res.end();
    return;
  }
  // The client left while the handler was still running: nothing to stream to, and nothing was started.
  if (res.destroyed || req.socket.destroyed) return;
  req.socket.setNoDelay(true);

  let finished = false; // the client is gone or the response has ended: no more writes
  let cancelled = false;
  let cancel: (() => void) | undefined;
  const runCancel = (): void => {
    if (!finished || cancelled || cancel === undefined) return;
    cancelled = true;
    try {
      cancel();
    } catch (err) {
      safeWarn(logger, 'chatwarden.http_error', { error: errorClass(err) });
    }
  };
  const gone = (): void => {
    finished = true;
    runCancel();
  };
  res.on('close', gone);
  res.on('error', gone);

  const returned = stream.start({
    write(chunk: string): boolean {
      if (finished || res.destroyed || res.writableEnded) return false;
      try {
        return res.write(chunk);
      } catch {
        return false;
      }
    },
    end(): void {
      if (!finished && !res.destroyed && !res.writableEnded) {
        try {
          res.end();
        } catch {
          // already gone
        }
      }
      gone();
    },
  });
  if (typeof returned === 'function') cancel = returned;
  if (!res.headersSent && !res.writableEnded && !res.destroyed) res.flushHeaders();
  runCancel();
}

/**
 * Mount kit routes (`adminRoutes`, `playerRoutes`, `healthRoutes`, or a table of your own) on an Express app:
 * `app.use('/admin', toExpress(adminRoutes(cw, { authorize })))`.
 *
 * - Mount it BEFORE any body parser. The adapter reads the raw body itself (so a webhook can verify a signature over the
 *   exact bytes) and routes parse it with the kit's own `parseJson`. If `express.json()` (or `raw`, `text`) already ran
 *   for the request, the bytes are gone: the answer is 500 `internal`, and `chatwarden.http_body_already_parsed` is
 *   logged once per adapter. If your app needs `express.json()`, mount it on your own routes, not globally.
 * - A path that matches none of its routes goes on to the next Express handler (`fallthrough`, default true), and the body
 *   is not read, so a kit mounted at `/` does not hide the routes and body parsers mounted after it. A wrong method on a
 *   known path is still the kit's 405, and a handler's own 404 (an unknown report id) still the kit's 404. The one
 *   exception is `OPTIONS`: unless the table has an `OPTIONS` route for the path, it goes on too, so the CORS middleware
 *   you mount BEFORE `toExpress` answers a preflight (the kit does no CORS itself). With
 *   `{ fallthrough: false }` the adapter answers EVERY path under its mount point itself (an unknown path is the kit's
 *   404), so mount it after your own routes, or at a prefix.
 * - `path` is relative to the mount point; `query` holds the first string value of each key; header names are
 *   lowercased and an array is joined with ", ".
 * - A body over `maxBody` bytes is 413 `payload_too_large`; the adapter stops reading and closes the connection.
 *   `maxBody` is a positive whole number of bytes, at most 16 MiB (a larger one is a `RangeError` when the adapter is
 *   built): the body is held in memory and decoded to one string before the routes see it.
 * - `remoteAddress` is the socket peer, never a header; behind a proxy, your `identify` decides what to trust.
 * - `rawBody` is the body decoded as UTF-8: exact for valid UTF-8; an invalid byte becomes U+FFFD, so a signature over
 *   the original bytes fails to verify (it fails closed).
 * - A `KitResponse` becomes status + headers; a string body is sent raw (with its own `content-type`, `text/plain` if
 *   none), anything else as JSON. The response is written with `end`, so there is no ETag and no 304, and
 *   `x-powered-by` is removed. HEAD on a GET route has the GET status, headers, content type and `content-length`, and
 *   no body bytes.
 * - A handler's own error is the kit's 500 `internal` (the router wraps it). An error while SENDING (an invalid status,
 *   a CR/LF in a header, a body that is not JSON-serialisable) never goes to Express's error handlers, so no stack page
 *   can reach a client: it is logged (`chatwarden.http_error`, error class only), the headers the adapter set are
 *   removed and the kit 500 `{ error: 'internal' }` is sent; if the headers had already gone out the connection is
 *   destroyed.
 * - A `KitResponse` with `stream` stays open (Server-Sent Events): the adapter sends the status and headers, adds
 *   `cache-control: no-store`, `x-accel-buffering: no` and `content-type: text/event-stream; charset=utf-8` where the route
 *   set none, turns off the socket's Nagle delay, calls `stream.start(sink)` and calls the cancel it returns exactly once,
 *   when the client leaves or the sink ends the response. `body` is ignored; a HEAD gets the headers and no `start`. A
 *   throw from `start` before any byte is the kit 500; after the first byte the connection is destroyed (that `start`
 *   returned no cancel, so it releases what it took itself).
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
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > MAX_BODY_LIMIT) {
    throw new RangeError('toExpress: maxBody must be a positive whole number of bytes, at most 16 MiB');
  }
  const fallthrough = options.fallthrough === undefined ? true : options.fallthrough;
  if (typeof fallthrough !== 'boolean') throw new TypeError('toExpress: fallthrough must be a boolean');
  const compiled = compileRoutes(routes);
  const handle = withErrors(compiled.run, logger);
  let warnedParsed = false;

  const router = Router();
  // Calls `next()` only with no argument and only for a path that is not the kit's: nothing here may reach Express's own
  // error handling.
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    const applied: string[] = [];
    try {
      // Not ours: hand it on before touching anything, the body included.
      if (fallthrough && !compiled.matches(req.path, req.method)) {
        next();
        return;
      }
      res.removeHeader('x-powered-by');
      // The client is already gone: nothing to answer, and nothing the adopter did wrong.
      if (req.destroyed) return;
      if (consumed(req)) {
        if (!warnedParsed) {
          warnedParsed = true;
          safeWarn(logger, 'chatwarden.http_body_already_parsed');
        }
        send(res, { status: 500, body: { error: 'internal' } }, applied, req.method === 'HEAD');
        return;
      }
      const body = await readBody(req, max);
      if (body.kind === 'aborted') return;
      if (body.kind === 'too_large') {
        res.setHeader('connection', 'close');
        send(res, errorResponse('payload_too_large'), applied, req.method === 'HEAD');
        return;
      }
      const kit: KitRequest = {
        method: req.method,
        path: req.path,
        query: queryOf(req.query),
        headers: headersOf(req.headers),
        body: undefined,
        rawBody: body.text,
        ...(typeof req.socket.remoteAddress === 'string' ? { remoteAddress: req.socket.remoteAddress } : {}),
      };
      const response = await handle(kit);
      if (response.stream === undefined) send(res, response, applied, req.method === 'HEAD');
      else sendStream(req, res, response, response.stream, applied, req.method === 'HEAD', logger);
    } catch (err) {
      safeWarn(logger, 'chatwarden.http_error', { error: errorClass(err) });
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      try {
        for (const name of applied) res.removeHeader(name);
        res.statusCode = 200;
        send(res, { status: 500, body: { error: 'internal' } }, [], req.method === 'HEAD');
      } catch {
        res.destroy();
      }
    }
  });
  return router;
}
