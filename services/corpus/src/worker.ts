import { submit, status, ID_RE } from './arrival.js';
import { purgeExpired } from './counters.js';
import { logEvent, type AppDeps, type Clock } from './deps.js';
import type { Env } from './env.js';
import { json, methodNotAllowed, notFound } from './http.js';

export type { AppDeps, Clock, LogEvent } from './deps.js';

// The Worker: a router over the handlers, built from injected dependencies so every route runs in a test with no Cloudflare account.
// Server-to-server only: no CORS, no cookies, no page on /v1.

export interface App {
  fetch(request: Request): Promise<Response>;
}

const SUBMISSIONS = '/v1/submissions';

/** The routes, over `deps`. Throws only for a configuration that cannot work (no secret). */
export function createApp(deps: AppDeps): App {
  if (typeof deps.secret !== 'string' || deps.secret.length === 0) throw new RangeError('createApp: secret is required');
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === SUBMISSIONS) return request.method === 'POST' ? submit(request, deps) : methodNotAllowed('POST');
      if (pathname.startsWith(`${SUBMISSIONS}/`)) {
        const id = pathname.slice(SUBMISSIONS.length + 1);
        if (!ID_RE.test(id)) return notFound();
        return request.method === 'GET' ? status(request, id, deps) : methodNotAllowed('GET');
      }
      return notFound();
    },
  };
}

/** The system clock: the one place the service reads real time. Everything else takes the injected clock. */
const systemClock: Clock = { now: () => Date.now() };

/** What the runtime hands a Worker. */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface ScheduledEventLike {
  scheduledTime: number;
  cron: string;
}

const logToConsole = (event: { stage: string; code: string; count?: number }): void => {
  console.warn(JSON.stringify(event));
};

function depsFor(env: Env): AppDeps {
  return { db: env.DB, clock: systemClock, secret: env.COUNTER_SECRET, log: logToConsole };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    try {
      return createApp(depsFor(env)).fetch(request);
    } catch {
      logEvent(depsFor(env), 'worker', 'misconfigured');
      return Promise.resolve(json(500, { error: 'internal' }));
    }
  },
  /** The daily purge (the cron trigger in wrangler.jsonc): counters older than two days, notes 90 days after a decision. */
  scheduled(_event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    const work = purgeExpired(env.DB, systemClock).then(
      (out) => logEvent(depsFor(env), 'purge', 'done', out.counters + out.notes),
      () => logEvent(depsFor(env), 'purge', 'db_error'),
    );
    ctx.waitUntil(work);
    return work;
  },
};
