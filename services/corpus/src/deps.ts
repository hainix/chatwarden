import type { AccessConfig } from './access.js';
import type { D1Like } from './env.js';

/** The injected clock: every time in the service comes from here (the Worker entry is the one place that reads the system clock). */
export interface Clock {
  now(): number;
}

/** What the service logs: where, and a closed code, never a word, a note, an address or a key. `count` is a number of rows or requests. */
export interface LogEvent {
  stage: string;
  code: string;
  count?: number;
}

/** What a request handler needs. The Worker builds it from the environment; a test builds it from fakes. */
export interface AppDeps {
  db: D1Like;
  clock: Clock;
  /** Keys the rate-limit network hash. Required: without it the hash of an IPv4 address could be reversed. */
  secret: string;
  log?: (event: LogEvent) => void;
  /** Random bytes (default `crypto.getRandomValues`). */
  random?: (length: number) => Uint8Array;
  /** Leading zero bits the hashcash stamp of a submission must have (default 16, design 6.8). */
  stampBits?: number;
  /** Cloudflare Access for `/admin/*`. Without it the review page and its API do not exist (404). */
  access?: AccessConfig;
  /** The review page's static files (`page/admin/*`): the Worker's ASSETS binding in production, files in a test. Null when there is no such file. */
  assets?: (name: string) => Promise<Response | null>;
}

/** Logs an event without ever letting the logger break a request. */
export function logEvent(deps: AppDeps, stage: string, code: string, count?: number): void {
  try {
    deps.log?.(count === undefined ? { stage, code } : { stage, code, count });
  } catch {
    // a logger that throws must not break a request
  }
}
