import { describe, expect, it } from 'vitest';
import { SanctionError } from '../src/sanctions.js';
import { HOUR, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';
import { appealsKit, DAY, HOUR as AHOUR } from './appealsWorld.js';
import type { AppealDecision } from '../src/appeals.js';

// The C8+C9 fix round, core side: revoking within limits (M-6) and the reportId a reduced appeal's replacement keeps (M-7).

const A = 'creator:alice';
const LIMITS = { kinds: ['warning', 'chat'] as const, maxDurationMs: 7 * DAY };

let n = 0;
async function fileIn(w: World, scope: string | null) {
  n += 1;
  const room = `room-fix-${n}`;
  w.cw.rooms.seat(room, 'p1', { clientKey: `rep-key-${n}-aaaaaaaa` }, 'Rep', scope === null ? undefined : { scope });
  w.cw.rooms.seat(room, 'p2', { clientKey: `tgt-key-${n}-aaaaaaaa` }, 'Tgt');
  w.cw.chat.accept(room, 'p2', 'a line from the target');
  w.clock.t += 1000;
  const res = await w.submit(room, {});
  if (!res.ok) throw new Error(`refused: ${res.refused}`);
  const rec = w.cw.reports.get(res.reportId);
  if (rec === null) throw new Error('missing');
  return { id: res.reportId, target: rec.targetPerson };
}
async function sanctioned(w: World, scope: string | null, kind: 'warning' | 'chat' | 'area' | 'ban' | 'note', durationMs: number | null) {
  const f = await fileIn(w, scope);
  const res = await w.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'senior_sam', reason: 'r', actions: [{ subject: f.target, kind, durationMs, rule: 1, lineIds: [] }] } as never);
  if (!res.ok) throw new Error(`decide refused: ${res.error}`);
  return { ...f, groupId: res.groups[0]!.groupId };
}
const revokedAt = (w: World, scope: string[], groupId: string): number | null => w.cw.sanctions.list({ limit: 200, scope }).items.find((i) => i.groupId === groupId)?.revokedAt ?? null;

describe('sanctions.revoke with `within` (a scoped moderator revokes only what they could have applied)', () => {
  it('a sanction inside the limits is revoked: a warning, a chat restriction, one of exactly the longest length', async () => {
    const w = await world();
    for (const [kind, ms] of [['warning', null], ['chat', HOUR], ['chat', 7 * DAY]] as const) {
      const s = await sanctioned(w, A, kind, ms);
      expect(await w.cw.sanctions.revoke(s.groupId, 'mod_x', 'lifted', { scope: [A], within: LIMITS }), `${kind} ${ms}`).toBe(true);
      expect(revokedAt(w, [A], s.groupId)).not.toBeNull();
    }
  });

  it('outside the limits it throws a SanctionError and revokes nothing: another kind, a ban, permanent, longer than the limit, a note', async () => {
    const w = await world();
    for (const [kind, ms] of [['area', HOUR], ['ban', HOUR], ['ban', null], ['chat', null], ['chat', 7 * DAY + 1], ['note', null]] as const) {
      const s = await sanctioned(w, A, kind, ms);
      await expect(w.cw.sanctions.revoke(s.groupId, 'mod_x', 'lifted', { scope: [A], within: LIMITS }), `${kind} ${ms}`).rejects.toBeInstanceOf(SanctionError);
      expect(revokedAt(w, [A], s.groupId), `${kind} ${ms}`).toBeNull();
    }
  });

  it('an out-of-scope or unknown group is false (not the throw), whatever its kind', async () => {
    const w = await world();
    const s = await sanctioned(w, 'creator:bob', 'ban', null);
    expect(await w.cw.sanctions.revoke(s.groupId, 'mod_x', 'lifted', { scope: [A], within: LIMITS })).toBe(false);
    expect(await w.cw.sanctions.revoke('g_unknown_000000', 'mod_x', 'lifted', { scope: [A], within: LIMITS })).toBe(false);
    expect(revokedAt(w, ['creator:bob'], s.groupId)).toBeNull();
  });

  it('without `within` (or without a scope) nothing is bounded, as before', async () => {
    const w = await world();
    const s = await sanctioned(w, A, 'ban', null);
    expect(await w.cw.sanctions.revoke(s.groupId, 'mod_x', 'lifted', { scope: [A] })).toBe(true);
    const s2 = await sanctioned(w, A, 'ban', null);
    expect(await w.cw.sanctions.revoke(s2.groupId, 'mod_x', 'lifted')).toBe(true);
  });

  it('a malformed `within` is refused before anything is read or revoked', async () => {
    const w = await world();
    const s = await sanctioned(w, A, 'chat', HOUR);
    for (const within of [null, 5, { kinds: 'chat', maxDurationMs: DAY }, { kinds: ['chat'], maxDurationMs: -1 }, { kinds: ['chat'] }, { kinds: ['bogus'], maxDurationMs: DAY }]) {
      await expect(w.cw.sanctions.revoke(s.groupId, 'mod_x', 'lifted', { scope: [A], within: within as never })).rejects.toBeInstanceOf(Error);
    }
    expect(revokedAt(w, [A], s.groupId)).toBeNull();
  });
});

describe('a reduced appeal keeps the report on the replacement sanction (M-7)', () => {
  const decision = (appealId: string, over: Partial<AppealDecision> = {}): AppealDecision => ({ appealId, outcome: 'uphold', actor: 'senior_bea', reason: 'the rule applied', ...over });

  it('the replacement row carries the original reportId (the original keeps it too); a revoke outcome writes no replacement; an uphold none', async () => {
    const k = await appealsKit();
    const s = await k.sanction({ kind: 'ban', durationMs: null });
    const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
    if (!r.ok) throw new Error('filing refused');
    const res = await k.cw.appeals.decide(decision(r.appeal.id, { outcome: 'reduce', to: { kind: 'chat', durationMs: 12 * AHOUR } }));
    expect(res).toMatchObject({ ok: true, status: 'reduced' });
    const subjectRows = k.store.rawSanctions().filter((row) => row.targetType === 'subject');
    expect(subjectRows).toHaveLength(2);
    const orig = subjectRows.find((row) => row.groupId === s.groupId)!;
    const repl = subjectRows.find((row) => row.groupId !== s.groupId)!;
    expect(orig.reportId).toBe(s.reportId);
    expect(repl.reportId).toBe(s.reportId);
    expect(repl.reportId).not.toBeNull();
  });

  it('several reductions each keep their own report (no cross-over between two appeals)', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const out: Array<{ report: string; replacement: string }> = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await k.sanction({ kind: 'ban', durationMs: null });
      const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
      if (!r.ok) throw new Error('filing refused');
      const res = await k.cw.appeals.decide(decision(r.appeal.id, { outcome: 'reduce', to: { kind: 'chat', durationMs: (i + 1) * AHOUR } }));
      if (!res.ok || !('replacementGroupId' in res)) throw new Error('not reduced');
      out.push({ report: s.reportId, replacement: res.replacementGroupId as string });
    }
    for (const o of out) {
      const row = k.store.rawSanctions().find((x) => x.groupId === o.replacement && x.targetType === 'subject');
      expect(row?.reportId).toBe(o.report);
    }
    expect(new Set(out.map((o) => o.report)).size).toBe(3);
  });
});
