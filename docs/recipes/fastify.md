# Recipe: Fastify

Init writes the files below into `chatwarden/` (into `src/chatwarden/` when your project has a `src` folder). It never changes a file that exists.

**Init writes:** `kit.ts` (the engine, the store and the matcher), `fastify.ts` (the plugin and the mount), `auth.ts` (three starter hooks), `terms.ts` (a synthetic term pack), `.env.example` (variable names, no values), and with the answers you give, `hub.ts` and `ChatPanel.tsx`.

**You write:** one line in your app, the staff and player hooks in `auth.ts` (marked `TODO(auth)` and `TODO(identity)`) and your own terms in `terms.ts` (marked `TODO(terms)`).

```sh
npx chatwarden init --framework fastify
```

## The mount

Fastify reads a JSON body before a handler runs, and the kit needs the exact text. The plugin below removes the body parsers for its own routes only, so your other routes keep Fastify's JSON parsing.

<!-- golden: fastify-sqlite-box-element/chatwarden/fastify.ts -->
```ts
// Mounts Chatwarden on your Fastify app: await mountChatwarden(app).
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { adminRoutes, chatRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';
import { BODY_MAX_BYTES } from '@chatwarden/http';
import { toFetch } from '@chatwarden/http/fetch';
import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { createKit } from './kit.js';
import type { Kit } from './kit.js';
import { hubHandler } from './hub.js';

/** The request headers in the form the Web Request wants: one string per name (a repeated header is joined). */
function headersOf(raw: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/**
 * The Web Request for a Fastify request. The body is the exact text the parser below handed over. The URL is the path on a fixed base, never the
 * client's Host header (a malformed one would throw here): the kit reads only the path and the query.
 */
function webRequestOf(request: FastifyRequest, signal: AbortSignal): Request {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(new URL(request.url, 'http://localhost'), {
    method: request.method,
    headers: headersOf(request.headers),
    signal,
    ...(hasBody ? { body: typeof request.body === 'string' ? request.body : '' } : {}),
  });
}

/**
 * The plugin: register it with the kit and the prefix, `app.register(chatwarden, { kit, prefix: kit.base })`, or call mountChatwarden(app).
 * It is encapsulated, so removing the body parsers below changes this plugin's routes only: your own routes keep Fastify's JSON parsing.
 */
export const chatwarden: FastifyPluginAsync<{ kit: Kit }> = async (app, { kit }) => {
  // The kit reads each body itself, in full, to enforce its cap and refuse forbidden keys: Fastify must not parse it first. It still stops
  // reading at the cap, and the kit's own error shape answers an oversized body.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: BODY_MAX_BYTES }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'payload_too_large', message: 'The request body is too large.' });
    }
    return reply.send(error);
  });

  // The peer address of each request, kept by request: the socket's, which a client cannot choose, never a header.
  const peers = new WeakMap<Request, string>();
  const handle = toFetch(
    {
      '/admin': adminRoutes(kit.cw, { authorize: kit.hooks.authorize, terms: kit.terms }),
      '/api': playerRoutes(kit.cw, { identify: kit.hooks.identify }),
      '/chat': chatRoutes(kit.cw, kit.chat, { identify: kit.hooks.identify, join: kit.hooks.join }),
      '': healthRoutes(kit.cw),
    },
    { prefix: kit.base, remoteAddress: (request) => peers.get(request) },
  );
  const hub = hubHandler(kit);

  app.all('/*', async (request, reply) => {
    const gone = new AbortController();
    reply.raw.once('close', () => gone.abort());
    const web = webRequestOf(request, gone.signal);
    peers.set(web, request.socket.remoteAddress ?? '');
    const response = (await hub(web)) ?? (await handle(web));
    return reply.send(response);
  });
};

/** Build the kit, mount the plugin under its prefix and close the kit when the app closes. Returns the kit for your own code. */
export async function mountChatwarden(app: FastifyInstance): Promise<Kit> {
  const kit = await createKit();
  await app.register(chatwarden, { kit, prefix: kit.base });
  app.addHook('onClose', async () => {
    await kit.close();
  });
  return kit;
}
```

In your app that is one line: `await mountChatwarden(app)`. It registers the plugin under `/chatwarden`, returns the kit, and closes the kit when the app closes. The plugin is exported too, if you want to register it yourself.

The plugin builds each request URL from a fixed base, not from the `Host` header. The kit reads only the path and the query. A client abort stops the chat stream.

## What is safe by default

- The staff routes and the hub answer 401 until `CHATWARDEN_ADMIN_TOKEN` is set to a long value (at least 24 characters).
- In production the server refuses to start without `CHATWARDEN_SECRET` (at least 32 characters).
- The player's address comes from the socket, never from a header.
- The term pack is a synthetic starter and warns in production.

Your server reads these variables from its environment. A `.env` file is not loaded for you: export the names, or start the server with `node --env-file=.env`.

## Before you go live

Run `npx chatwarden init --check`. It lists every starter marker still in your code, with its file and line, and the required variable names that are not set. It changes nothing.

## The hub needs an ESM project

`hub.ts` finds the hub script with `import.meta.url`, so it needs an ESM project (`"type": "module"` in `package.json`). In a CommonJS project, run init with `--hub none` and load the hub as one script tag instead: see the `hub-element` README.

## More

- The same files, as committed goldens: `examples/recipes/cases/fastify-sqlite-box-element/`. A test builds them with init, type-checks them and runs them against a real Fastify 5: the raw body, the stream, and an abort.
- Any server built on Web `Request` and `Response` can use `toFetch` directly: see the Next.js recipe.
