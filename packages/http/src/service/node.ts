// The Node bridge of `chatwarden serve`: an `http.createServer` request to a Web `Request` (with a byte cap and a read timeout) and the `Response` back to the socket (with backpressure).
// It is the only place the service meets Node's HTTP types. It trusts no forwarding header: the address of a player is the socket's, and a header is only a header.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { BODY_MAX_BYTES } from '../body.js';
import { errorResponse } from '../errors.js';
import type { ErrorCode } from '../errors.js';
import { SERVICE_API_VERSION, requestIdFor } from './contract.js';

/** The longest the bridge waits for a request's body to arrive. */
export const READ_TIMEOUT_MS = 10_000;

const peers = new WeakMap<Request, string>();

/** The address of the socket a `Request` came in on, or undefined. Hand it to `toFetch` as its `remoteAddress` option: it is never read from a header. */
export function peerAddress(request: Request): string | undefined {
  return peers.get(request);
}

export interface NodeHandlerOptions {
  /** The largest request body in bytes. Default 65536. */
  maxBody?: number;
  /** How long to wait for the body, in ms. Default 10 000. */
  readTimeoutMs?: number;
}

type Reading = { kind: 'ok'; body: Buffer } | { kind: 'too_large' } | { kind: 'timeout' } | { kind: 'failed' };

/** The body of a request, read with a cap and a timeout. A declared length over the cap is refused before a byte is read. */
function readBody(req: IncomingMessage, max: number, timeoutMs: number): Promise<Reading> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > max) return Promise.resolve({ kind: 'too_large' });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: Reading): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) finish({ kind: 'too_large' });
      else chunks.push(chunk);
    };
    const onEnd = (): void => finish({ kind: 'ok', body: Buffer.concat(chunks, size) });
    const onError = (): void => finish({ kind: 'failed' });
    const onClose = (): void => finish(req.complete ? { kind: 'ok', body: Buffer.concat(chunks, size) } : { kind: 'failed' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/** The request headers as a Headers object; a header Node accepted but `Headers` will not hold is left out. */
function headersOf(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    try {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else headers.append(name, value);
    } catch {
      /* not representable: left out */
    }
  }
  return headers;
}

/** Is this path the service API (`/v1` or under it)? Its answers all carry the version and a request id, bridge errors included. */
const isService = (pathname: string): boolean => pathname === '/v1' || pathname.startsWith('/v1/');

/** The headers every /v1 answer carries, for an error the bridge writes itself: the version, the caller's request id when it is a valid one (else a fresh one), no-store and nosniff. */
function serviceHeaders(req: IncomingMessage): Record<string, string> {
  const given = req.headers['x-request-id'];
  return { 'chatwarden-api': String(SERVICE_API_VERSION), 'x-request-id': requestIdFor(typeof given === 'string' ? given : undefined), 'x-content-type-options': 'nosniff' };
}

function sendError(res: ServerResponse, code: ErrorCode | 'internal', extra: Record<string, string> = {}, close = false): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  // `internal` is the bridge's own, a 500 with no detail (the README's `internal` row); a 408 for a body that did not arrive is the `request_timeout` code. Every body is `{ error, message }`, as the API's other errors are.
  const { status, body } = code === 'internal' ? { status: 500, body: { error: 'internal', message: 'Something went wrong on the server.' } } : errorResponse(code);
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...(close ? { connection: 'close' } : {}), ...extra });
  res.end(text);
}

/** Write a `Response` to the socket: the status and headers, then the body chunk by chunk, waiting for the socket to drain, and cancel the body if the client goes away first. */
async function send(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let finished = false;
  let cancelled = false;
  const cancel = (): void => {
    if (finished || cancelled) return;
    cancelled = true;
    void reader.cancel().catch(() => undefined);
  };
  res.once('close', cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || cancelled) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const release = (): void => {
            res.off('drain', release);
            res.off('close', release);
            resolve();
          };
          res.once('drain', release);
          res.once('close', release);
        });
      }
      if (cancelled || res.destroyed) break;
    }
  } catch {
    cancel();
  } finally {
    finished = true;
    res.off('close', cancel);
  }
  if (!res.destroyed) res.end();
}

/** The path of a request's target, or '' when it has none that parses. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://chatwarden.invalid').pathname;
  } catch {
    return '';
  }
}

/**
 * A request listener for `http.createServer`: `createServer(nodeHandler(toFetch(mounts, { remoteAddress: peerAddress })))`. HEAD is answered on `/healthz` and `/readyz` only (as GET, no body) and is 405 everywhere else. A body over the cap is
 * 413 and one that does not arrive in time is 408, both before the handler runs. Nothing a handler throws reaches the client: a 500 with no detail.
 */
export function nodeHandler(handle: (request: Request) => Promise<Response | null>, options: NodeHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const max = options.maxBody ?? BODY_MAX_BYTES;
  const timeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  return (req, res) => {
    void (async () => {
      try {
        let method = (req.method ?? 'GET').toUpperCase();
        const target = req.url ?? '/';
        if (!target.startsWith('/')) return sendError(res, 'invalid_request');
        let url: URL;
        try {
          url = new URL(target, 'http://chatwarden.invalid');
        } catch {
          return sendError(res, 'invalid_request');
        }
        // Errors the bridge writes itself on /v1 carry the service headers, as every other /v1 answer does.
        const more = isService(url.pathname) ? serviceHeaders(req) : {};
        if (method === 'HEAD') {
          // A load balancer or an uptime monitor may probe the two health paths with HEAD: answered as GET (Node sends no body). Nothing else answers HEAD.
          if (url.pathname !== '/healthz' && url.pathname !== '/readyz') return sendError(res, 'method_not_allowed', { allow: 'GET, POST, PUT, DELETE', ...more });
          method = 'GET';
        }
        let body: Buffer | undefined;
        if (method !== 'GET') {
          const read = await readBody(req, max, timeoutMs);
          if (read.kind === 'too_large') return sendError(res, 'payload_too_large', more, true);
          if (read.kind === 'timeout') {
            sendError(res, 'request_timeout', more, true);
            req.destroy();
            return;
          }
          if (read.kind === 'failed') return sendError(res, 'invalid_request', more, true);
          body = read.body;
        }
        const request = new Request(url, { method, headers: headersOf(req.headers), ...(body === undefined || body.length === 0 ? {} : { body }) });
        const address = req.socket.remoteAddress;
        if (address !== undefined) peers.set(request, address);
        const response = await handle(request);
        if (response === null) return sendError(res, 'not_found', more);
        await send(response, res);
      } catch {
        sendError(res, 'internal', isService(pathOf(req)) ? serviceHeaders(req) : {});
      }
    })();
  };
}
