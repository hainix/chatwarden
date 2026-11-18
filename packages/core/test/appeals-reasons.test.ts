import { describe, expect, it } from 'vitest';
import { APPEAL_REASONS, APPEAL_REASON_CODES, APPEAL_REASON_DEFAULT } from '../src/index.js';
import type { AppealDecision, AppealOutcome, AppealReasonCode } from '../src/index.js';
import { appealsKit, HOUR } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// The fixed reasons of a decided appeal (0.2.1): a closed list per outcome, stored as `reason_code`, shown to the player and carried by `appeal.decided`.
// The free-text `reason` stays required and private. The check order is: shape (`invalid`), reason code (`invalid_reason`), then the store.

type Filed = Awaited<ReturnType<AppealsKit['sanction']>> & { appealId: string };
async function filed(k: AppealsKit, o: Parameters<AppealsKit['sanction']>[0] = {}): Promise<Filed> {
  const s = await k.sanction(o);
  const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
  if (!r.ok) throw new Error(`filing refused: ${r.refused}`);
  return { ...s, appealId: r.appeal.id };
}
const TO = { kind: 'chat', durationMs: 2 * HOUR } as const;
const decision = (appealId: string, outcome: AppealOutcome, over: Record<string, unknown> = {}): AppealDecision =>
  ({ appealId, outcome, actor: 'senior_bea', reason: 'the rule applied', ...(outcome === 'reduce' ? { to: TO } : {}), ...over }) as AppealDecision;
const OUTCOMES: AppealOutcome[] = ['uphold', 'reduce', 'revoke'];
const decidedEvents = (k: AppealsKit) => k.events.filter((e) => e.type === 'appeal.decided');

describe('the lists', () => {
  it('seven codes, three per outcome, each outcome keeps context_considered, all frozen', () => {
    expect([...APPEAL_REASON_CODES]).toEqual(['rule_applies', 'evidence_clear', 'context_considered', 'first_offence', 'lighter_fits', 'mistake', 'not_a_violation']);
    expect(APPEAL_REASONS).toEqual({
      uphold: ['rule_applies', 'evidence_clear', 'context_considered'],
      reduce: ['first_offence', 'lighter_fits', 'context_considered'],
      revoke: ['mistake', 'not_a_violation', 'context_considered'],
    });
    expect(APPEAL_REASON_DEFAULT).toBe('context_considered');
    expect(Object.isFrozen(APPEAL_REASON_CODES)).toBe(true);
    expect(Object.isFrozen(APPEAL_REASONS)).toBe(true);
    for (const o of OUTCOMES) expect(Object.isFrozen(APPEAL_REASONS[o]), o).toBe(true);
    // every outcome's codes are in the closed list
    for (const o of OUTCOMES) for (const c of APPEAL_REASONS[o]) expect(APPEAL_REASON_CODES).toContain(c);
  });

  it('a frozen list cannot be changed by a caller', () => {
    expect(() => (APPEAL_REASON_CODES as unknown as string[]).push('x')).toThrow();
    expect(() => (APPEAL_REASONS.uphold as unknown as string[]).push('x')).toThrow();
  });
});

describe('a code of the outcome is accepted and stored', () => {
  const cases = OUTCOMES.flatMap((o) => APPEAL_REASONS[o].map((c) => [o, c] as const));
  it.each(cases)('%s accepts %s, the appeal row stores it and get() reads it back', async (outcome, code) => {
    const k = await appealsKit();
    const s = await filed(k);
    const res = await k.cw.appeals.decide(decision(s.appealId, outcome, { reasonCode: code }));
    expect(res.ok).toBe(true);
    expect(k.store.loadAppeal(s.appealId)?.reasonCode).toBe(code);
    expect(k.cw.appeals.get(s.appealId)?.decided).toMatchObject({ by: 'senior_bea', reasonCode: code });
  });

  it('there are nine cases: every outcome, every one of its three codes', () => {
    expect(cases).toHaveLength(9);
  });
});

