import { errorClass, safeWarn } from '@chatwarden/core';
import type { Logger } from '@chatwarden/core';
import { BODY_MAX_BYTES } from './body.js';
import { errorResponse, withErrors } from './errors.js';
import { compileRoutes } from './router.js';
import type { RouteTable } from './router.js';
import type { KitRequest, KitResponse, KitStream } from './types.js';

// The Web adapter: kit route tables behind a `(Request) => Promise<Response>`. It runs wherever the Fetch API does (Next.js route handlers, Bun,
// Deno, Workers, SvelteKit, Remix, a Fastify bridge) and imports nothing from Node, so it can also run in a page.

/**
 * Route tables by the path they live under: `{ '/admin': adminTable, '/api': playerTable, '': healthTable }`. A key is `''` or starts with `/`,
 * has no trailing `/`, and each of its parts is letters, digits and `_ . ~ -`.
 */
export type Mounts = Record<string, RouteTable>;

export interface FetchOptions {
  /** Where the mounts are rooted in the URL, such as `/chatwarden`. Default `''`. A request outside it is not this adapter's (see `unmatched`). Same rule as a mount key. */
  prefix?: string;
  /** The largest request body read, in bytes: a whole number from 1 to 16 MiB, default 65536 (the same cap `parseJson` enforces). More is the kit's 413. */
  maxBody?: number;
  /**
   * The socket peer's address, if the host can tell, for `KitRequest.remoteAddress` (Bun: `server.requestIP`; Next: nothing). Never read from a
   * header: a client can send any header. Default: absent.
   */
  remoteAddress?: (request: Request) => string | undefined;
  /** A path no mount owns: `'not_found'` (default) answers the kit's JSON 404; `'pass'` resolves `null` so the host can answer. */
  unmatched?: 'not_found' | 'pass';
  /** Where the adapter logs (event and error class only). Default `console.warn`. */
  logger?: Logger;
}

/** What `toFetch` returns: hand it a `Request`, get the kit's `Response`. */
export type FetchHandler = (request: Request) => Promise<Response>;

/** The largest `maxBody` accepted: the body is held in memory and decoded to one string. */
const MAX_BODY_LIMIT = 16 * 1024 * 1024;
/** How much a response stream holds before `write` says the consumer is behind (the same 16 KiB as a Node response). */
const STREAM_BUFFER_BYTES = 16 * 1024;
const PART = /^[A-Za-z0-9_.~-]+$/;
const KEY_MESSAGE = 'toFetch: a mount key and the prefix are "" or a path such as "/chatwarden": it starts with a slash, has no trailing slash and no empty or dot part';

function checkKey(key: unknown): string {
  if (typeof key !== 'string') throw new RangeError(KEY_MESSAGE);
  if (key === '') return key;
  const parts = key.startsWith('/') ? key.slice(1).split('/') : [];
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..' || !PART.test(part))) throw new RangeError(KEY_MESSAGE);
  return key;
}

/** The first value of each query key, strings only, on an object with no prototype (a `__proto__` key is plain data). */
function queryOf(url: URL): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of url.searchParams) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** The request headers, lower-cased; a repeated one is joined with ", " by the Headers object itself. */
function headersOf(headers: Headers): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [name, value] of headers) out[name.toLowerCase()] = value;
  return out;
}

/** What reading the body came to: the text, "too big", or "the stream failed". */
type Read = { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'failed' };

/**
 * The raw body as text. A GET or HEAD has none. A declared `content-length` over the cap is refused before the stream is touched; otherwise the
 * stream is read chunk by chunk, counting bytes, and abandoned (cancelled) the moment it passes the cap, so a body over the cap is never held.
 * The text is the bytes decoded as UTF-8, a byte-order mark kept and an invalid byte as U+FFFD: what the Express adapter gives.
 */
async function readBody(request: Request, method: string, max: number): Promise<Read> {
  if (method === 'GET' || method === 'HEAD') return { kind: 'ok', text: '' };
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) return { kind: 'too_large' };
  const body = request.body;
  if (body === null) return { kind: 'ok', text: '' };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: 'failed' };
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return { kind: 'ok', text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(joined) };
}

const JSON_TYPE = 'application/json; charset=utf-8';

function internal(head: boolean): Response {
  return new Response(head ? null : JSON.stringify({ error: 'internal' }), { status: 500, headers: { 'content-type': JSON_TYPE } });
}

/**
 * A KitResponse as a Response: a string body is sent raw (`text/plain` unless the route set a type), anything else as JSON, and `undefined` as no
 * body. For HEAD the status, headers and the length of what GET would send, and no body. Throws (and the caller answers 500) for what a Response
 * cannot hold: an invalid status, a header name or value with a line break, a body that is not JSON-serialisable, a body on a 204.
 */
