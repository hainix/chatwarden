// The Next.js route handler: the kit behind toFetch, built once for the process.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { adminRoutes, chatRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';
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
    '/chat': chatRoutes(kit.cw, kit.chat, { identify: kit.hooks.identify, join: kit.hooks.join }),
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
