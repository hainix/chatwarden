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
   * It is a string, so it is exact for valid UTF-8 only: a request byte that is not valid UTF-8 becomes U+FFFD. A
   * signature computed over the original bytes then fails to verify, which fails closed (the request is refused).
   */
  rawBody?: string;
  /**
   * The address of the socket peer, as the server's own socket reports it. Adapters fill it from the connection and
   * NEVER from a header: it is not `X-Forwarded-For`, so a client cannot choose it. Behind a reverse proxy or load
   * balancer it is the proxy's address; the adopter's `identify` decides whether to trust a forwarding header from
   * its own proxy. Absent when the adapter cannot tell.
   */
  remoteAddress?: string;
}

/**
 * A response that stays open: the adapter sends the status and headers, then calls `start` once. Server-Sent Events use it.
 * @experimental
 */
export interface KitStream {
  /**
   * Called once, after the status and headers are decided. `write` appends text and returns `false` when the connection is backed up
   * (or the client has left or the response has ended, in which case nothing is written); `end` finishes the response. Return a
   * function the adapter calls exactly once when the client goes away or the response ends; it must stop writing and release
   * anything the stream holds.
   *
   * Backpressure: `write` does not queue for you. When it returns `false` the connection is backed up, and the chunk was still accepted
   * (it sits in the response's buffer); there is no drain event. A producer must count the `false`s, stop or drop what it can, and end
   * the response (`end()`) once the consumer has stayed backed up too long; the chat broadcaster closes a stream after `maxBacklog`
   * writes in a row that returned `false`, and the client reconnects with a fresh snapshot. A producer that ignores `false` grows the
   * response's buffer without bound.
   *
   * A `start` that throws has returned no cancel, so it must release what it took before it throws.
   */
  start(sink: { write(chunk: string): boolean; end(): void }): () => void;
}

/**
 * One HTTP response. How an adapter sends `body`:
 * - a `string` is sent RAW, as the response body, with the response's own `content-type` header (the code of conduct is
 *   `text/html`, `text/markdown` or `text/plain`). Never JSON-encode it: that would quote the document.
 * - anything else is serialised as JSON and sent with `content-type: application/json; charset=utf-8`.
 * Every `headers` entry is sent as given.
 *
 * With `stream` the response stays open instead (see {@link KitStream}): `body` is ignored, and an adapter that streams adds
 * `cache-control: no-store, no-transform`, `x-accel-buffering: no` and `content-type: text/event-stream; charset=utf-8` unless `headers` has them.
 */
export interface KitResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  /**
   * When present, `body` is ignored and the response stays open until `start`'s sink ends it or the client leaves.
   * @experimental
   */
  stream?: KitStream;
}

/** Who is calling: supplied by the adopter's auth hook. */
export interface Authz {
  actor: string;
  role: Role;
}

/** The route params, already decoded and checked against `^[A-Za-z0-9_-]{1,64}$`. */
export type RouteParams = Record<string, string>;