describe('a code of another outcome is refused', () => {
  const cross = OUTCOMES.flatMap((o) => APPEAL_REASON_CODES.filter((c) => !APPEAL_REASONS[o].includes(c)).map((c) => [o, c] as const)).filter(([, c]) => c !== 'context_considered');
  it.each(cross)('%s refuses %s as invalid_reason and nothing changes', async (outcome, code) => {
    const k = await appealsKit();
    const s = await filed(k);
    const before = k.events.length;
    const res = await k.cw.appeals.decide(decision(s.appealId, outcome, { reasonCode: code }));
    expect(res).toEqual({ ok: false, error: 'invalid_reason' });
    // still open, sanction standing, no outcome notice, no event
    expect(k.store.loadAppeal(s.appealId)).toMatchObject({ status: 'open', decidedAt: null, decidedBy: null, replacementGroupId: null });
    expect(k.store.loadAppeal(s.appealId)?.reasonCode ?? null).toBeNull();
    expect(k.store.rawSanctions().every((r) => r.revokedAt === null)).toBe(true);
    expect(k.store.rawSanctions()).toHaveLength(1);
    expect(k.cw.notices.pending(s.who).filter((n) => n.kind.startsWith('appeal_'))).toEqual([]);
    expect(k.store.rawNotices().find((n) => n.id === s.noticeId)?.withdrawnAt).toBeNull();
    expect(k.events.slice(before)).toEqual([]);
    // and the same appeal can still be decided with a code that fits
    const ok = await k.cw.appeals.decide(decision(s.appealId, outcome, { reasonCode: APPEAL_REASONS[outcome][0] }));
    expect(ok.ok).toBe(true);
  });

  it('there are twelve code and outcome pairs that do not fit (four per outcome; context_considered fits all three)', () => {
    expect(cross).toHaveLength(12);
  });
});

describe('no code', () => {
  it.each(OUTCOMES)('stores context_considered for %s (an absent key is the one way to ask for the default)', async (outcome) => {
    const k = await appealsKit();
    const s = await filed(k);
    expect((await k.cw.appeals.decide(decision(s.appealId, outcome))).ok).toBe(true);
    expect(k.store.loadAppeal(s.appealId)?.reasonCode).toBe('context_considered');
    expect(k.cw.appeals.get(s.appealId)?.decided?.reasonCode).toBe('context_considered');
  });

  it('an explicit undefined reads as absent', async () => {
    const k = await appealsKit();
    const s = await filed(k);
    expect((await k.cw.appeals.decide(decision(s.appealId, 'uphold', { reasonCode: undefined }))).ok).toBe(true);
    expect(k.store.loadAppeal(s.appealId)?.reasonCode).toBe('context_considered');
  });
});

describe('a code that is not one', () => {
  const bad: Array<[string, unknown]> = [
    ['inherited toString', 'toString'],
    ['inherited __proto__', '__proto__'],
    ['constructor', 'constructor'],
    ['a number', 7],
    ['null', null],
    ['an empty string', ''],
    ['a code with a leading space', ' mistake'],
    ['a code with a trailing space', 'mistake '],
    ['the wrong case', 'MISTAKE'],
    ['an unknown word', 'because'],
    ['an object', { code: 'mistake' }],
    ['an array', ['mistake']],
    ['true', true],
  ];
  it.each(bad)('%s is invalid_reason, and writes nothing', async (_name, code) => {
    const k = await appealsKit();
    const s = await filed(k);
    for (const outcome of OUTCOMES) {
      expect(await k.cw.appeals.decide(decision(s.appealId, outcome, { reasonCode: code })), outcome).toEqual({ ok: false, error: 'invalid_reason' });
    }
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('open');
    expect(decidedEvents(k)).toEqual([]);
  });

  it('the code is read once: a getter that gives a good code and then a bad one stores the first', async () => {
    const k = await appealsKit();
    const s = await filed(k);
    let reads = 0;
    const d = decision(s.appealId, 'revoke');
    Object.defineProperty(d, 'reasonCode', { get: () => (++reads === 1 ? 'mistake' : 'bogus'), enumerable: true });
    expect((await k.cw.appeals.decide(d)).ok).toBe(true);
    expect(reads).toBe(1);
    expect(k.store.loadAppeal(s.appealId)?.reasonCode).toBe('mistake');
  });
});

