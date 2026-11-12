import { describe, expect, it } from 'vitest';
import type { AIRead, AiOutcomeInsert, AiReadDone } from '@chatwarden/core';
import { MemoryStore, createMemoryStore, withMemoryAi } from '../src/index.js';

// What is specific to MemoryStore in the AI methods: it stores copies, and it is built to be subclassed. The behaviour it shares
// with SqliteStore is in the shared contract suite (test/contract/ai.contract.ts, run by contract.test.ts).

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const aiRead = (): AIRead => ({
  severity: 'rude',
  rule: 2,
  summary: 'P1 was rude to P2.',
  evidence: ['L1', 'L2'],
  confidence: 'medium',
  injectionSuspected: false,
  recommendation: { verdict: 'noted', severity: 'rude', rule: 2, evidence: ['L1'] },
});
const doneOf = (read: AIRead): AiReadDone => ({
  read,
  model: 'm',
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 42,
  latencyMs: 9,
});
const outcomeRow = (): AiOutcomeInsert => ({
  reportId: 'r1',
  readId: null,
  decidedAt: NOW,
  level: 2,
  verdict: 'noted',
  rule: '2',
  severity: 'rude',
  aiVerdict: 'noted',
  agreement: 'agree',
  detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
  badFaith: false,
  example: { rule: 2, severity: 'rude', verdict: 'noted', lines: [{ who: 'P1', text: 'zorbak' }] },
});

describe('MemoryStore AI rows are copies', () => {
  it('changing the objects handed to completeAiRead afterwards does not change the stored read', () => {
    const s = withMemoryAi(new MemoryStore());
    const r = s.reserveAiRead({ reportId: 'r1', inputHash: 'h', promptVersion: 1, adapter: 'a' }, NOW + MIN, NOW);
    if (!r.reserved) throw new Error('expected a reservation');
    const read = aiRead();
    expect(s.completeAiRead(r.id, r.lease, doneOf(read))).toBe(true);
    read.summary = 'changed';
    read.evidence.push('L9');
    if (read.recommendation) read.recommendation.evidence.push('L9');
    expect(s.loadAiRead('r1')?.read).toEqual(aiRead());
  });

  it('changing a loaded read, a listed row or a reserve answer does not change the store', () => {
    const s = withMemoryAi(new MemoryStore());
    const r = s.reserveAiRead({ reportId: 'r1', inputHash: 'h', promptVersion: 1, adapter: 'a' }, NOW + MIN, NOW);
    if (!r.reserved) throw new Error('expected a reservation');
    s.completeAiRead(r.id, r.lease, doneOf(aiRead()));
    const loaded = s.loadAiRead('r1');
    if (loaded?.read) loaded.read.evidence.length = 0;
    const many = s.loadAiReads(['r1']);
    if (many[0]) many[0].status = 'failed';
    const again = s.reserveAiRead({ reportId: 'r1', inputHash: 'h', promptVersion: 1, adapter: 'a' }, NOW + MIN, NOW);
    if (!again.reserved) again.existing.attempts = 99;
    expect(s.loadAiRead('r1')).toMatchObject({ status: 'ok', attempts: 1, read: { evidence: ['L1', 'L2'] } });
  });

  it('changing the outcome row handed to insertAiOutcome afterwards does not change the stored one', () => {
    const s = withMemoryAi(new MemoryStore());
    const row = outcomeRow();
    expect(s.insertAiOutcome(row)).toBe(true);
    row.verdict = 'no_action';
    row.example?.lines.push({ who: 'P2', text: 'later' });
    expect(s.loadAiOutcome('r1')).toMatchObject({ verdict: 'noted', example: { lines: [{ who: 'P1', text: 'zorbak' }] } });
  });

  it('an example listed by aiExamples is a copy', () => {
    const s = withMemoryAi(new MemoryStore());
    s.insertAiOutcome(outcomeRow());
    const [row] = s.aiExamples('2', 'rude', 5, 0);
    row?.example.lines.splice(0);
    expect(s.aiExamples('2', 'rude', 5, 0)[0]?.example.lines).toHaveLength(1);
  });
});

