import { describe, expect, it } from 'vitest';
import type { MemoryAiStore } from '@chatwarden/store-memory';
import { fakeRead } from '../../src/ai/fake.js';
import type { FakeStep } from '../../src/ai/fake.js';
import type { AIExample, AIReadInput } from '../../src/ai/types.js';
import type { AiOutcomeInsert, ConductLevel } from '../../src/types.js';
import { aiWorld, DAY, NOW } from './aiWorld.js';
import type { AiWorld } from './aiWorld.js';

// The casebook: decided cases that taught the AI. Examples are pseudonymised, at most two, only from 30 teachable rows, and never
// from a bad-faith, reversed or "don't teach" decision.

const ownRef = (input: AIReadInput): string => input.lines.find((l) => l.who === 'P1')?.ref ?? 'L1';
const rudeUpheld = (input: AIReadInput): FakeStep => ({
  output: fakeRead(input, {
    severity: 'rude',
    rule: 2,
    evidence: [ownRef(input)],
    recommendation: { verdict: 'upheld', severity: 'rude', rule: 2, evidence: [ownRef(input)] },
  }),
});
const store = (w: AiWorld): MemoryAiStore => w.store as MemoryAiStore;

const example = (n: number): AIExample => ({ rule: 2, severity: 'rude', verdict: 'upheld', lines: [{ who: 'P1', text: `seed words ${n}` }] });
const outcome = (n: number, over: Partial<AiOutcomeInsert> = {}): AiOutcomeInsert => ({
  reportId: `seed-${n}`,
  readId: null,
  decidedAt: NOW - n * 1000,
  level: 2,
  verdict: 'upheld',
  rule: '2',
  severity: 'rude',
  aiVerdict: 'upheld',
  agreement: 'agree',
  detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
  badFaith: false,
  example: example(n),
  ...over,
});
const seed = (w: AiWorld, count: number, over: (n: number) => Partial<AiOutcomeInsert> = () => ({})): void => {
  for (let n = 1; n <= count; n += 1) store(w).insertAiOutcome(outcome(n, over(n)));
};

/** File a report for rule 2 (harassment), read it, and decide it as the AI recommended. */
async function decided(w: AiWorld, o: { verdict?: 'upheld' | 'no_action'; accepted?: boolean; severity?: ConductLevel } = {}) {
  const r = await w.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
  await w.idle();
  const view = w.cw.ai.read(r.id);
  const lineIds = view?.recommendation?.evidenceLineIds ?? [];
  const verdict = o.verdict ?? 'upheld';
  // The step the AI pre-filled: a one-click accepts exactly this.
  const step = view?.recommendation?.step;
  await w.cw.decide({
    reportId: r.id,
    verdict,
    actions: verdict === 'upheld' ? [{ subject: r.target, kind: step?.kind ?? 'warning', durationMs: step?.durationMs ?? null, rule: 2, lineIds }] : [],
    reason: verdict === 'upheld' ? 'rude' : undefined,
    actor: 'mod_ann',
    ai: { readId: view?.id ?? 'x', accepted: o.accepted ?? false, role: 'moderator', ...(o.severity === undefined ? {} : { severity: o.severity }) },
  });
  return r;
}

