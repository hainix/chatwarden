import { createRouter } from '../src/router.js';
import type { RouteTable } from '../src/router.js';
import type { KitResponse } from '../src/types.js';

// Helpers for the service API tests (/v1): fake service keys (obviously not real, long enough for the grammar) and a caller that goes straight to a route table.

/** Fake service keys: 32 to 64 characters of the key grammar. Not secrets. */
export const KEY_A = `test-key-a-${'0123456789abcdef'.repeat(2)}`;
export const KEY_B = `test-key-b-${'fedcba9876543210'.repeat(2)}`;
export const KEY_C = `test-key-c-${'abcdef0123456789'.repeat(2)}`;

export interface CallOptions {
  /** The bearer key. `undefined`: KEY_A. `null`: no Authorization header. */
  key?: string | null;
  /** A value for the whole Authorization header (overrides `key`). */
  authorization?: string;
  body?: unknown;
  /** The raw body, as sent (overrides `body`). */
  raw?: string;
  /** The content type of a body. `undefined`: application/json when there is a body. `null`: none. */
  contentType?: string | null;
  headers?: Record<string, string>;
  remoteAddress?: string;
  idempotencyKey?: string;
}

export type Caller = (method: string, path: string, o?: CallOptions) => Promise<KitResponse>;

/** A caller over a route table (the table is what `toFetch` mounts at `/v1`, so paths here are relative to the mount). */
export function callerOver(table: RouteTable): Caller {
  const run = createRouter(table);
  return (method, path, o = {}) => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.authorization !== undefined) headers.authorization = o.authorization;
    else if (o.key !== null) headers.authorization = `Bearer ${o.key ?? KEY_A}`;
    const rawBody = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    if (rawBody !== undefined && o.contentType !== null) headers['content-type'] = o.contentType ?? 'application/json';
    if (o.idempotencyKey !== undefined) headers['idempotency-key'] = o.idempotencyKey;
    return run({ method, path, query: {}, headers, body: undefined, ...(rawBody === undefined ? {} : { rawBody }), ...(o.remoteAddress === undefined ? {} : { remoteAddress: o.remoteAddress }) });
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const bodyOf = (res: KitResponse): any => res.body;
export const errorCode = (res: KitResponse): unknown => (res.body as { error?: unknown } | undefined)?.error;
