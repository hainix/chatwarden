import { describe, expect, it } from 'vitest';
import type { OverturnInput, Store } from '@chatwarden/core';
import { MemoryStore, withMemoryAppeals } from '../src/index.js';
import { seedWorld } from '../../../test/contract/privacy.contract.js';
import { withMemoryAi, withMemoryLinks, withMemoryNames, withMemorySignals } from '../src/index.js';

// What only the in-memory store has to get right about the overturn methods: they ride in the appeals wrapper (a bare store does not carry them), the state is
// journaled and erased with the rest, and what is read comes back as a copy. The behaviour both stores share is in test/contract/overturns.contract.ts.

const NOW = 1_800_000_000_000;
const input = (over: Partial<OverturnInput> = {}): OverturnInput => ({
  groupId: 'g1',
  at: NOW,
  subject: 's_a',
  aliases: ['s_a'],
  source: 'auto_filter',
  termId: 'term1',
  filterKey: null,
  reportId: null,
  strikes: null,
  ...over,
});
const ALL = (): MemoryStore => withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));
/** The overturn rows the appeals wrapper holds (a private map: this is the one place a test reaches for it, to see a report id the Store API never returns). */
const held = (s: Store): Array<{ groupId: string; reportId: string | null; subject: string }> =>
  [...((s as unknown as { ap?: { overturns?: Map<string, { groupId: string; reportId: string | null; subject: string }> } }).ap?.overturns?.values() ?? [])].map((r) => ({
    groupId: r.groupId,
    reportId: r.reportId,
    subject: r.subject,
  }));

describe('the overturn methods ride in the appeals wrapper', () => {
  it('a bare MemoryStore has none; withMemoryAppeals adds all five', () => {
    const bare = new MemoryStore() as unknown as Record<string, unknown>;
    for (const m of ['recordOverturn', 'latestAutoChatStart', 'overturnedTermCounts', 'overturnedFilterCounts', 'purgeOverturns']) expect(bare[m], m).toBeUndefined();
    const s = withMemoryAppeals(new MemoryStore());
    for (const m of ['recordOverturn', 'latestAutoChatStart', 'overturnedTermCounts', 'overturnedFilterCounts', 'purgeOverturns'] as const) expect(typeof s[m], m).toBe('function');
  });

  it('a bare store still reads strikes and starts as before (no overturned flag anywhere)', () => {
    const s = new MemoryStore();
    s.insertStrike({ id: 'k1', at: NOW, subject: 's_a', roomId: 'R', termId: 't', rawLine: 'x' });
    expect(s.loadStrikes(0).map((r) => r.id)).toEqual(['k1']);
    expect(s.loadAutoChatStarts()).toEqual([]);
  });
});

describe('state and copies', () => {
  it('the counts come back as copies: changing one changes nothing stored', () => {
    const s = withMemoryAppeals(new MemoryStore());
    s.recordOverturn(input());
    s.overturnedTermCounts(0)[0]!.overturned = 99;
    expect(s.overturnedTermCounts(0)).toEqual([{ termId: 'term1', overturned: 1, lastAt: NOW }]);
  });

  it('an undone transaction leaves no overturn row, no sanction mark and no strike flag behind', () => {
    const s = withMemoryAppeals(new MemoryStore());
    s.insertSanctionGroup([
      { id: 'x1', groupId: 'g1', refCode: 'M-AAAAA', kind: 'chat', targetType: 'subject', value: 's_a', startsAt: NOW, endsAt: NOW + 1000, reason: 'r', rule: '2', gapNote: null, gapStatus: null, roomId: null, actor: 'f', source: 'auto_filter', automated: true, pending: false },
    ]);
    s.insertStrike({ id: 'k1', at: NOW - 1, subject: 's_a', roomId: 'R', termId: 't', rawLine: 'x' });
    expect(() =>
      s.transaction(() => {
        s.recordOverturn(input({ strikes: { from: NOW - 5, to: NOW } }));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(held(s)).toEqual([]);
    expect(s.loadStrikes(0).map((r) => r.id)).toEqual(['k1']);
    expect(s.loadAutoChatStarts()).toEqual([{ subject: 's_a', startsAt: NOW }]);
    expect(s.loadSanctionSubjectRow('g1')).not.toHaveProperty('overturnedAt');
  });
});

describe('the erase', () => {
  it('deletes the person\'s overturn rows, clears the report id of the others when the report goes, and leaves nothing of the person in the wrapper\'s state', async () => {
    const s = ALL();
    await seedWorld(s, { held: true });
    expect(held(s).map((r) => [r.groupId, r.reportId])).toEqual([
      ['gEnded', 'rAbout'],
      ['gQ', 'rAbout'],
      ['gHeld', 'rHeld'],
    ]);
    s.eraseSubjects({ subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(['rHeld']), receiptId: 'e_ov', at: NOW });
    expect(held(s)).toEqual([
      { groupId: 'gQ', reportId: null, subject: 's_qq' },
      { groupId: 'gHeld', reportId: 'rHeld', subject: 's_pp' },
    ]);
  });

  it('a dry run changes nothing, and an erase undone with its transaction restores the rows and the report ids', async () => {
    const s = ALL();
    await seedWorld(s);
    const before = held(s);
    s.eraseSubjects({ subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_dry', at: NOW, dryRun: true });
    expect(held(s)).toEqual(before);
    expect(() =>
      s.transaction(() => {
        s.eraseSubjects({ subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_tx', at: NOW });
        expect(held(s).map((r) => r.groupId)).toEqual(['gQ']);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(held(s)).toEqual(before);
  });

  it('a bare store with no appeals wrapper erases without touching overturns', async () => {
    const s = new MemoryStore();
    await s.saveSubject({ id: 's_a', createdAt: NOW, mergedInto: null });
    expect(s.eraseSubjects({ subjects: ['s_a'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_bare', at: NOW }).removed).toEqual({ subjects: 1 });
  });
});
