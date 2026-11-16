// `@chatwarden/http/coop`: the Coop adapter (K5). Not exported from the package root: it uses `node:crypto`. Nothing here runs at import; `coop` is a function the
// adopter calls.
import type { Chatwarden } from '@chatwarden/core';
import type { RouteTable } from '../router.js';
import { createInbound } from './inbound.js';
import { resolveOptions } from './options.js';
import type { CoopOptions } from './options.js';
import { createOutbound } from './outbound.js';
import { createSetup } from './setup.js';
import type { CoopChecklist, CoopVerification } from './setup.js';
import type { SweepResult } from './outbound.js';

export type { CoopDecision, CoopOptions } from './options.js';
export type { SweepResult } from './outbound.js';
export type { CoopChecklist, CoopChecklistItemType, CoopVerification } from './setup.js';

/** What `coop` returns. @experimental */
export interface CoopAdapter {
  /** The routes to mount with the rest of the kit's: `POST /coop/actions` (the callback). */
  routes: RouteTable;
  /**
   * Send every open report from the last `catchUpMs` that has no link yet (run once at startup; also callable on a timer). Resolves when each has been sent,
   * skipped (already linked, closed meanwhile) or failed; a job that is still being retried counts as failed only once its retries are used up.
   */
  sweep(): Promise<SweepResult>;
  /**
   * What to create in Coop by hand (`checklist()`; Coop has no write API for it) and a read-only self-check of what is there (`verify()`: three GETs, never a write,
   * never a secret in the answer).
   */
  setup: { checklist(): CoopChecklist; verify(): Promise<CoopVerification> };
  /** Unsubscribe, abort the request in flight, clear every timer and drop the queue. Safe to call more than once; nothing is written afterwards. */
  dispose(): void;
}

/**
 * The Coop adapter: kit reports go to Coop as review jobs and Coop decisions come back through a verified callback into the kit's own decision path. The kit stays
 * the source of truth; Coop is a place to review. `evidence` is required (no default): chat text leaves the kit only where you say so. Throws `RangeError` at construction
 * for a bad option or a store without `cw.links`. Mount `adapter.routes` through an adapter that supplies `rawBody` (the signature covers the exact bytes).
 *
 * @experimental
 */
export function coop(cw: Chatwarden, options: CoopOptions): CoopAdapter {
  const o = resolveOptions(options);
  if (!cw.links.supported) throw new RangeError('coop: the store does not support links (use a store from 0.1.12 or later)');
  const inbound = createInbound(cw, o);
  const outbound = createOutbound(cw, o);
  const setup = createSetup(cw, o);
  return {
    routes: inbound.routes,
    sweep: () => outbound.sweep(),
    setup,
    dispose() {
      inbound.dispose();
      outbound.dispose();
    },
  };
}
