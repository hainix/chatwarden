// The staff side of `chatwarden serve`: the shared-token sign-in of the init starter (one token, role owner, actor admin; fail closed) and the hub page with its script and sign-in form.
// Node only (it reads the hub element's script from the installed package and compares secrets with node:crypto), so it is not part of the browser-safe `service` entry.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Authenticate } from '../auth.js';
import { HttpError } from '../errors.js';
import { checkLimit } from '../limiter.js';
import type { NamesRateLimit } from '../limiter.js';
import type { KitRequest } from '../types.js';
import { FailureThrottle } from './auth.js';
import { peerAddress } from './node.js';
import { resolvePathFromProject } from './serveResolve.js';

/** The staff token is at least this long, or it protects nothing. */
export const MIN_TOKEN_LENGTH = 24;
/** The cookie the sign-in form sets. It holds an HMAC of the token, never the token. */
export const STAFF_COOKIE = 'chatwarden_staff';
const FORM_MAX = 2048;
/** Wrong staff tokens an address may present in a minute before further wrong ones are refused at once. A right token always passes. */
const STAFF_FAILURES: NamesRateLimit = { max: 20, windowMs: 60_000 };

/** Equal text without leaking where it differs: both sides are hashed to the same length first. */
function sameText(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
}

function cookieValue(cookies: string | undefined, name: string): string | undefined {
  if (cookies === undefined) return undefined;
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface TokenStaff {
  authorize: Authenticate;
  /** The Set-Cookie value when the token is right; else `ok: false` with the wait in ms when this address is over its failure limit (0 when it is just wrong). */
  signIn(given: unknown, address?: string): { ok: true; cookie: string } | { ok: false; waitMs: number };
  /** How many addresses the failure throttle holds (for tests). */
  throttled(): number;
}

export interface TokenStaffOptions {
  now?: () => number;
  /** Wrong tokens per window per address before further wrong ones are refused (default 20 a minute). */
  failureLimit?: NamesRateLimit;
}

/**
 * The shared-token staff sign-in: the header `x-admin-token`, or the cookie `signIn` sets (`Secure` unless `secure` is false). A wrong header is not rescued by a cookie. Wrong tokens (header or form) are
 * counted per address; past the limit a further WRONG one is refused `rate_limited` at once, and a right token always passes, so one stale client behind a shared address cannot lock staff out. A request
 * with no token, or only a cookie, is not a failure.
 */
export function tokenStaff(token: string, secret: string, secure: boolean, options: TokenStaffOptions = {}): TokenStaff {
  const now = options.now ?? Date.now;
  const throttle = new FailureThrottle(checkLimit(options.failureLimit, STAFF_FAILURES, 'staff sign-in failure limit'));
  const cookieFor = (): string => createHmac('sha256', secret).update(token).digest('hex');
  return {
    throttled: () => throttle.size(),
    authorize(req) {
      const given = req.headers['x-admin-token'];
      if (given !== undefined) {
        if (sameText(given, token)) return { actor: 'admin', role: 'owner' };
        const address = req.remoteAddress ?? '';
        const wait = throttle.blockedFor(address, now());
        if (wait > 0) throw new HttpError('rate_limited', { 'retry-after': String(Math.max(1, Math.ceil(wait / 1000))) });
        throttle.record(address, now());
        return null;
      }
      return sameText(cookieValue(req.headers.cookie, STAFF_COOKIE), cookieFor()) ? { actor: 'admin', role: 'owner' } : null;
    },
    signIn(given, address = '') {
      if (sameText(given, token)) return { ok: true, cookie: `${STAFF_COOKIE}=${cookieFor()}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}` };
      const wait = throttle.blockedFor(address, now());
      if (wait > 0) return { ok: false, waitMs: wait };
      throttle.record(address, now());
      return { ok: false, waitMs: 0 };
    },
  };
}

const HUB_CSS = 'body{margin:0}';
const SIGN_IN_CSS = 'body{font:16px/1.5 system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem;margin:.25rem 0}input{width:100%;box-sizing:border-box}';
const styleHash = (css: string): string => `'sha256-${createHash('sha256').update(css).digest('base64')}'`;
const HUB_CSP = ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "img-src 'self' data:", `style-src ${styleHash(HUB_CSS)}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
const SIGN_IN_CSP = ["default-src 'none'", `style-src ${styleHash(SIGN_IN_CSS)}`, "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');

const hubPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moderation</title>
<style>${HUB_CSS}</style>
</head>
<body>
<script type="module" src="/mod/hub-element.js"></script>
<chatwarden-hub base-url="/admin"></chatwarden-hub>
</body>
</html>
`;

const signInPage = (notice: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moderation: sign in</title>
<style>${SIGN_IN_CSS}</style>
</head>
<body>
<h1>Moderation</h1>
<p>Sign in with the staff token (CHATWARDEN_ADMIN_TOKEN).${notice === '' ? '' : ` ${notice}`}</p>
<form method="post" action="/mod/login">
<label for="token">Staff token</label>
<input id="token" name="token" type="password" autocomplete="off" required>
<button type="submit">Sign in</button>
</form>
</body>
</html>
`;

const pageHeaders = (csp: string): Record<string, string> => ({ 'cache-control': 'no-store', 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'content-type': 'text/html; charset=utf-8' });

/** Where the hub element's script is: in the project this runs in first, then next to this package; null when the package (or its built script) is not there. */
export function hubScriptPath(cwd: string = process.cwd()): string | null {
  const fromProject = resolvePathFromProject('@chatwarden/hub-element/standalone', cwd);
  if (fromProject !== undefined) return fromProject;
  try {
    return createRequire(import.meta.url).resolve('@chatwarden/hub-element/standalone');
  } catch {
    return null;
  }
}

const headersOf = (request: Request): Record<string, string> => {
  const out: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
};

async function readForm(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? '0') > FORM_MAX) return null;
  const text = await request.text();
  return text.length > FORM_MAX ? null : text;
}

/**
 * The hub under `/mod`: the page and its script for a signed-in caller, the sign-in form for anyone else, `POST /mod/login` for the token form (only with a token: a custom auth module has its own
 * sign-in). Resolves a Response for a path under `/mod` and null for any other path. `script` finds the element's script file.
 */
export function hubHandler(options: { authorize: Authenticate; staff?: TokenStaff; script: () => string | null }): (request: Request) => Promise<Response | null> {
  const page = (status: number, csp: string, body: string): Response => new Response(body, { status, headers: pageHeaders(csp) });
  const throttledPage = (retryAfter: string | undefined): Response =>
    new Response(signInPage('Too many wrong tries from this address. Wait a little and try again.'), { status: 429, headers: { ...pageHeaders(SIGN_IN_CSP), 'retry-after': retryAfter ?? '60' } });
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== '/mod' && !path.startsWith('/mod/')) return null;
    const address = peerAddress(request);
    const kit: KitRequest = { method: request.method, path, query: {}, headers: headersOf(request), body: undefined, ...(address === undefined ? {} : { remoteAddress: address }) };
    let signedIn: boolean;
    try {
      signedIn = (await options.authorize(kit)) !== null;
    } catch (err) {
      // Too many wrong tokens from this address (the staff throttle): a page that says so. Anything else is not ours to hide.
      if (!(err instanceof HttpError) || err.code !== 'rate_limited') throw err;
      return throttledPage(err.headers?.['retry-after']);
    }
    if (path === '/mod' && request.method === 'GET') return signedIn ? page(200, HUB_CSP, hubPage) : page(401, SIGN_IN_CSP, signInPage(''));
    if (path === '/mod/hub-element.js' && request.method === 'GET') {
      const plain = { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' };
      if (!signedIn) return new Response('Sign in first.', { status: 401, headers: plain });
      const file = options.script();
      if (file === null) return new Response('The hub script is not installed.', { status: 503, headers: plain });
      try {
        return new Response(await readFile(file), { status: 200, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'text/javascript; charset=utf-8' } });
      } catch {
        return new Response('The hub script is not installed.', { status: 503, headers: plain });
      }
    }
    if (path === '/mod/login' && request.method === 'POST' && options.staff !== undefined) {
      const form = (request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded') ? await readForm(request) : null;
      const answer = options.staff.signIn(form === null ? undefined : new URLSearchParams(form).get('token'), address);
      if (!answer.ok) return answer.waitMs > 0 ? throttledPage(String(Math.max(1, Math.ceil(answer.waitMs / 1000)))) : page(401, SIGN_IN_CSP, signInPage('That token was not accepted.'));
      return new Response(null, { status: 303, headers: { location: '/mod', 'set-cookie': answer.cookie, 'cache-control': 'no-store' } });
    }
    return Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  };
}