function toResponse(kit: KitResponse, head: boolean): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(kit.headers ?? {})) headers.set(name, value);
  let payload: string | undefined;
  if (typeof kit.body === 'string') {
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
    payload = kit.body;
  } else {
    payload = kit.body === undefined ? undefined : JSON.stringify(kit.body);
    if (!headers.has('content-type')) headers.set('content-type', JSON_TYPE);
  }
  if (head) {
    if (payload !== undefined && !headers.has('content-length')) headers.set('content-length', String(new TextEncoder().encode(payload).byteLength));
    return new Response(null, { status: kit.status, headers });
  }
  return new Response(payload ?? null, { status: kit.status, headers });
}

/**
 * A KitResponse with `stream` as a Response whose body is a ReadableStream (Server-Sent Events). The status and headers are the route's, plus
 * `cache-control: no-store, no-transform`, `x-accel-buffering: no` and `content-type: text/event-stream; charset=utf-8` for each one it left out.
 * `start` runs before the Response is returned, so a throw before any chunk is the kit's 500; after a chunk it is too late for that, and the
 * stream errors once what was queued has been read. `write` returns false when the stream holds more than the consumer has taken (its
 * `desiredSize` is not positive), the chunk still queued. The cancel `start` returned runs exactly once: when the sink ends the stream, the
 * consumer cancels it, or `request.signal` aborts, whichever comes first. A HEAD gets the headers and no body, and `start` is not called.
 */
function streamResponse(request: Request, kit: KitResponse, stream: KitStream, head: boolean, logger: Logger | undefined): Response {
  if (typeof stream.start !== 'function') throw new TypeError('KitResponse.stream.start must be a function');
  const headers = new Headers();
  for (const [name, value] of Object.entries(kit.headers ?? {})) headers.set(name, value);
  // `no-transform` is what keeps a proxy or a compressing layer from holding the first frames back.
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store, no-transform');
  if (!headers.has('x-accel-buffering')) headers.set('x-accel-buffering', 'no');
  if (!headers.has('content-type')) headers.set('content-type', 'text/event-stream; charset=utf-8');
  if (head) return new Response(null, { status: kit.status, headers });

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false; // the consumer is gone or the stream has ended: no more writes
  let written = false; // a chunk or the end has been given to the stream: too late for a 500
  let cancelled = false;
  let cancel: (() => void) | undefined;
  let failure: { error: unknown } | undefined;
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
    request.signal.removeEventListener('abort', gone);
    runCancel();
  };
  const readable = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      // A deferred error: it is raised once what the stream already holds has been read, so the consumer sees those chunks and then the failure.
      pull(c) {
        if (failure !== undefined && c.desiredSize === STREAM_BUFFER_BYTES) {
          const { error } = failure;
          failure = undefined;
          c.error(error);
        }
      },
      cancel() {
        gone();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: STREAM_BUFFER_BYTES }),
  );
  const open = controller as ReadableStreamDefaultController<Uint8Array>;
  if (request.signal.aborted) {
    open.close();
    return new Response(readable, { status: kit.status, headers });
  }
  request.signal.addEventListener('abort', gone, { once: true });

  let returned: unknown;
  try {
    returned = stream.start({
      write(chunk: string): boolean {
        if (finished) return false;
        try {
          if (chunk !== '') open.enqueue(encoder.encode(chunk));
        } catch {
          return false;
        }
        written = true;
        const room = open.desiredSize;
        return room !== null && room > 0;
      },
      end(): void {
        if (!finished) {
          try {
            open.close();
          } catch {
            // already closed or errored
          }
          written = true;
        }
        gone();
      },
    });
  } catch (err) {
    finished = true;
    request.signal.removeEventListener('abort', gone);
    if (!written) throw err;
    safeWarn(logger, 'chatwarden.http_error', { error: errorClass(err) });
    failure = { error: err };
    return new Response(readable, { status: kit.status, headers });
  }
  if (typeof returned === 'function') cancel = returned as () => void;
  runCancel();
  return new Response(readable, { status: kit.status, headers });
}

/**
 * Serve kit route tables from a Web `Request`: `toFetch({ '/admin': adminRoutes(cw, { authorize }), '': healthRoutes(cw) }, { prefix: '/chatwarden' })`
 * gives a `(request) => Promise<Response>` for a Next.js route handler, a Bun or Deno server, a Worker, or the Fastify bridge init writes.
 *
 * - The longest mount key that owns the path wins, and the prefix and the key are stripped before the table sees the path, so the tables
 *   `toExpress` takes work as they are. A key owns the whole path segments under it (`/a` owns `/a/x`, not `/ab`); the root key `''` owns only
 *   the paths its own table has. A path no mount owns is the kit's JSON 404, or `null` with `unmatched: 'pass'`. Inside a mount a path no
 *   route has is the kit's 404 and a wrong method its 405 with `allow`, exactly as `createRouter` answers.
 * - The `KitRequest` is built like the Express adapter builds it: `query` holds the first value of each key (strings, on a prototype-free
 *   object), header names are lower-cased, `rawBody` is the body decoded as UTF-8 (a GET or HEAD has an empty one), `body` stays `undefined`,
 *   and `remoteAddress` comes only from the `remoteAddress` option.
 * - A body over `maxBody` bytes is 413 `payload_too_large` in the kit's error shape: a declared `content-length` over it is refused before
 *   the body is read, and a stream that passes it is cancelled. A stream that fails midway is a 400.
 * - A handler's own error is the kit's 500 `{ error: 'internal' }` with no stack (and a response the Fetch API cannot hold, such as an
 *   invalid status or a header with a line break, is the same 500), logged by error class only.
 * - A KitResponse becomes status and headers; a string body is sent raw (`text/plain` unless the route set a type), anything else as JSON.
 *   HEAD on a GET route has the GET status and headers and no body. A KitResponse with `stream` is a streaming Response (see `streamResponse`).
 *
 * Mount keys, the prefix and `maxBody` are checked when this is called: a bad one is a `RangeError` that does not repeat the value.
 */
