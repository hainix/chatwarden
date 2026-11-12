import { describe, expect, it } from 'vitest';
import { DECISION_REASON_MAX, NO_ACTION_DEFAULT_REASON, decisionKey, isDefaultNoActionReason } from '../src/decide.js';
import type { DecisionInput } from '../src/decide.js';
import { SubjectIndex } from '../src/subjects.js';
import { MemoryStore } from '@chatwarden/store-memory';
import { world } from './reportingWorld.js';


// D1: a dismissal with no typed reason. Core stores one recognisable constant; every other verdict still needs a real reason.

const EVIDENCE = 'filed the same false report against three players in one evening';

const base = (reportId: string, over: Record<string, unknown> = {}): DecisionInput =>
  ({ reportId, verdict: 'no_action', actions: [], actor: 'mod-a', ...over }) as DecisionInput;

/** A kit over a MemoryStore, keeping the store's concrete type for its raw readers. */
const mk = async () => {
  const store = new MemoryStore();
  return { ...(await world({}, store)), store };
};
const fileOne = (w: Awaited<ReturnType<typeof mk>>) => w.file();

describe('decide: a dismissal with no reason', () => {
  it('a no_action decision with no reason closes the report and stores the standard reason as modNote', async () => {
    const w = await mk();
    const f = await fileOne(w);
    const res = await w.cw.decide(base(f.id));
    expect(res).toMatchObject({ ok: true, replay: false, groups: [] });
    expect(w.store.loadReport(f.id)).toMatchObject({ status: 'dismissed', badFaith: false, modNote: NO_ACTION_DEFAULT_REASON, actionedBy: 'mod-a' });
  });

  it.each(['', '   ', '\n\t '])('a blank or whitespace-only reason (%j) is the same as none for no_action', async (reason) => {
    const w = await mk();
    const f = await fileOne(w);
    const res = await w.cw.decide(base(f.id, { reason }));
    expect(res.ok).toBe(true);
    expect(w.store.loadReport(f.id)?.modNote).toBe(NO_ACTION_DEFAULT_REASON);
  });

  it('a typed reason on no_action is kept exactly as typed (trimmed)', async () => {
    const w = await mk();
    const f = await fileOne(w);
    const res = await w.cw.decide(base(f.id, { reason: '  chat was friendly banter  ' }));
    expect(res.ok).toBe(true);
    expect(w.store.loadReport(f.id)?.modNote).toBe('chat was friendly banter');
  });

  it('no_action that acts on the reporter still needs a reason', async () => {
    const w = await mk();
    const f = await fileOne(w);
    const action = { subject: f.reporter, kind: 'warning' as const, durationMs: null, rule: 2 };
    for (const reason of [undefined, '', '   ']) {
      const input = base(f.id, { actions: [action], ...(reason === undefined ? {} : { reason }) });
      expect(await w.cw.decide(input)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(w.store.loadReport(f.id)?.status).toBe('open');
    expect(w.store.rawSanctions()).toEqual([]);
    // With a reason it works, as before.
    expect((await w.cw.decide(base(f.id, { actions: [action], reason: 'reporter baited the target' }))).ok).toBe(true);
  });

  const needy: Array<[DecisionInput['verdict'], Record<string, unknown>]> = [
    ['upheld', { actions: [{ kind: 'warning', durationMs: null, rule: 2 }] }],
    ['noted', { actions: [{ kind: 'note', durationMs: null, rule: 2 }] }],
    ['bad_faith', { evidence: EVIDENCE }],
  ];
  it.each(needy.flatMap(([verdict, extra]) => [undefined, '', '   '].map((reason) => [verdict, extra, reason] as const)))(
    'upheld, noted and bad_faith refuse an absent or blank reason (%s, %j, %j)',
    async (verdict, extra, reason) => {
      const w = await mk();
      const f = await fileOne(w);
      const actions = (extra.actions as Array<Record<string, unknown>> | undefined)?.map((a) => ({ ...a, subject: f.target })) ?? [];
      const input = base(f.id, { verdict, ...extra, actions, ...(reason === undefined ? {} : { reason }) });
      expect(await w.cw.decide(input)).toEqual({ ok: false, error: 'invalid' });
      expect(w.store.loadReport(f.id)?.status).toBe('open');
      expect(w.store.rawDecisions()).toEqual([]);
    },
  );

  it.each([[5], [null], [{}], [[]], [true], [['x']]])('a reason that is not a string (%j) is invalid for every verdict', async (reason) => {
    const w = await mk();
    const f = await fileOne(w);
    for (const verdict of ['no_action', 'upheld', 'noted', 'bad_faith'] as const) {
      const input = base(f.id, { verdict, reason, ...(verdict === 'bad_faith' ? { evidence: EVIDENCE } : {}) });
      expect(await w.cw.decide(input)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(w.store.loadReport(f.id)?.status).toBe('open');
  });

  it('a reason over 500 characters is still refused, with and without the default', async () => {
    const w = await mk();
    const f = await fileOne(w);
    expect(await w.cw.decide(base(f.id, { reason: 'x'.repeat(DECISION_REASON_MAX + 1) }))).toEqual({ ok: false, error: 'invalid' });
    expect(await w.cw.decide(base(f.id, { reason: `${' '.repeat(DECISION_REASON_MAX + 5)}${'x'.repeat(DECISION_REASON_MAX + 1)}` }))).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(w.store.loadReport(f.id)?.status).toBe('open');
    // A very long blank reason falls back to the default; exactly 500 characters is fine.
    expect((await w.cw.decide(base(f.id, { reason: ' '.repeat(2000) }))).ok).toBe(true);
    const g = await fileOne(w);
    expect((await w.cw.decide(base(g.id, { reason: 'x'.repeat(DECISION_REASON_MAX) }))).ok).toBe(true);
  });

  it('the same dismissal with and without a reason is one decision: the second is a replay', async () => {
    const w = await mk();
    const f = await fileOne(w);
    expect(await w.cw.decide(base(f.id))).toMatchObject({ ok: true, replay: false });
    expect(await w.cw.decide(base(f.id, { reason: 'typed later', actor: 'mod-b' }))).toMatchObject({ ok: true, replay: true });
    expect(w.store.loadReport(f.id)?.modNote).toBe(NO_ACTION_DEFAULT_REASON);
    expect(w.store.rawDecisions()).toHaveLength(1);
    // And the other way round.
    const g = await fileOne(w);
    await w.cw.decide(base(g.id, { reason: 'typed first' }));
    expect(await w.cw.decide(base(g.id))).toMatchObject({ ok: true, replay: true });
    expect(w.store.loadReport(g.id)?.modNote).toBe('typed first');
  });

  it('a reasonless dismissal makes no notice, no sanction and no reporter outcome notice', async () => {
    const w = await mk();
    const f = await fileOne(w);
    await w.cw.decide(base(f.id));
    expect(w.store.rawNotices()).toEqual([]);
    expect(w.store.rawSanctions()).toEqual([]);
    expect(w.cw.notices.pending({ clientKey: 'key-reporter' })).toEqual([]);
  });

  it('a different verdict after a dismissal is already_decided, not a replay', async () => {
    const w = await mk();
    const f = await fileOne(w);
    await w.cw.decide(base(f.id));
    expect(await w.cw.decide(base(f.id, { verdict: 'bad_faith', evidence: EVIDENCE, reason: 'abuse' }))).toEqual({
      ok: false,
      error: 'already_decided',
    });
  });

  it('an unknown report is not_found even with no reason', async () => {
    const w = await mk();
    expect(await w.cw.decide(base('nope'))).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('isDefaultNoActionReason', () => {
  it('matches the constant, trimmed, and nothing else', () => {
    expect(isDefaultNoActionReason(NO_ACTION_DEFAULT_REASON)).toBe(true);
    expect(isDefaultNoActionReason(`  ${NO_ACTION_DEFAULT_REASON}\n`)).toBe(true);
    expect(isDefaultNoActionReason('no action needed')).toBe(false);
    expect(isDefaultNoActionReason('No action needed.')).toBe(false);
    expect(isDefaultNoActionReason('No action needed here')).toBe(false);
    expect(isDefaultNoActionReason('')).toBe(false);
    expect(isDefaultNoActionReason(null)).toBe(false);
    expect(isDefaultNoActionReason(undefined)).toBe(false);
  });
});

describe('decisionKey', () => {
  const subjects = () => new SubjectIndex(new MemoryStore(), { now: () => 1 }, { logger: { warn() {} } });

  it('is the same for a reasonless and a reasoned no_action', () => {
    const s = subjects();
    const a = decisionKey(s, base('r1'));
    expect(decisionKey(s, base('r1', { reason: 'typed' }))).toBe(a);
    expect(decisionKey(s, base('r1', { reason: '   ', actor: 'someone-else' }))).toBe(a);
    expect(decisionKey(s, base('r2'))).not.toBe(a);
  });

  it('throws for a reasonless verdict that needs one', () => {
    expect(() => decisionKey(subjects(), base('r1', { verdict: 'bad_faith', evidence: EVIDENCE }))).toThrow();
  });
});
