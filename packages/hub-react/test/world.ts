import { createChatwarden, defineRules, starterRules } from '@chatwarden/core';
import type { Chatwarden, RawWho, Role } from '@chatwarden/core';
import { LiveTerms } from '@chatwarden/matcher';
import { MemoryTermStore, syntheticTermPack } from '@chatwarden/matcher/fixtures';
import { MemoryStore } from '@chatwarden/store-memory';
import type { Store } from '@chatwarden/core';
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
  /** Rule numbers to retire (a retired rule stays listed but cannot be cited). */
  retire?: number[];
  /** The adopter's own ladder (six rows, steps 0 to 5): replaces the profile's. */
  ladder?: NonNullable<Parameters<typeof createChatwarden>[0]['overrides']>['ladder'];
  /** The store the kit runs on (default: a MemoryStore). A store without the policy methods cannot save settings. */
  store?: Store;
  /** More overrides on the profile in code (the base the stored layer is merged onto). */
  overrides?: NonNullable<Parameters<typeof createChatwarden>[0]['overrides']>;
}

export interface FileOptions {
  /** Who is reported: a handle; the same name is the same person across rooms. */
  target?: string;
  /** Who reports: the same name is the same reporter (the kit allows a few reports a day each). */
  reporter?: string;
  category?: ReportCategory;
  /** A reason id from the reporting settings, or null for a report that gave none (a one-tap report). Replaces `category`. */
  reason?: string | null;
  room?: string;
}

export interface RichLine {
  who: 'reporter' | 'target' | 'bystander';
  text: string;
}

export interface RichOptions extends FileOptions {
  /** The third person in the room. */
  bystander?: string;
  /** What is said, in order (default: a short exchange). A blocked term makes a blocked line. */
  lines?: RichLine[];
  /** The index in `lines` the report cites (default: the first line the reported person wrote); null cites none. */
  cite?: number | null;
  /** The reporter's note. */
  note?: string;
  /** Tags on the room when the report is filed. */
  tags?: Record<string, string>;
}