describe('what a decision teaches', () => {
  it('an agreeing decision stores an example: aliases only, at most 6 lines', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    const r = await decided(w);
    const row = store(w).loadAiOutcome(r.id);
    expect(row?.example).not.toBeNull();
    expect(row?.example).toMatchObject({ rule: 2, severity: 'rude', verdict: 'upheld' });
    expect(row?.example?.lines.length).toBeGreaterThan(0);
    expect(row?.example?.lines.length).toBeLessThanOrEqual(6);
  });

  it('example lines hold aliases only, at most 6, and nothing that identifies anyone', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    const t = w.table({ reporter: 'key-many-lines' });
    for (let i = 0; i < 12; i += 1) {
      w.clock.t += 6000;
      w.cw.chat.accept(t.room, 'p2', i === 3 ? 'send zorbak to tarvo@example.org now' : `line number ${i} from the target`);
    }
    w.clock.t += 6000;
    w.cw.chat.accept(t.room, 'p1', 'please stop');
    w.clock.t += 1000;
    const res = await w.submit(t.room, { reason: 'harassment' });
    if (!res.ok) throw new Error('refused');
    await w.idle();
    const view = w.cw.ai.read(res.reportId);
    await w.cw.decide({
      reportId: res.reportId,
      verdict: 'upheld',
      actions: [{ subject: t.target, kind: 'warning', durationMs: null, rule: 2, lineIds: view?.recommendation?.evidenceLineIds ?? [] }],
      reason: 'rude',
      actor: 'mod_ann',
      ai: { readId: view?.id ?? 'x', accepted: false, role: 'moderator' },
    });
    const ex = store(w).loadAiOutcome(res.reportId)?.example;
    expect(ex?.lines.length).toBeLessThanOrEqual(6);
    for (const line of ex?.lines ?? []) expect(line.who).toMatch(/^P\d+$/);
    const blob = JSON.stringify(ex);
    for (const secret of [res.reportId, t.room, t.target, t.reporter, 'Tgt', 'Rep', 'tarvo@example.org']) expect(blob).not.toContain(secret);
    // The line the human cited is among the ones kept.
    expect(ex?.lines.some((l) => l.who === 'P1')).toBe(true);
  });

  it('a bad-faith, reversed or dont-teach row is not an example', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    const good = await decided(w);
    const bad = await w.report(['you are trash'], { reason: 'harassment' });
    await w.idle();
    await w.cw.decide({ reportId: bad.id, verdict: 'bad_faith', actions: [], evidence: 'same report in many rooms', reason: 'abuse', actor: 'mod_ann', ai: { readId: w.cw.ai.read(bad.id)?.id ?? 'x', accepted: false, role: 'moderator' } });
    const reversed = await decided(w);
    const untaught = await decided(w);
    expect(w.cw.ai.markReversed(reversed.id)).toBe(true);
    expect(w.cw.ai.dontTeach(untaught.id)).toBe(true);
    expect(store(w).loadAiOutcome(bad.id)?.example).toBeNull();
    expect(store(w).loadAiOutcome(reversed.id)?.example).toBeNull();
    expect(store(w).loadAiOutcome(untaught.id)?.example).toBeNull();
    const teachable = store(w).aiExamples('2', 'rude', 10, 0).map((e) => e.reportId);
    expect(teachable).toEqual([good.id]);
    expect(store(w).aiTeachableCount(0)).toBe(1);
  });

  it('markReversed excludes an example and counts as an ai false positive', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    const r = await decided(w);
    expect(w.cw.ai.stats({ since: 0 })).toMatchObject({ decided: 1, falsePositives: 0 });
    expect(store(w).aiExamples('2', 'rude', 10, 0)).toHaveLength(1);
    expect(w.cw.ai.markReversed(r.id)).toBe(true);
    expect(store(w).aiExamples('2', 'rude', 10, 0)).toHaveLength(0);
    expect(w.cw.ai.stats({ since: 0 })).toMatchObject({ decided: 1, falsePositives: 1 });
    // Idempotent, and unknown reports are false.
    expect(w.cw.ai.markReversed(r.id)).toBe(true);
    expect(w.cw.ai.markReversed('no-such-report')).toBe(false);
    expect(w.cw.ai.dontTeach('no-such-report')).toBe(false);
  });

  it('the one-click rate cannot exceed 1: a forged accepted flag on overrides and nones adds nothing', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    await decided(w, { verdict: 'no_action', accepted: true });
    await decided(w, { verdict: 'no_action', accepted: true });
    await decided(w, { accepted: true });
    const stats = w.cw.ai.stats({ since: 0 });
    expect(stats.oneClick).toBe(1);
    expect(stats.oneClickRate).toBeLessThanOrEqual(1);
    expect(stats.oneClickRate).toBeCloseTo(1 / 3, 5);
  });

  it('a none (no recommendation shown) teaches nothing', async () => {
    const w = await aiWorld({ level: 1, script: rudeUpheld });
    const r = await decided(w);
    expect(store(w).loadAiOutcome(r.id)).toMatchObject({ agreement: 'none', example: null });
  });

  it('a human override is an example, labelled with the human verdict', async () => {
    const noAction = (input: AIReadInput): FakeStep => ({
      output: fakeRead(input, { severity: 'banter', rule: null, evidence: [], recommendation: { verdict: 'no_action', severity: 'banter', rule: null, evidence: [] } }),
    });
    const w = await aiWorld({ level: 2, script: noAction });
    const r = await decided(w, { severity: 'rude' });
    const row = store(w).loadAiOutcome(r.id);
    expect(row).toMatchObject({ agreement: 'override', aiVerdict: 'no_action', verdict: 'upheld', severity: 'rude' });
    expect(row?.example).toMatchObject({ rule: 2, severity: 'rude', verdict: 'upheld' });
  });

  it('a dismissal names no rule of its own: the row is filed under the rule the AI cited, and teaches nothing', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    const r = await decided(w, { verdict: 'no_action' });
    expect(store(w).loadAiOutcome(r.id)).toMatchObject({ agreement: 'override', verdict: 'no_action', severity: 'banter', rule: '2', example: null });
  });

  it('a false positive lands on the rule the AI cited, the AI rule null falls back to the reason, then to none, and uncovered stays', async () => {
    const stats = async (script: (i: AIReadInput) => FakeStep, reason: string | null) => {
      const w = await aiWorld({ level: 2, script });
      const r = await w.report(['you are trash'], reason === null ? {} : { reason });
      await w.idle();
      await w.cw.decide({ reportId: r.id, verdict: 'no_action', actions: [], actor: 'mod_ann', ai: { readId: w.cw.ai.read(r.id)?.id ?? 'x', accepted: false, role: 'moderator' } });
      return w.cw.ai.stats({ since: 0 }).rules;
    };
    const upheldUnder = (rule: number | 'uncovered' | null) => (input: AIReadInput): FakeStep => ({
      output: fakeRead(input, { severity: 'rude', rule, evidence: [ownRef(input)], recommendation: { verdict: 'upheld', severity: 'rude', rule, evidence: [ownRef(input)] } }),
    });
    expect(await stats(upheldUnder(2), 'harassment')).toEqual([{ rule: 2, decided: 1, agree: 0, override: 1, none: 0, falsePositives: 1, oneClick: 0 }]);
    // The AI named no rule: the reason's first rule (harassment is rule 2).
    expect(await stats(upheldUnder(null), 'harassment')).toMatchObject([{ rule: 2, falsePositives: 1 }]);
    // The AI named no rule and the reason maps to none: no rule.
    expect(await stats(upheldUnder(null), null)).toMatchObject([{ rule: null, falsePositives: 1 }]);
    expect(await stats(upheldUnder('uncovered'), 'harassment')).toMatchObject([{ rule: 'uncovered', falsePositives: 1 }]);
  });

  it('with no echo a decision teaches nothing, even when it agrees', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    const r = await w.report(['you are trash'], { reason: 'harassment' });
    await w.idle();
    const view = w.cw.ai.read(r.id);
    const step = view?.recommendation?.step;
    await w.cw.decide({
      reportId: r.id,
      verdict: 'upheld',
      actions: [{ subject: r.target, kind: step?.kind ?? 'warning', durationMs: step?.durationMs ?? null, rule: 2, lineIds: view?.recommendation?.evidenceLineIds ?? [] }],
      reason: 'rude',
      actor: 'mod_ann',
    });
    expect(store(w).loadAiOutcome(r.id)).toMatchObject({ agreement: 'agree', example: null });
    expect(store(w).aiTeachableCount(0)).toBe(0);
  });

  it('learn off: no example text is stored or sent', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    seed(w, 40);
    w.cw.policy.save({ ai: { learn: false } }, { version: 0, actor: 'owner_ann', reason: 'no learning' });
    const r = await decided(w);
    expect(store(w).loadAiOutcome(r.id)?.example).toBeNull();
    expect(w.adapter.calls.at(-1)?.examples).toEqual([]);
    expect(store(w).loadAiRead(r.id)?.exampleIds).toEqual([]);
  });

  it('aiExamplesMs 0: no example text is stored or sent', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld, over: { retention: { aiExamplesMs: 0, everyMs: 2_000_000_000 } } });
    seed(w, 40);
    const r = await decided(w);
    expect(store(w).loadAiOutcome(r.id)?.example).toBeNull();
    expect(w.adapter.calls.at(-1)?.examples).toEqual([]);
  });
});

