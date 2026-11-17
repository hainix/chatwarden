import { MemoryStore, withMemoryAi, withMemorySignals } from '@chatwarden/store-memory';
import type { MemoryAiStore } from '@chatwarden/store-memory';
import { describe, expect, it } from 'vitest';
import { confirmAgrees } from '../../src/ai/confirm.js';
import { createFakeModerationAI, fakeRead } from '../../src/ai/fake.js';
import type { FakeStep } from '../../src/ai/fake.js';
import { AIError, AI_CONFIRM_PROMPT_VERSION, AI_PROMPT_VERSION } from '../../src/ai/types.js';
import type { AIRead, AIReadInput } from '../../src/ai/types.js';
import type { AiService } from '../../src/ai/service.js';
import { aiWorld, DAY, MIN } from './aiWorld.js';
import type { AiWorld } from './aiWorld.js';

// The confirming read (design 3 ruling 8, 4.1, 6.3): before the AI would act, a second, clean read looks for the innocent reading. It is its own row (the purpose is in the
// input hash and the prompt version differs), it is reserved, called, validated and stored like a read, it costs against the same daily caps, and it never changes what the case
// shows. Nothing here acts on a person: this file tests the read and the agreement, the planner is in act-plan.test.ts.

const store = (w: AiWorld): MemoryAiStore => w.store as MemoryAiStore;
const svc = (w: AiWorld): AiService => w.cw.ai as unknown as AiService;
const ownRef = (input: AIReadInput): string => input.lines.find((l) => l.who === 'P1')?.ref ?? 'L1';
const upheld =
  (over: Partial<AIRead> = {}) =>
  (input: AIReadInput): FakeStep => ({
    output: fakeRead(input, { severity: 'hostile', rule: 2, confidence: 'high', evidence: [ownRef(input)], recommendation: { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: [ownRef(input)] }, ...over }),
  });

/** A kit at level 2 whose adapter answers every call, read or confirm, with `upheld`. */
const world = (o: Parameters<typeof aiWorld>[0] = {}) => aiWorld({ level: 2, script: upheld(), ...o });
const rowsOf = (w: AiWorld): Array<{ id: string; reportId: string; purpose: string; inputHash: string; promptVersion: number; status: string; adapter: string }> =>
  (store(w) as unknown as { aiReads: Array<{ id: string; reportId: string; purpose: string; inputHash: string; promptVersion: number; status: string; adapter: string }> }).aiReads;

