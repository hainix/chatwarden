import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryNames } from '@chatwarden/store-memory';
import type { RawWho, SanctionKind } from '@chatwarden/core';
import { hubWorld } from './world.js';
import type { WorldOptions } from './world.js';

// The hub's test world with appeals (and optionally names) switched on, over a MemoryStore that keeps appeals. An appeal is made the real way: a report,
// an upheld decision that writes the sanction and its notice, and the player filing from that notice. Synthetic terms only (zorbak is a slur here).

export { DAY, HOUR, MINUTE, T0 } from './world.js';

export interface AppealsHubOptions extends WorldOptions {
  /** Appeal settings on top of `{ enabled: true, perPlayerPerWeek: 20 }`; `false` leaves appeals off. */
  appeals?: Record<string, unknown> | false;
  names?: Record<string, unknown>;
}

export async function appealsHub(over: AppealsHubOptions = {}) {
  const { appeals, names, ...rest } = over;
  const w = await hubWorld({
    ...rest,
    store: withMemoryNames(withMemoryAppeals(withMemoryAi(new MemoryStore()))),
    overrides: {
      ...(rest.overrides ?? {}),
      ...(appeals === false ? {} : { appeals: { enabled: true, perPlayerPerWeek: 20, ...(appeals ?? {}) } }),
      ...(names === undefined ? {} : { names }),
    },
  });

  /** A person sanctioned through a real decision by `actor`, with an appeal filed from the notice they were shown. */
  const appeal = async (o: { target?: string; actor?: string; kind?: SanctionKind; durationMs?: number | null; rule?: number; statement?: string; file?: boolean } = {}) => {
    const target = o.target ?? `Tgt${Math.random().toString(36).slice(2, 8)}`;
    const f = await w.file({ target });
    const kind = o.kind ?? 'chat';
    const res = await w.cw.decide({
      reportId: f.id,
      verdict: 'upheld',
      actor: o.actor ?? 'mod_ann',
      reason: 'private moderator reason',
      actions: [{ subject: f.person, kind, durationMs: kind === 'warning' ? null : o.durationMs === undefined ? 6 * 3_600_000 : o.durationMs, rule: o.rule ?? 2, lineIds: [] }],
    } as never);
    if (!res.ok) throw new Error(`decide refused: ${res.error}`);
    const g = res.groups[0];
    if (g === undefined || g.noticeId === null) throw new Error('expected a group and a notice');
    const who: RawWho = { clientKey: `key-target-${target}` };
    let appealId = '';
    if (o.file !== false) {
      const filed = w.cw.appeals.file(who, { noticeId: g.noticeId, statement: o.statement ?? 'I did not do this; it was a joke between friends.' });
      if (!filed.ok) throw new Error(`filing refused: ${filed.refused}`);
      appealId = filed.appeal.id;
    }
    w.clock.t += 1000;
    return { appealId, groupId: g.groupId, refCode: g.refCode, noticeId: g.noticeId, person: f.person, reportId: f.id, who, target };
  };
  return { ...w, appeal };
}

export type AppealsHub = Awaited<ReturnType<typeof appealsHub>>;
