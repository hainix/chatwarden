import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store, StoredReport } from '@chatwarden/core';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryLinks, withMemoryNames, withMemorySignals } from '@chatwarden/store-memory';
import { openStore } from '../src/index.js';

// What is specific to SqliteStore in the filter methods: the counters survive a reopen, the writes are one upsert per row, and the stores agree on a
// scripted run (the differential). The behaviour both stores share is in the shared contract suite (test/contract/filters.contract.ts).

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const TODAY = Math.floor(NOW / DAY_MS);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const filePath = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-flt-'));
  dirs.push(d);
  return join(d, 'kit.db');
};

const report = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
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

describe('SqliteStore: filter counters and origin reports', () => {
  it('counts survive closing and reopening the file; another process adds to the same row', () => {
    const path = filePath();
    const a = openStore({ path });
    a.addFilterHits([{ day: TODAY, key: 'link.unlisted', action: 'count', hits: 4 }]);
    a.close();
    const b = openStore({ path });
    const c = openStore({ path });
    b.addFilterHits([{ day: TODAY, key: 'link.unlisted', action: 'count', hits: 1 }]);
    c.addFilterHits([{ day: TODAY, key: 'link.unlisted', action: 'count', hits: 2 }]);
    expect(b.listFilterHits(TODAY, TODAY)).toEqual([{ day: TODAY, key: 'link.unlisted', action: 'count', hits: 7 }]);
    b.close();
    c.close();
  });

  it('an open filter report survives a reopen and still blocks a second; the cap count reads the file', () => {
    const path = filePath();
    const a = openStore({ path });
    expect(a.insertReport(report('f1'))).toBe(true);
    a.close();
    const b = openStore({ path });
    expect(b.insertReport(report('f2'))).toBe(false);
    expect(b.countOriginReports('filter', NOW)).toBe(1);
    expect(b.loadReport('f1')).toMatchObject({ origin: 'filter', originKey: 'link.unlisted' });
    b.close();
  });

  it('an origin the check refuses is thrown, not swallowed as a duplicate', () => {
    const s = openStore({ db: new DatabaseSync(':memory:') });
    expect(() => s.insertReport(report('f1', { origin: 'robot' as never }))).toThrow(/CHECK/i);
  });

  it('purgeFilterHits does not touch reports, and purgeReports removes origin reports on the report clock', () => {
    const s = openStore({ db: new DatabaseSync(':memory:') });
    s.insertReport(report('f1', { createdAt: NOW - 100 * DAY_MS }));
    s.addFilterHits([{ day: TODAY - 100, key: 'k', action: 'count', hits: 1 }]);
    expect(s.purgeFilterHits(TODAY)).toBe(1);
    expect(s.loadReport('f1')).not.toBeNull();
    expect(s.purgeReports(NOW - 90 * DAY_MS, 0)).toBe(1);
    expect(s.loadReport('f1')).toBeNull();
  });
});

describe('MemoryStore and SqliteStore give the same answers on a scripted run', () => {
  const sql = (): Store => openStore({ db: new DatabaseSync(':memory:') });
  const mem = (): Store => withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));

  it('the same hit writes, filed and refused reports, closes and counts', () => {
    const a = mem();
    const b = sql();
    const script = (s: Store): unknown[] => {
      const out: unknown[] = [];
      s.addFilterHits([
        { day: TODAY, key: 'link.unlisted', action: 'count', hits: 2 },
        { day: TODAY, key: 'link.unlisted', action: 'flag', hits: 1 },
        { day: TODAY - 3, key: 'phrase.ads', action: 'refuse', hits: 9 },
      ]);
      s.addFilterHits([{ day: TODAY, key: 'link.unlisted', action: 'count', hits: 5 }]);
      out.push(s.listFilterHits(0, TODAY));
      out.push(s.listFilterHits(TODAY - 3, TODAY - 3));
      out.push(s.insertReport(report('f1')), s.insertReport(report('f2')), s.insertReport(report('f3', { targetSubject: 's_b' })));
      out.push(s.insertReport({ ...report('o1'), reporterSubject: 's_rep', reporterSeat: 'p1', reporterHandle: 'Rep', origin: null, originKey: null }));
      out.push(s.countOriginReports('filter', 0), s.countOriginReports('filter', NOW + 1), s.countOriginReports('watch', 0));
      out.push(s.closeReport('f1', 'dismissed', false, 'mod', NOW + 1, 'n'));
      out.push(s.insertReport(report('f4')), s.insertReport(report('f5')));
      out.push(s.listReports({ limit: 50 }).map((r) => [r.id, r.status, r.origin, r.originKey, r.reporterSubject]));
      out.push(s.listOpenReports({ limit: 50 }).map((r) => r.id));
      out.push(s.reporterTally(['filter:f1', 's_rep']), s.listOpenReportsByReporter?.(['filter:f3', 's_rep'], 10).map((r) => r.id));
      out.push(s.purgeFilterHits(TODAY - 2), s.listFilterHits(0, TODAY));
      return out;
    };
    expect(script(a)).toEqual(script(b));
  });
});
