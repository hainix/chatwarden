import { describe, expect, it } from 'vitest';
import { APPEAL_RATE_ELEVATED, APPEAL_RATE_HIGH, APPEAL_STATS_MIN_SANCTIONS } from '../src/appeals.js';
import type { AppealRow, SanctionRow } from '../src/types.js';
import { appealsKit, DAY, NOW } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// The per-rule false-positive rate: granted (revoked ONLY) over every sanction given under the rule; a reduction is shown beside it as
// "lightened" and never in it. No rate below ten sanctions; three bands.

let n = 0;
const sanction = (k: AppealsKit, rule: string | null, over: Partial<SanctionRow> = {}): string => {
  n += 1;
  const groupId = `sg${n}`;
  k.store.insertSanctionGroup([
    { id: `sr${n}`, groupId, refCode: `M-${String(n).padStart(5, '0')}`, kind: 'chat', targetType: 'subject', value: `s_${n % 7}`, startsAt: NOW - DAY, endsAt: NOW + DAY, reason: 'r', rule, gapNote: null, gapStatus: null, roomId: null, actor: 'mod_ann', source: 'moderator', automated: false, pending: false, ...over },
  ]);
  return groupId;
};
const appeal = (k: AppealsKit, groupId: string, rule: string | null, status: AppealRow['status'], over: Partial<AppealRow> = {}): void => {
  n += 1;
  const row: AppealRow = { id: `ap${n}`, subject: `s_${n % 7}`, groupId, noticeId: `n${n}`, reportId: null, rule, kind: 'chat', statement: 'x', status: 'open', createdAt: NOW - DAY, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null, ...over };
  k.store.insertAppeal(row);
  if (status === 'upheld' || status === 'reduced' || status === 'revoked') k.store.decideAppeal(row.id, { status, at: NOW, by: 'bea', reason: 'r', replacementGroupId: over.replacementGroupId ?? null });
  if (status === 'moot') k.store.closeAppealsForGroup(groupId, 'x', NOW);
};
/** `count` sanctions under `rule`, the first `statuses.length` of them appealed with those statuses. */
const seed = (k: AppealsKit, rule: string | null, count: number, statuses: AppealRow['status'][] = []): void => {
  for (let i = 0; i < count; i++) {
    const g = sanction(k, rule);
    const status = statuses[i];
    if (status !== undefined) appeal(k, g, rule, status);
  }
};
const rule = (s: ReturnType<AppealsKit['cw']['appeals']['stats']>, r: number | 'uncovered') => s.perRule.find((x) => x.rule === r);

describe('constants', () => {
  it('are 10, 0.15 and 0.30', () => {
    expect([APPEAL_STATS_MIN_SANCTIONS, APPEAL_RATE_ELEVATED, APPEAL_RATE_HIGH]).toEqual([10, 0.15, 0.3]);
  });
});

