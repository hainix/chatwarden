import { describe, expect, it } from 'vitest';
import type { ErasePlan, Store } from '@chatwarden/core';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryLinks, withMemoryNames, withMemorySignals } from '../src/index.js';
import { seedWorld } from '../../../test/contract/privacy.contract.js';

// The privacy contract (test/contract/privacy.contract.ts) runs against MemoryStore from contract.test.ts. This file adds what only the in-memory store has to
// get right: the opt-in wrappers keep state of their own (signals, appeals, kept names, AI marks and actions, links), and the erase and the export must
// reach it in whatever order the wrappers were added, and must still work on a bare store that has none of them.

const NOW = 1_800_000_000_000;
const plan = (over: Partial<ErasePlan> = {}): ErasePlan => ({ subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_mem', at: NOW, ...over });
const dump = (s: unknown): string => JSON.stringify(s, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v.values()] : v));
const ALL = (): MemoryStore => withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));
const REVERSED = (): MemoryStore => withMemoryAi(withMemorySignals(withMemoryAppeals(withMemoryNames(withMemoryLinks(new MemoryStore())))));

describe('the wrappers added in any order erase and export the same', () => {
  it.each([
    ['every wrapper', ALL],
    ['the wrappers in the other order', REVERSED],
  ])('%s: the same counts, and nothing of the person is left in the wrappers\' own state', async (_n, make) => {
    const s = make();
    await seedWorld(s, { ban: true });
    const preview = s.eraseSubjects(plan({ dryRun: true }));
    const counts = s.eraseSubjects(plan());
    expect(counts).toEqual(preview);
    expect(counts.removed).toMatchObject({ signals: 2, appeals: 1, blocked_names: 1, workflow: 3 });
    for (const needle of ['s_pp', 'acct-pp', 'zorbak pp', 'ppname_vlemmo', 'pp appeal statement']) expect(dump(s), needle).not.toContain(needle);
    expect(dump(s)).toContain('s_qq');
  });
});

describe('a bare MemoryStore (no wrappers)', () => {
  it('erases and exports what it has: the sections the wrappers own are empty, never an error', async () => {
    const s = new MemoryStore();
    await s.saveSubject({ id: 's_a', createdAt: NOW, mergedInto: null });
    await s.saveIdentifier({ subjectId: 's_a', kind: 'account', value: 'acct-a', firstSeen: NOW, lastSeen: NOW });
    s.insertStrike({ id: 'k1', at: NOW, subject: 's_a', roomId: 'R', termId: 't', rawLine: 'zorbak' });
    const out = s.exportSubjects(['s_a']);
    expect(out.accounts).toEqual(['acct-a']);
    expect(out.signals).toEqual([]);
    expect(out.appeals).toEqual([]);
    expect(out.blockedNames).toEqual([]);
    expect(out.ai).toEqual({ noAutomation: null, reads: 0, outcomes: [] });
    expect(s.eraseSubjects(plan({ subjects: ['s_a'] })).removed).toEqual({ identifiers: 1, strikes: 1, subjects: 1 });
    expect(s.rawStrikes()).toEqual([]);
  });
});

describe('journaling', () => {
  it('an erase inside a transaction that fails is undone in every collection, wrappers included, and a retry gives the same counts', async () => {
    const s = ALL();
    await seedWorld(s, { ban: true, held: true });
    const before = dump(s);
    const held = plan({ mode: 'safety', heldReportIds: new Set(['rHeld']) });
    let first: ReturnType<Store['eraseSubjects']> | null = null;
    expect(() =>
      s.transaction(() => {
        first = s.eraseSubjects(held);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(dump(s)).toBe(before);
    expect(s.eraseSubjects(held)).toEqual(first);
  });

  it('an erase nested in a transaction that commits, then an outer failure, still undoes it', async () => {
    const s = ALL();
    await seedWorld(s);
    const before = dump(s);
    expect(() =>
      s.transaction(() => {
        s.transaction(() => s.eraseSubjects(plan()));
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(dump(s)).toBe(before);
  });

  it('a row inserted before the erase in the same failing transaction is undone as well (the undo steps compose)', async () => {
    const s = ALL();
    await seedWorld(s);
    const before = dump(s);
    expect(() =>
      s.transaction(() => {
        s.insertStrike({ id: 'late', at: NOW, subject: 's_pp', roomId: 'R', termId: 't', rawLine: 'late line' });
        s.eraseSubjects(plan());
        s.insertStrike({ id: 'later', at: NOW, subject: 's_qq', roomId: 'R', termId: 't', rawLine: 'later line' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(dump(s)).toBe(before);
  });
});

describe('ref codes', () => {
  it('a ref code freed by an erase can be used again, as it can after a purge', async () => {
    const s = ALL();
    await seedWorld(s);
    s.eraseSubjects(plan());
    const row = (groupId: string) => ({
      id: `row-${groupId}`,
      groupId,
      refCode: 'M-ENDED',
      kind: 'chat' as const,
      targetType: 'subject' as const,
      value: 's_xx',
      startsAt: NOW,
      endsAt: NOW + 1000,
      reason: 'r',
      rule: '1',
      gapNote: null,
      gapStatus: null,
      roomId: null,
      actor: 'mod',
      source: 'moderator' as const,
      automated: false,
      pending: false,
    });
    expect(s.insertSanctionGroup([row('gNew')])).toBe(true);
  });
});
