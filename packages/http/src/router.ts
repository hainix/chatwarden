import { errorResponse } from './errors.js';
import type { KitRequest, KitResponse, RouteParams } from './types.js';

export type RouteHandler = (req: KitRequest, params: RouteParams) => KitResponse | Promise<KitResponse>;

/** Routes keyed `METHOD /path/:param`, e.g. `'GET /reports/:id'`. */
export type RouteTable = Record<string, RouteHandler>;

const PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * The id charset of the audit trail's target refs: `A-Z a-z 0-9 _ . : -`, 1..64, and never only dots (`.` and `..` are
 * path words, not ids). Term and exception ids need it because a term pack's own ids use `:` (`syn:zorbak`).
 */
export const REF_PARAM_RE = /^(?!\.+$)[A-Za-z0-9_.:-]{1,64}$/;
/** The named param patterns a route may ask for, as `:name~ref`. A param with no `~` uses `PARAM_RE`. */
const PATTERNS: ReadonlyMap<string, RegExp> = new Map([['ref', REF_PARAM_RE]]);
const SEGMENT = '(?:[A-Za-z0-9_.~-]+|:[A-Za-z0-9_]+(?:~[a-z]+)?)';
const KEY_RE = new RegExp(`^([A-Z]+) (/${SEGMENT}(?:/${SEGMENT})*|/)$`);
const BAD_ROUTE = 'router: a route must look like "GET /path/:param"';

interface Route {
  method: string;
  /** `null` marks a param segment. */
  segments: Array<string | null>;
  names: Array<string | null>;
  /** What a param segment's decoded value must match. */
  patterns: RegExp[];
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
      if (!(route.patterns[i] as RegExp).test(value)) return null;
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
 *   `:name~ref` swaps in the audit-ref charset (`A-Z a-z 0-9 _ . : -`, never only dots) for that one param.
 * - a literal segment beats a param segment.
 * - no match -> 404; a path that matches under other methods only -> 405 with an `allow` header.
 * - HEAD on a path with a GET route (and no HEAD route of its own) runs the GET handler and returns its response as is;
 *   the adapter must send that response's status, headers and body length for a HEAD but not the body itself. `allow`
 *   lists HEAD wherever it lists GET.
 * Handler errors propagate: wrap the router (or each handler) in `withErrors`.
 * `compileRoutes` is the same router with a `matches(path)` check beside `run`, for an adapter that must tell "this path is
 * not mine" (hand it on) from a handler's own 404 (answer it).
 */
export function createRouter(routes: RouteTable): (req: KitRequest) => Promise<KitResponse> {
  return compileRoutes(routes).run;
}

/** A route table, compiled: answer a request, or say whether a path belongs to it at all. */
export interface CompiledRoutes {
  /** Exactly what {@link createRouter} returns: every request gets a response, an unmatched path the kit 404. */
  run(req: KitRequest): Promise<KitResponse>;
  /**
   * True when some route answers this path under SOME method (the query string is ignored). False is "no route matched":
   * unlike a handler that answers 404 (which is a match), it means the path is not this table's. A path that matches only
   * under another method is true, because `run` answers it 405. An adapter uses this to hand a foreign path back to its
   * framework (`toExpress` calls `next()`) before it reads the body.
   *
   * With `method`, an `OPTIONS` request is the table's only when a route of the table answers `OPTIONS` itself. A
   * preflight to a known path is otherwise the app's to answer (its CORS middleware), not `run`'s 405. Any other method
   * behaves as without it.
   */
  matches(path: string, method?: string): boolean;
}

/**
 * Compile a route table once. Validates it exactly as {@link createRouter} does (`RangeError`).
 *
 * Exported from the package as `matchRoute`, for authors of an adapter for another framework (Fastify, Koa, a Worker).
 * The contract:
 * - `run(req)` answers every request: a handler's response, 404 for a path no route has, 405 (with `allow`) for a known
 *   path under another method. Handler errors propagate; wrap the handlers in `withErrors` as `createRouter` expects.
 * - `matches(path, method?)` is the question to ask first. True means the path is this table's (answer it with `run`);
 *   false means it is not, so hand the request back to your framework (`toExpress` calls `next()`) BEFORE you read the
 *   body. A handler that answers 404 is a match; `matches` is false only when no route fits the path under any method.
 *   Pass the request method so a CORS preflight (`OPTIONS`) to a known path stays the app's, unless a route answers it.
 * - The path is the URL path only. The query string is ignored by `matches` and stripped by `run`.
 * - HEAD runs the GET handler; send its status and headers, but not its body.
 */
export function compileRoutes(routes: RouteTable): CompiledRoutes {
  const table: Route[] = [];
  const seen = new Set<string>();
  for (const [key, handler] of Object.entries(routes)) {
    const m = KEY_RE.exec(key);
    if (m === null) throw new RangeError(BAD_ROUTE);
    const method = m[1] as string;
    const path = m[2] as string;
    const parts = path === '/' ? [] : path.slice(1).split('/');
    const segments = parts.map((p) => (p.startsWith(':') ? null : p));
    const names = parts.map((p) => (p.startsWith(':') ? (p.slice(1).split('~')[0] as string) : null));
    const patterns = parts.map((p) => {
      const name = p.startsWith(':') ? p.split('~')[1] : undefined;
      if (name === undefined) return PARAM_RE;
      const pattern = PATTERNS.get(name);
      if (pattern === undefined) throw new RangeError(BAD_ROUTE);
      return pattern;
    });
    // `.` and `..` can never match a client path (no dot-segment is normalised), so such a route is a mistake.
    if (segments.some((s) => s === '.' || s === '..')) throw new RangeError('router: a route may not contain "." or ".." segments');
    const seenNames = names.filter((n): n is string => n !== null);
    if (new Set(seenNames).size !== seenNames.length) throw new RangeError('router: a route may not repeat a param name');
    const shape = `${method} /${segments.map((s) => s ?? ':').join('/')}`;
    if (seen.has(shape)) throw new RangeError('router: two routes have the same method and shape');
    seen.add(shape);
    table.push({ method, segments, names, patterns, literals: segments.filter((s) => s !== null).length, handler });
  }
  // Most literal segments first, so `/reports/export` wins over `/reports/:id`. An equal count is broken left to
  // right (a literal beats a param at the first segment where they differ), so the order the table was written in
  // never decides. Two routes of one method with an identical shape were rejected above, so no tie is left.
  table.sort((a, b) => {
    if (a.literals !== b.literals) return b.literals - a.literals;
    for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
      const la = a.segments[i] !== null;
      const lb = b.segments[i] !== null;
      if (la !== lb) return la ? -1 : 1;
    }
    return 0;
  });