describe('a confirming read is its own row', () => {
  it('has its own hash, purpose and prompt version, and is never the one the case shows', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    const first = store(w).loadAiRead(r.id)!;
    const out = await svc(w).confirmRead(r.id);
    expect(out).toMatchObject({ state: 'ok' });
    const confirmId = (out as { readId: string }).readId;
    expect(confirmId).not.toBe(first.id);
    const confirm = store(w).loadAiReadById(confirmId)!;
    expect(confirm).toMatchObject({ purpose: 'confirm', status: 'ok', reportId: r.id, promptVersion: AI_CONFIRM_PROMPT_VERSION });
    expect(first).toMatchObject({ purpose: 'read', promptVersion: AI_PROMPT_VERSION });
    expect(confirm.inputHash).not.toBe(first.inputHash);
    expect(AI_CONFIRM_PROMPT_VERSION).not.toBe(AI_PROMPT_VERSION);
    expect(w.cw.ai.read(r.id)?.id).toBe(first.id);
    expect(rowsOf(w).filter((x) => x.reportId === r.id)).toHaveLength(2);
  });

  it('loadAiRead, loadAiReads, the briefs, expected, readAgain and the sweeper ignore a confirming read', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    const first = store(w).loadAiRead(r.id)!;
    await svc(w).confirmRead(r.id);
    // the store: the case's read is still the first, though the confirming one is newer
    expect(store(w).loadAiRead(r.id)?.id).toBe(first.id);
    expect(store(w).loadAiReads([r.id]).map((x) => x.id)).toEqual([first.id]);
    expect(w.cw.ai.briefs([r.id]).get(r.id)).toMatchObject({ stale: false, rule: 2 });
    expect(w.cw.ai.expected(r.id)).toBe(true);
    const calls = w.adapter.callCount;
    expect(await w.cw.ai.readAgain(r.id, 'mod_ann')).toMatchObject({ id: first.id });
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(calls);
  });

  it('a report with only a confirming read (the first purged) has no read, no brief and is queued to be read', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    await svc(w).confirmRead(r.id);
    // drop the case's read the way retention would; the confirming one stays
    const mem = store(w) as unknown as { aiReads: Array<{ purpose: string }> };
    mem.aiReads = mem.aiReads.filter((x) => x.purpose === 'confirm');
    expect(store(w).loadAiRead(r.id)).toBeNull();
    expect(w.cw.ai.read(r.id)).toBeNull();
    expect(w.cw.ai.briefs([r.id]).size).toBe(0);
  });

  it('a failed confirming read is not offered to the sweeper as a retry of the case', async () => {
    const adapter = createFakeModerationAI((input) => (input.purpose === 'confirm' ? { error: new AIError('retryable') } : upheld()(input)));
    const w = await world({ adapter });
    const r = await w.report();
    await w.idle();
    expect(await svc(w).confirmRead(r.id)).toMatchObject({ state: 'wait' });
    const failed = rowsOf(w).find((x) => x.purpose === 'confirm')!;
    expect(failed.status).toBe('failed');
    w.clock.t += 2 * DAY;
    expect(store(w).listAiRetries(w.clock.t, 50).map((x) => x.id)).not.toContain(failed.id);
    const calls = w.adapter.callCount;
    await w.cw.ai.sweep();
    await w.idle();
    expect(w.adapter.callCount).toBe(calls);
  });

  it('a decision that echoes the confirming read id is filed against the case\'s own read', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    const first = store(w).loadAiRead(r.id)!;
    const out = (await svc(w).confirmRead(r.id)) as { readId: string };
    const lineIds = first.read?.recommendation?.evidence ?? [];
    const res = await w.cw.decide({
      reportId: r.id,
      verdict: 'upheld',
      actions: [{ subject: r.target, kind: 'warning', durationMs: null, rule: 2, lineIds }],
      reason: 'rude',
      actor: 'mod_ann',
      ai: { readId: out.readId, accepted: false, role: 'moderator' },
    });
    expect(res).toMatchObject({ ok: true });
    expect(store(w).loadAiOutcome(r.id)?.readId).toBe(first.id);
  });
});

describe('the confirming read is called once, like a read', () => {
  it('a second ask returns the stored read and makes no call', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    const a = (await svc(w).confirmRead(r.id)) as { state: 'ok'; readId: string };
    const calls = w.adapter.callCount;
    const b = (await svc(w).confirmRead(r.id)) as { state: 'ok'; readId: string };
    expect(b.readId).toBe(a.readId);
    expect(w.adapter.callCount).toBe(calls);
  });

  it('two asks at once make one call (the lease)', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    const calls = w.adapter.callCount;
    const [a, b] = await Promise.all([svc(w).confirmRead(r.id), svc(w).confirmRead(r.id)]);
    expect(w.adapter.callCount).toBe(calls + 1);
    expect([a.state, b.state].sort()).toEqual(['ok', 'wait']);
  });

  it('is refused for a report that is gone, decided, or when the AI is off', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    expect(await svc(w).confirmRead('no-such-report')).toEqual({ state: 'none' });
    const off = await aiWorld({ level: 0 });
    expect(await svc(off).confirmRead('x')).toEqual({ state: 'none' });
    const lineIds = store(w).loadAiRead(r.id)?.read?.recommendation?.evidence ?? [];
    const decided = await w.cw.decide({ reportId: r.id, verdict: 'upheld', actions: [{ subject: r.target, kind: 'warning', durationMs: null, rule: 2, lineIds }], reason: 'rude', actor: 'mod_ann' });
    expect(decided).toMatchObject({ ok: true });
    const calls = w.adapter.callCount;
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'none' });
    expect(w.adapter.callCount).toBe(calls);
  });

  it('is not asked at level 1 (the confirming read serves acting, which needs level 2)', async () => {
    const w = await aiWorld({ level: 1, script: upheld() });
    const r = await w.report();
    await w.idle();
    const calls = w.adapter.callCount;
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'none' });
    expect(w.adapter.callCount).toBe(calls);
  });

  it('returns the validated read, with the line ids the case uses (not refs)', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    const out = (await svc(w).confirmRead(r.id)) as { state: 'ok'; readId: string; read: AIRead };
    const first = store(w).loadAiRead(r.id)!;
    expect(out.read.recommendation?.evidence).toEqual(first.read?.recommendation?.evidence);
    for (const id of out.read.evidence) expect(id).not.toMatch(/^L\d+$/);
  });
});

