# Recipe: Next.js route handlers, and any server on Web `Request`

Init writes the files below. It never changes a file that exists. With `--framework next` it writes a catch-all route handler under `app/chatwarden/` (under `src/app/chatwarden/` when your project keeps its routes in `src/app`). With `--framework fetch` it writes a handler you call yourself, for Hono, Bun, Deno, SvelteKit, Remix or a Worker.

**Init writes:** `chatwarden/kit.ts`, `chatwarden/handler.ts`, `chatwarden/auth.ts`, `chatwarden/terms.ts`, `chatwarden/.env.example`, and for Next the route file `app/chatwarden/[...path]/route.ts`. With the React hub it also writes `chatwarden/HubPage.tsx` and `app/chatwarden/mod/page.tsx`.

**You write:** nothing to wire for Next. Replace the starter hooks in `auth.ts` (marked `TODO(auth)` and `TODO(identity)`) and the terms in `terms.ts` (marked `TODO(terms)`). With `--framework fetch`, one call to the handler for each request.

```sh
npm install @chatwarden/http @chatwarden/core
npx chatwarden init --framework next
```

## This needs a Node process, not serverless

The kit keeps a database file and open chat streams. That needs one long-lived Node process: `next start`, a container or a VM. A serverless host stops the process between requests and has no durable disk, so do not use this recipe there. Moderation without the chat box also needs the durable store.

## The route

Every method goes to one handler. The route is never cached, and it runs on Node.

<!-- golden: next-memory-minimal/app/chatwarden/[...path]/route.ts -->
```ts
// The Next.js route handler: every request under the prefix goes to the Chatwarden handler.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { handler } from '../../../chatwarden/handler';

// The kit keeps a database file and open chat streams, so this runs on Node and is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
```

## The handler

The handler builds the kit once for the process and answers each `Request` through `toFetch`. Your dev server may reload the module, so the kit is kept on `globalThis`.

<!-- golden: next-memory-minimal/chatwarden/handler.ts -->
```ts
// The Next.js route handler: the kit behind toFetch, built once for the process.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { adminRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';
import { toFetch } from '@chatwarden/http/fetch';
import { createKit } from './kit';
import type { Kit } from './kit';

/** What the process holds: the kit, and the function that answers a request (null: not a Chatwarden path, the host answers it). */
interface Ready {
  kit: Kit;
  answer: (request: Request) => Promise<Response>;
}

// Cached on globalThis: a dev server that reloads this module must not open the database a second time.
const SLOT = Symbol.for('chatwarden.ready');
const shared = globalThis as unknown as Record<symbol, Promise<Ready> | undefined>;

async function build(): Promise<Ready> {
  const kit = await createKit();
  const handle = toFetch(
    {
      '/admin': adminRoutes(kit.cw, { authorize: kit.hooks.authorize, terms: kit.terms }),
      '/api': playerRoutes(kit.cw, { identify: kit.hooks.identify }),
      '': healthRoutes(kit.cw),
    },
    { prefix: kit.base },
  );
  return { kit, answer: handle };
}

function ready(): Promise<Ready> {
  let current = shared[SLOT];
  if (current === undefined) {
    current = build();
    shared[SLOT] = current;
    // A start that failed is tried again by the next request, not remembered.
    current.catch(() => {
      shared[SLOT] = undefined;
    });
  }
  return current;
}

/** The kit, for your own code (kit.cw.chat.accept(...)) and for kit.close() on shutdown. */
export async function getKit(): Promise<Kit> {
  return (await ready()).kit;
}

/** Answer one request under /chatwarden. */
export async function handler(request: Request): Promise<Response> {
  return (await ready()).answer(request);
}
```

## Other servers: the Web fetch handler

For a server that is not Next, run init with `--framework fetch`. It writes a `handler.ts` with the same shape. It returns `null` for a path that is not under `/chatwarden`, so your own router answers it. With the moderator hub it also serves the hub page.

<!-- golden: fetch-memory-box-element/chatwarden/handler.ts -->
```ts
// The Web fetch handler: the kit behind toFetch, built once for the process.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { adminRoutes, chatRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';
import { toFetch } from '@chatwarden/http/fetch';
import { createKit } from './kit.js';
import type { Kit } from './kit.js';
import { hubHandler } from './hub.js';

/** What the process holds: the kit, and the function that answers a request (null: not a Chatwarden path, the host answers it). */
interface Ready {
  kit: Kit;
  answer: (request: Request) => Promise<Response | null>;
}

// Cached on globalThis: a dev server that reloads this module must not open the database a second time.
const SLOT = Symbol.for('chatwarden.ready');
const shared = globalThis as unknown as Record<symbol, Promise<Ready> | undefined>;

async function build(): Promise<Ready> {
  const kit = await createKit();
  const handle = toFetch(
    {
      '/admin': adminRoutes(kit.cw, { authorize: kit.hooks.authorize, terms: kit.terms }),
      '/api': playerRoutes(kit.cw, { identify: kit.hooks.identify }),
      '/chat': chatRoutes(kit.cw, kit.chat, { identify: kit.hooks.identify, join: kit.hooks.join }),
      '': healthRoutes(kit.cw),
    },
    { prefix: kit.base, unmatched: 'pass' },
  );
  const hub = hubHandler(kit);
  return { kit, answer: (request) => hub(request).then((response) => response ?? handle(request)) };
}

function ready(): Promise<Ready> {
  let current = shared[SLOT];
  if (current === undefined) {
    current = build();
    shared[SLOT] = current;
    // A start that failed is tried again by the next request, not remembered.
    current.catch(() => {
      shared[SLOT] = undefined;
    });
  }
  return current;
}

/** The kit, for your own code (kit.cw.chat.accept(...)) and for kit.close() on shutdown. */
export async function getKit(): Promise<Kit> {
  return (await ready()).kit;
}

/** Answer one request under /chatwarden. Resolves null for a path that is not Chatwarden's, so your host can answer it. */
export async function handler(request: Request): Promise<Response | null> {
  return (await ready()).answer(request);
}
```

The handler cannot see the socket, so it has no player address of its own. Behind your own reverse proxy, and only there, set `CHATWARDEN_TRUST_PROXY` to the number of proxies of your own in front of the app (`1` for one) and the address is the `X-Forwarded-For` entry that many places from the right, the same rule `chatwarden serve` uses. The entries to its left are the client's own claim and are never read.

## Safe by default

- The staff routes and the hub answer 401 until `CHATWARDEN_ADMIN_TOKEN` is set to a long value (at least 24 characters).
- In production the server refuses to start without `CHATWARDEN_SECRET` (at least 32 characters).
- The term pack is a synthetic starter and warns in production.

Your server reads these variables from its environment. A `.env` file is not loaded for you: export the names, or start the server with `node --env-file=.env`. Next loads `.env` files itself, so there it works as you expect.

Run `npx chatwarden init --check` before you go live. It lists every starter marker still in your code and the required variable names that are not set.

## The hub with `--framework fetch` needs an ESM project

With `--hub element`, `hub.ts` finds the hub script with `import.meta.url`, so the project must be ESM (`"type": "module"`). With Next, use `--hub react` (the default for Next): the hub is a client component and needs no such file.

## More

- The same files, as committed goldens: `examples/recipes/cases/next-memory-minimal/`, `next-sqlite-box-react/` and `fetch-memory-box-element/`. A test runs them by calling the exported handlers with Web requests. It does not start Next.
- `toFetch` is documented in the `@chatwarden/http` README, under "Other servers".
