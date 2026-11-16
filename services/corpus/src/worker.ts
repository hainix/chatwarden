import { createAccessVerifier } from './access.js';
import { submit, status, ID_RE } from './arrival.js';
import { purgeExpired } from './counters.js';
import { logEvent, type AppDeps, type Clock } from './deps.js';
import type { Env } from './env.js';
import { json, methodNotAllowed, notFound } from './http.js';
import { preflight, report } from './reports.js';
import { handleAdmin } from './review.js';

export type { AppDeps, Clock, LogEvent } from './deps.js';

// The Worker: a router over the handlers, built from injected dependencies so every route runs in a test with no Cloudflare account.
// Server-to-server only: no CORS, no cookies, no page on /v1.

export interface App {
  fetch(request: Request): Promise<Response>;
}

const SUBMISSIONS = '/v1/submissions';
const REPORTS = '/v1/reports';

/** The routes, over `deps`. Throws only for a configuration that cannot work (no secret). */
export function createApp(deps: AppDeps): App {
  if (typeof deps.secret !== 'string' || deps.secret.length === 0) throw new RangeError('createApp: secret is required');
  const verifier = deps.access === undefined ? null : createAccessVerifier(deps.access, deps.clock, (e) => logEvent(deps, e.stage, e.code));
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      if (pathname === '/admin' || pathname.startsWith('/admin/')) return handleAdmin(request, deps, verifier);
      if (pathname === REPORTS) {
        if (request.method === 'POST') return report(request, deps);
        return request.method === 'OPTIONS' ? preflight(deps, request) : methodNotAllowed('POST');
      }
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
  const deps: AppDeps = { db: env.DB, clock: systemClock, secret: env.COUNTER_SECRET, log: logToConsole };
  if (env.ACCESS_TEAM_DOMAIN !== undefined && env.ACCESS_TEAM_DOMAIN !== '' && env.ACCESS_AUD !== undefined && env.ACCESS_AUD !== '') {
    deps.access = { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD };
  }
  if (env.TURNSTILE_SECRET !== undefined && env.TURNSTILE_SECRET !== '') {
    deps.turnstile = { secret: env.TURNSTILE_SECRET, ...(env.REPORTS_HOSTNAME === undefined || env.REPORTS_HOSTNAME === '' ? {} : { hostname: env.REPORTS_HOSTNAME }) };
  }
  if (env.REPORTS_ORIGIN !== undefined && env.REPORTS_ORIGIN !== '') deps.reportsOrigin = env.REPORTS_ORIGIN;
  const assets = env.ASSETS;
  if (assets !== undefined) {
    deps.assets = async (name) => {
      try {
        return await assets.fetch(new Request(`https://assets.invalid/admin/${name}`));
      } catch {
        return null;
      }
    };
  }
  return deps;
}

/** One app per environment, so the Access keys it has fetched are kept between requests. */
const apps = new WeakMap<object, App>();

function appFor(env: Env): App {
  let app = apps.get(env);
  if (app === undefined) {
    app = createApp(depsFor(env));
    apps.set(env, app);
  }
  return app;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    try {
      return appFor(env).fetch(request);
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
