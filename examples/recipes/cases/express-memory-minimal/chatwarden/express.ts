// Mounts Chatwarden on your Express app: await mountChatwarden(app).
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { adminRoutes, healthRoutes, playerRoutes } from '@chatwarden/http';
import { toExpress } from '@chatwarden/http/express';
import type { Express } from 'express';
import { createKit } from './kit.js';
import type { Kit } from './kit.js';

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
  app.use(kit.base, toExpress(healthRoutes(kit.cw), { fallthrough: false }));
  return kit;
}
