import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import type { Chatwarden, ChatwardenOptions } from '../src/chatwarden.js';
import type { Logger, RawWho, Store } from '../src/types.js';
import type { ReportInput } from '../src/reports.js';

// A kit over a MemoryStore with a fake clock, for the reporting tests: seat two people in a room and file reports.

export const NOW = 1_800_000_000_000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const OWNER = { actor: 'owner_ann', reason: 'tuning reporting' };

export type Logged = Array<[string, Record<string, string | number | boolean> | undefined]>;

export async function world(over: Partial<ChatwardenOptions> = {}, store: Store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const logged: Logged = [];
  const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
  const cw: Chatwarden = await createChatwarden({
    store,
    secret: 'reporting-secret',
    platform: { identify: (ctx) => ctx as RawWho },
    clock,
    logger,
    retention: false,
    ...over,
  });
  let n = 0;
  /** A room with a reporter in p1 and a target in p2 (fresh people each call unless keys are given). */
  const table = (keys: { reporter?: string; target?: string; room?: string } = {}) => {
    n += 1;
    const room = keys.room ?? `room-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: keys.reporter ?? 'key-reporter' }, 'Rep');
    cw.rooms.seat(room, 'p2', { clientKey: keys.target ?? `key-target-${n}` }, 'Tgt');
    return { room, reporter: cw.rooms.subjectAt(room, 'p1') as string, target: cw.rooms.subjectAt(room, 'p2') as string };
  };
  const submit = (room: string, o: Partial<ReportInput> = {}) => cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', ...o });
  /** File one report in a fresh room and return its id (throws when refused). */
  const file = async (o: Partial<ReportInput> = {}, keys: { reporter?: string; target?: string } = {}) => {
    const t = table(keys);
    const res = await submit(t.room, o);
    if (!res.ok) throw new Error(`refused: ${res.refused}`);
    return { ...t, id: res.reportId };
  };
  return { cw, store, clock, logged, table, submit, file };
}

export type World = Awaited<ReturnType<typeof world>>;
