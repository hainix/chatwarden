// The shape every /v1 answer shares (design 3.2): the version, the response headers, the id and `who` validators. Browser-safe.
import { ValidationError } from '../errors.js';
import { randomHex } from '../chat/random.js';
import type { KitResponse } from '../types.js';

/**
 * The service API's major version. It is in every path (`/v1`) and in every response (`chatwarden-api: 1`). Within one version a change is additive only.
 * @experimental
 */
export const SERVICE_API_VERSION = 1;

/** A room or seat id in a path: the game's own id, 1 to 128 characters, opaque to the kit. */
const ID_RE = /^[A-Za-z0-9_.:@~-]{1,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const WHO_KEYS: readonly string[] = ['clientKey', 'accountId', 'ip'];
const WHO_MAX = 256;

/** A room or seat id: 1 to 128 characters of `A-Za-z0-9_.:@~-`, and never only dots. Anything else is 400 `invalid_request`. The value is never echoed. */
export function validId(value: unknown): string {
  if (typeof value !== 'string' || !ID_RE.test(value) || /^\.+$/.test(value)) throw new ValidationError();
  return value;
}

/** Who a call is about, as the game names them. Raw: the kit hashes it on arrival and keeps nothing. */
export interface ServiceWho {
  clientKey?: string;
  accountId?: string;
  ip?: string;
}

/**
 * A `who` object: `{ clientKey?, accountId?, ip? }`, each 1 to 256 characters, at least one key, no unknown key. A copy of the known fields. With `identity`, `clientKey` or `accountId` must be there (an
 * address alone cannot chat or own a record). Anything else is 400 `invalid_request`.
 */
export function parseWho(value: unknown, options: { identity?: boolean } = {}): ServiceWho {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError();
  const given = value as Record<string, unknown>;
  const keys = Object.keys(given);
  if (keys.length === 0 || keys.some((k) => !WHO_KEYS.includes(k))) throw new ValidationError();
  const who: ServiceWho = {};
  for (const key of keys) {
    const v = given[key];
    if (typeof v !== 'string' || v.length < 1 || v.length > WHO_MAX) throw new ValidationError();
    who[key as keyof ServiceWho] = v;
  }
  if (options.identity === true && who.clientKey === undefined && who.accountId === undefined) throw new ValidationError();
  return who;
}

/** The request's own `x-request-id` when it is 1 to 64 characters of `A-Za-z0-9_.:-`, else 16 random hex characters. */
export function requestIdFor(header: string | undefined): string {
  return header !== undefined && REQUEST_ID_RE.test(header) ? header : randomHex(8);
}

/** The response with the headers every /v1 answer carries. The route's own headers stay (`retry-after`, `allow`), except that none of these four can be overridden. */
export function withServiceHeaders(res: KitResponse, rid: string): KitResponse {
  return {
    ...res,
    headers: { ...res.headers, 'chatwarden-api': String(SERVICE_API_VERSION), 'x-request-id': rid, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  };
}