describe('what the AI is shown', () => {
  it('examples need 30 teachable rows', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    seed(w, 29);
    const a = await w.report(['you are trash'], { reason: 'harassment' });
    await w.idle();
    expect(w.adapter.calls.at(-1)?.examples).toEqual([]);
    expect(store(w).loadAiRead(a.id)?.exampleIds).toEqual([]);
    store(w).insertAiOutcome(outcome(30));
    const b = await w.report(['you are trash'], { reason: 'harassment' });
    await w.idle();
    expect(w.adapter.calls.at(-1)?.examples).toHaveLength(2);
    expect(store(w).loadAiRead(b.id)?.exampleIds).toEqual(['seed-1', 'seed-2']);
  });

  it('a report with no reason, or a reason with no rule, gets no examples', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    seed(w, 40);
    await w.report(['you are trash']);
    await w.report(['you are trash'], { reason: 'other' });
    await w.idle();
    for (const call of w.adapter.calls) expect(call.examples).toEqual([]);
  });

  it('at most two, same rule and severity, newest first', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    seed(w, 30);
    // Other rule, other severity, and a bad-faith row: none of them qualify for a rude rule-2 case.
    store(w).insertAiOutcome(outcome(100, { rule: '3', decidedAt: NOW + 10 * 1000 }));
    store(w).insertAiOutcome(outcome(101, { severity: 'hostile', decidedAt: NOW + 20 * 1000 }));
    store(w).insertAiOutcome(outcome(102, { badFaith: true, decidedAt: NOW + 30 * 1000 }));
    // A first read does not know the severity yet: it takes the newest of the rule. Here that is the hostile one...
    const first = await w.report(['you are trash'], { reason: 'harassment' });
    await w.idle();
    expect(store(w).loadAiRead(first.id)?.exampleIds).toEqual(['seed-101', 'seed-1']);
    // ...a re-read knows the AI said rude, and takes the same severity only.
    w.clock.t += 60_000;
    await w.cw.reports.addDetail(first.id, 'p1', { note: 'it went on for a while' });
    await w.idle();
    const rows = store(w).loadAiRead(first.id);
    expect(rows?.exampleIds).toEqual(['seed-1', 'seed-2']);
    // Newest first: seed-1 was decided after seed-2.
    expect(w.adapter.calls.at(-1)?.examples.map((e) => e.lines[0]?.text)).toEqual(['seed words 1', 'seed words 2']);
  });

  it('examples reach the adapter with no id, and do not change the input hash', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    seed(w, 30);
    const r = await w.report(['you are trash'], { reason: 'harassment' });
    await w.idle();
    const call = w.adapter.calls.at(-1) as AIReadInput;
    expect(call.examples).toHaveLength(2);
    expect(JSON.stringify(call)).not.toContain('seed-1');
    expect(call.prompt.variable).toContain('example: ');
    // The read is not stale because the casebook grew: the examples are not in the hash.
    store(w).insertAiOutcome(outcome(500, { decidedAt: NOW + 5 }));
    expect(w.cw.ai.read(r.id)?.stale).toBe(false);
  });

  it('examples older than the retention window are not used', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    seed(w, 40, () => ({ decidedAt: NOW - 400 * DAY }));
    await w.report(['you are trash'], { reason: 'harassment' });
    await w.idle();
    expect(w.adapter.calls.at(-1)?.examples).toEqual([]);
  });

  it('a store that fails when asked for examples does not stop the read', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    (store(w) as unknown as Record<string, unknown>).aiTeachableCount = () => {
      throw new Error('gone');
    };
    const r = await w.report(['you are trash'], { reason: 'harassment' });
    await w.idle();
    expect(w.cw.ai.read(r.id)).not.toBeNull();
  });
});

