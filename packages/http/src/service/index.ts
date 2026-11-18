// `@chatwarden/http/service`: the service API (`/v1`) over the kit, for a game server written in any language that talks to the kit over HTTP. Mount the table at `/v1`:
// `toFetch({ '/v1': serviceRoutes(cw, { keys }) })`. Browser-safe: nothing in this folder imports `node:` (the Node process is `serve.ts` and `node.ts`, which this index never loads).
import { errorClass, safeWarn } from '@chatwarden/core';
import type { Chatwarden } from '@chatwarden/core';
import type { RouteTable } from '../router.js';
import { VERSION } from '../version.js';
import { SERVICE_API_VERSION } from './contract.js';
import { createServiceWrapper } from './wrap.js';
import type { ServiceWrapperOptions } from './wrap.js';

export { SERVICE_API_VERSION } from './contract.js';
export type { ServiceWho } from './contract.js';
export type { ServiceCall, ServiceHandler, ServiceWrapperOptions, Svc } from './wrap.js';

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

/** @experimental */
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
}

const WARNING_RE = /^[a-z][a-z_]{0,31}$/;
const MATCH_MODES = ['word', 'segment', 'contains'];

/**
 * The `/v1` route table over a kit, for `toFetch({ '/v1': serviceRoutes(cw, { keys: [...] }) })`. Every route goes through one wrapper: request id, service-key authentication (401, and 429 for an address that keeps failing),
 * a per-key rate limit (429), the body cap (413) and, on the three calls whose retry would be judged twice, `Idempotency-Key`. Every response carries `chatwarden-api: 1`, `x-request-id`, `cache-control: no-store`
 * and `nosniff`. `GET /` (so `GET /v1`) is the handshake: `{ api, kit, mode, processes, capabilities, warnings }`.
 * @experimental
 */
export function serviceRoutes(cw: Chatwarden, options: ServiceOptions): RouteTable {
  if (typeof cw !== 'object' || cw === null) throw new TypeError('serviceRoutes: cw must be the kit');
  if (typeof options !== 'object' || options === null) throw new TypeError('serviceRoutes: options must be an object');
  if (options.warnings !== undefined && typeof options.warnings !== 'function') throw new TypeError('serviceRoutes: warnings must be a function');
  if (options.processes !== undefined && options.processes !== 'single' && options.processes !== 'multiple') throw new RangeError('serviceRoutes: processes must be single or multiple');
  if (options.capabilities !== undefined && (typeof options.capabilities !== 'object' || options.capabilities === null)) throw new TypeError('serviceRoutes: capabilities must be an object');
  const { svc } = createServiceWrapper(options);
  const { logger } = options;

  const warningsFor = (plainHttp: boolean): string[] => {
    let given: unknown = [];
    try {
      given = options.warnings === undefined ? [] : options.warnings();
    } catch (err) {
      safeWarn(logger, 'chatwarden.service_warnings_failed', { error: errorClass(err) });
    }
    const out: string[] = [];
    if (Array.isArray(given)) for (const w of given as unknown[]) if (typeof w === 'string' && WARNING_RE.test(w) && !out.includes(w)) out.push(w);
    if (plainHttp && !out.includes('plain_http')) out.push('plain_http');
    return out;
  };

  return {
    'GET /': svc('GET /', ({ req }) => {
      const given = options.capabilities ?? {};
      const capabilities: ServiceCapabilities = {
        phrases: given.phrases ?? true,
        blocks: given.blocks ?? true,
        contexts: given.contexts === undefined ? [...cw.contexts.names()] : [...given.contexts],
        sharedPacing: given.sharedPacing ?? false,
        matchModes: given.matchModes === undefined ? [...MATCH_MODES] : [...given.matchModes],
      };
      const plain = (req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'http';
      return {
        status: 200,
        body: { api: SERVICE_API_VERSION, kit: VERSION, mode: 'service', processes: options.processes ?? 'single', capabilities, warnings: warningsFor(plain) },
      };
    }),
  };
}
