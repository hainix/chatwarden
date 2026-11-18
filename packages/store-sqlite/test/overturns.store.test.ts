import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { OverturnInput, SanctionRow, StoredReport } from '@chatwarden/core';
import { openStore } from '../src/index.js';
import { latestAutoChatStartSql, OVERTURN_FILTER_COUNTS_SQL, OVERTURN_PURGE_SQL, OVERTURN_TERM_COUNTS_SQL } from '../src/sqliteStore.js';
import { seedWorld } from '../../../test/contract/privacy.contract.js';

// What only the SQLite store can show about the overturn methods: the raw rows, the query plans, the chunked list and the erase's unlink of report ids.
// The behaviour the two stores share is in test/contract/overturns.contract.ts.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});
const open = () => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return { db, store: openStore({ db }) };
};
const sanction = (groupId: string, refCode: string, over: Partial<SanctionRow> = {}): SanctionRow => ({
  id: `id-${groupId}-${over.targetType ?? 'subject'}`,
  groupId,
  refCode,
  kind: 'chat',
  targetType: 'subject',
  value: 's_a',
  startsAt: NOW,
  endsAt: NOW + 1000,
  reason: 'private',
  rule: '2',
  gapNote: null,
  gapStatus: null,
  roomId: null,
  actor: 'chat_filter',
  source: 'auto_filter',
  automated: true,
  pending: false,
  ...over,
});
const report = (id: string): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: 's_rep',
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_a',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'spam',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
});
const input = (over: Partial<OverturnInput> = {}): OverturnInput => ({
  groupId: 'g1',
  at: NOW + DAY,
  subject: 's_a',
  aliases: ['s_a'],
  source: 'auto_filter',
  termId: 'term1',
  filterKey: null,
  reportId: null,
  strikes: null,
  ...over,
});
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();

describe('recordOverturn on SQLite', () => {
  it('writes the row as given and marks every row of the group (the address row too) with the one time', () => {
    const { db, store } = open();
    store.insertSanctionGroup([sanction('g1', 'M-AAAAA'), sanction('g1', 'M-AAAAA', { targetType: 'ip', value: 'iphash' })]);
    expect(store.recordOverturn?.(input({ filterKey: 'fk', reportId: 'r-unknown' }))).toBe(true);
    expect(rows(db, 'kit_overturns')).toEqual([
      { group_id: 'g1', at: NOW + DAY, subject_id: 's_a', source: 'auto_filter', term_id: 'term1', filter_key: 'fk', report_id: 'r-unknown' },
    ]);
    expect(db.prepare('SELECT overturned_at FROM kit_sanctions ORDER BY rowid').all()).toEqual([{ overturned_at: NOW + DAY }, { overturned_at: NOW + DAY }]);
  });

  it('a second call changes no column: the report, the sanction and the row keep their first values', () => {
    const { db, store } = open();
    store.insertSanctionGroup([sanction('g1', 'M-AAAAA')]);
    store.insertReport(report('r1'));
    store.recordOverturn?.(input({ reportId: 'r1' }));
    const first = [rows(db, 'kit_overturns'), rows(db, 'kit_sanctions'), rows(db, 'kit_reports')];
    expect(store.recordOverturn?.(input({ at: NOW + 9 * DAY, reportId: 'r1', termId: 'other' }))).toBe(false);
    expect([rows(db, 'kit_overturns'), rows(db, 'kit_sanctions'), rows(db, 'kit_reports')]).toEqual(first);
    expect(db.prepare('SELECT overturned_at FROM kit_reports').get()).toEqual({ overturned_at: NOW + DAY });
  });

  it('marks the strikes of every alias in the window with the flag and leaves the rows themselves', () => {
    const { db, store } = open();
    store.insertStrike({ id: 'k1', at: NOW - 5, subject: 's_a', roomId: 'R', termId: 't', rawLine: 'x' });
    store.insertStrike({ id: 'k2', at: NOW - 5, subject: 's_b', roomId: 'R', termId: 't', rawLine: 'x' });
    store.insertStrike({ id: 'k3', at: NOW - 5, subject: 's_c', roomId: 'R', termId: 't', rawLine: 'x' });
    store.recordOverturn?.(input({ aliases: ['s_a', 's_b'], strikes: { from: NOW - 10, to: NOW } }));
    expect(db.prepare('SELECT id, overturned FROM kit_strikes ORDER BY id').all()).toEqual([
      { id: 'k1', overturned: 1 },
      { id: 'k2', overturned: 1 },
      { id: 'k3', overturned: 0 },
    ]);
  });
});