describe('stats', () => {
  it('stats: per-rule agree, override, false positives, one-click rate', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    await decided(w, { accepted: true }); // agree, one click
    await decided(w, { accepted: false }); // agree
    await decided(w, { verdict: 'no_action' }); // override (and a false positive: the AI said upheld)
    const stats = w.cw.ai.stats({ since: 0 });
    expect(stats).toMatchObject({ decided: 3, agree: 2, override: 1, none: 0, falsePositives: 1, oneClick: 1 });
    expect(stats.agreementRate).toBeCloseTo(2 / 3, 5);
    expect(stats.oneClickRate).toBeCloseTo(1 / 3, 5);
    expect(stats.falsePositiveRate).toBeCloseTo(1 / 3, 5);
    // The dismissal is filed under the rule the AI cited, so the false positive is on rule 2.
    expect(stats.rules).toEqual([{ rule: 2, decided: 3, agree: 2, override: 1, none: 0, falsePositives: 1, oneClick: 1 }]);
  });

  it('has no rates before any decision, and respects the window', async () => {
    const w = await aiWorld({ level: 2, script: rudeUpheld });
    expect(w.cw.ai.stats({ since: 0 })).toMatchObject({ decided: 0, agreementRate: null, oneClickRate: null, falsePositiveRate: null, rules: [] });
    await decided(w);
    expect(w.cw.ai.stats({ since: w.clock.t + 1 })).toMatchObject({ decided: 0 });
    expect(w.cw.ai.stats()).toMatchObject({ decided: 1 });
  });
});
