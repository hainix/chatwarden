import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, normalizeStatement } from '@chatwarden/core';
import type { AuditRow, SignalRow, Store, StoredReport } from '@chatwarden/core';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryNames, withMemorySignals } from '@chatwarden/store-memory';
import { openStore } from '../src/index.js';

// Differential tests: the same writes go to SqliteStore (the reference) and MemoryStore, and every combined query and cursor
// must answer the same. The shared contract suite (test/contract) pins each behaviour on its own with explicit expectations;
// this file pins their combinations, so a query shape the contract does not name still cannot drift.

const NOW = 1_800_000_000_000;
const sql = (): Store => openStore({ db: new DatabaseSync(':memory:') });
const mem = (): Store => withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore()))));

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
    const leases = new Map<string, number>();
    const lease = (id: string): number => leases.get(id) ?? 0;
    const label = (id: string): string => `#${issued.indexOf(id)}`;
    const scrub = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value, (k, v: unknown) => (k === 'id' && typeof v === 'string' ? label(v) : v)));
    const log = (name: string, value: unknown) => out.push([name, scrub(value)]);
    const reserve = (reportId: string, inputHash: string, lease: number, now: number) => {
      const r = s.reserveAiRead!({ reportId, inputHash, promptVersion: 1, adapter: 'fake:one' }, lease, now);
      if (r.reserved) {
        issued.push(r.id);
        leases.set(r.id, r.lease);
      }
      return r;
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
      if (i % 4 === 0) log(`complete ${i}`, s.completeAiRead!(id, lease(id), { ...usageOf(i), read: readOf(i), exampleIds: i % 3 === 0 ? [`o${i}`] : [] }));
      else if (i % 4 === 1) log(`fail ${i}`, s.failAiRead!(id, lease(id), 'failed', 'retryable', MIDNIGHT + i * MIN, i % 5 === 1 ? usageOf(i) : undefined));
      else if (i % 8 === 2) log(`invalid ${i}`, s.failAiRead!(id, lease(id), 'invalid', 'invalid', null, usageOf(i)));
      else if (i % 8 === 6) log(`skip ${i}`, s.failAiRead!(id, lease(id), 'skipped', 'budget', MIDNIGHT + DAY));
    }
    log('complete twice', s.completeAiRead!(issued[0]!, lease(issued[0]!), { ...usageOf(0), read: readOf(99) }));
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
          detail: { verdict: agreement === 'agree', rule: i % 3 === 0, lines: i % 4, outcome: (['same', 'milder', 'harsher', 'none'] as const)[i % 4]!, oneClick: i % 2 === 0 },
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

describe('the signal methods: insert, grouped listing and purge', () => {
  const DAY = 86_400_000;
  const script = (): SignalRow[] => {
    const rows: SignalRow[] = [];
    let n = 0;
    const kinds = ['muted_by_player', 'blocked_by_player', 'flood_triggered', 'constructor'];
    for (let i = 0; i < 300; i++) {
      const at = NOW - ((i * 7) % 40) * DAY - ((i * 13) % 1000);
      const source = i % 5 === 0 ? { sourceKey: `r:room-${i % 4}`, bySubject: null, roomId: `room-${i % 4}` } : i % 7 === 0 ? { sourceKey: `d:${i % 6}`, bySubject: null, roomId: null } : { sourceKey: `b:s_from_${i % 11}`, bySubject: `s_from_${i % 11}`, roomId: null };
      rows.push({
        id: `sig-${(n += 1)}`,
        kind: kinds[i % kinds.length] as string,
        subject: `s_${i % 13}`,
        ...source,
        at,
        weight: [0, 0.5, 1, 2, 10][i % 5] as number,
        // Several rows of one source share a bucket now and then, so the cap refuses some of them.
        capBucket: Math.floor(at / DAY) - (i % 3 === 0 ? 0 : 1),
      });
    }
    // Repeats of earlier rows (same tuple, another id) and of earlier ids (another tuple): refused alike by both.
    rows.push({ ...(rows[3] as SignalRow), id: 'dup-tuple', weight: 9 }, { ...(rows[4] as SignalRow), id: (rows[5] as SignalRow).id });
    return rows;
  };

  it('give the same answer to every call of the same script', () => {
    const a = mem();
    const b = sql();
    const rows = script();
    const wrote = rows.map((r) => [a.insertSignal?.(r), b.insertSignal?.(r)]);
    for (const [x, y] of wrote) expect(y).toBe(x);
    expect(wrote.some(([x]) => x === false)).toBe(true);
    expect(wrote.some(([x]) => x === true)).toBe(true);

    const subjects = Array.from({ length: 13 }, (_, i) => `s_${i}`);
    const queries: Array<[string[], number]> = [
      [subjects, 0],
      [subjects, NOW - 30 * DAY],
      [subjects, NOW - 14 * DAY],
      [subjects, NOW],
      [subjects, NOW + 1],
      [['s_1'], 0],
      [['s_1', 's_2', 's_3'], NOW - 20 * DAY],
      [['s_1', 's_1', 's_2'], 0],
      [['s_nobody'], 0],
      [[], 0],
    ];
    for (const [who, since] of queries) {
      expect(b.listSignalSources?.(who, since), JSON.stringify([who.length, since])).toEqual(a.listSignalSources?.(who, since));
    }
    for (const before of [NOW - 35 * DAY, NOW - 20 * DAY, NOW - 20 * DAY, NOW + 1]) {
      expect(b.purgeSignals?.(before), String(before)).toBe(a.purgeSignals?.(before));
      for (const [who, since] of queries) expect(b.listSignalSources?.(who, since)).toEqual(a.listSignalSources?.(who, since));
    }
    // The cap slots freed by the purge are free in both.
    for (const r of rows.slice(0, 30)) expect(b.insertSignal?.({ ...r, id: `again-${r.id}` })).toBe(a.insertSignal?.({ ...r, id: `again-${r.id}` }));
  });

  it('agree inside a transaction that is undone', () => {
    const a = mem();
    const b = sql();
    const rows = script().slice(0, 40);
    for (const s of [a, b]) {
      for (const r of rows.slice(0, 20)) s.insertSignal?.(r);
      expect(() =>
        s.transaction(() => {
          for (const r of rows.slice(20)) s.insertSignal?.(r);
          s.purgeSignals?.(NOW);
          throw new Error('undo');
        }),
      ).toThrow('undo');
    }
    const subjects = Array.from({ length: 13 }, (_, i) => `s_${i}`);
    expect(b.listSignalSources?.(subjects, 0)).toEqual(a.listSignalSources?.(subjects, 0));
  });
});

