import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { KitEvent } from '../src/events.js';
import type { AppealRow, RawWho, SanctionKind, SubjectId } from '../src/types.js';
import { world } from './reportingWorld.js';

// A kit with appeals on, over a MemoryStore with the appeal methods: seat people, sanction them through a real decision (so the notice,
// the sanction row and the report id are the real ones) and hand back who to file as.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export { NOW } from './reportingWorld.js';

export type AppealsStore = ReturnType<typeof withMemoryAppeals<MemoryStore>>;

export async function appealsKit(over: Partial<ChatwardenOptions> = {}, appeals: Record<string, unknown> = {}, store: AppealsStore = withMemoryAppeals(new MemoryStore())) {
  const w = await world({ ...over, overrides: { appeals: { enabled: true, ...appeals }, ...(over.overrides ?? {}) } }, store);
  const events: KitEvent[] = [];
  w.cw.on('*', (e) => void events.push(e));
  let n = 0;

  /** Sanction one player (a fresh one unless `key` is given) through a real decision and return what an appeal needs. */
  const sanction = async (
    o: { key?: string; kind?: SanctionKind; durationMs?: number | null; actor?: string; rule?: number; source?: 'moderator' | 'api'; lines?: boolean } = {},
  ) => {
    n += 1;
    const key = o.key ?? `key-player-${n}`;
    const f = await w.file({}, { target: key });
    const kind = o.kind ?? 'chat';
    const res = await w.cw.decide({
      reportId: f.id,
      verdict: 'upheld',
      actor: o.actor ?? 'mod_ann',
      reason: 'private reason',
      ...(o.source === undefined ? {} : { source: o.source }),
      actions: [{ subject: f.target, kind, durationMs: kind === 'warning' ? null : o.durationMs === undefined ? 6 * HOUR : o.durationMs, rule: o.rule ?? 2, lineIds: [] }],
    } as never);
    if (!res.ok) throw new Error(`decide refused: ${res.error}`);
    const g = res.groups[0];
    if (g === undefined || g.noticeId === null) throw new Error('expected a group and a notice');
    const who: RawWho = { clientKey: key };
    return { who, subject: f.target as SubjectId, groupId: g.groupId, refCode: g.refCode, noticeId: g.noticeId, reportId: f.id, key, room: f.room };
  };

  const rows = (): AppealRow[] => (w.store as unknown as AppealsStore).listAppeals({ status: 'all', limit: 200 });
  return { ...w, store: w.store as unknown as AppealsStore, events, sanction, rows };
}

export type AppealsKit = Awaited<ReturnType<typeof appealsKit>>;