export function toFetch(mounts: Mounts, options: FetchOptions & { unmatched: 'pass' }): (request: Request) => Promise<Response | null>;
export function toFetch(mounts: Mounts, options?: FetchOptions): FetchHandler;
export function toFetch(mounts: Mounts, options?: FetchOptions): (request: Request) => Promise<Response | null> {
  if (typeof mounts !== 'object' || mounts === null || Array.isArray(mounts)) throw new TypeError('toFetch: mounts must be an object of route tables');
  const settings: FetchOptions = options ?? {};
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('toFetch: options must be an object');
  const { logger } = settings;
  const prefix = checkKey(settings.prefix ?? '');
  const max = settings.maxBody === undefined ? BODY_MAX_BYTES : settings.maxBody;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > MAX_BODY_LIMIT) {
    throw new RangeError('toFetch: maxBody must be a positive whole number of bytes, at most 16 MiB');
  }
  const unmatched = settings.unmatched ?? 'not_found';
  if (unmatched !== 'not_found' && unmatched !== 'pass') throw new TypeError("toFetch: unmatched must be 'not_found' or 'pass'");
  const remoteAddress = settings.remoteAddress;
  if (remoteAddress !== undefined && typeof remoteAddress !== 'function') throw new TypeError('toFetch: remoteAddress must be a function');

  const entries = Object.entries(mounts)
    .map(([key, table]) => {
      checkKey(key);
      if (typeof table !== 'object' || table === null || Array.isArray(table)) throw new TypeError('toFetch: every mount must be a route table');
      const compiled = compileRoutes(table);
      return { key, compiled, handle: withErrors(compiled.run, logger) };
    })
    // The longest key first, so the order the mounts were written in never decides.
    .sort((a, b) => b.key.length - a.key.length);

  return async (request: Request): Promise<Response | null> => {
    // Request only upper-cases the methods it knows (a PATCH sent as patch stays patch); the router does not care, a route's own check might.
    const method = request.method.toUpperCase();
    const head = method === 'HEAD';
    try {
      const url = new URL(request.url);
      let path = url.pathname;
      if (prefix !== '') {
        if (path !== prefix && !path.startsWith(`${prefix}/`)) return unmatched === 'pass' ? null : toResponse(errorResponse('not_found'), head);
        path = path.slice(prefix.length) || '/';
      }
      let owner: { handle: (req: KitRequest) => Promise<KitResponse> } | undefined;
      let rest = path;
      for (const entry of entries) {
        if (entry.key === '') {
          if (entry.compiled.matches(path, method)) {
            owner = entry;
            break;
          }
        } else if (path === entry.key || path.startsWith(`${entry.key}/`)) {
          owner = entry;
          rest = path.slice(entry.key.length) || '/';
          break;
        }
      }
      if (owner === undefined) return unmatched === 'pass' ? null : toResponse(errorResponse('not_found'), head);

      const body = await readBody(request, method, max);
      if (body.kind === 'too_large') return toResponse(errorResponse('payload_too_large'), head);
      if (body.kind === 'failed') return toResponse(errorResponse('invalid_request'), head);

      let address: string | undefined;
      if (remoteAddress !== undefined) {
        try {
          const given = remoteAddress(request);
          if (typeof given === 'string' && given !== '') address = given;
        } catch (err) {
          safeWarn(logger, 'chatwarden.http_error', { error: errorClass(err) });
        }
      }
      const kit: KitRequest = {
        method,
        path: rest,
        query: queryOf(url),
        headers: headersOf(request.headers),
        body: undefined,
        rawBody: body.text,
        ...(address === undefined ? {} : { remoteAddress: address }),
      };
      const response = await owner.handle(kit);
      return response.stream === undefined ? toResponse(response, head) : streamResponse(request, response, response.stream, head, logger);
    } catch (err) {
      safeWarn(logger, 'chatwarden.http_error', { error: errorClass(err) });
      return internal(head);
    }
  };
}
