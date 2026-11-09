import type { Role } from '@chatwarden/core';

/** One HTTP request, as the adopter's server adapter hands it to the kit. No framework type leaks in. */
export interface KitRequest {
  method: string;
  /** The path, with or without a query string; the router strips the query. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** The parsed body, when the adapter already parsed one. A route that needs a body validates it itself. */
  body: unknown;
  /** The body exactly as received; {@link parseJson} reads this. */
  rawBody?: string;
}

/** One HTTP response; the adapter serialises `body` (JSON). */
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