describe('MemoryStore AI methods can be overridden on an instance, like every other', () => {
  it('a test can make completeAiRead fail and the lease row stays pending', () => {
    const s = withMemoryAi(new MemoryStore());
    const r = s.reserveAiRead({ reportId: 'r1', inputHash: 'h', promptVersion: 1, adapter: 'a' }, NOW + MIN, NOW);
    if (!r.reserved) throw new Error('expected a reservation');
    s.completeAiRead = () => {
      throw new Error('disk full');
    };
    expect(() => s.completeAiRead(r.id, r.lease, doneOf(aiRead()))).toThrow('disk full');
    expect(s.loadAiRead('r1')).toBeNull();
  });
});

const AI_METHODS = [
  'reserveAiRead',
  'completeAiRead',
  'failAiRead',
  'loadAiRead',
  'loadAiReadById',
  'loadAiReadFor',
  'loadAiReads',
  'listAiRetries',
  'aiSpendSince',
  'insertAiOutcome',
  'loadAiOutcome',
  'markAiOutcome',
  'aiExamples',
  'aiTeachableCount',
  'aiStats',
  'purgeAi',
] as const;
const has = (s: object, name: string): boolean => typeof (s as Record<string, unknown>)[name] === 'function';

describe('withMemoryAi: the AI methods are opt-in', () => {
  it('createMemoryStore() and new MemoryStore() carry none of them (so a bundle that never opts in has none)', () => {
    for (const s of [createMemoryStore(), new MemoryStore()]) for (const m of AI_METHODS) expect(has(s, m), m).toBe(false);
  });

  it('withMemoryAi adds every one, returns the same store, and the methods work', () => {
    const base = createMemoryStore();
    const s = withMemoryAi(base);
    expect(s).toBe(base);
    for (const m of AI_METHODS) expect(has(s, m), m).toBe(true);
    const r = s.reserveAiRead({ reportId: 'r1', inputHash: 'h', promptVersion: 1, adapter: 'a' }, NOW + MIN, NOW);
    expect(r.reserved).toBe(true);
    expect(s.aiSpendSince(0).calls).toBe(1);
  });

  it('twice changes nothing, and the data stays', () => {
    const s = withMemoryAi(new MemoryStore());
    s.reserveAiRead({ reportId: 'r1', inputHash: 'h', promptVersion: 1, adapter: 'a' }, NOW + MIN, NOW);
    expect(withMemoryAi(s)).toBe(s);
    expect(s.aiSpendSince(0).calls).toBe(1);
  });

  it('keeps a method the store already has: a subclass override wins', () => {
    class Failing extends MemoryStore {
      loadAiRead(): null {
        throw new Error('boom');
      }
    }
    const s = withMemoryAi(new Failing()) as unknown as Record<string, () => unknown>;
    expect(() => s.loadAiRead?.()).toThrow('boom');
    expect(has(s, 'reserveAiRead')).toBe(true);
  });

  it('two stores do not share rows, and one without the methods is not touched by the other', () => {
    const a = withMemoryAi(createMemoryStore());
    const b = createMemoryStore();
    a.reserveAiRead({ reportId: 'r1', inputHash: 'h', promptVersion: 1, adapter: 'a' }, NOW + MIN, NOW);
    expect(has(b, 'reserveAiRead')).toBe(false);
    const c = withMemoryAi(createMemoryStore());
    expect(c.aiSpendSince(0).calls).toBe(0);
  });

  it('a transaction that is undone undoes an AI write', () => {
    const s = withMemoryAi(createMemoryStore());
    expect(() =>
      s.transaction(() => {
        s.reserveAiRead({ reportId: 'r1', inputHash: 'h', promptVersion: 1, adapter: 'a' }, NOW + MIN, NOW);
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(s.aiSpendSince(0).calls).toBe(0);
    expect(s.loadAiReadFor('r1', 'h')).toBeNull();
  });

  it('a store without the AI methods purges reports as before', () => {
    const s = createMemoryStore();
    expect(s.purgeReports(NOW, NOW)).toBe(0);
  });
});
