/**
 * One call to the player routes. `path` is the route path with no prefix (`/notices`); the transport adds whatever prefix its
 * server uses. `query` values that are `undefined` are left out. `body` is sent as JSON.
 *
 * This is the same shape `@chatwarden/hub-react` uses for the staff routes. It is written out here so this package does not
 * depend on that one; a test keeps the two assignable to each other.
 */
export interface TransportRequest {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Lets the caller abandon the call (fetch only; the in-page router answers at once). */
  signal?: AbortSignal;
  /** Lets the call finish after the page is gone (fetch `keepalive`). Ignored by the in-page router. */
  keepalive?: boolean;
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
 * How the components reach the player routes. It resolves with the response whatever the status, and rejects only when no
 * answer arrived (a dropped connection, a handler that threw); the client turns that into a `network` error.
 */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** What `routerTransport` sends to a `createRouter(...)` handler: the kit's `KitRequest`, written out structurally. */
export interface RouterRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: undefined;
  rawBody?: string;
}

/** What a `createRouter(...)` handler answers: the kit's `KitResponse`, written out structurally. */
export interface RouterResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

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
  /** Sent with every request, for an `identify` hook that reads a header. */
  headers?: Record<string, string>;
}

/**
 * A transport that calls `createRouter(playerRoutes(...))` directly, in the same process: no network. A demo and this
 * package's tests use it, so the components run the real player routes. A response body goes through JSON on the way out, so
 * the components see exactly what a fetch would deliver.
 */
export function routerTransport(handle: (req: RouterRequest) => Promise<RouterResponse>, options: RouterTransportOptions = {}): Transport {
  return async (req) => {
    const request: RouterRequest = {
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
  /** Where the player routes are mounted: `https://host/player` or `/player`. No trailing slash needed. */
  baseUrl: string;
  /** Sent with every request (a session token, for example). */
  headers?: Record<string, string>;
  /** `include` sends cookies to another origin. Default: the browser's (`same-origin`). */
  credentials?: RequestCredentials;
  /** For tests, or a polyfill. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** The default transport for a real game: `fetch` against the routes your server mounts. */
export function fetchTransport(options: FetchTransportOptions): Transport {
  if (typeof options?.baseUrl !== 'string') throw new TypeError('fetchTransport: baseUrl is required (for example "/player")');
  // "/" and "" both mean the server root: routes are then "/notices", "/record", ...
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
    if (req.keepalive === true) init.keepalive = true;
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
