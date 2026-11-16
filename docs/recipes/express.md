# Recipe: Express

Init writes the files below into `chatwarden/` (into `src/chatwarden/` when your project has a `src` folder). It never changes a file that exists.

**Init writes:** `kit.ts` (the engine, the store and the matcher), `express.ts` (the mount), `auth.ts` (three starter hooks), `terms.ts` (a synthetic term pack), `.env.example` (variable names, no values), and with the answers you give, `hub.ts` (the moderator hub) and `ChatPanel.tsx` (the chat box for your player page).

**You write:** one line in your app, the staff and player hooks in `auth.ts` (marked `TODO(auth)` and `TODO(identity)`) and your own terms in `terms.ts` (marked `TODO(terms)`). The rest is yours to change.

```sh
npx chatwarden init --framework express
```

## The mount

`express.ts` is the whole wiring. Call it from your app, before any body parser:

<!-- golden: express-sqlite-box-element/chatwarden/express.ts -->
```ts
// Mounts Chatwarden on your Express app: await mountChatwarden(app).
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { adminRoutes, chatRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';
import type { Express } from 'express';
import { createKit } from './kit.js';
import type { Kit } from './kit.js';
import { mountHub } from './hub.js';

/**
 * Mount the moderation routes under `kit.base` (/chatwarden by default) and return the kit, so your own code can reach `kit.cw` and call
 * `kit.close()` on shutdown.
 *
 * Call this before any body parser (express.json(), express.urlencoded(), body-parser). The kit reads each request body itself, in full,
 * to enforce its size cap and refuse forbidden keys. A body parser mounted before it has already consumed the body and the kit answers an
 * error, so that order is not supported. A parser mounted after this call is fine.
 */
export async function mountChatwarden(app: Express): Promise<Kit> {
  const kit = await createKit();
  // fallthrough: false makes an unknown path under the prefix the kit's own 404; a path outside it is still yours.
  app.use(`${kit.base}/admin`, toExpress(adminRoutes(kit.cw, { authorize: kit.hooks.authorize, terms: kit.terms }), { fallthrough: false }));
  app.use(`${kit.base}/api`, toExpress(playerRoutes(kit.cw, { identify: kit.hooks.identify }), { fallthrough: false }));
  app.use(`${kit.base}/chat`, toExpress(chatRoutes(kit.cw, kit.chat, { identify: kit.hooks.identify, join: kit.hooks.join }), { fallthrough: false }));
  mountHub(app, kit);
  app.use(kit.base, toExpress(healthRoutes(kit.cw), { fallthrough: false }));
  return kit;
}
```

In your app that is one line: `await mountChatwarden(app)`. It returns the kit, so your own code can reach `kit.cw` and call `kit.close()` when the server stops.

The kit reads each request body itself. A body parser that runs first has already used up the body, so mount this before `express.json()`. A parser mounted after it is fine.

## What is safe by default

- The staff routes and the hub answer 401 until `CHATWARDEN_ADMIN_TOKEN` is set to a long value (at least 24 characters).
- In production the server refuses to start without `CHATWARDEN_SECRET` (at least 32 characters). Make one with the command in `.env.example`.
- Everything lives under `/chatwarden`, so it cannot collide with your own `/api` or `/admin`.
- The term pack is a synthetic starter and warns in production. Put your own terms in `terms.ts`.

Your server reads these variables from its environment. A `.env` file is not loaded for you: export the names, or start the server with `node --env-file=.env`.

## Before you go live

Run `npx chatwarden init --check`. It lists every starter marker still in your code, with its file and line, and the required variable names that are not set. It changes nothing. It exits 1 until the list is empty.

## The hub needs an ESM project

`hub.ts` finds the hub script with `import.meta.url`, so it needs an ESM project (`"type": "module"` in `package.json`). In a CommonJS project, run init with `--hub none` and load the hub as one script tag instead: see the `hub-element` README.

## More

- The same files, as committed goldens: `examples/recipes/cases/express-sqlite-box-element/`. A test builds them with init, type-checks them and runs them against a real Express.
- With the chat box over your own Socket.IO server: the Socket.IO recipe.
- A larger runnable example, with a WebSocket protocol and a demo page: `examples/tiny-chat`.
