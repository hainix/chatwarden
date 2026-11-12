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

describe('the AI methods: reads, outcomes, spend, examples, stats and purge', () => {
  const MIN = 60_000;
  const DAY = 86_400_000;
  const MIDNIGHT = Math.floor(NOW / DAY) * DAY;

  /** Everything one store answers for a fixed script; the random read ids are replaced by the order they were issued in. */
  function run(s: Store): unknown[] {
    const out: unknown[] = [];
    const issued: string[] = [];
    const label = (id: string): string => `#${issued.indexOf(id)}`;
    const scrub = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value, (k, v: unknown) => (k === 'id' && typeof v === 'string' ? label(v) : v)));
    const log = (name: string, value: unknown) => out.push([name, scrub(value)]);
    const reserve = (reportId: string, inputHash: string, lease: number, now: number) => {
      const r = s.reserveAiRead!({ reportId, inputHash, promptVersion: 1, adapter: 'fake:one' }, lease, now);
      if (r.reserved) issued.push(r.id);
      return r.reserved ? { reserved: true, id: r.id } : r;
    };
    const readOf = (n: number) => ({
      severity: (['banter', 'rude', 'hostile', 'severe'] as const)[n % 4]!,
      rule: n % 5 === 0 ? ('uncovered' as const) : n % 7 === 0 ? null : (n % 4) + 1,
      summary: `read ${n}`,
      evidence: [`L${n % 9}`],
      confidence: (['low', 'medium', 'high'] as const)[n % 3]!,
      injectionSuspected: n % 6 === 0,
      recommendation: n % 2 === 0 ? { verdict: 'upheld' as const, severity: 'hostile' as const, rule: 1, evidence: ['L1'] } : null,
    });
    const usageOf = (n: number) => ({ model: 'm', inputTokens: n, outputTokens: n + 1, cacheReadTokens: 0, cacheWriteTokens: n % 3, costMicros: 100 + n, latencyMs: 10 + n });

    // Reads at distinct times either side of midnight.
    for (let i = 0; i < 24; i++) {
      const at = MIDNIGHT - 6 * 3600_000 + i * 30 * MIN;
      log(`reserve ${i}`, reserve(`rep${i % 8}`, `h${i % 3}`, at + 5 * MIN, at));
    }
    log('reserve again', reserve('rep0', 'h0', NOW, MIDNIGHT - 6 * 3600_000 + 1));
    for (let i = 0; i < issued.length; i++) {
      const id = issued[i]!;
      if (i % 4 === 0) log(`complete ${i}`, s.completeAiRead!(id, { ...usageOf(i), read: readOf(i) }));
      else if (i % 4 === 1) log(`fail ${i}`, s.failAiRead!(id, 'failed', 'retryable', MIDNIGHT + i * MIN, NOW));
      else if (i % 8 === 2) log(`invalid ${i}`, s.failAiRead!(id, 'invalid', 'invalid', null, NOW, usageOf(i)));
      else if (i % 8 === 6) log(`skip ${i}`, s.failAiRead!(id, 'skipped', 'budget', MIDNIGHT + DAY, NOW));
    }
    log('complete twice', s.completeAiRead!(issued[0]!, { ...usageOf(0), read: readOf(99) }));
    log('retake due', reserve('rep1', 'h1', MIDNIGHT + 9 * MIN, MIDNIGHT + 8 * MIN));
    log('retake not due', reserve('rep5', 'h2', MIDNIGHT + 9 * MIN, MIDNIGHT + 1));
    log('token', s.changeToken() === s.changeToken());

    for (let r = 0; r < 9; r++) log(`loadAiRead rep${r}`, s.loadAiRead!(`rep${r}`));
    log('loadAiReads', s.loadAiReads!(['rep0', 'rep1', 'rep2', 'rep3', 'rep4', 'rep5', 'rep6', 'rep7', 'rep0', 'nobody']));
    for (const since of [0, MIDNIGHT - 3 * 3600_000, MIDNIGHT, MIDNIGHT + 1, MIDNIGHT + DAY]) log(`spend ${since}`, s.aiSpendSince!(since));
    for (const [t, n] of [[MIDNIGHT, 3], [MIDNIGHT + 2 * 3600_000, 50], [MIDNIGHT + DAY, 5], [MIDNIGHT - DAY, 100]] as const) {
      log(`retries ${t} ${n}`, s.listAiRetries!(t, n));
    }

    // Outcomes.
    const verdicts = ['upheld', 'noted', 'no_action'] as const;
    for (let i = 0; i < 30; i++) {
      const v = verdicts[i % 3]!;
      const aiV = i % 5 === 0 ? null : verdicts[(i + (i % 4 === 0 ? 1 : 0)) % 3]!;
      const agreement = aiV === null ? 'none' : (aiV === 'no_action') === (v === 'no_action') ? 'agree' : 'override';
      log(
        `outcome ${i}`,
        s.insertAiOutcome!({
          reportId: `o${i}`,
          readId: i % 2 === 0 ? `read${i}` : null,
          decidedAt: NOW - i * 7 * DAY,
          level: i % 4 === 0 ? 1 : 2,
          verdict: v,
          rule: i % 9 === 0 ? null : i % 7 === 0 ? 'uncovered' : String((i % 12) + 1),
          severity: i % 6 === 0 ? null : (['rude', 'hostile'] as const)[i % 2]!,
          aiVerdict: aiV,
          agreement,
          detail: { verdict: agreement === 'agree', outcome: 'same', oneClick: i % 2 === 0 },
          badFaith: i % 11 === 0,
          example: i % 4 === 3 ? null : { rule: (i % 12) + 1, severity: 'hostile', verdict: v, lines: [{ who: 'P1', text: `zorbak ${i}` }] },
        }),
      );
    }
    log('outcome twice', s.insertAiOutcome!({ ...(s.loadAiOutcome!('o3') as object), reportId: 'o3' } as never));
    for (const [id, patch] of [['o1', { reversed: true }], ['o2', { dontTeach: true }], ['o5', { reversed: true, dontTeach: true }], ['nope', { reversed: true }]] as const) {
      log(`mark ${id}`, s.markAiOutcome!(id, patch));
    }
    log('token moved', s.changeToken().length > 0);
    for (const id of ['o0', 'o1', 'o2', 'o3', 'o5', 'o9', 'nope']) log(`loadAiOutcome ${id}`, s.loadAiOutcome!(id));
    for (const [rule, sev] of [['1', 'hostile'], ['2', 'rude'], ['2', 'hostile'], ['3', 'rude'], ['uncovered', 'hostile'], ['99', 'rude']] as const) {
      for (const [limit, since] of [[2, 0], [10, NOW - 100 * DAY], [1, NOW - 10 * DAY], [0, 0]] as const) {
        log(`examples ${rule} ${sev} ${limit} ${since}`, s.aiExamples!(rule, sev, limit, since));
      }
    }
    for (const since of [0, NOW - 30 * DAY, NOW - 100 * DAY, NOW - 400 * DAY, NOW + 1]) {
      log(`teachable ${since}`, s.aiTeachableCount!(since));
      log(`stats ${since}`, s.aiStats!(since));
    }

    // Purge: reports with reads first, then the AI clocks.
    for (let i = 0; i < 4; i++) s.insertReport({ ...report({ id: `rep${i}`, createdAt: MIDNIGHT - (i % 2 === 0 ? 100 : 10) * DAY, reporterSubject: `s_p${i}`, roomId: `R${i}` }) });
    log('purgeReports', s.purgeReports(MIDNIGHT - 90 * DAY, MIDNIGHT - 30 * DAY));
    for (let r = 0; r < 9; r++) log(`after purgeReports rep${r}`, s.loadAiRead!(`rep${r}`));
    log('spend after', s.aiSpendSince!(0));
    log('purgeAi', s.purgeAi!(MIDNIGHT - 2 * DAY, NOW - 150 * DAY, NOW - 60 * DAY));
    log('stats after purge', s.aiStats!(0));
    log('teachable after purge', s.aiTeachableCount!(0));
    log('examples after purge', s.aiExamples!('1', 'hostile', 20, 0));
    for (let i = 0; i < 30; i += 3) log(`outcome after ${i}`, s.loadAiOutcome!(`o${i}`));
    log('retries after', s.listAiRetries!(NOW + DAY, 100));
    return out;
  }

  it('give the same answer to every call of the same script, read ids aside', () => {
    const a = run(mem());
    const b = run(sql());
    expect(a.length).toBeGreaterThan(150);
    expect(b).toEqual(a);
  });
});
