import { errorResponse } from './errors.js';
import type { KitRequest, KitResponse, RouteParams } from './types.js';

export type RouteHandler = (req: KitRequest, params: RouteParams) => KitResponse | Promise<KitResponse>;

/** Routes keyed `METHOD /path/:param`, e.g. `'GET /reports/:id'`. */
export type RouteTable = Record<string, RouteHandler>;

const PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^([A-Z]+) (\/(?:[A-Za-z0-9_.~-]+|:[A-Za-z0-9_]+)(?:\/(?:[A-Za-z0-9_.~-]+|:[A-Za-z0-9_]+))*|\/)$/;

interface Route {
  method: string;
  /** `null` marks a param segment. */
  segments: Array<string | null>;
  names: Array<string | null>;
  literals: number;
  handler: RouteHandler;
}

/** Match `segments` to `pattern`; null for no match, a bad param included. */
function matchPath(route: Route, segments: string[]): RouteParams | null {
  if (route.segments.length !== segments.length) return null;
  const params: RouteParams = Object.create(null) as RouteParams;
  for (let i = 0; i < segments.length; i++) {
    const raw = segments[i] as string;
    const want = route.segments[i];
    if (want === null) {
      let value: string;
      try {
        value = decodeURIComponent(raw);
      } catch {
        return null;
      }
      if (!PARAM_RE.test(value)) return null;
      params[route.names[i] as string] = value;
    } else if (want !== raw) {
      return null;
    }
  }
  return params;
}

/**
 * A router over a route table. `createRouter(routes)` returns `(req) => Promise<KitResponse>`.
 * - the query string is stripped; a trailing slash, an empty segment or a path without a leading `/` is no match.
 * - a param is URI-decoded, then must match `^[A-Za-z0-9_-]{1,64}$`; a malformed encoding or a bad value is no match.
 * - a literal segment beats a param segment.
 * - no match -> 404; a path that matches under other methods only -> 405 with an `allow` header.
 * Handler errors propagate: wrap the router (or each handler) in `withErrors`.
 */
export function createRouter(routes: RouteTable): (req: KitRequest) => Promise<KitResponse> {
  const table: Route[] = [];
  const seen = new Set<string>();
  for (const [key, handler] of Object.entries(routes)) {
    const m = KEY_RE.exec(key);
    if (m === null) throw new RangeError('router: a route must look like "GET /path/:param"');
    const method = m[1] as string;
    const path = m[2] as string;
    const parts = path === '/' ? [] : path.slice(1).split('/');
    const segments = parts.map((p) => (p.startsWith(':') ? null : p));
    const names = parts.map((p) => (p.startsWith(':') ? p.slice(1) : null));
    const shape = `${method} /${segments.map((s) => s ?? ':').join('/')}`;
    if (seen.has(shape)) throw new RangeError('router: two routes have the same method and shape');
    seen.add(shape);
    table.push({ method, segments, names, literals: segments.filter((s) => s !== null).length, handler });
  }
  // Most literal segments first, so `/reports/export` wins over `/reports/:id`.
  table.sort((a, b) => b.literals - a.literals);

  return async (req) => {
    const path = req.path.split('?', 1)[0] as string;
    if (!path.startsWith('/')) return errorResponse('not_found');
    const segments = path === '/' ? [] : path.slice(1).split('/');
    if (segments.some((s) => s === '')) return errorResponse('not_found');
    const method = req.method.toUpperCase();

    const allowed = new Set<string>();
    for (const route of table) {
      const params = matchPath(route, segments);
      if (params === null) continue;
      if (route.method === method) return route.handler(req, params);
      allowed.add(route.method);
    }
    if (allowed.size > 0) return errorResponse('method_not_allowed', { allow: [...allowed].sort().join(', ') });
    return errorResponse('not_found');
  };
}
