import { createChatwarden, defineRules, starterRules } from '@chatwarden/core';
import type { Chatwarden, RawWho, ReportCategory } from '@chatwarden/core';
import { MemoryStore } from '@chatwarden/store-memory';
import { createRouter, playerRoutes } from '@chatwarden/http';
import type { KitResponse } from '@chatwarden/http';
import { playerClient } from '../src/client.js';
import type { PlayerClient } from '../src/client.js';
import { routerTransport } from '../src/transport.js';
import type { Transport, TransportRequest } from '../src/transport.js';

// The player components' tests run the REAL player routes (playerRoutes over MemoryStore and the real core) through
// routerTransport. Only a network failure, a 401/403/404 (the game's own door, which the kit does not have) or a 500 is faked,
// where the real routes cannot produce one.

export const T0 = 1_800_000_000_000;
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A synthetic blocked term (see the matcher's synthetic pack): a line with it is blocked, and masked in a notice. */
export const BLOCKED = 'zorbak';

export interface Player {
  /** The key the player's client sends (the world's `identify` hook reads it from a header). */
  key: string;
  handle: string;
  seat: string;
}

export const ALICE: Player = { key: 'key-alice-0001-secret', handle: 'Alice', seat: 'a' };
export const BOB: Player = { key: 'key-bob-0002-secret', handle: 'Bob', seat: 'b' };
export const CARA: Player = { key: 'key-cara-0003-secret', handle: 'Cara', seat: 'c' };

export interface WorldOptions {
  gameName?: string;
  /** Rule numbers to retire (a retired rule drops out of GET /rules). */
  retire?: number[];
}

export async function playerWorld(opts: WorldOptions = {}) {
  const clock = { t: T0, now: () => clock.t };
  const cw: Chatwarden = await createChatwarden({
    store: new MemoryStore(),
    // A matcher that blocks the synthetic term, so a blocked line can be masked in a notice.
    matcher: {
      match: (t) => (t.toLowerCase().includes(BLOCKED) ? { termId: `syn:${BLOCKED}` } : null),
      spans: (t) => {
        const i = t.toLowerCase().indexOf(BLOCKED);
        return i < 0 ? [] : [{ start: i, end: i + BLOCKED.length, termId: `syn:${BLOCKED}` }];
      },
    },
    secret: 'player-react-test-secret-0000-not-real',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    profile: 'standard',
    rules: defineRules(starterRules('standard').map((r) => (opts.retire?.includes(r.number) ? { ...r, retired: true } : r))),
    overrides: { profanity: { mode: 'allow' } },
    retention: false,
  });
  /** Who is calling: the key the transport sends. `null` sends none (the kit treats nobody as an empty answer). */
  const caller: { key: string | null } = { key: ALICE.key };
  const routes = playerRoutes(cw, {
    identify: (req): RawWho => (req.headers['x-test-key'] === undefined ? {} : { clientKey: req.headers['x-test-key'] }),
    gameName: opts.gameName ?? 'Test Game',
    now: () => clock.t,
  });
  const handle = createRouter(routes);

  /** Every request the components sent, in order. */
  const sent: TransportRequest[] = [];
  /** A hook for a test to answer one request itself (a 401, a 500, a dropped connection); return undefined to pass through. */
  const intercept: { fn: ((req: TransportRequest) => Promise<KitResponse | undefined> | KitResponse | undefined) | null } = { fn: null };
  const headers: Record<string, string> = {};
  const real: Transport = routerTransport(handle, { headers });
  const transport: Transport = async (req) => {
    sent.push(req);
    if (caller.key === null) delete headers['x-test-key'];
    else headers['x-test-key'] = caller.key;
    const faked = await intercept.fn?.(req);
    if (faked !== undefined) return { status: faked.status, headers: faked.headers ?? {}, body: faked.body };
    return real(req);
  };
  const client: PlayerClient = playerClient({ transport });

  const room = (n: number): string => `room-${n}`;
  let rooms = 0;
  /**
   * Gets `who` a sanction through a real report: `who` chats (the lines are the notice's excerpt), someone else reports them,
   * and a moderator decides it. Returns the report id, the decide result and the player's notice refCode when one was made.
   */
  const sanction = async (
    who: Player,
    kind: 'warning' | 'chat' | 'area' | 'ban',
    o: { rule?: number | 'uncovered'; durationMs?: number | null; lines?: string[]; category?: ReportCategory; reporter?: Player } = {},
  ) => {
    const reporter = o.reporter ?? BOB;
    const roomId = room(++rooms);
    cw.rooms.seat(roomId, who.seat, { clientKey: who.key }, who.handle);
    cw.rooms.seat(roomId, reporter.seat, { clientKey: reporter.key }, reporter.handle);
    for (const line of o.lines ?? ['you play like a snerp', 'honestly tarvo']) {
      cw.chat.accept(roomId, who.seat, line);
      clock.t += 1000;
    }
    cw.chat.accept(roomId, reporter.seat, 'reporter line the target must never see');
    clock.t += 1000;
    const res = await cw.reports.submit({ roomId, reporterSeat: reporter.seat, targetSeat: who.seat, category: o.category ?? 'harassment' });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    const report = cw.reports.get(res.reportId);
    if (report === null) throw new Error('report missing');
    const subject = cw.rooms.subjectAt(roomId, who.seat);
    if (subject === null) throw new Error('no subject');
    const lineIds = report.excerpt.filter((l) => l.seatId === who.seat).map((l) => l.lineId);
    const decided = await cw.decide({
      reportId: res.reportId,
      verdict: 'upheld',
      actor: 'ann@example.test',
      reason: 'private moderator reason',
      actions: [
        {
          subject,
          kind,
          durationMs: kind === 'warning' ? null : o.durationMs === undefined ? DAY : o.durationMs,
          rule: o.rule ?? 1,
          ...((o.rule ?? 1) === 'uncovered' ? { gapNote: 'a private gap note' } : {}),
          lineIds,
        },
      ],
    });
    clock.t += 1000;
    return { reportId: res.reportId, decided };
  };

  const warn = (who: Player = ALICE, o: Parameters<typeof sanction>[2] = {}) => sanction(who, 'warning', o);

  /** The notices the real routes hold for `who` (not through the transport, so `sent` stays clean). */
  const pending = (who: Player = ALICE) => cw.notices.pending({ clientKey: who.key });
  const record = (who: Player = ALICE) => cw.notices.record({ clientKey: who.key });

  return { cw, clock, caller, routes, handle, transport, client, sent, intercept, sanction, warn, pending, record, now: () => clock.t };
}

export type PlayerWorld = Awaited<ReturnType<typeof playerWorld>>;
