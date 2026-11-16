// The moderator hub page for a Web fetch handler: one HTML page, one script, and the starter sign-in form.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { KitRequest } from '@chatwarden/http';
import type { Kit } from './kit.js';

const HUB_CSS = 'body{margin:0}';
const SIGN_IN_CSS =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem;margin:.25rem 0}input{width:100%;box-sizing:border-box}';

/** A style-src value that allows exactly one inline stylesheet, by its hash: no 'unsafe-inline'. */
const styleHash = (css: string): string => `'sha256-${createHash('sha256').update(css).digest('base64')}'`;

const HUB_CSP = ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "img-src 'self' data:", `style-src ${styleHash(HUB_CSS)}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
const SIGN_IN_CSP = ["default-src 'none'", `style-src ${styleHash(SIGN_IN_CSS)}`, "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');

/** The hub: the element and one script tag. base is where the kit is mounted (letters, digits, - _ and / only, so it is safe in HTML). */
const hubPage = (base: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moderation</title>
<style>${HUB_CSS}</style>
</head>
<body>
<script type="module" src="${base}/mod/hub-element.js"></script>
<chatwarden-hub base-url="${base}/admin"></chatwarden-hub>
</body>
</html>
`;

/** The sign-in form (a plain post). notice is fixed text from this file, never anything the visitor sent. */
const signInPage = (base: string, notice: string): string => `<!doctype html>
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
<form method="post" action="${base}/mod/login">
<label for="token">Staff token</label>
<input id="token" name="token" type="password" autocomplete="off" required>
<button type="submit">Sign in</button>
</form>
</body>
</html>
`;

/** Where the @chatwarden/hub-element script is, or null when the package is not installed. */
function hubScriptPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve('@chatwarden/hub-element/standalone');
  } catch {
    return null;
  }
}

/** The headers of a page: never cached, never sniffed, and its own content security policy. */
const pageHeaders = (csp: string): Record<string, string> => ({ 'cache-control': 'no-store', 'content-security-policy': csp, 'x-content-type-options': 'nosniff' });

const FORM_MAX = 2048;

/** The kit's request shape from a Web Request, for the staff check. */
function kitRequestOf(request: Request, path: string): KitRequest {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return { method: request.method, path, query: {}, headers, body: undefined };
}

/** The sign-in form's text, read up to FORM_MAX bytes, or null when it is larger. */
async function readForm(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? '0') > FORM_MAX) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FORM_MAX) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/**
 * The hub for a Web fetch handler: resolves a Response for <base>/mod and what is under it, and null for any other path. Call it before the
 * kit's own handler. It needs Node (it reads the element's script from the installed package).
 */
export function hubHandler(kit: Kit): (request: Request) => Promise<Response | null> {
  const mod = `${kit.base}/mod`;
  const page = (status: number, csp: string, body: string): Response =>
    new Response(body, { status, headers: { ...pageHeaders(csp), 'content-type': 'text/html; charset=utf-8' } });
  const json = (status: number, body: unknown): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== mod && !path.startsWith(`${mod}/`)) return null;
    const signedIn = kit.hooks.authorize(kitRequestOf(request, path)) !== null;
    if (path === mod && (request.method === 'GET' || request.method === 'HEAD')) {
      return signedIn ? page(200, HUB_CSP, hubPage(kit.base)) : page(401, SIGN_IN_CSP, signInPage(kit.base, ''));
    }
    if (path === `${mod}/hub-element.js` && request.method === 'GET') {
      if (!signedIn) return new Response('Sign in first.', { status: 401, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });
      const file = hubScriptPath();
      if (file === null) return new Response('@chatwarden/hub-element is not installed.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      return new Response(await readFile(file), { status: 200, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'text/javascript; charset=utf-8' } });
    }
    if (path === `${mod}/login` && request.method === 'POST') {
      const form = (request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded') ? await readForm(request) : null;
      const cookie = kit.hooks.signIn(form === null ? undefined : new URLSearchParams(form).get('token'));
      if (cookie === null) return page(401, SIGN_IN_CSP, signInPage(kit.base, 'That token was not accepted.'));
      return new Response(null, { status: 303, headers: { location: mod, 'set-cookie': cookie, 'cache-control': 'no-store' } });
    }
    return json(404, { error: 'not_found' });
  };
}
