import type { KitRequest, KitResponse } from '@chatwarden/http/admin';

/**
 * One call to the staff API, as the hub makes it. `path` is the route path with no prefix (`/reports/abc`); the transport
 * adds whatever prefix its server uses. `query` values that are `undefined` are left out. `body` is sent as JSON.
 */
export interface TransportRequest {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Lets the caller abandon the call (fetch only; the in-page router answers at once). */
  signal?: AbortSignal;
}

/**
 * What came back: any HTTP status is an answer, not an error. `headers` are lower-case. `body` is the parsed JSON, a string
 * for a text document, or null when there was none.
 */
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * How the hub reaches the staff API. It resolves with the response whatever the status, and rejects only when no answer
 * arrived (a dropped connection, a handler that threw); the client turns that into a `network` error.
 */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** The query as strings, with `undefined` values dropped. */
function queryOf(query: TransportRequest['query']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) out[key] = String(value);
  return out;
}

function lowerCased(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
  return out;
}

export interface RouterTransportOptions {
  /** Sent with every request, for an `authorize` hook that reads a header. */
  headers?: Record<string, string>;
}

/**
 * A transport that calls `createRouter(adminRoutes(...))` directly, in the same process: no network. The landing-page demo
 * and the hub's tests use it, so the hub runs the real staff routes. A response body goes through JSON on the way out, so
 * the hub sees exactly what a fetch would deliver.
 */
export function routerTransport(handle: (req: KitRequest) => Promise<KitResponse>, options: RouterTransportOptions = {}): Transport {
  return async (req) => {
    const request: KitRequest = {
      method: req.method,
      path: req.path,
      query: queryOf(req.query),
      headers: { ...options.headers },
      body: undefined,
    };
    // The routes read `rawBody`, never `body` (a pre-parsed body would skip the size cap and the key check).
    if (req.body !== undefined) request.rawBody = JSON.stringify(req.body);
    const res = await handle(request);
    const body: unknown = typeof res.body === 'string' ? res.body : res.body === undefined ? null : (JSON.parse(JSON.stringify(res.body)) as unknown);
    return { status: res.status, headers: lowerCased(res.headers), body };
  };
}

export interface FetchTransportOptions {
  /** Where the staff routes are mounted: `https://host/admin` or `/admin`. No trailing slash needed. */
  baseUrl: string;
  /** Sent with every request (a CSRF token, for example). */
  headers?: Record<string, string>;
  /** `include` sends cookies to another origin. Default: the browser's (`same-origin`). */
  credentials?: RequestCredentials;
  /** For tests, or a polyfill. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** The default transport for a real app: `fetch` against the routes your server mounts. */
export function fetchTransport(options: FetchTransportOptions): Transport {
  if (typeof options?.baseUrl !== 'string') throw new TypeError('fetchTransport: baseUrl is required (for example "/admin")');
  // "/" and "" both mean the server root: routes are then "/me", "/reports", ...
  const base = options.baseUrl.replace(/\/+$/, '');
  return async (req) => {
    const params = new URLSearchParams(queryOf(req.query)).toString();
    const url = `${base}${req.path}${params === '' ? '' : `?${params}`}`;
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(req.body);
    }
    if (options.credentials !== undefined) init.credentials = options.credentials;
    if (req.signal !== undefined) init.signal = req.signal;
    const res = await (options.fetch ?? globalThis.fetch)(url, init);
    const headersOut: Record<string, string> = {};
    res.headers.forEach((value, key) => (headersOut[key.toLowerCase()] = value));
    const text = await res.text();
    let body: unknown = text === '' ? null : text;
    if (text !== '' && /\bjson\b/i.test(headersOut['content-type'] ?? '')) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: res.status, headers: headersOut, body };
  };
}