describe('what the confirming read sends', () => {
  const FEEDS = { ai: { kinds: ['muted_by_player'], windowDays: 14 } };
  const KINDS = { muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const } };
  const signalsWorld = () =>
    aiWorld({
      level: 2,
      script: upheld(),
      store: withMemorySignals(withMemoryAi(new MemoryStore())),
      over: { overrides: { ai: { level: 2 }, signals: { kinds: KINDS, feeds: FEEDS } } as never },
    });

  it('has no signal block, no casebook example and no caution, even when the first read had them', async () => {
    const w = await signalsWorld();
    const t = w.table({ reporter: 'key-conf-reporter' });
    for (const text of ['you are trash', 'uninstall the game']) {
      w.clock.t += 6000;
      w.cw.chat.accept(t.room, 'p2', text);
    }
    for (let i = 0; i < 3; i += 1) {
      w.cw.rooms.seat(`seat-m${i}`, 'p1', { clientKey: `muter-${i}` }, 'H');
      w.cw.signals.record({ kind: 'muted_by_player', subject: t.target, by: w.cw.rooms.subjectAt(`seat-m${i}`, 'p1')!, roomId: 'room-secret-1' });
    }
    w.clock.t += 1000;
    const res = await w.submit(t.room);
    if (!res.ok) throw new Error('refused');
    await w.idle();
    const readInput = w.adapter.calls[0]!;
    expect(readInput.signals).toBeDefined();
    expect(readInput.prompt.variable).toContain('Context about P1');
    await svc(w).confirmRead(res.reportId);
    const confirm = w.adapter.calls[1]!;
    expect(confirm.purpose).toBe('confirm');
    expect(confirm.signals).toBeUndefined();
    expect(confirm.cautions).toBeUndefined();
    expect(confirm.examples).toEqual([]);
    for (const needle of ['Context about P1', 'Caution on appeal history', 'example: ', 'distinct player']) expect(confirm.prompt.variable, needle).not.toContain(needle);
    for (const needle of ['Context about P1', 'Caution on appeal history', 'DATA block may end', 'kind": "corrective']) expect(confirm.prompt.stable, needle).not.toContain(needle);
    // the read's own input is unchanged by the existence of a confirming read
    expect(w.adapter.calls[0]!.purpose).toBeUndefined();
  });

  it('carries the same lines, note and rules as the read, and a stable paragraph asking for the innocent reading', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    await svc(w).confirmRead(r.id);
    const [first, second] = w.adapter.calls as [AIReadInput, AIReadInput];
    expect(second.lines).toEqual(first.lines);
    expect(second.rules).toEqual(first.rules);
    expect(second.report).toEqual(first.report);
    expect(second.promptVersion).toBe(AI_CONFIRM_PROMPT_VERSION);
    expect(second.prompt.stable).not.toBe(first.prompt.stable);
    expect(second.prompt.stable).toMatch(/innocent/i);
    expect(first.prompt.stable).not.toMatch(/innocent/i);
    // it still carries the policy text, byte for byte
    const policyOf = (s: string): string => s.slice(s.indexOf('\nCOMMUNITY RULES\n'));
    expect(policyOf(second.prompt.stable)).toBe(policyOf(first.prompt.stable));
    expect(second.prompt.variable).toContain('<data>');
    expect(second.prompt.variable).toContain('people: ');
  });

  it('keeps the first read\'s own prompt byte-identical to what it was (the confirm text is an addition)', async () => {
    const plain = await aiWorld({ level: 2, script: upheld() });
    await plain.report();
    await plain.idle();
    expect(plain.adapter.calls[0]!.prompt.stable).not.toMatch(/SECOND LOOK/);
    expect(plain.adapter.calls[0]!.prompt.stable).toContain('CONTEXT');
    expect(plain.adapter.calls[0]!.prompt.stable).toContain('APPEALS');
  });
});

