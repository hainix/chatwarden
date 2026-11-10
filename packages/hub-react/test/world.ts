import { createChatwarden, defineRules, starterRules } from '@chatwarden/core';
import type { Chatwarden, RawWho, Role } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { MemoryTermStore, syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { MemoryStore } from '@chatwarden/store-memory';
import { adminRoutes, createRouter } from '@chatwarden/http/admin';
import type { KitRequest, KitResponse, PermissionKey, RouteTable } from '@chatwarden/http/admin';
import type { ReportCategory } from '@chatwarden/core';
import { createHubClient } from '../src/client.js';
import type { HubClient } from '../src/client.js';
import { routerTransport } from '../src/transport.js';
import type { Transport, TransportRequest } from '../src/transport.js';

// The hub's tests run the REAL staff routes (adminRoutes over MemoryStore and the real core) through routerTransport, the
// same path the landing-page demo takes. Only a network failure or a 500 is faked, where the real routes cannot produce one.

export const T0 = 1_800_000_000_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface WorldOptions {
  role?: Role | null;
  actor?: string;
  permissions?: Partial<Record<PermissionKey, Role>>;
  /** Mount the term routes (default true). */
  terms?: boolean;
  gameName?: string;
}

export interface FileOptions {
  /** Who is reported: a handle; the same name is the same person across rooms. */
  target?: string;
  /** Who reports: the same name is the same reporter (the kit allows a few reports a day each). */
  reporter?: string;
  category?: ReportCategory;
  room?: string;
}

export async function hubWorld(opts: WorldOptions = {}) {
  const clock = { t: T0, now: () => clock.t };
  // The term list is built first: the kit asks it to judge chat, and a kit with no matcher logs a warning on start.
  const live = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock });
  live.loadSync();
  const cw: Chatwarden = await createChatwarden({
    store: new MemoryStore(),
    matcher: live,
    secret: 'hub-react-test-secret-0000-not-real',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    profile: 'standard',
    rules: defineRules(starterRules('standard')),
    overrides: { profanity: { mode: 'allow' } },
    retention: false,
  });
  // The caller is whoever `session` says: tests change it to see a role, or nobody (401).
  const session: { who: { actor: string; role: Role } | null } = {
    who: opts.role === null ? null : { actor: opts.actor ?? 'ann@example.test', role: opts.role ?? 'moderator' },
  };
  const routes: RouteTable = adminRoutes(cw, {
    authorize: () => session.who,
    ...(opts.permissions === undefined ? {} : { permissions: opts.permissions }),
    ...(opts.terms === false ? {} : { terms: live }),
    gameName: opts.gameName ?? 'Test Game',
  });
  const handle = createRouter(routes);

  /** Every request the hub sent, in order. */
  const sent: TransportRequest[] = [];
  /** A hook for a test to answer one request itself (a 500, a dropped connection); return undefined to pass through. */
  const intercept: { fn: ((req: TransportRequest) => Promise<KitResponse | undefined> | KitResponse | undefined) | null } = { fn: null };
  const real: Transport = routerTransport(handle);
  const transport: Transport = async (req) => {
    sent.push(req);
    const faked = await intercept.fn?.(req);
    if (faked !== undefined) return { status: faked.status, headers: faked.headers ?? {}, body: faked.body };
    return real(req);
  };
  const client: HubClient = createHubClient(transport);

  let n = 0;
  /** Files one report in a new room and returns its id, the reported person's staff ref and the reporter's. */
  const file = async (o: FileOptions = {}) => {
    const target = o.target ?? 'Mallory';
    const reporter = o.reporter ?? `Reporter${++n}`;
    const room = o.room ?? `room-${++n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `key-reporter-${reporter}` }, reporter);
    cw.rooms.seat(room, 'p2', { clientKey: `key-target-${target}` }, target);
    cw.chat.accept(room, 'p1', 'hello there');
    cw.chat.accept(room, 'p2', 'a line from the target');
    clock.t += 1000;
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: o.category ?? 'harassment' });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    const report = cw.reports.get(res.reportId);
    if (report === null) throw new Error('report missing');
    return { id: res.reportId, person: report.targetPerson, reporter: report.reporterPerson, room };
  };

  /** A direct sanction as the first moderator, so Recent actions has something to show. */
  const sanction = async (person: string, kind: 'warning' | 'chat' | 'ban' | 'area' | 'note' = 'chat', rule: number | 'uncovered' = 1) => {
    const res = await cw.sanctions.apply({
      kind,
      subject: person,
      includeIp: false,
      durationMs: kind === 'warning' || kind === 'note' ? null : DAY,
      reason: 'private moderator reason',
      actor: 'ann@example.test',
      source: 'moderator',
      automated: false,
      rule,
      ...(rule === 'uncovered' ? { gapNote: 'a gap note' } : {}),
    });
    clock.t += 1000;
    return res;
  };

  const raw = (req: Partial<KitRequest> & { method: string; path: string }): Promise<KitResponse> =>
    handle({ query: {}, headers: {}, body: undefined, ...req });

  return { cw, clock, session, routes, handle, transport, client, sent, intercept, file, sanction, raw, live, now: () => clock.t };
}

export type HubWorld = Awaited<ReturnType<typeof hubWorld>>;
