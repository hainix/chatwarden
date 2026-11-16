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