describe('the order of the checks', () => {
  it('invalid_reason is answered before not_found: a bad code on an unknown appeal id is invalid_reason', async () => {
    const k = await appealsKit();
    expect(await k.cw.appeals.decide(decision('no-such-appeal', 'uphold', { reasonCode: 'mistake' }))).toEqual({ ok: false, error: 'invalid_reason' });
    // a good (or absent) code on the unknown id is still not_found
    expect(await k.cw.appeals.decide(decision('no-such-appeal', 'uphold', { reasonCode: 'rule_applies' }))).toEqual({ ok: false, error: 'not_found' });
    expect(await k.cw.appeals.decide(decision('no-such-appeal', 'uphold'))).toEqual({ ok: false, error: 'not_found' });
  });

  it('a malformed decision is still invalid, whatever the code: the shape comes first', async () => {
    const k = await appealsKit();
    const s = await filed(k);
    expect(await k.cw.appeals.decide(decision(s.appealId, 'uphold', { reason: '', reasonCode: 'mistake' }))).toEqual({ ok: false, error: 'invalid' });
    expect(await k.cw.appeals.decide(decision(s.appealId, 'uphold', { actor: 'x y', reasonCode: 'mistake' }))).toEqual({ ok: false, error: 'invalid' });
  });

  it('a bad code on an already-decided appeal is invalid_reason, not already_decided', async () => {
    const k = await appealsKit();
    const s = await filed(k);
    expect((await k.cw.appeals.decide(decision(s.appealId, 'uphold'))).ok).toBe(true);
    expect(await k.cw.appeals.decide(decision(s.appealId, 'uphold', { reasonCode: 'mistake' }))).toEqual({ ok: false, error: 'invalid_reason' });
    expect(await k.cw.appeals.decide(decision(s.appealId, 'uphold', { reasonCode: 'rule_applies' }))).toEqual({ ok: false, error: 'already_decided' });
  });

  it('with appeals off the answer is still not_found, whatever the code', async () => {
    const k = await appealsKit({}, { enabled: false });
    expect(await k.cw.appeals.decide(decision('x', 'uphold', { reasonCode: 'mistake' }))).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('the appeal.decided event', () => {
  it.each(OUTCOMES)('carries reason for %s: the code given, and the default when none, once', async (outcome) => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const a = await filed(k);
    const b = await filed(k);
    const code = APPEAL_REASONS[outcome][0] as AppealReasonCode;
    await k.cw.appeals.decide(decision(a.appealId, outcome, { reasonCode: code }));
    await k.cw.appeals.decide(decision(b.appealId, outcome));
    const events = decidedEvents(k);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'appeal.decided', appealId: a.appealId, outcome, reason: code });
    expect(events[1]).toMatchObject({ type: 'appeal.decided', appealId: b.appealId, outcome, reason: 'context_considered' });
    // the free text never rides on the event
    expect(JSON.stringify(events)).not.toContain('the rule applied');
  });
});

describe('what the player and the row show', () => {
  it('an appeal decided before this release reads reasonCode null, and so does one with a code nobody knows', async () => {
    const k = await appealsKit();
    const base = { subject: 's_x', noticeId: 'n1', reportId: null, rule: '2', kind: 'chat', statement: 'st', status: 'upheld', createdAt: 1, decidedAt: 5, decidedBy: 'senior_bea', decisionReason: 'old', replacementGroupId: null } as const;
    k.store.insertAppeal({ ...base, id: 'old1', groupId: 'g-old1' });
    k.store.insertAppeal({ ...base, id: 'old2', groupId: 'g-old2', reasonCode: 'a_code_from_the_future' });
    k.store.insertAppeal({ ...base, id: 'old3', groupId: 'g-old3', reasonCode: null });
    for (const id of ['old1', 'old2', 'old3']) expect(k.cw.appeals.get(id)?.decided, id).toMatchObject({ by: 'senior_bea', reasonCode: null });
  });

  it('an open appeal has no decided block, and a moot one reads reasonCode null', async () => {
    const k = await appealsKit();
    const open = await filed(k);
    expect(k.cw.appeals.get(open.appealId)?.decided).toBeNull();
    const moot = await filed(k);
    expect(await k.cw.sanctions.revoke(moot.groupId, 'senior_bea', 'undone elsewhere')).toBe(true);
    expect(k.cw.appeals.get(moot.appealId)?.status).toBe('moot');
    expect(k.cw.appeals.get(moot.appealId)?.decided?.reasonCode).toBeNull();
  });

  it('a reduce keeps the reason on the appeal row, and none is shown on the replacement or in the notices', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const res = await k.cw.appeals.decide(decision(s.appealId, 'reduce', { reasonCode: 'first_offence', to: { kind: 'chat', durationMs: 2 * HOUR } }));
    expect(res).toMatchObject({ ok: true, status: 'reduced' });
    const replacement = (res as { replacementGroupId: string }).replacementGroupId;
    expect(k.store.loadAppeal(s.appealId)?.reasonCode).toBe('first_offence');
    const rows = k.store.rawSanctions().filter((r) => r.groupId === replacement);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('first_offence');
    expect(JSON.stringify(rows)).not.toContain('reasonCode');
    expect(JSON.stringify(k.store.rawNotices())).not.toContain('first_offence');
  });

  it('the decision with a code and the free text keeps both: the text stays private on the row', async () => {
    const k = await appealsKit();
    const s = await filed(k);
    await k.cw.appeals.decide(decision(s.appealId, 'revoke', { reasonCode: 'not_a_violation', reason: 'private words quissel' }));
    expect(k.store.loadAppeal(s.appealId)).toMatchObject({ reasonCode: 'not_a_violation', decisionReason: 'private words quissel' });
  });
});
