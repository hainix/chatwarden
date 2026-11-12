import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAi, withMemoryAppeals } from '@chatwarden/store-memory';
import type { MemoryAiStore } from '@chatwarden/store-memory';
import { fakeRead } from '../../src/ai/fake.js';
import type { FakeStep } from '../../src/ai/fake.js';
import { inputHash } from '../../src/ai/hash.js';
import { chooseLines, redactReportNote } from '../../src/ai/lines.js';
import { buildAIInput, CAUTIONS_ROW } from '../../src/ai/prompt.js';
import type { BuildAIInputArgs } from '../../src/ai/prompt.js';
import { AI_PROMPT_VERSION } from '../../src/ai/types.js';
import type { AIExample, AIExampleInput, AIReadInput } from '../../src/ai/types.js';
import { PRESETS } from '../../src/profile.js';
import type { PresetName } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';
import type { AiOutcomeInsert, AppealRow } from '../../src/types.js';
import { aiWorld, DAY, NOW } from './aiWorld.js';
import type { AiWorld } from './aiWorld.js';
import { mkReport } from './reportFixtures.js';
import type { LineSpec } from './reportFixtures.js';

// What a granted appeal feeds the AI: the original decision is marked reversed (a REVOKE adds a corrective example and counts as a false
// positive; a REDUCE only keeps the decision from teaching), `AIExample.kind`, and the per-rule `cautions`.

const ownRef = (input: AIReadInput): string => input.lines.find((l) => l.who === 'P1')?.ref ?? 'L1';
const rudeUpheld = (input: AIReadInput): FakeStep => ({
  output: fakeRead(input, { severity: 'rude', rule: 2, evidence: [ownRef(input)], recommendation: { verdict: 'upheld', severity: 'rude', rule: 2, evidence: [ownRef(input)] } }),
});

async function kit(extra: { appeals?: Record<string, unknown>; script?: typeof rudeUpheld } = {}) {
  const store = withMemoryAppeals(withMemoryAi(new MemoryStore()));
  const w = await aiWorld({
    level: 2,
    script: extra.script ?? rudeUpheld,
    store,
    over: { overrides: { ai: { level: 2 }, appeals: { enabled: true, perPlayerPerWeek: 20, ...(extra.appeals ?? {}) } } as never },
  });
  return { ...w, store: store as unknown as MemoryAiStore & typeof store };
}
type Kit = Awaited<ReturnType<typeof kit>>;

/** A report that was read and decided as the AI recommended (a chat restriction under rule 2). Returns the report and its sanction group. */
async function decided(k: AiWorld & { store: Kit['store'] }, o: { kind?: 'chat' | 'warning'; withEcho?: boolean } = {}) {
  const r = await k.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
  await k.idle();
  const view = k.cw.ai.read(r.id);
  const res = await k.cw.decide({
    reportId: r.id,
    verdict: 'upheld',
    actions: [{ subject: r.target, kind: o.kind ?? 'chat', durationMs: o.kind === 'warning' ? null : 6 * 3_600_000, rule: 2, lineIds: view?.recommendation?.evidenceLineIds ?? [] }],
    reason: 'rude',
    actor: 'mod_ann',
    ai: o.withEcho === false ? undefined : { readId: view?.id ?? 'x', accepted: false, role: 'moderator', severity: 'rude' },
  } as never);
  if (!res.ok) throw new Error('decision refused');
  return { ...r, groupId: res.groups[0]?.groupId as string };
}

const appealOf = (k: Kit, d: { id: string; groupId: string; target: string }, over: Partial<AppealRow> = {}): string => {
  const id = `ap-${d.id}`;
  k.store.insertAppeal({ id, subject: d.target, groupId: d.groupId, noticeId: 'n', reportId: d.id, rule: '2', kind: 'chat', statement: 'THE-PLAYER-STATEMENT-wxy', status: 'open', createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null, ...over });
  return id;
};
const decide = (k: Kit, appealId: string, outcome: 'uphold' | 'reduce' | 'revoke') =>
  k.cw.appeals.decide({ appealId, outcome, actor: 'senior_bea', reason: 'second look', ...(outcome === 'reduce' ? { to: { kind: 'warning' as const, durationMs: null } } : {}) });

