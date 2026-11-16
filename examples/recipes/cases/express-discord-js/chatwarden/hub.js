// The moderator hub page for Express: one HTML page, one script, and the starter sign-in form.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import express from 'express';

const HUB_CSS = 'body{margin:0}';
const SIGN_IN_CSS =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem;margin:.25rem 0}input{width:100%;box-sizing:border-box}';

/** A style-src value that allows exactly one inline stylesheet, by its hash: no 'unsafe-inline'. */
const styleHash = (css) => `'sha256-${createHash('sha256').update(css).digest('base64')}'`;

const HUB_CSP = ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "img-src 'self' data:", `style-src ${styleHash(HUB_CSS)}`, "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
const SIGN_IN_CSP = ["default-src 'none'", `style-src ${styleHash(SIGN_IN_CSS)}`, "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');

/** The hub: the element and one script tag. base is where the kit is mounted (letters, digits, - _ and / only, so it is safe in HTML). */
const hubPage = (base) => `<!doctype html>
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
const signInPage = (base, notice) => `<!doctype html>
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
function hubScriptPath() {
  try {
    return createRequire(import.meta.url).resolve('@chatwarden/hub-element/standalone');
  } catch {
    return null;
  }
}

/** The headers of a page: never cached, never sniffed, and its own content security policy. */
const pageHeaders = (csp) => ({ 'cache-control': 'no-store', 'content-security-policy': csp, 'x-content-type-options': 'nosniff' });

/** The kit's request shape from Express's, for the staff check (the page routes are not mounted through toExpress). */
function kitRequestOf(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return { method: req.method, path: req.path, query: {}, headers, body: undefined };
}

/** Mount the hub under <base>/mod: the page, its script and the sign-in form. Call it after the kit's own mounts. */
export function mountHub(app, kit) {
  const mod = `${kit.base}/mod`;
  const signedIn = (req) => kit.hooks.authorize(kitRequestOf(req)) !== null;
  const page = (res, status, csp, body) => {
    res.status(status).type('html').set(pageHeaders(csp)).send(body);
  };

  app.get(mod, (req, res) => {
    if (signedIn(req)) page(res, 200, HUB_CSP, hubPage(kit.base));
    else page(res, 401, SIGN_IN_CSP, signInPage(kit.base, ''));
  });
  app.get(`${mod}/hub-element.js`, async (req, res, next) => {
    if (!signedIn(req)) {
      res.status(401).set('cache-control', 'no-store').type('text').send('Sign in first.');
      return;
    }
    const file = hubScriptPath();
    if (file === null) {
      res.status(503).type('text').send('@chatwarden/hub-element is not installed.');
      return;
    }
    try {
      res.status(200).set({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).type('text/javascript; charset=utf-8').send(await readFile(file));
    } catch (err) {
      next(err);
    }
  });
  // This route parses its own small form body; nothing is mounted globally, so the kit's routes still read theirs.
  app.post(`${mod}/login`, express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const given = req.body?.token;
    const cookie = kit.hooks.signIn(given);
    if (cookie === null) {
      page(res, 401, SIGN_IN_CSP, signInPage(kit.base, 'That token was not accepted.'));
      return;
    }
    res.append('set-cookie', cookie);
    res.set('cache-control', 'no-store').redirect(303, mod);
  });
  app.use(mod, (_req, res) => void res.status(404).json({ error: 'not_found' }));
}