describe('the appeal and blocked-name methods: one script, the same answer from both stores', () => {
  const DAY = 86_400_000;
  type Pair = [Store, Store];
  const pair = (): Pair => [mem(), sql()];

  /** Every read the stores answer, as one comparable value. */
  const reads = (s: Store): unknown => ({
    open: s.countOpenAppeals?.(),
    all: s.listAppeals?.({ status: 'all', limit: 200 }),
    decided: s.listAppeals?.({ status: 'decided', limit: 50 }),
    pageOne: s.listAppeals?.({ status: 'all', limit: 7 }),
    pageTwo: s.listAppeals?.({ status: 'all', limit: 7, after: { createdAt: NOW - 20 * DAY, id: 'ap10' } }),
    open7: s.listAppeals?.({ status: 'open', limit: 7 }),
    by: [0, 3, 10].map((k) => s.countAppealsBy?.([`s_${k}`, `s_${k + 1}`, `s_${k + 1}`], NOW - 40 * DAY)),
    none: s.countAppealsBy?.([], 0),
    rules: [NOW - 90 * DAY, NOW - 30 * DAY, NOW].map((t) => [...(s.appealCountsByRule?.(t) ?? [])].sort((a, b) => String(a.rule).localeCompare(String(b.rule)))),
    sanctions: [0, NOW - 60 * DAY, NOW - 10 * DAY].map((t) => [...(s.countSanctionsByRule?.(t) ?? [])].sort((a, b) => String(a.rule).localeCompare(String(b.rule)))),
    subjectRows: ['sg0', 'sg5', 'sg9', 'sg-nope'].map((g) => s.loadSanctionSubjectRow?.(g)),
  });

  const script = (s: Store, log: unknown[]): void => {
    const rules = ['1', '2', '2', null, 'uncovered', '3'];
    for (let i = 0; i < 12; i++) {
      s.insertSanctionGroup([
        {
          id: `sr${i}`, groupId: `sg${i}`, refCode: `M-${String(i).padStart(5, '0')}`, kind: (['chat', 'ban', 'warning', 'area'] as const)[i % 4] ?? 'chat', targetType: 'subject', value: `s_${i % 4}`,
          startsAt: NOW - i * 9 * DAY, endsAt: i % 4 === 1 ? null : NOW - i * 9 * DAY + 5 * DAY, reason: 'r', rule: rules[i % 6] ?? null, gapNote: null, gapStatus: null,
          roomId: null, actor: 'mod', source: i % 3 === 0 ? 'auto_filter' : 'moderator', automated: i % 3 === 0, pending: false, ...(i % 2 === 0 ? { reportId: `rep${i}` } : {}),
        },
        { id: `ip${i}`, groupId: `sg${i}`, refCode: `M-${String(i).padStart(5, '0')}`, kind: 'chat', targetType: 'ip', value: `h${i}`, startsAt: NOW, endsAt: NOW + DAY, reason: 'r', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod', source: 'moderator', automated: false, pending: false },
      ]);
    }
    s.insertSanctionGroup([{ id: 'note', groupId: 'sg-note', refCode: 'M-99999', kind: 'note', targetType: 'subject', value: 's_1', startsAt: NOW, endsAt: NOW, reason: 'r', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod', source: 'moderator', automated: false, pending: false }]);
    for (let i = 0; i < 24; i++) {
      const row = {
        id: `ap${String(i).padStart(2, '0')}`, subject: `s_${i % 12}`, groupId: i < 12 ? `sg${i}` : `gx${i}`, noticeId: `n${i}`, reportId: i % 2 === 0 ? `rep${i}` : null, rule: rules[i % 6] ?? null,
        kind: (['chat', 'ban', 'warning', 'area'] as const)[i % 4] ?? 'chat', statement: `s${i}`, status: 'open' as const, createdAt: NOW - (i % 11) * 4 * DAY, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null,
      };
      log.push(s.insertAppeal?.(row));
    }
    log.push(s.insertAppeal?.({ id: 'dup-group', subject: 's_1', groupId: 'sg3', noticeId: 'x', reportId: null, rule: null, kind: 'chat', statement: null, status: 'open', createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null }));
    const out = ['upheld', 'reduced', 'revoked'] as const;
    for (let i = 0; i < 24; i += 2) {
      log.push(s.decideAppeal?.(`ap${String(i).padStart(2, '0')}`, { status: out[(i / 2) % 3] as 'upheld', at: NOW - (i % 7) * DAY, by: 'bea', reason: 'r', replacementGroupId: (i / 2) % 3 === 1 ? `sg${(i + 5) % 12}` : null, ...(i % 4 === 0 ? { clearStatement: true } : {}) }));
    }
    log.push(s.decideAppeal?.('ap00', { status: 'revoked', at: NOW, by: 'x', reason: 'again', replacementGroupId: null }));
    log.push(s.closeAppealsForGroup?.('sg5', 'cy', NOW - DAY), s.closeAppealsForGroup?.('sg4', 'cy', NOW - DAY), s.closeAppealsForGroup?.('nothing', 'cy', NOW));
    s.revokeSanctionGroup('sg9', 'mod', NOW - 3 * DAY, 'x');
  };

  it('give identical answers after the same writes, and after each purge', () => {
    const [a, b] = pair();
    const la: unknown[] = [];
    const lb: unknown[] = [];
    script(a, la);
    script(b, lb);
    expect(lb).toEqual(la);
    expect(la.includes(false)).toBe(true);
    expect(la.includes(true)).toBe(true);
    expect(reads(b)).toEqual(reads(a));
    for (const [method, arg] of [
      ['clearAppealStatements', NOW - 50 * DAY],
      ['clearAppealStatements', NOW + DAY],
      ['purgeAppeals', NOW - 30 * DAY],
      ['purgeAppeals', NOW - 3 * DAY],
      ['purgeAppeals', NOW + 100 * DAY],
    ] as const) {
      expect(b[method]?.(arg), `${method} ${arg}`).toBe(a[method]?.(arg));
      expect(reads(b), `${method} ${arg}`).toEqual(reads(a));
    }
  });

  it('the orphan close agrees, once a purge of sanctions has removed rows', () => {
    const [a, b] = pair();
    script(a, []);
    script(b, []);
    for (const s of [a, b]) s.purgeSanctions(NOW - 20 * DAY);
    expect(b.closeOrphanAppeals?.('retention', NOW, true)).toBe(a.closeOrphanAppeals?.('retention', NOW, true));
    expect(reads(b)).toEqual(reads(a));
    expect(b.closeOrphanAppeals?.('retention', NOW)).toBe(a.closeOrphanAppeals?.('retention', NOW));
  });

  it('agree inside a transaction that is undone, change token included', () => {
    const [a, b] = pair();
    for (const s of [a, b]) {
      script(s, []);
      const token = s.changeToken();
      expect(() =>
        s.transaction(() => {
          s.insertAppeal?.({ id: 'tx', subject: 's_1', groupId: 'g-tx', noticeId: 'n', reportId: null, rule: '1', kind: 'chat', statement: 'x', status: 'open', createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
          s.closeOrphanAppeals?.('retention', NOW);
          s.purgeAppeals?.(NOW + 1000 * DAY);
          s.clearAppealStatements?.(NOW + 1000 * DAY);
          throw new Error('undo');
        }),
      ).toThrow('undo');
      expect(s.changeToken()).toBe(token);
    }
    expect(reads(b)).toEqual(reads(a));
  });

  it('the notice purge agrees for the four message kinds, seen and unseen, with and without the ceilings', () => {
    const [a, b] = pair();
    const kinds = ['rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked', 'warning', 'report_outcome', 'chat'] as const;
    for (const s of [a, b]) {
      kinds.forEach((kind, i) => {
        for (const [j, age] of [10, 100, 300, 400, 500].entries()) {
          s.insertNotice({
            id: `n-${kind}-${j}`, subject: 's_a', groupId: kind === 'warning' || kind === 'chat' ? `g-${kind}-${j}` : null, kind, rule: null, until: kind === 'chat' ? NOW + DAY : null, refCode: null,
            excerpt: [], createdAt: NOW - age * DAY + i, ackedAt: j % 2 === 0 ? NOW : null, withdrawnAt: null,
          });
        }
      });
    }
    const ids = (s: Store): string[] => s.loadNotices(['s_a']).map((r) => r.id).sort();
    expect(ids(b)).toEqual(ids(a));
    expect(b.purgeNotices(NOW - 90 * DAY)).toBe(a.purgeNotices(NOW - 90 * DAY));
    expect(ids(b)).toEqual(ids(a));
    const ceilings = { appealBefore: NOW - 365 * DAY, renameBefore: NOW - 450 * DAY };
    expect(b.purgeNotices(NOW - 90 * DAY, ceilings)).toBe(a.purgeNotices(NOW - 90 * DAY, ceilings));
    expect(ids(b)).toEqual(ids(a));
    expect(b.purgeNotices(NOW, { appealBefore: NOW, renameBefore: NOW })).toBe(a.purgeNotices(NOW, { appealBefore: NOW, renameBefore: NOW }));
    expect(ids(b)).toEqual(ids(a));
  });

  it('a statement the service has normalized reads back identically from both stores (the stores differ only on text normalizeStatement removes)', () => {
    const [a, b] = pair();
    const inputs = ['plain', 'a\u0000b\uD800c\uDC00d', '\u{1F4AC}'.repeat(40) + '\uD83D', ' a\u200b\u202eb ', 'line\r\n\r\n\r\nline\u2028x', '\u0007'];
    inputs.forEach((raw, i) => {
      const statement = normalizeStatement(raw);
      const row = { id: `nz${i}`, subject: 's_1', groupId: `gnz${i}`, noticeId: 'n', reportId: null, rule: '1', kind: 'chat' as const, statement, status: 'open' as const, createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null };
      expect(a.insertAppeal?.(row)).toBe(true);
      expect(b.insertAppeal?.(row)).toBe(true);
      expect(b.loadAppeal?.(`nz${i}`)?.statement, JSON.stringify(raw)).toBe(a.loadAppeal?.(`nz${i}`)?.statement);
      expect(a.loadAppeal?.(`nz${i}`)?.statement).toBe(statement);
    });
    // what normalization removes is exactly what the stores disagree on: a lone surrogate (memory keeps it, SQLite writes U+FFFD) and a NUL
    expect(normalizeStatement('a\uD800b')).toBe('ab');
    expect(normalizeStatement('a\u0000b')).toBe('ab');
    // eslint-disable-next-line no-control-regex
    expect(normalizeStatement('a\u0000b\uD800c')).not.toMatch(/[\u0000\uD800-\uDFFF]/);
  });

  it('the blocked-name methods agree', () => {
    const [a, b] = pair();
    for (const s of [a, b]) {
      for (let i = 0; i < 30; i++) s.insertBlockedName?.({ id: `b${String(i).padStart(2, '0')}`, subject: i % 4 === 0 ? null : `s_${i % 5}`, name: `quissel${i}`, termId: i % 3 === 0 ? null : 'syn:quissel', reason: i % 2 === 0 ? 'name_not_allowed' : 'name_profane', at: NOW - (i % 10) * DAY });
    }
    for (const [since, limit] of [[0, 200], [NOW - 5 * DAY, 200], [NOW - 5 * DAY, 4], [NOW + 1, 10], [0, 0], [0, 1000]] as const) {
      expect(b.listBlockedNames?.(since, limit), `${since} ${limit}`).toEqual(a.listBlockedNames?.(since, limit));
    }
    for (const before of [NOW - 8 * DAY, NOW - 8 * DAY, NOW - 3 * DAY, NOW + 1]) {
      expect(b.purgeBlockedNames?.(before)).toBe(a.purgeBlockedNames?.(before));
      expect(b.listBlockedNames?.(0, 200)).toEqual(a.listBlockedNames?.(0, 200));
    }
  });
});