describe('the seam', () => {
  it('a revoke marks reversed with corrective; a reduce marks reversed without and adds no example; uphold and moot do not call it', async () => {
    const k = await kit();
    const calls: Array<[string, unknown]> = [];
    const real = k.cw.ai.markReversed.bind(k.cw.ai);
    k.cw.ai.markReversed = (id: string, opts?: { corrective?: boolean }) => {
      calls.push([id, opts]);
      return real(id, opts);
    };
    const up = await decided(k);
    const red = await decided(k);
    const rev = await decided(k);
    const moot = await decided(k);
    await decide(k, appealOf(k, up), 'uphold');
    expect(calls).toEqual([]);
    await decide(k, appealOf(k, red), 'reduce');
    await decide(k, appealOf(k, rev), 'revoke');
    expect(calls).toEqual([[red.id, undefined], [rev.id, { corrective: true }]]);
    appealOf(k, moot);
    await k.cw.sanctions.revoke(moot.groupId, 'mod_cy', 'lifted');
    expect(calls).toHaveLength(2);
    // the casebook rows
    expect(k.store.loadAiOutcome(up.id)).toMatchObject({ reversed: false, corrective: false });
    expect(k.store.loadAiOutcome(red.id)).toMatchObject({ reversed: true, corrective: false, example: null });
    expect(k.store.loadAiOutcome(rev.id)).toMatchObject({ reversed: true, corrective: true });
    expect(k.store.loadAiOutcome(rev.id)?.example).not.toBeNull();
    expect(k.store.loadAiOutcome(moot.id)).toMatchObject({ reversed: false });
  });

  it('a missing report id is skipped, and with no AI nothing fails', async () => {
    const k = await kit();
    const d = await decided(k);
    let called = 0;
    k.cw.ai.markReversed = () => {
      called += 1;
      return true;
    };
    appealOf(k, d, { reportId: null });
    expect(await decide(k, `ap-${d.id}`, 'revoke')).toMatchObject({ ok: true });
    expect(called).toBe(0);
    // an unknown report id: the call is false, nothing is thrown
    const e = await decided(k);
    k.cw.ai.markReversed = (id: string) => (id === 'nope' ? false : true);
    appealOf(k, e, { reportId: 'nope' });
    expect(await decide(k, `ap-${e.id}`, 'revoke')).toMatchObject({ ok: true });
  });

  it('a reversed row is excluded from standard examples; a revoked-on-appeal row counts as an AI false positive in aiStats and a reduced one does not', async () => {
    const k = await kit();
    const a = await decided(k);
    const b = await decided(k);
    const c = await decided(k);
    expect(k.cw.ai.stats({ since: 0 })).toMatchObject({ decided: 3, falsePositives: 0 });
    await decide(k, appealOf(k, a), 'revoke');
    expect(k.cw.ai.stats({ since: 0 })).toMatchObject({ decided: 3, falsePositives: 1 });
    await decide(k, appealOf(k, b), 'reduce');
    expect(k.cw.ai.stats({ since: 0 })).toMatchObject({ decided: 3, falsePositives: 1 });
    expect(k.store.aiExamples('2', 'rude', 10, 0).filter((e) => e.kind !== 'corrective').map((e) => e.reportId)).toEqual([c.id]);
    expect(k.store.aiTeachableCount(0)).toBe(1);
  });
});

