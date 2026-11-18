import { describe, expect, it } from 'vitest';
import type { HoldRow } from '@chatwarden/core';
import type { MemoryAiMethods } from '../src/index.js';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryLinks, withMemoryNames, withMemorySignals } from '../src/index.js';

// The legal-hold contract (test/contract/legal.contract.ts) runs against MemoryStore from contract.test.ts. This file adds what only the in-memory store has to
// get right: the purges that live in the opt-in wrappers (AI reads, outcomes and actions, appeals) read the store's holds too, and a bare store works.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const hold = (reportId: string): HoldRow => ({ reportId, code: 'legal_proceeding', heldBy: 'senior_a', heldAt: NOW, releasedBy: null, releasedAt: null });
const full = (): MemoryStore => withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));

describe('the wrappers read the store\'s own holds', () => {
  it('an AI read, outcome and action of a held report survive a purge made through the wrapper methods, in either wrapper order', () => {
    for (const make of [full, () => withMemoryAi(withMemoryAppeals(new MemoryStore()))]) {
      const s = make() as MemoryStore & MemoryAiMethods;
      const t = NOW - 400 * DAY;
      s.insertAiAction({
        id: 'a1', reportId: 'rA', readId: 'x', confirmReadId: null, rule: '3', severity: 'hostile', state: 'shadow', refusedCode: null, notBefore: t, createdAt: t, groupId: null, kind: null,
        durationMs: null, actedAt: t, reviewDueAt: null, reviewedAt: null, reviewedBy: null, undoCode: null, undoNote: 'note', adapter: 'a', promptVersion: 1,
      });
      s.placeHold(hold('rA'));
      s.purgeAiActions(NOW, NOW);
      s.purgeAi(NOW, NOW, NOW);
      expect(s.loadAiAction('rA')?.undoNote).toBe('note');
      s.releaseHold('rA', 'o', NOW);
      s.purgeAiActions(NOW, NOW);
      expect(s.loadAiAction('rA')).toBeNull();
    }
  });

  it('a bare store (no wrappers) holds, purges and erases without error', async () => {
    const s = new MemoryStore();
    s.insertReport({ id: 'r1', createdAt: 1, roomId: 'R', tags: {}, reporterSubject: 's_r', reporterSeat: 'p1', reporterHandle: 'R', targetSubject: 's_t', targetSeat: 'p2', targetHandle: 'T', category: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open' });
    s.placeHold(hold('r1'));
    expect(s.purgeReports(NOW, 0)).toBe(0);
    await s.saveSubject({ id: 's_t', createdAt: 1, mergedInto: null });
    expect(s.eraseSubjects({ subjects: ['s_t'], mode: 'none', heldReportIds: new Set(), receiptId: 'e1', at: NOW }).kept.heldReports).toBe(1);
    expect(s.loadReport('r1')).not.toBeNull();
    s.releaseHold('r1', 'o', NOW);
    expect(s.purgeReports(NOW, 0)).toBe(1);
  });
});