describe('the reads on SQLite', () => {
  it('latestAutoChatStart is answered through the target index by the planner itself: no index hint, no scan of kit_sanctions', () => {
    const { db, store } = open();
    for (let i = 0; i < 50; i++) store.insertSanctionGroup([sanction(`g${i}`, `M-${String(i).padStart(5, '0')}`, { value: `s_${i}`, startsAt: NOW + i })]);
    // The exported builder is what the store prepares: the plan is read from it, not from a copy.
    const text = latestAutoChatStartSql(2);
    expect(text).not.toMatch(/INDEXED\s+BY/i);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${text}`).all('s_3', 's_7').map((r) => String(r.detail)).join(' | ');
    expect(plan).toMatch(/USING (COVERING )?INDEX kit_sanctions_by_target/);
    expect(plan).not.toMatch(/SCAN kit_sanctions/);
    expect(plan).not.toMatch(/kit_sanctions_by_start/);
    expect(store.latestAutoChatStart?.(['s_3', 's_7'])).toBe(NOW + 7);
  });

  it('latestAutoChatStart does not hard-fail when the target index is gone (a later migration or a host dropped it): it answers, only slower', () => {
    const { db, store } = open();
    store.insertSanctionGroup([sanction('g1', 'M-AAAAA', { value: 's_x', startsAt: NOW + 5 })]);
    db.exec('DROP INDEX kit_sanctions_by_target');
    expect(store.latestAutoChatStart?.(['s_x'])).toBe(NOW + 5);
    expect(store.latestAutoChatStart?.(['nobody'])).toBeNull();
  });

  it('loadStrikes with the flag still reads through the time index and needs no sort', () => {
    const { db, store } = open();
    for (let i = 0; i < 30; i++) store.insertStrike({ id: `k${i}`, at: NOW + i, subject: 's_a', roomId: 'R', termId: 't', rawLine: 'x' });
    const seen: string[] = [];
    const real = db.prepare.bind(db);
    db.prepare = ((text: string) => {
      seen.push(text);
      return real(text);
    }) as typeof db.prepare;
    store.loadStrikes(NOW);
    db.prepare = real as typeof db.prepare;
    const sql = seen.find((t) => t.includes('FROM kit_strikes'));
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(NOW).map((r) => String(r.detail)).join(' | ');
    expect(plan).toMatch(/kit_strikes_by_at/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it('the term and filter counts are answered through their partial indexes (the exported statements)', () => {
    const { db } = open();
    for (const [sql, index] of [[OVERTURN_TERM_COUNTS_SQL, 'kit_overturns_by_term'], [OVERTURN_FILTER_COUNTS_SQL, 'kit_overturns_by_filter']] as const) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0).map((r) => String(r.detail)).join(' | ');
      expect(plan, sql).toContain(index);
    }
  });
});

describe('the erase on SQLite', () => {
  it('an erase that deletes a report clears report_id on the overturn rows of people who stay, and deletes the erased person\'s rows', async () => {
    const { db, store } = open();
    await seedWorld(store, { held: true });
    expect(db.prepare('SELECT group_id, report_id FROM kit_overturns ORDER BY group_id').all()).toEqual([
      { group_id: 'gEnded', report_id: 'rAbout' },
      { group_id: 'gHeld', report_id: 'rHeld' },
      { group_id: 'gQ', report_id: 'rAbout' },
    ]);
    store.eraseSubjects({ subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(['rHeld']), receiptId: 'e_ov', at: NOW });
    expect(db.prepare('SELECT group_id, subject_id, report_id FROM kit_overturns ORDER BY group_id').all()).toEqual([
      { group_id: 'gHeld', subject_id: 's_pp', report_id: 'rHeld' },
      { group_id: 'gQ', subject_id: 's_qq', report_id: null },
    ]);
  });

  it('a dry run leaves the overturn rows and their report ids as they were', async () => {
    const { db, store } = open();
    await seedWorld(store);
    const before = rows(db, 'kit_overturns');
    store.eraseSubjects({ subjects: ['s_pp'], mode: 'none', heldReportIds: new Set(), receiptId: 'e_dry', at: NOW, dryRun: true });
    expect(rows(db, 'kit_overturns')).toEqual(before);
  });

  it('the export joins the overturn time onto each appeal and returns null without one', async () => {
    const { store } = open();
    await seedWorld(store);
    expect(store.exportSubjects(['s_pp', 's_pp2']).appeals.map((a) => a.overturnedAt)).toEqual([NOW - 500]);
    expect(store.exportSubjects(['s_xx']).appeals).toEqual([]);
  });
});

describe('purgeOverturns on SQLite', () => {
  it('the retention delete is answered through the time index', () => {
    const { db } = open();
    // The exported statement itself, with the hold filter: it must still start from the time index.
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${OVERTURN_PURGE_SQL}`).all(1).map((r) => String(r.detail)).join(' | ');
    expect(plan).toContain('kit_overturns_by_at');
    expect(OVERTURN_PURGE_SQL).toContain('NOT IN (SELECT group_id FROM kit_sanctions');
  });

  it('keeps the overturn row of a held group in the table itself, and deletes the rest', () => {
    const { db, store } = open();
    store.insertSanctionGroup([sanction('gh', 'M-HHHHH', { reportId: 'rh' }), sanction('gu', 'M-UUUUU', { reportId: 'ru' })]);
    store.recordOverturn?.(input({ groupId: 'gh', reportId: null, termId: 'th', strikes: null, at: NOW }));
    store.recordOverturn?.(input({ groupId: 'gu', reportId: null, termId: 'tu', strikes: null, at: NOW }));
    store.placeHold({ reportId: 'rh', code: 'legal_proceeding', heldBy: 'senior_a', heldAt: NOW, releasedBy: null, releasedAt: null });
    expect(store.purgeOverturns?.(NOW + DAY)).toBe(1);
    expect(db.prepare('SELECT group_id FROM kit_overturns').all()).toEqual([{ group_id: 'gh' }]);
  });
});
