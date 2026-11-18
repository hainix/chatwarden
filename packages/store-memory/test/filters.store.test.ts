import { describe, expect, it } from 'vitest';
import type { StoredReport } from '@chatwarden/core';
import { MemoryStore, createMemoryStore } from '../src/index.js';

// What is specific to MemoryStore in the filter methods: they are plain methods (not opt-in), the state lives per store, and rows go in and come out
// as copies. The behaviour it shares with SqliteStore is in the shared contract suite (test/contract/filters.contract.ts, run by contract.test.ts).

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const TODAY = Math.floor(NOW / DAY_MS);
const METHODS = ['addFilterHits', 'listFilterHits', 'purgeFilterHits', 'countOriginReports'] as const;

const filterReport = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: 'ROOM1',
  tags: {},
  reporterSubject: `filter:${id}`,
  reporterSeat: '',
  reporterHandle: '',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'spam',
  reportedReason: 'spam',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  origin: 'filter',
  originKey: 'link.unlisted',
  ...over,
});

describe('MemoryStore: the filter methods', () => {
  it('a plain MemoryStore and createMemoryStore() both have the four methods', () => {
    for (const s of [new MemoryStore(), createMemoryStore()] as unknown as Array<Record<string, unknown>>) for (const m of METHODS) expect(typeof s[m], m).toBe('function');
  });

  it('counters are per store', () => {
    const a = new MemoryStore();
    const b = new MemoryStore();
    a.addFilterHits([{ day: TODAY, key: 'k', action: 'count', hits: 1 }]);
    expect(b.listFilterHits(0, TODAY + 1)).toEqual([]);
  });

  it('rows given are copied in: changing the argument afterwards changes nothing stored', () => {
    const s = new MemoryStore();
    const row = { day: TODAY, key: 'k', action: 'count' as const, hits: 1 };
    s.addFilterHits([row]);
    row.hits = 50;
    expect(s.listFilterHits(TODAY, TODAY)[0]!.hits).toBe(1);
  });

  it('a refused insert leaves the stored report list as it was, and an undone transaction removes an accepted one', () => {
    const s = new MemoryStore();
    expect(s.insertReport(filterReport('f1'))).toBe(true);
    expect(s.insertReport(filterReport('f2'))).toBe(false);
    expect(s.listReports({ limit: 10 }).map((r) => r.id)).toEqual(['f1']);
    expect(() =>
      s.transaction(() => {
        s.insertReport(filterReport('f3', { roomId: 'ROOM2' }));
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(s.loadReport('f3')).toBeNull();
    // the slot is free again after the undo
    expect(s.insertReport(filterReport('f4', { roomId: 'ROOM2' }))).toBe(true);
  });

  it('a stored origin report reads back as a copy', () => {
    const s = new MemoryStore();
    s.insertReport(filterReport('f1'));
    const r = s.loadReport('f1')!;
    r.originKey = 'changed';
    expect(s.loadReport('f1')!.originKey).toBe('link.unlisted');
  });
});