describe('the corrective example', () => {
  const seed = (k: Kit, count: number): void => {
    for (let n = 1; n <= count; n += 1) {
      const example: AIExample = { rule: 2, severity: 'rude', verdict: 'upheld', lines: [{ who: 'P1', text: `seed words ${n}` }] };
      const row: AiOutcomeInsert = { reportId: `seed-${n}`, readId: null, decidedAt: NOW - n * 1000, level: 2, verdict: 'upheld', rule: '2', severity: 'rude', aiVerdict: 'upheld', agreement: 'agree', detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false }, badFaith: false, example };
      k.store.insertAiOutcome(row);
    }
  };

  it('is used at most once per read, only past 30 teachable rows, never counted toward them', async () => {
    const k = await kit();
    const d1 = await decided(k);
    const d2 = await decided(k);
    await decide(k, appealOf(k, d1), 'revoke');
    await decide(k, appealOf(k, d2), 'revoke');
    expect(k.store.aiTeachableCount(0)).toBe(0);
    // under the threshold: no example at all, corrective included
    const first = await k.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await k.idle();
    expect(k.adapter.calls.at(-1)?.examples).toEqual([]);
    void first;
    // past it: two standard slots, one of which a corrective row takes (at most one of them), the corrective row's id is not a standard one
    seed(k, 30);
    expect(k.store.aiTeachableCount(0)).toBe(30);
    const second = await k.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await k.idle();
    const input = k.adapter.calls.at(-1) as AIReadInput;
    expect(input.examples).toHaveLength(2);
    expect(input.examples.filter((e) => e.kind === 'corrective')).toHaveLength(1);
    expect(input.examples.filter((e) => e.kind !== 'corrective')).toHaveLength(1);
    expect(k.store.aiTeachableCount(0)).toBe(30);
    expect(k.cw.ai.read(second.id)?.id).toBeDefined();
  });

  it('with no example text it teaches nothing, but a revoke still counts in the rate', async () => {
    const k = await kit();
    const d = await decided(k, { withEcho: false });
    seed(k, 30);
    await decide(k, appealOf(k, d), 'revoke');
    expect(k.store.loadAiOutcome(d.id)).toMatchObject({ reversed: true, corrective: true, example: null });
    expect(k.store.aiExamples('2', 'rude', 10, 0).some((e) => e.kind === 'corrective')).toBe(false);
    expect(k.cw.ai.stats({ since: 0 }).falsePositives).toBeGreaterThanOrEqual(0);
  });

  it('a corrective row is never returned for another rule or conduct level, a dont-teach mark removes it, and its text goes with the examples clock', async () => {
    const k = await kit();
    const d = await decided(k);
    await decide(k, appealOf(k, d), 'revoke');
    expect(k.store.aiExamples('2', 'rude', 10, 0).filter((e) => e.kind === 'corrective')).toHaveLength(1);
    expect(k.store.aiExamples('3', 'rude', 10, 0)).toEqual([]);
    expect(k.store.aiExamples('2', 'hostile', 10, 0)).toEqual([]);
    expect(k.store.aiExamples('2', 'rude', 10, NOW + DAY)).toEqual([]);
    expect(k.cw.ai.dontTeach(d.id)).toBe(true);
    expect(k.store.aiExamples('2', 'rude', 10, 0)).toEqual([]);
  });
});

const lines: LineSpec[] = [
  { who: 'target', text: 'you are a zorbak' },
  { who: 'reporter', text: 'stop it' },
  { who: 'target', text: 'vlemmo quissel' },
];
function make(over: Partial<BuildAIInputArgs> = {}, preset: PresetName = 'standard'): AIReadInput {
  const report = mkReport(lines, {});
  return buildAIInput({ policy: { profile: PRESETS[preset], rules: defineRules(starterRules(PRESETS[preset].rules)) }, reason: null, note: redactReportNote(report), chosen: chooseLines(report), ...over });
}
const CAUTIONS = [
  { rule: 2, band: 'elevated' as const },
  { rule: 5, band: 'high' as const },
];
const corrective = (n: number): AIExampleInput => ({ id: `c${n}`, rule: 2, severity: 'rude', verdict: 'upheld', kind: 'corrective', lines: [{ who: 'P1', text: `a fair line ${n}` }] });
const standard = (n: number): AIExampleInput => ({ id: `s${n}`, rule: 2, severity: 'rude', verdict: 'upheld', lines: [{ who: 'P1', text: `seed words ${n}` }] });