describe('stats', () => {
  it('sanctions are counted per rule (notes excluded, a reduction counted once); appealed; granted counts revoked only; lightened counts reduced only; upheld and moot count in neither', async () => {
    const k = await appealsKit();
    seed(k, '2', 12, ['revoked', 'reduced', 'upheld', 'moot', 'open', 'revoked']);
    sanction(k, '2', { kind: 'note', endsAt: NOW - DAY });
    sanction(k, '2', { targetType: 'ip', value: 'iphash' });
    // a reduction: the original is revoked and a replacement group is written; the replacement is not a second sanction
    const orig = sanction(k, '3');
    const repl = sanction(k, '3', { kind: 'warning' });
    appeal(k, orig, '3', 'reduced', { replacementGroupId: repl });
    const s = k.cw.appeals.stats();
    expect(rule(s, 2)).toEqual({ rule: 2, sanctions: 12, appealed: 6, granted: 2, lightened: 1, rate: 2 / 12, band: 'elevated' });
    expect(rule(s, 3)).toMatchObject({ sanctions: 1, appealed: 1, granted: 0, lightened: 1, rate: null, band: null });
    expect(s.overall).toEqual({ sanctions: 13, appealed: 7, granted: 2, lightened: 2, rate: 2 / 13 });
    expect(s.windowDays).toBe(90);
  });

  it('a reduce never moves the rate or its band', async () => {
    const k = await appealsKit();
    seed(k, '4', 10, ['reduced', 'reduced', 'reduced', 'reduced', 'reduced']);
    const s = k.cw.appeals.stats();
    expect(rule(s, 4)).toMatchObject({ sanctions: 10, granted: 0, lightened: 5, rate: 0, band: 'normal' });
  });

  it('rate is null at 9 sanctions and exact at 10; bands at the exact edges 0.15 and 0.30', async () => {
    const nine = await appealsKit();
    seed(nine, '1', 9, ['revoked', 'revoked', 'revoked', 'revoked', 'revoked']);
    expect(rule(nine.cw.appeals.stats(), 1)).toMatchObject({ sanctions: 9, granted: 5, rate: null, band: null });
    const ten = await appealsKit();
    seed(ten, '1', 10, ['revoked']);
    expect(rule(ten.cw.appeals.stats(), 1)).toMatchObject({ sanctions: 10, rate: 0.1, band: 'normal' });
    // 0.15 is elevated, just under it is normal; 0.30 is high, just under it is elevated
    const at15 = await appealsKit();
    seed(at15, '1', 20, ['revoked', 'revoked', 'revoked']);
    expect(rule(at15.cw.appeals.stats(), 1)).toMatchObject({ rate: 0.15, band: 'elevated' });
    const under15 = await appealsKit();
    seed(under15, '1', 21, ['revoked', 'revoked', 'revoked']);
    expect(rule(under15.cw.appeals.stats(), 1)?.band).toBe('normal');
    const at30 = await appealsKit();
    seed(at30, '1', 10, ['revoked', 'revoked', 'revoked']);
    expect(rule(at30.cw.appeals.stats(), 1)).toMatchObject({ rate: 0.3, band: 'high' });
    const under30 = await appealsKit();
    seed(under30, '1', 11, ['revoked', 'revoked', 'revoked']);
    expect(rule(under30.cw.appeals.stats(), 1)?.band).toBe('elevated');
    const all = await appealsKit();
    seed(all, '1', 10, Array(10).fill('revoked'));
    expect(rule(all.cw.appeals.stats(), 1)).toMatchObject({ rate: 1, band: 'high' });
  });

  it('uncovered and a null rule sort last, together; rules go by number', async () => {
    const k = await appealsKit();
    seed(k, 'uncovered', 3, ['revoked']);
    seed(k, null, 2);
    seed(k, '10', 1);
    seed(k, '2', 1);
    seed(k, '9', 1);
    const s = k.cw.appeals.stats();
    expect(s.perRule.map((r) => r.rule)).toEqual([2, 9, 10, 'uncovered']);
    expect(rule(s, 'uncovered')).toMatchObject({ sanctions: 5, appealed: 1, granted: 1 });
  });

  it('window edges are strict: the 30, 90 and 365 day windows each include a sanction exactly on the line and leave out one before it', async () => {
    const k = await appealsKit();
    for (const days of [30, 90, 365] as const) {
      sanction(k, String(days), { startsAt: NOW - days * DAY });
      sanction(k, String(days), { startsAt: NOW - days * DAY - 1 });
    }
    const counts = (days?: 30 | 90 | 365) => Object.fromEntries(k.cw.appeals.stats(days === undefined ? undefined : { days }).perRule.map((r) => [r.rule, r.sanctions]));
    expect(counts(30)).toEqual({ 30: 1 });
    expect(counts(90)).toEqual({ 30: 2, 90: 1 });
    expect(counts(365)).toEqual({ 30: 2, 90: 2, 365: 1 });
    expect(counts()).toEqual(counts(90));
    // an appeal is in the window by its filing time, inclusive
    const g = sanction(k, '7');
    appeal(k, g, '7', 'revoked', { createdAt: NOW - 30 * DAY });
    appeal(k, sanction(k, '7'), '7', 'revoked', { createdAt: NOW - 30 * DAY - 1 });
    expect(rule(k.cw.appeals.stats({ days: 30 }), 7)).toMatchObject({ appealed: 1, granted: 1 });
  });

  it('a window that is not 30, 90 or 365 is a RangeError; an empty store gives zeros and null', async () => {
    const k = await appealsKit();
    for (const days of [0, 1, 7, 60, 91, 366, Number.NaN, '90']) expect(() => k.cw.appeals.stats({ days: days as never })).toThrow(RangeError);
    expect(k.cw.appeals.stats()).toEqual({ windowDays: 90, perRule: [], overall: { sanctions: 0, appealed: 0, granted: 0, lightened: 0, rate: null } });
  });

  it('an appeal for a rule with no sanction in the window still shows, with no rate', async () => {
    const k = await appealsKit();
    const g = sanction(k, '5', { startsAt: NOW - 200 * DAY });
    appeal(k, g, '5', 'revoked');
    expect(rule(k.cw.appeals.stats(), 5)).toEqual({ rule: 5, sanctions: 0, appealed: 1, granted: 1, lightened: 0, rate: null, band: null });
  });

  it('a real revoke through the kit moves the rate; a real reduce through the kit does not', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    for (let i = 0; i < 8; i++) await k.sanction({ rule: 6 });
    const a = await k.sanction({ rule: 6 });
    const b = await k.sanction({ rule: 6 });
    const r1 = k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 'x' });
    const r2 = k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: 'x' });
    if (!r1.ok || !r2.ok) throw new Error('filing refused');
    await k.cw.appeals.decide({ appealId: r1.appeal.id, outcome: 'revoke', actor: 'senior_bea', reason: 'wrong' });
    await k.cw.appeals.decide({ appealId: r2.appeal.id, outcome: 'reduce', actor: 'senior_bea', reason: 'harsh', to: { kind: 'warning', durationMs: null } });
    // ten sanctions under the rule (the replacement warning is not an eleventh)
    expect(rule(k.cw.appeals.stats(), 6)).toMatchObject({ sanctions: 10, appealed: 2, granted: 1, lightened: 1, rate: 0.1, band: 'normal' });
  });

  it('with appeals off the stats are empty and no store method is touched', async () => {
    const k = await appealsKit({}, { enabled: false });
    seed(k, '1', 12, ['revoked']);
    let touched = 0;
    for (const m of ['countSanctionsByRule', 'appealCountsByRule'] as const) {
      const real = (k.store as unknown as Record<string, (...a: unknown[]) => unknown>)[m] as (...a: unknown[]) => unknown;
      (k.store as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        touched += 1;
        return real.apply(k.store, a);
      };
    }
    expect(k.cw.appeals.stats()).toEqual({ windowDays: 90, perRule: [], overall: { sanctions: 0, appealed: 0, granted: 0, lightened: 0, rate: null } });
    expect(touched).toBe(0);
  });

  it('a store failure reads as empty and is logged by class', async () => {
    const k = await appealsKit();
    k.store.countSanctionsByRule = () => {
      throw new TypeError('x');
    };
    expect(k.cw.appeals.stats().perRule).toEqual([]);
    expect(k.logged).toContainEqual(['chatwarden.appeal_failed', { error: 'TypeError' }]);
  });
});
