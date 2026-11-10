import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@chatwarden/core';
import type { AuditRow, Store, StoredReport } from '@chatwarden/core';
import { MemoryStore } from '@chatwarden/store-memory';
import { openStore } from '../src/index.js';

// Differential tests: the same writes go to SqliteStore (the reference) and MemoryStore, and every combined query and cursor
// must answer the same. The shared contract suite (test/contract) pins each behaviour on its own with explicit expectations;
// this file pins their combinations, so a query shape the contract does not name still cannot drift.

const NOW = 1_800_000_000_000;
const sql = (): Store => openStore({ db: new DatabaseSync(':memory:') });
const mem = (): Store => new MemoryStore();

const report = (over: Partial<StoredReport> = {}): StoredReport => ({
  id: 'r1',
  createdAt: NOW,
  roomId: 'ROOM1',
  tags: { mode: 'ranked' },
  reporterSubject: 's_rep',
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: 'rude',
  lineId: '3',
  excerpt: [{ lineId: '3', ts: NOW - 5, seatId: 'p2', handle: 'Tgt', raw: 'zorbak "you"', delivered: null, blocked: true, audience: ['p1'], p: 0 }],
  people: ['s_tgt'],
  status: 'open',
  ...over,
});

describe('the audit trail: pages, filters and cursors', () => {
  it('give identical pages for the same writes, filters and cursors, and the same purge', () => {
    const a = mem();
    const b = sql();
    for (let i = 0; i < 40; i++) {
      const r: AuditRow = {
        id: `id${String((i * 7) % 40).padStart(2, '0')}`,
        at: NOW + Math.floor(i / 4),
        actor: i % 3 === 0 ? 'alice' : 'bob',
        action: AUDIT_ACTIONS[i % AUDIT_ACTIONS.length] as AuditRow['action'],
        role: i % 5 === 0 ? null : (['moderator', 'senior', 'owner'] as const)[i % 3] ?? null,
        target: i % 4 === 0 ? null : { type: 'report', ref: `r${i}` },
      };
      a.insertAudit(r);
      b.insertAudit(r);
    }
    const queries: Array<Parameters<Store['listAudit']>[0]> = [
      { limit: 200 },
      { limit: 7 },
      { limit: 7, actor: 'alice' },
      { limit: 7, action: 'report.view' },
      { limit: 3, actor: 'bob', action: 'suggest' },
      { limit: 5, before: NOW + 5 },
      { limit: 5, before: NOW + 5, beforeId: 'id20' },
      { limit: 5, before: NOW + 5, beforeId: 'zzz' },
      { limit: 5, before: NOW + 5, beforeId: 'id20', actor: 'alice' },
      { limit: 4, before: NOW + 5, beforeId: 'id20', actor: 'bob', action: 'report.decide' },
      { limit: 6, before: NOW + 9, actor: 'alice', action: 'report.view' },
      { limit: 0 },
      { limit: 999, beforeId: 'id05' },
    ];
    for (const q of queries) expect(b.listAudit(q), JSON.stringify(q)).toEqual(a.listAudit(q));
    expect(b.purgeAudit(NOW + 4)).toBe(a.purgeAudit(NOW + 4));
    expect(b.listAudit({ limit: 200 })).toEqual(a.listAudit({ limit: 200 }));
  });
});

describe('reports: listReports', () => {
  const seeded = (s: Store) => {
    // r1..r6 with three at the same instant, so the id tie-break shows.
    const times = [NOW, NOW + 10, NOW + 10, NOW + 10, NOW + 20, NOW + 30];
    times.forEach((createdAt, i) => {
      s.insertReport(report({ id: `r${i + 1}`, createdAt, reporterSubject: `s_rep${i}` }));
    });
    s.closeReport('r2', 'actioned', false, 'mod', NOW + 100, 'n');
    s.closeReport('r3', 'dismissed', true, 'mod', NOW + 100, 'n', 'ev');
    s.closeReport('r5', 'actioned', false, 'mod', NOW + 100, 'n');
  };

  it('agrees on every filter, cursor and limit, alone and combined', () => {
    const a = mem();
    const b = sql();
    seeded(a);
    seeded(b);
    const queries = [
      { limit: 10 },
      { limit: 2 },
      { status: 'open' as const, limit: 10 },
      { status: 'actioned' as const, limit: 1 },
      { status: 'dismissed' as const, limit: 10 },
      { before: NOW + 10, limit: 10 },
      { before: NOW + 10, beforeId: 'r3', limit: 10 },
      { before: NOW + 10, beforeId: 'r4', limit: 2 },
      { before: NOW + 30, limit: 3 },
      { before: NOW + 31, beforeId: 'zz', limit: 3 },
      { status: 'open' as const, before: NOW + 10, beforeId: 'r4', limit: 10 },
      { status: 'actioned' as const, before: NOW + 30, limit: 5 },
      { status: 'dismissed' as const, before: NOW + 11, beforeId: 'r9', limit: 5 },
      { beforeId: 'r3', limit: 10 },
      { limit: 0 },
      { limit: 999 },
    ];
    for (const q of queries) expect(b.listReports(q), JSON.stringify(q)).toEqual(a.listReports(q));
  });

  it('agrees page by page when walked by the cursor', () => {
    const a = mem();
    const b = sql();
    seeded(a);
    seeded(b);
    let cursor: { before: number; beforeId: string } | undefined;
    for (let page = 0; page < 8; page++) {
      const q = { limit: 2, ...(cursor ?? {}) };
      const got = b.listReports(q);
      expect(got, JSON.stringify(q)).toEqual(a.listReports(q));
      const last = got[got.length - 1];
      if (last === undefined) break;
      cursor = { before: last.createdAt, beforeId: last.id };
    }
  });
});

describe('reports: listReportsByPerson', () => {
  const seeded = (s: Store) => {
    // Reports against s_a (two aliases: s_a and s_a2), s_b, and one filed BY s_a against s_b.
    const rows: Array<[string, number, string, string]> = [
      ['p1', NOW, 's_a', 's_x1'],
      ['p2', NOW + 10, 's_a2', 's_x2'],
      ['p3', NOW + 10, 's_a', 's_x3'],
      ['p4', NOW + 20, 's_b', 's_x4'],
      ['p5', NOW + 30, 's_b', 's_a'],
      ['p6', NOW + 40, 's_a', 's_x5'],
    ];
    for (const [id, createdAt, targetSubject, reporterSubject] of rows) {
      s.insertReport(report({ id, createdAt, targetSubject, reporterSubject, people: [targetSubject] }));
    }
    s.closeReport('p3', 'actioned', false, 'mod', NOW + 100, 'n');
  };

  it('agrees on aliases, limits and unknown people', () => {
    const a = mem();
    const b = sql();
    seeded(a);
    seeded(b);
    const queries: Array<[string[], number]> = [
      [['s_a'], 10],
      [['s_a', 's_a2'], 10],
      [['s_a2', 's_a'], 2],
      [['s_a', 's_a2'], 4],
      [['s_b'], 1],
      [['s_a', 's_b'], 4],
      [['s_a', 's_a', 's_a2'], 10],
      [['nobody'], 5],
      [[], 5],
      [['s_a'], 0],
      [['s_a'], 999],
      [['s_a'], 2.9],
    ];
    for (const [who, limit] of queries) {
      expect(b.listReportsByPerson(who, limit), JSON.stringify([who, limit])).toEqual(a.listReportsByPerson(who, limit));
    }
  });
});
