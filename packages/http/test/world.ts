import { DatabaseSync } from 'node:sqlite';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, Logger, RawWho } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { syntheticTermPack } from '@chatwarden/matcher/test-fixtures';
import { openStore } from '@chatwarden/store-sqlite';
import { adminRoutes, createRouter } from '@chatwarden/http';
import type { Authz, KitRequest, KitResponse, Role } from '@chatwarden/http';

// A shared test world for the staff routes added after the report routes: the kit on a real SQLite store, the real
// LiveTerms (the matcher is a devDependency of this package only), and a router with a header-driven `authorize`.

export const NOW = 1_800_000_000_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const KEY_TARGET = 'raw-client-key-target-world-0001';
export const IP_TARGET = '203.0.113.99';
export const SECRET = 'admin-world-secret';

export type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

export interface WorldOptions {
  wrap?: (cw: Chatwarden) => Chatwarden;
  permissions?: Parameters<typeof adminRoutes>[1]['permissions'];
  /** Build the term routes (default true). */
  terms?: boolean;
  recentLines?: () => readonly string[];
  gameName?: string;
  contactUrl?: string;
}

export async function world(over: WorldOptions = {}) {
  const db = new DatabaseSync(':memory:');
  const store = openStore({ db });
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const real = await createChatwarden({
    store,
    secret: SECRET,
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    retention: false,
  });
  const live = new LiveTerms({ store, pack: syntheticTermPack(), clock, logger });
  await live.load();
  logged.length = 0;

  const cw = over.wrap === undefined ? real : over.wrap(real);
  const authorize = (req: KitRequest): Authz | null => {
    const role = req.headers['x-role'];
    if (role === undefined) return null;
    return { actor: req.headers['x-actor'] ?? 'ann', role: role as Role };
  };
  const routes = adminRoutes(cw, {
    authorize,
    logger,
    ...(over.permissions === undefined ? {} : { permissions: over.permissions }),
    ...(over.terms === false ? {} : { terms: live }),
    ...(over.recentLines === undefined ? {} : { recentLines: over.recentLines }),
    ...(over.gameName === undefined ? {} : { gameName: over.gameName }),
    ...(over.contactUrl === undefined ? {} : { contactUrl: over.contactUrl }),
  });
  const router = createRouter(routes);

  const call = (
    method: string,
    path: string,
    o: { role?: Role | null; actor?: string; query?: Record<string, string>; body?: unknown; raw?: string } = {},
  ): Promise<KitResponse> => {
    const headers: Record<string, string> = {};
    if (o.role !== null) headers['x-role'] = o.role ?? 'moderator';
    if (o.actor !== undefined) headers['x-actor'] = o.actor;
    const rawBody = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    return router({ method, path, query: o.query ?? {}, headers, body: undefined, ...(rawBody === undefined ? {} : { rawBody }) });
  };
  const audit = () => real.audit.list({ limit: 200 }).items;
  /** The audit rows the routes wrote (role set), leaving the rows LiveTerms and the store wrote themselves. */
  const routeAudit = () => audit().filter((r) => r.role !== null);

  let n = 0;
  /** A seated, identified person in a new room; returns their canonical subject (a staff ref). */
  const person = (): string => {
    const room = `room-w-${++n}`;
    real.rooms.seat(room, 'p1', { clientKey: `${KEY_TARGET}-${n}`, ip: IP_TARGET }, 'Tgt');
    return real.rooms.subjectAt(room, 'p1') as string;
  };
  /** A moderator sanction under 'uncovered': opens a rule gap. */
  const gap = async (note = 'Griefing by repeatedly blocking the exit.') => {
    const subject = person();
    const res = await real.sanctions.apply({
      kind: 'warning',
      subject,
      includeIp: false,
      durationMs: null,
      reason: 'private moderator reason',
      actor: 'ann',
      source: 'moderator',
      automated: false,
      rule: 'uncovered',
      gapNote: note,
    });
    clock.t += 1000;
    return { ...res, subject };
  };
  return { cw: real, live, routes, router, call, audit, routeAudit, clock, logged, store, db, person, gap };
}

export const errorOf = (res: KitResponse): string => (res.body as { error: string }).error;

/** Every key at any depth. */
export function keysDeep(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysDeep(v, out);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}