  /** The path's segments, or null for a path no route can match (no leading slash, an empty segment). */
  const segmentsOf = (full: string): string[] | null => {
    const path = full.split('?', 1)[0] as string;
    if (!path.startsWith('/')) return null;
    const segments = path === '/' ? [] : path.slice(1).split('/');
    return segments.some((s) => s === '') ? null : segments;
  };

  const matches = (full: string, method?: string): boolean => {
    const segments = segmentsOf(full);
    if (segments === null) return false;
    const preflight = method !== undefined && method.toUpperCase() === 'OPTIONS';
    return table.some((route) => (!preflight || route.method === 'OPTIONS') && matchPath(route, segments) !== null);
  };

  const run = async (req: KitRequest): Promise<KitResponse> => {
    const segments = segmentsOf(req.path);
    if (segments === null) return errorResponse('not_found');
    const method = req.method.toUpperCase();

    const allowed = new Set<string>();
    let viaGet: { route: Route; params: RouteParams } | null = null;
    for (const route of table) {
      const params = matchPath(route, segments);
      if (params === null) continue;
      if (route.method === method) return route.handler(req, params);
      if (method === 'HEAD' && route.method === 'GET' && viaGet === null) viaGet = { route, params };
      allowed.add(route.method);
    }
    if (viaGet !== null) {
      // The GET answer, whole: an adapter sends its status and headers (and the length of its body) but never the body.
      return viaGet.route.handler(req, viaGet.params);
    }
    if (allowed.has('GET')) allowed.add('HEAD');
    if (allowed.size > 0) return errorResponse('method_not_allowed', { allow: [...allowed].sort().join(', ') });
    return errorResponse('not_found');
  };

  return { run, matches };
}
