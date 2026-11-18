import type { Logger } from '@chatwarden/core';
import { serviceRoutes } from '../src/service/index.js';
import type { ServiceOptions } from '../src/service/index.js';
import { toFetch } from '../src/fetch.js';
import type { KitResponse } from '../src/types.js';
import { BLOCKED, chatWorld, SEC } from './chat-world.js';
import type { WorldOptions } from './chat-world.js';
import { KEY_A, KEY_B, callerOver } from './serviceKit.js';
import type { CallOptions } from './serviceKit.js';

// A world for the service API tests: the chat world's kit (synthetic terms, a fake clock) behind `serviceRoutes`, with every response recorded for the privacy scan.

export { BLOCKED, SEC };

export interface Recorded {
  method: string;
  path: string;
  status: number;
  body: unknown;
  headers: Record<string, string> | undefined;
}

export interface ServiceWorldOptions {
  world?: WorldOptions;
  service?: Partial<ServiceOptions>;
}

export async function serviceWorld(over: ServiceWorldOptions = {}) {
  const w = await chatWorld({ noBroadcaster: true, ...over.world });
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const logger: Logger = { warn: (event, detail) => void logs.push([event, detail]) };
  const routes = serviceRoutes(w.cw, {
    keys: [KEY_A, KEY_B],
    now: w.clock.now,
    logger,
    // a big budget: the tests are about the routes, the limits have their own tests
    rateLimit: { max: 1_000_000, windowMs: 10_000 },
    ...over.service,
  });
  const base = callerOver(routes);
  const recorded: Recorded[] = [];
  const call = async (method: string, path: string, o?: CallOptions): Promise<KitResponse> => {
    const res = await base(method, path, o);
    recorded.push({ method, path, status: res.status, body: JSON.parse(JSON.stringify(res.body ?? null)), headers: res.headers });
    return res;
  };
  /** The same table over `toFetch`, mounted at `/v1`, for the end-to-end checks. */
  const fetcher = toFetch({ '/v1': routes });
  const fetchJson = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; headers: Headers }> => {
    const res = await fetcher(
      new Request(`http://svc.test/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${KEY_A}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text === '' ? undefined : (JSON.parse(text) as unknown), headers: res.headers };
  };

  /** The raw identity of a named player: stable per name. */
  const who = (name: string, extra: Record<string, string> = {}) => ({ clientKey: `raw-client-key-${name}-0001`, ...extra });
  const seat = (room: string, seatId: string, name: string, extra: { tags?: Record<string, string>; who?: Record<string, string> } = {}) =>
    call('PUT', `/rooms/${room}/seats/${seatId}`, { body: { who: who(name, extra.who), handle: name, ...(extra.tags === undefined ? {} : { tags: extra.tags }) } });
  const line = (room: string, seatId: string, text: string, idempotencyKey?: string) =>
    call('POST', `/rooms/${room}/seats/${seatId}/lines`, { body: { text }, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  /** File a report from `reporterSeat` against `targetSeat` (both in `room`, the target having spoken) and warn the target by a decision: they get one warning notice. */
  const warn = async (room: string, reporterSeat: string, targetSeat: string): Promise<void> => {
    const filed = await w.real.reports.submit({ roomId: room, reporterSeat, targetSeat, category: 'harassment' });
    if (!filed.ok) throw new Error('report refused');
    const report = w.real.reports.get(filed.reportId);
    const lineIds = (report?.excerpt ?? []).filter((l) => l.seatId === targetSeat).map((l) => l.lineId);
    const decided = await w.real.decide({
      reportId: filed.reportId,
      verdict: 'upheld',
      actor: 'mod@example.test',
      reason: 'private moderator reason',
      actions: [{ subject: w.real.rooms.subjectAt(room, targetSeat) as string, kind: 'warning', durationMs: null, rule: 2, lineIds }],
    });
    if (!decided.ok) throw new Error('decision refused');
  };
  /** A moderator's sanction on whoever sits in a seat (found by the seat, so no address links two players). */
  const sanctionSeat = (kind: 'chat' | 'ban', room: string, seatId: string, durationMs: number | null = 3_600_000) =>
    w.real.sanctions.apply({
      kind,
      subject: w.real.rooms.subjectAt(room, seatId) as string,
      includeIp: false,
      durationMs,
      reason: 'private moderator reason',
      actor: 'mod@example.test',
      source: 'moderator',
      automated: false,
      rule: 2,
      roomId: room,
    });
  /** Move the kit's clock (the per-seat pacing and the rate window run on it). */
  const advance = (ms: number): void => w.advance(ms);

  return { ...w, routes, call, recorded, logs, fetchJson, who, seat, line, advance, warn, sanctionSeat };
}

export type ServiceWorld = Awaited<ReturnType<typeof serviceWorld>>;