export async function hubWorld(opts: WorldOptions = {}) {
  const clock = { t: T0, now: () => clock.t };
  // The term list is built first: the kit asks it to judge chat, and a kit with no matcher logs a warning on start.
  const live = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock });
  live.loadSync();
  const cw: Chatwarden = await createChatwarden({
    store: opts.store ?? new MemoryStore(),
    matcher: live,
    secret: 'hub-react-test-secret-0000-not-real',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    profile: 'standard',
    rules: defineRules(starterRules('standard').map((r) => (opts.retire?.includes(r.number) ? { ...r, retired: true } : r))),
    overrides: { profanity: { mode: 'allow' }, ...(opts.ladder === undefined ? {} : { ladder: opts.ladder }), ...opts.overrides },
    retention: false,
  });
  // The caller is whoever `session` says: tests change it to see a role, or nobody (401).
  const session: { who: { actor: string; role: Role } | null } = {
    who: opts.role === null ? null : { actor: opts.actor ?? 'ann@example.test', role: opts.role ?? 'moderator' },
  };
  // A second moderator: a client made by `clientFor` sends who it is in a header, so two people can act at once on one server.
  const routes: RouteTable = adminRoutes(cw, {
    authorize: (req) => {
      const actor = req.headers['x-test-actor'];
      const role = req.headers['x-test-role'];
      if (typeof actor === 'string' && typeof role === 'string') return { actor, role: role as Role };
      return session.who;
    },
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
  /** A client straight to the real routes: not recorded, never intercepted (for a test's own fake answers). */
  const direct: HubClient = createHubClient(real);
  /** A client for another signed-in person (a teammate), straight to the real routes. */
  const clientFor = (actor: string, role: Role = 'moderator'): HubClient =>
    createHubClient(routerTransport(handle, { headers: { 'x-test-actor': actor, 'x-test-role': role } }));

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
    const res = await cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', ...(o.reason === undefined ? { category: o.category ?? 'harassment' } : { reason: o.reason }) });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    const report = cw.reports.get(res.reportId);
    if (report === null) throw new Error('report missing');
    return { id: res.reportId, person: report.targetPerson, reporter: report.reporterPerson, room };
  };

  /**
   * Files a report with a chosen conversation: up to three people (reporter, reported, bystander), each line in order, a cited
   * line and a note. Returns the line id of each line (by index), the three people's staff refs and the room.
   */
  const fileRich = async (o: RichOptions = {}) => {
    const target = o.target ?? 'Mallory';
    const reporter = o.reporter ?? `Reporter${++n}`;
    const bystander = o.bystander ?? 'Bystander';
    const room = o.room ?? `room-${++n}`;
    const lines: RichLine[] = o.lines ?? [
      { who: 'reporter', text: 'hello there' },
      { who: 'target', text: 'a line from the target' },
      { who: 'bystander', text: 'what is going on' },
      { who: 'target', text: 'another line from the target' },
    ];
    const seats = { reporter: 'p1', target: 'p2', bystander: 'p3' } as const;
    cw.rooms.seat(room, 'p1', { clientKey: `key-reporter-${reporter}` }, reporter, o.tags);
    cw.rooms.seat(room, 'p2', { clientKey: `key-target-${target}` }, target);
    if (lines.some((l) => l.who === 'bystander')) cw.rooms.seat(room, 'p3', { clientKey: `key-bystander-${bystander}` }, bystander);
    const lineIds: string[] = [];
    for (const [i, l] of lines.entries()) {
      cw.chat.accept(room, seats[l.who], l.text);
      // The evidence buffer numbers every line it keeps, blocked ones included, from 1.
      lineIds.push(String(i + 1));
      clock.t += 2000;
    }
    const cite = o.cite === undefined ? lines.findIndex((l) => l.who === 'target') : o.cite;
    const res = await cw.reports.submit({
      roomId: room,
      reporterSeat: 'p1',
      targetSeat: 'p2',
      ...(o.reason === undefined ? { category: o.category ?? 'harassment' } : { reason: o.reason }),
      ...(o.note === undefined ? {} : { note: o.note }),
      ...(cite === null || cite < 0 ? {} : { lineId: lineIds[cite] as string }),
    });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    const report = cw.reports.get(res.reportId);
    if (report === null) throw new Error('report missing');
    const byHandle = (handle: string): string | null => {
      const i = report.excerpt.findIndex((l) => l.handle === handle && l.p !== null);
      const p = i < 0 ? null : report.excerpt[i]?.p;
      return p === null || p === undefined ? null : (report.people[p] ?? null);
    };
    return {
      id: res.reportId,
      person: report.targetPerson,
      reporter: report.reporterPerson,
      bystander: byHandle(bystander),
      room,
      lineIds,
    };
  };

  /** A direct sanction as the first moderator, so Recent actions has something to show. */
  const sanction = async (
    person: string,
    kind: 'warning' | 'chat' | 'ban' | 'area' | 'note' = 'chat',
    rule: number | 'uncovered' = 1,
    durationMs: number | null = DAY,
  ) => {
    const res = await cw.sanctions.apply({
      kind,
      subject: person,
      includeIp: false,
      durationMs: kind === 'warning' || kind === 'note' ? null : durationMs,
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

  /**
   * A player types a line the term list refuses (a synthetic term such as zorbak): the kit records a blocked attempt. Returns the
   * room and the newest blocked item (its person is the staff ref).
   */
  const blockLine = (handle: string, text: string, room?: string, clientKey?: string) => {
    const roomId = room ?? `room-${++n}`;
    cw.rooms.seat(roomId, 'p1', { clientKey: clientKey ?? `key-blocker-${handle}` }, handle);
    const res = cw.chat.accept(roomId, 'p1', text);
    clock.t += 1000;
    const item = cw.blocked.list({ days: 30 })[0];
    if (item === undefined) throw new Error(`the line was not blocked: ${JSON.stringify(res)}`);
    return { room: roomId, item };
  };

  const raw = (req: Partial<KitRequest> & { method: string; path: string }): Promise<KitResponse> =>
    handle({ query: {}, headers: {}, body: undefined, ...req });

  return { cw, clock, session, routes, handle, transport, client, direct, sent, intercept, clientFor, file, fileRich, sanction, blockLine, raw, live, now: () => clock.t };
}

export type HubWorld = Awaited<ReturnType<typeof hubWorld>>;
