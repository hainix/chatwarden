import { DatabaseSync } from 'node:sqlite';
import { createChatwarden } from '@chatwarden/core';
import type { Chatwarden, Logger, Matcher, ProfanityFilter, RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { createRouter, playerRoutes } from '@chatwarden/http';
import type { KitRequest, KitResponse } from '@chatwarden/http';

// A player-API world with appeals and names switched on, over a real SQLite store: people are sanctioned through a real decision so the
// notice ids, sanction rows and report ids are the real ones. Synthetic terms only (zorbak: a slur here, snerp: a swear word here).

export const NOW = 1_800_000_000_000;
export const HOUR = 3_600_000;

export const ALICE: RawWho = { clientKey: 'raw-key-alice-0001-secret', ip: '203.0.113.11' };
export const BOB: RawWho = { clientKey: 'raw-key-bob-0002-secret', ip: '203.0.113.12' };
export const CAROL: RawWho = { clientKey: 'raw-key-carol-0003-secret', accountId: 'acct-carol', ip: '203.0.113.13' };
export const RAW_VALUES = [ALICE.clientKey, BOB.clientKey, CAROL.clientKey, CAROL.accountId, ALICE.ip, BOB.ip, CAROL.ip] as string[];

export const blocker: Matcher = {
  match: (t) => (t.toLowerCase().includes('zorbak') ? { termId: 'syn:zorbak' } : null),
  spans: (t) => {
    const i = t.toLowerCase().indexOf('zorbak');
    return i < 0 ? [] : [{ start: i, end: i + 6, termId: 'syn:zorbak' }];
  },
};

export const snerpFilter: ProfanityFilter = {
  apply: (text) => ({ hit: /snerp/i.test(text), text }),
};

export type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

/** Identity from headers: x-key, x-account, x-ip; x-identify=throw breaks the hook. */
export const identifyFromHeaders = (req: KitRequest): RawWho => {
  const h = req.headers;
  if (h['x-identify'] === 'throw') throw new Error(`boom for ${h['x-key'] ?? ''}`);
  const who: Record<string, unknown> = {};
  if (h['x-key'] !== undefined) who.clientKey = h['x-key'];
  if (h['x-account'] !== undefined) who.accountId = h['x-account'];
  if (h['x-ip'] !== undefined) who.ip = h['x-ip'];
  return who as RawWho;
};

export interface PlayerWorldOptions {
  appeals?: Record<string, unknown> | false;
  names?: Record<string, unknown>;
  routes?: Record<string, unknown>;
  wrap?: (cw: Chatwarden) => Chatwarden;
}

export async function playerWorld(over: PlayerWorldOptions = {}) {
  const store = openStore({ db: new DatabaseSync(':memory:') });
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const cw = await createChatwarden({
    store,
    secret: 'player-appeals-secret',
    platform: { identify: (ctx: unknown) => ctx as RawWho },
    clock,
    logger,
    matcher: blocker,
    profanity: snerpFilter,
    retention: false,
    overrides: {
      ...(over.appeals === false ? {} : { appeals: { enabled: true, ...(over.appeals ?? {}) } }),
      ...(over.names === undefined ? {} : { names: over.names }),
    },
  } as never);
  const used = over.wrap === undefined ? cw : over.wrap(cw);
  const routes = playerRoutes(used, { identify: identifyFromHeaders, logger, now: () => clock.t, ...over.routes } as Parameters<typeof playerRoutes>[1]);
  const router = createRouter(routes);
  const call = (
    method: string,
    path: string,
    o: { who?: RawWho; query?: Record<string, string>; body?: unknown; raw?: string; headers?: Record<string, string> } = {},
  ): Promise<KitResponse> => {
    const headers: Record<string, string> = { ...o.headers };
    if (o.who?.clientKey !== undefined) headers['x-key'] = o.who.clientKey;
    if (o.who?.accountId !== undefined) headers['x-account'] = o.who.accountId;
    if (o.who?.ip !== undefined && o.who.ip !== null) headers['x-ip'] = o.who.ip;
    const rawBody = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    return router({ method, path, query: o.query ?? {}, headers, body: undefined, ...(rawBody === undefined ? {} : { rawBody }) });
  };

  let n = 0;
  /**
   * Sanction `who` for real (a report from a bystander, an upheld decision) and return the sanction notice's id, group id and subject.
   * The notice is the player's own: it is what the player holds when they appeal.
   */
  const sanction = async (who: RawWho, o: { kind?: 'warning' | 'chat' | 'area' | 'ban'; durationMs?: number | null; rule?: number } = {}) => {
    n += 1;
    const room = `room-pw-${n}`;
    cw.rooms.seat(room, 'a', who, `Target${n}`);
    cw.rooms.seat(room, 'b', { clientKey: `raw-key-reporter-${n}-secret`, ip: '198.51.100.20' }, 'Reporter');
    cw.chat.accept(room, 'a', 'a line from the target');
    const submitted = await cw.reports.submit({ roomId: room, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
    if (!submitted.ok) throw new Error('expected a stored report');
    const subject = cw.rooms.subjectAt(room, 'a');
    if (subject === null) throw new Error('expected a subject');
    const kind = o.kind ?? 'chat';
    const res = await cw.decide({
      reportId: submitted.reportId,
      verdict: 'upheld',
      actor: 'mod_ann',
      reason: 'private moderator reason text',
      actions: [{ subject, kind, durationMs: kind === 'warning' ? null : o.durationMs === undefined ? 6 * HOUR : o.durationMs, rule: o.rule ?? 2, lineIds: [] }],
    } as never);
    if (!res.ok) throw new Error(`decide refused: ${res.error}`);
    const g = res.groups[0];
    if (g === undefined || g.noticeId === null) throw new Error('expected a group and a notice');
    clock.t += 1000;
    return { noticeId: g.noticeId, groupId: g.groupId, refCode: g.refCode, subject, reportId: submitted.reportId };
  };
  return { cw, store, clock, logged, call, router, routes, sanction };
}

export type PlayerWorld = Awaited<ReturnType<typeof playerWorld>>;
export const bodyOf = (res: KitResponse) => res.body as Record<string, unknown>;
export const errorOf = (res: KitResponse): string => (res.body as { error: string }).error;