describe('the stable prefix is the cache key', () => {
  it('is byte-identical between two confirming reads, and differs from a read\'s', async () => {
    const w = await world();
    const a = await w.report();
    const b = await w.report(['you are a zorbak', 'vlemmo quissel']);
    await w.idle();
    await svc(w).confirmRead(a.id);
    await svc(w).confirmRead(b.id);
    const confirms = w.adapter.calls.filter((c) => c.purpose === 'confirm');
    const reads = w.adapter.calls.filter((c) => c.purpose === undefined);
    expect(confirms).toHaveLength(2);
    expect(confirms[0]!.prompt.stable).toBe(confirms[1]!.prompt.stable);
    expect(confirms[0]!.prompt.variable).not.toBe(confirms[1]!.prompt.variable);
    expect(reads[0]!.prompt.stable).toBe(reads[1]!.prompt.stable);
    expect(confirms[0]!.prompt.stable).not.toBe(reads[0]!.prompt.stable);
  });
});

describe('a confirming read that gives no answer is no confirmation', () => {
  const fail = (step: FakeStep) => createFakeModerationAI((input) => (input.purpose === 'confirm' ? step : upheld()(input)));

  it.each([
    ['declined', { error: new AIError('declined') }],
    ['fatal', { error: new AIError('fatal') }],
    ['an invalid answer', { output: { nonsense: true }, usage: { costMicros: 4000 } }],
  ] as Array<[string, FakeStep]>)('%s: state none, and nothing is stored as a read', async (_name, step) => {
    const w = await world({ adapter: fail(step) });
    const r = await w.report();
    await w.idle();
    const out = await svc(w).confirmRead(r.id);
    // an invalid answer is tried once more a minute later; every other end is final
    if (_name === 'an invalid answer') expect(out).toEqual({ state: 'wait' });
    else expect(out).toEqual({ state: 'none' });
    expect(store(w).loadAiRead(r.id)?.purpose).toBe('read');
    expect(w.cw.ai.read(r.id)).not.toBeNull();
  });

  it('an invalid answer twice is final: none; a retryable failure waits for its retry', async () => {
    const w = await world({ adapter: fail({ output: { nonsense: true } }) });
    const r = await w.report();
    await w.idle();
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'wait' });
    w.clock.t += 2 * MIN;
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'none' });
    w.clock.t += DAY;
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'none' });
  });

  it('a timeout or retryable error waits and is tried again after its time, up to three calls in all, then none', async () => {
    const w = await world({ adapter: fail({ error: new AIError('retryable') }) });
    const r = await w.report();
    await w.idle();
    const before = w.adapter.callCount;
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'wait' });
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'wait' });
    expect(w.adapter.callCount).toBe(before + 1);
    w.clock.t += 2 * MIN;
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'wait' });
    w.clock.t += 20 * MIN;
    expect(await svc(w).confirmRead(r.id)).toEqual({ state: 'none' });
    expect(w.adapter.callCount).toBe(before + 3);
  });

  it('is booked to the same daily spend and call caps as a read', async () => {
    const w = await world({ dailyCalls: 2 });
    const r = await w.report();
    await w.idle();
    const spent0 = store(w).aiSpendSince(0);
    expect(spent0.calls).toBe(1);
    expect(await svc(w).confirmRead(r.id)).toMatchObject({ state: 'ok' });
    const spent1 = store(w).aiSpendSince(0);
    expect(spent1.calls).toBe(2);
    expect(spent1.micros).toBeGreaterThan(spent0.micros);
    expect(w.cw.ai.status().reads).toBe(2);
    // the cap is reached: another report's read and a confirming read both wait, and no call is made
    const r2 = await w.report(['you are a zorbak', 'vlemmo quissel']);
    await w.idle();
    expect(store(w).aiSpendSince(0).calls).toBe(2);
    expect(await svc(w).confirmRead(r2.id)).toEqual({ state: 'wait' });
    expect(w.adapter.callCount).toBe(2);
  });

  it('is skipped (no call, no cost) when the money cap is reached', async () => {
    const w = await world({ ai: { dailyBudgetMicros: 1000 } });
    const r = await w.report();
    await w.idle();
    expect(store(w).aiSpendSince(0).micros).toBe(1000);
    const out = await svc(w).confirmRead(r.id);
    expect(out).toEqual({ state: 'wait' });
    expect(w.adapter.callCount).toBe(1);
    expect(store(w).aiSpendSince(0)).toEqual({ micros: 1000, calls: 1 });
  });

  it('uses the confirming adapter when one is given, and its id is part of its hash', async () => {
    const big = createFakeModerationAI(upheld(), { id: 'fake:big' });
    const w = await world({ ai: { maxLevel: 3, act: { confirmAdapter: big } } });
    const r = await w.report();
    await w.idle();
    const out = (await svc(w).confirmRead(r.id)) as { readId: string };
    expect(big.callCount).toBe(1);
    expect(big.calls[0]!.purpose).toBe('confirm');
    expect(w.adapter.callCount).toBe(1);
    expect(store(w).loadAiReadById(out.readId)?.adapter).toBe('fake:big');
  });
});