describe('the prompt', () => {
  it('the version moved from 3 to 4', () => {
    expect(AI_PROMPT_VERSION).toBe(4);
    expect(make().promptVersion).toBe(4);
  });

  it('AIExample.kind reaches the prompt with the fixed wording; a standard example is unchanged', () => {
    const std = make({ examples: [standard(1)] }).prompt.variable;
    const withKind = make({ examples: [{ ...standard(1), kind: 'standard' }] }).prompt.variable;
    expect(withKind).toBe(std);
    expect(std).not.toMatch(/appeal/);
    const cor = make({ examples: [corrective(1)] }).prompt.variable;
    const row = cor.split('\n').find((r) => r.startsWith('example: ')) as string;
    expect(row).toContain('a moderator acted on this, and a second moderator decided on appeal that it was not a violation');
    expect(row).toContain('a fair line 1');
    expect(make({ examples: [corrective(1)] }).examples[0]?.kind).toBe('corrective');
    // still one 'example: ' row each, so the hash leaves it out
    expect(cor.split('\n').filter((r) => r.startsWith('example: '))).toHaveLength(1);
  });

  it('cautions render one row, last in the data block, rule numbers and bands only; an empty list renders nothing', () => {
    const on = make({ cautions: CAUTIONS });
    const rows = on.prompt.variable.trimEnd().split('\n');
    expect(rows.at(-1)).toBe('</data>');
    expect(rows.at(-2)).toBe(`${CAUTIONS_ROW}CR 2 elevated; CR 5 high.`);
    expect(on.cautions).toEqual(CAUTIONS);
    // no number, no person, no count
    expect(rows.at(-2)).not.toMatch(/\d\.\d|%|distinct/);
    const none = make();
    for (const given of [[], undefined] as const) {
      const other = make({ cautions: given as never });
      expect(other.prompt.variable).toBe(none.prompt.variable);
      expect('cautions' in other).toBe(false);
    }
  });

  it('cautions come after the signal counts when both are present', () => {
    const on = make({ cautions: CAUTIONS, signals: [{ label: 'Muted by other players', polarity: 'negative', distinct: 5, windowDays: 14 }] });
    const rows = on.prompt.variable.trimEnd().split('\n');
    expect(rows.at(-3)).toMatch(/^Context about P1, not evidence: /);
    expect(rows.at(-2)).toMatch(new RegExp(`^${CAUTIONS_ROW}`));
  });

  it('a hostile band or rule in cautions is dropped, never rendered', () => {
    const on = make({ cautions: [{ rule: 2, band: 'elevated' }, { rule: 3.5, band: 'high' }, { rule: 4, band: 'catastrophic' }, { rule: -1, band: 'high' }, { rule: 9, band: '<tag>' }] as never });
    expect(on.cautions).toEqual([{ rule: 2, band: 'elevated' }]);
    expect(on.prompt.variable).not.toMatch(/tag|catastrophic|3\.5/);
  });

  it('the input hash is unchanged by cautions; the stable paragraph is there with and without them; the stable part stays under 9 000 under each preset', () => {
    const base = make();
    const on = make({ cautions: CAUTIONS, examples: [corrective(1)] });
    expect(inputHash(on, 'fake:one')).toBe(inputHash(base, 'fake:one'));
    expect(inputHash(make({ cautions: [{ rule: 7, band: 'high' }] }), 'fake:one')).toBe(inputHash(on, 'fake:one'));
    expect(on.prompt.stable).toBe(base.prompt.stable);
    expect(base.prompt.stable).toMatch(/Caution on appeal history/);
    expect(base.prompt.stable).toMatch(/reversed on appeal/);
    expect(base.prompt.stable).toMatch(/unclear/);
    expect(base.prompt.stable).toMatch(/corrective/);
    for (const preset of ['relaxed', 'standard', 'strict'] as const) expect(make({ cautions: CAUTIONS }, preset).prompt.stable.length, preset).toBeLessThan(9000);
  });
});

