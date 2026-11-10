import { safeWarn } from '@chatwarden/core';
import type { Chatwarden, Logger } from '@chatwarden/core';
import type { RouteTable } from './router.js';

export interface HealthOptions {
  /** Where a failed readiness check is logged (event and error class only). Defaults to `console.warn`. */
  logger?: Logger;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * Probe endpoints for a load balancer or orchestrator. Public by design: they say only "up" or "not ready", never why.
 * - `GET /healthz`: 200 `{ ok: true }`. Liveness: the process answers. It never touches the kit or the store.
 * - `GET /readyz`: 200 `{ ok: true }` while the store answers (`cw.ready()`, which asks `schemaVersion()`); otherwise
 *   503 `{ ok: false }` with no detail. A failure is logged with the error class only (`chatwarden.ready_failed` from
 *   the core, `chatwarden.http_ready_failed` if `cw.ready()` itself throws).
 */
export function healthRoutes(cw: Chatwarden, options: HealthOptions = {}): RouteTable {
  const { logger } = options;
  return {
    'GET /healthz': () => ({ status: 200, headers: { ...NO_STORE }, body: { ok: true } }),

    'GET /readyz': () => {
      let ready = false;
      try {
        ready = cw.ready() === true;
      } catch (err) {
        safeWarn(logger, 'chatwarden.http_ready_failed', { error: err instanceof Error ? err.name : typeof err });
      }
      return ready
        ? { status: 200, headers: { ...NO_STORE }, body: { ok: true } }
        : { status: 503, headers: { ...NO_STORE }, body: { ok: false } };
    },
  };
}