describe('a prompt version bump marks open reads stale once and does not storm', () => {
  it('re-reads at the sweeper\'s pace and then nothing more', async () => {
    const w = await world();
    const reports = [];
    for (let i = 0; i < 8; i += 1) reports.push(await w.report([`you are trash number ${i}`, 'uninstall the game']));
    await w.idle();
    expect(w.adapter.callCount).toBe(8);
    // the stored reads look like an older prompt's: another hash and version for every report
    for (const x of rowsOf(w)) {
      x.inputHash = `old-${x.id}`;
      x.promptVersion = AI_PROMPT_VERSION - 1;
    }
    expect(w.cw.ai.briefs(reports.map((x) => x.id)).get(reports[0]!.id)?.stale).toBe(true);
    const seen: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // a new read is newer than the one it replaces (the clock is the test's)
      w.clock.t += 1000;
      const before = w.adapter.callCount;
      await w.cw.ai.sweep();
      await w.idle();
      seen.push(w.adapter.callCount - before);
    }
    // at most five stale reads a sweep (the sweeper's pace), every report once, then quiet
    expect(seen).toEqual([5, 3, 0, 0]);
    for (const x of reports) expect(w.cw.ai.briefs([x.id]).get(x.id)?.stale).toBe(false);
    for (const row of rowsOf(w).filter((x) => x.status === 'ok' && x.purpose === 'read' && !x.inputHash.startsWith('old-'))) expect(row.promptVersion).toBe(AI_PROMPT_VERSION);
  });

  it('a stale read leaves the confirming read alone: its hash does not depend on the case read\'s version', async () => {
    const w = await world();
    const r = await w.report();
    await w.idle();
    const out = (await svc(w).confirmRead(r.id)) as { readId: string };
    const confirm = store(w).loadAiReadById(out.readId)!;
    expect(confirm.promptVersion).toBe(AI_CONFIRM_PROMPT_VERSION);
    expect(confirm.inputHash).toHaveLength(64);
  });
});

