import type { RawWho, SanctionKind } from '@chatwarden/core';
import { world } from './world.js';
import type { WorldOptions } from './world.js';

// The staff world with appeals (and optionally names) switched on, over the real SQLite store. Appeals are made the real way: a report, an
// upheld decision that writes the sanction and its notice, and the player filing from that notice.

export { DAY, HOUR, NOW } from './world.js';

export interface AppealsWorldOptions extends WorldOptions {
  appeals?: Record<string, unknown>;
  names?: Record<string, unknown>;
}

export async function appealsWorld(over: AppealsWorldOptions = {}) {
  const { appeals, names, ...rest } = over;
  const w = await world({
    ...rest,
    overrides: { ...(rest.overrides ?? {}), appeals: { enabled: true, perPlayerPerWeek: 20, ...(appeals ?? {}) }, ...(names === undefined ? {} : { names }) },
  });

  /** A person sanctioned through a real decision by `actor`, with an appeal filed from the notice they were shown. */
  const appeal = async (o: { actor?: string; kind?: SanctionKind; durationMs?: number | null; rule?: number; statement?: string; file?: boolean } = {}) => {
    const f = await w.file();
    const kind = o.kind ?? 'chat';
    const res = await w.cw.decide({
      reportId: f.id,
      verdict: 'upheld',
      actor: o.actor ?? 'mod_ann',
      reason: 'private moderator reason',
      actions: [{ subject: f.target, kind, durationMs: kind === 'warning' ? null : o.durationMs === undefined ? 6 * 3_600_000 : o.durationMs, rule: o.rule ?? 2, lineIds: [] }],
    } as never);
    if (!res.ok) throw new Error(`decide refused: ${res.error}`);
    const g = res.groups[0];
    if (g === undefined || g.noticeId === null) throw new Error('expected a group and a notice');
    const who: RawWho = { clientKey: f.key };
    let appealId = '';
    if (o.file !== false) {
      const filed = w.cw.appeals.file(who, { noticeId: g.noticeId, statement: o.statement ?? 'I did not do this; it was a joke between friends.' });
      if (!filed.ok) throw new Error(`filing refused: ${filed.refused}`);
      appealId = filed.appeal.id;
    }
    w.clock.t += 1000;
    return { appealId, groupId: g.groupId, noticeId: g.noticeId, subject: f.target, who, key: f.key, reportId: f.id };
  };
  return { ...w, appeal };
}

export type AppealsWorld = Awaited<ReturnType<typeof appealsWorld>>;
