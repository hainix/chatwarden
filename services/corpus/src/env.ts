// The Worker's environment, as small structural interfaces. Nothing in src imports a Cloudflare package: the real D1 and R2 bindings satisfy
// these shapes (types-check/workers.ts proves it against @cloudflare/workers-types), and the tests satisfy them with fakes
// (test/d1.ts over node:sqlite, test/r2.ts over a Map). That is what keeps every task testable with no Cloudflare account.

/** What a statement reports about itself, the part of D1's `meta` this service reads. */
export interface D1Meta {
  changes: number;
  last_row_id: number;
}

/** The result of a statement: rows for a query, a count for a write. */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

/** A prepared statement. `bind` returns the statement to run; bound values are positional. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

/** A D1 database: `prepare`, and `batch`, which runs its statements in order in one transaction. */
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1Result<T>[]>;
}

/** The body of a stored object. */
export interface R2BodyLike {
  readonly key: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** An R2 bucket, the part of it the release tools use. */
export interface R2Like {
  get(key: string): Promise<R2BodyLike | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string; cacheControl?: string; contentDisposition?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
}

/** The bindings and variables `wrangler.jsonc` declares. The secrets are set with `wrangler secret put`, never in a file. */
export interface Env {
  /** The queue and term database (D1). */
  DB: D1Like;
  /** The release bucket (R2): written by the release tools, read through the custom domain. */
  RELEASES: R2Like;
  /** Secret: the key that makes the rate-limit network hash unguessable. With the daily rotation it is the "salt" of design 10.2. */
  COUNTER_SECRET: string;
  /** The Cloudflare Access team domain, such as `example.cloudflareaccess.com`, and the application's audience tag (S4). */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** The review page's static files (Workers Static Assets, `page/admin/*`). Reached only after Access and the reviewer table have said yes. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Secret: the Turnstile secret for the docs-site report form. */
  TURNSTILE_SECRET?: string;
  /** The docs site origin (https://chatwarden.dev), allowed to call the web report form from a browser, and its hostname, which a Turnstile token must have been solved on. */
  REPORTS_ORIGIN?: string;
  REPORTS_HOSTNAME?: string;
}