/** An AIRead whose recommendation is upheld under rule 2 at `hostile`, citing `l1`, with every field a test cares about overridable. */
const rd = (over: Partial<AIRead> = {}, rec: Partial<NonNullable<AIRead['recommendation']>> | null = {}): AIRead => ({
  severity: 'hostile',
  rule: 2,
  summary: 's',
  evidence: ['l1'],
  confidence: 'high',
  injectionSuspected: false,
  recommendation: rec === null ? null : { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: ['l1'], ...rec },
  ...over,
});
const OWN = new Set(['l1', 'l2']);

describe('confirm agreement: same verdict, rule and conduct level, confidence at least medium, no injection, a shared own cited line', () => {
  const cases: Array<[string, AIRead, boolean]> = [
    ['an identical read agrees', rd(), true],
    ['medium confidence is enough', rd({ confidence: 'medium' }), true],
    ['low confidence does not agree', rd({ confidence: 'low' }), false],
    ['an upheld that turned unclear does not agree', rd({}, { verdict: 'unclear', evidence: [] }), false],
    ['an upheld that turned no_action does not agree', rd({}, { verdict: 'no_action', evidence: [] }), false],
    ['an upheld that turned noted does not agree', rd({}, { verdict: 'noted' }), false],
    ['a different rule does not agree', rd({}, { rule: 3 }), false],
    ['uncovered against a numbered rule does not agree', rd({}, { rule: 'uncovered' }), false],
    ['no rule does not agree', rd({}, { rule: null }), false],
    ['a different conduct level does not agree (severe)', rd({}, { severity: 'severe' }), false],
    ['a milder conduct level does not agree (rude)', rd({}, { severity: 'rude' }), false],
    ['an injection suspicion in the confirming read does not agree', rd({ injectionSuspected: true }), false],
    ['no shared cited line does not agree', rd({}, { evidence: ['l2'] }), false],
    ['no recommendation does not agree', rd({}, null), false],
    ['a cited line that is not by the reported person does not count', rd({}, { evidence: ['l1', 'l9'] }), true],
  ];
  it.each(cases)('%s', (_name, second, expected) => {
    expect(confirmAgrees(rd(), second, OWN)).toBe(expected);
  });

  it('an injection suspicion in the first read does not agree either', () => {
    expect(confirmAgrees(rd({ injectionSuspected: true }), rd(), OWN)).toBe(false);
  });

  it('a shared line must be by the reported person: shared but foreign does not agree', () => {
    expect(confirmAgrees(rd({}, { evidence: ['l9'] }), rd({}, { evidence: ['l9'] }), OWN)).toBe(false);
    expect(confirmAgrees(rd({}, { evidence: ['l9', 'l2'] }), rd({}, { evidence: ['l2', 'l7'] }), OWN)).toBe(true);
  });

  it('two reads that are not upheld never agree, however alike (there is nothing to act on)', () => {
    const noAction = rd({}, { verdict: 'no_action', evidence: [] });
    expect(confirmAgrees(noAction, noAction, OWN)).toBe(false);
    expect(confirmAgrees(rd({}, null), rd({}, null), OWN)).toBe(false);
  });

  it('is pure: it changes neither read and does not care about the order of citations', () => {
    const a = Object.freeze(rd({}, { evidence: ['l2', 'l1'] }));
    const b = Object.freeze(rd({}, { evidence: ['l1'] }));
    expect(confirmAgrees(a, b, OWN)).toBe(true);
    expect(confirmAgrees(b, a, OWN)).toBe(true);
  });
});
