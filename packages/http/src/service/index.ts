// `@chatwarden/http/service`: the service API (`/v1`) over the kit, for a game server written in any language that talks to the kit over HTTP. Mount the table at `/v1`:
// `toFetch({ '/v1': serviceRoutes(cw, { keys }) })`. Browser-safe: nothing in this folder imports `node:` (the Node process is `serve.ts` and `node.ts`, which this index never loads).
import type { Chatwarden } from '@chatwarden/core';
import type { RouteTable } from '../router.js';
import { createServiceWrapper } from './wrap.js';
import type { ServiceWrapperOptions } from './wrap.js';
import { buildServiceTable } from './routes.js';

export { SERVICE_API_VERSION } from './contract.js';
export type { ServiceWho } from './contract.js';
export { SERVICE_OPENAPI } from './openapi.js';
export type { ServiceCall, ServiceHandler, ServiceWrapperOptions, Svc } from './wrap.js';
export { createServiceClient, ServiceError } from './client.js';
export type { Handshake, Line, LineAnswer, Notice, ReportAnswer, ReportInput, Refusal, Restriction, ServiceClient, ServiceClientOptions } from './client.js';

/** What the handshake says the service can do. */
export interface ServiceCapabilities {
  /** Phrase-only rooms (`POST .../phrases`). */
  phrases: boolean;
  /** Blocks (`PUT .../mutes/{target}` with `kind: "block"`, `POST /blocks/between`). */
  blocks: boolean;
  /** The room contexts the profile declares (the `context` tag values that select rules). */
  contexts: string[];
  /** The pacer's state is in the store (`createChatwarden({ sharedPacing: true })`). */
  sharedPacing: boolean;
  /** The match modes a term may have. */
  matchModes: string[];
}

export interface ServiceOptions extends ServiceWrapperOptions {
  /** Overrides of what the handshake reports (the `sharedPacing` the kit was started with, for example). Anything left out is read from the kit. */
  capabilities?: Partial<ServiceCapabilities>;
  /**
   * The warning codes an operator should read, asked at each handshake: `synthetic_terms`, `pacing_per_process` (and the kit adds `plain_http` for a request that came through a proxy over plain HTTP).
   * A throw, or anything that is not a code, leaves that code out.
   */
  warnings?: () => string[];
  /** `multiple` when the operator runs several service processes (the handshake says so). Default `single`. */
  processes?: 'single' | 'multiple';
  /**
   * Caps on what the service tracks (whole numbers of 1 or more). `maxSeatsPerRoom` (default 5000): a seat past it is refused (400 `invalid_value`); a seat the room already holds may change hands.
   * `maxRooms` (default 10000): a new room past it closes the room idle the longest (as `DELETE /rooms/{room}`), logged as `chatwarden.service_room_evicted` without the room.
   */
  limits?: { maxSeatsPerRoom?: number; maxRooms?: number };
}

/**
 * The `/v1` route table over a kit, for `toFetch({ '/v1': serviceRoutes(cw, { keys: [...] }) })`. Every route goes through one wrapper: request id, service-key authentication (401, and 429 for an address that keeps failing),
 * a per-key rate limit (429), the body cap (413) and, on the calls whose retry would be judged twice, `Idempotency-Key`. Every response carries `chatwarden-api: 1`, `x-request-id`, `cache-control: no-store`
 * and `nosniff`. `GET /` (so `GET /v1`) is the handshake: `{ api, kit, mode, processes, capabilities, warnings }`. A refusal is a 200 with `ok: false`. `SERVICE_OPENAPI` describes every route.
 */
export function serviceRoutes(cw: Chatwarden, options: ServiceOptions): RouteTable {
  if (typeof cw !== 'object' || cw === null) throw new TypeError('serviceRoutes: cw must be the kit');
  if (typeof options !== 'object' || options === null) throw new TypeError('serviceRoutes: options must be an object');
  if (options.warnings !== undefined && typeof options.warnings !== 'function') throw new TypeError('serviceRoutes: warnings must be a function');
  if (options.processes !== undefined && options.processes !== 'single' && options.processes !== 'multiple') throw new RangeError('serviceRoutes: processes must be single or multiple');
  if (options.capabilities !== undefined && (typeof options.capabilities !== 'object' || options.capabilities === null)) throw new TypeError('serviceRoutes: capabilities must be an object');
  if (options.limits !== undefined) {
    const l = options.limits as unknown;
    if (typeof l !== 'object' || l === null) throw new RangeError('serviceRoutes: limits must be an object');
    for (const key of ['maxSeatsPerRoom', 'maxRooms'] as const) {
      const v = (l as Record<string, unknown>)[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 1)) throw new RangeError(`serviceRoutes: limits.${key} must be a whole number of 1 or more`);
    }
  }
  const { svc } = createServiceWrapper(options);
  return buildServiceTable(cw, svc, options);
}