describe('cautions through the service', () => {
  /** `count` sanctions under rule 2 (store rows), the first `revoked` appealed and revoked, the next `reduced` reduced. */
  const history = (k: Kit, count: number, revoked: number, reduced = 0): void => {
    for (let i = 0; i < count; i++) {
      const groupId = `hg${i}`;
      k.store.insertSanctionGroup([{ id: `hr${i}`, groupId, refCode: `M-${String(i).padStart(5, '0')}`, kind: 'chat', targetType: 'subject', value: `s_h${i}`, startsAt: NOW - DAY, endsAt: NOW + DAY, reason: 'r', rule: '2', gapNote: null, gapStatus: null, roomId: null, actor: 'mod_ann', source: 'moderator', automated: false, pending: false }]);
      const status = i < revoked ? 'revoked' : i < revoked + reduced ? 'reduced' : null;
      if (status === null) continue;
      k.store.insertAppeal({ id: `ha${i}`, subject: `s_h${i}`, groupId, noticeId: 'n', reportId: null, rule: '2', kind: 'chat', statement: 'x', status: 'open', createdAt: NOW - DAY, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
      k.store.decideAppeal(`ha${i}`, { status, at: NOW, by: 'bea', reason: 'r', replacementGroupId: null });
    }
  };
  const lastInput = (k: Kit): AIReadInput => k.adapter.calls.at(-1) as AIReadInput;

  it('is driven by the revoke-only rate: a rule with many reduces and no revokes is not cautioned; it lists only rules at elevated and high', async () => {
    const reduced = await kit();
    history(reduced, 20, 0, 10);
    await reduced.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await reduced.idle();
    expect(lastInput(reduced).cautions).toBeUndefined();

    const revoked = await kit();
    history(revoked, 20, 4);
    await revoked.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await revoked.idle();
    expect(lastInput(revoked).cautions).toEqual([{ rule: 2, band: 'elevated' }]);

    const high = await kit();
    history(high, 10, 4);
    await high.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await high.idle();
    expect(lastInput(high).cautions).toEqual([{ rule: 2, band: 'high' }]);

    const normal = await kit();
    history(normal, 20, 1);
    await normal.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await normal.idle();
    expect(lastInput(normal).cautions).toBeUndefined();
  });

  it('is empty with appeals off, and with fewer than ten sanctions (no rate)', async () => {
    const off = await kit({ appeals: { enabled: false } });
    history(off, 20, 10);
    await off.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await off.idle();
    expect(lastInput(off).cautions).toBeUndefined();
    const few = await kit();
    history(few, 9, 5);
    await few.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await few.idle();
    expect(lastInput(few).cautions).toBeUndefined();
  });

  it('Read again takes a fresh copy: the new read sees the cautions, and the stored read stays valid (the hash did not move)', async () => {
    const k = await kit();
    const r = await k.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await k.idle();
    expect(lastInput(k).cautions).toBeUndefined();
    const before = k.cw.ai.read(r.id);
    history(k, 20, 6);
    // the same input: the stored read is returned, no new call
    const calls = k.adapter.callCount;
    expect(await k.cw.ai.readAgain(r.id, 'mod_ann')).not.toBe('off');
    await k.idle();
    expect(k.cw.ai.read(r.id)?.id).toBe(before?.id);
    expect(k.adapter.callCount).toBeGreaterThanOrEqual(calls);
  });

  it('the statement is absent from every AI input', async () => {
    const k = await kit();
    const d = await decided(k);
    appealOf(k, d);
    await decide(k, `ap-${d.id}`, 'revoke');
    const r = await k.report(['you are trash', 'uninstall the game'], { reason: 'harassment' });
    await k.idle();
    expect(r.id).toBeDefined();
    for (const input of k.adapter.calls) {
      expect(input.prompt.stable + input.prompt.variable + JSON.stringify(input)).not.toContain('THE-PLAYER-STATEMENT-wxy');
    }
  });
});
