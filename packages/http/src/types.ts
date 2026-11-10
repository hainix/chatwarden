import type { Role } from '@chatwarden/core';

/** One HTTP request, as the adopter's server adapter hands it to the kit. No framework type leaks in. */
export interface KitRequest {
  method: string;
  /** The path, with or without a query string; the router strips the query. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /**
   * A body the adapter already parsed. Routes must NOT trust it: a pre-parsed body skipped the 64 KiB cap and the
   * prototype-pollution check. Adapters should leave it `undefined`; routes read `parseJson(req.rawBody)`.
   */
  body: unknown;
  /**
   * The body exactly as received. Adapters MUST supply it (and must not pre-parse with a framework JSON parser), and
   * routes call `parseJson(req.rawBody)`, which enforces the byte cap and rejects forbidden keys. A route that needs
   * a body validates the parsed value itself.
   */
  rawBody?: string;
}

/**
 * One HTTP response. How an adapter sends `body`:
 * - a `string` is sent RAW, as the response body, with the response's own `content-type` header (the code of conduct is
 *   `text/html`, `text/markdown` or `text/plain`). Never JSON-encode it: that would quote the document.
 * - anything else is serialised as JSON and sent with `content-type: application/json; charset=utf-8`.
 * Every `headers` entry is sent as given.
 */
export interface KitResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** Who is calling: supplied by the adopter's auth hook. */
export interface Authz {
  actor: string;
  role: Role;
}

/** The route params, already decoded and checked against `^[A-Za-z0-9_-]{1,64}$`. */
export type RouteParams = Record<string, string>;
