import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  applySanction,
  CommunityRules,
  DecisionService,
  NoticeService,
  purge,
  revokeAndWithdraw,
  SanctionIndex,
  STARTER_RULES,
  SubjectIndex,
  type StoredReport,
} from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';
import { insertOldReport } from './oldRows.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function env() {
  const db = new DatabaseSync(':memory:');
  const store = openStore({ db });
  const subjects = new SubjectIndex(store, { now: () => NOW }, { logger: { warn() {} } });
  return { db, store, subjects };
}

const count = (db: DatabaseSync, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

const report = (id: string, createdAt: number, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt,
  roomId: `ROOM-${id}`,
  tags: { mode: 'ranked' },
  reporterSubject: `s_rep_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: `s_tgt_${id}`,
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: 'rude',
  lineId: 'L1',
  excerpt: [{ lineId: 'L1', ts: NOW - 5, seatId: 'p2', handle: 'Tgt', raw: 'hi', delivered: 'hi', blocked: false, audience: null, p: 0 }],
  people: [`s_tgt_${id}`],
  status: 'open',
  ...over,
});

describe('migration 9: kit_decisions', () => {
  it('is version 9 and creates the table with the documented columns and a report index', () => {
    expect(MIGRATIONS[8]?.version).toBe(9);
    const { db, store } = env();
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(9);
    const info = db.prepare('PRAGMA table_info(kit_decisions)').all();
    expect(info.map((c) => String(c.name))).toEqual(['key', 'report_id', 'at', 'result_json']);
    expect(info.find((c) => c.name === 'key')?.pk).toBe(1);
    const idx = db.prepare('PRAGMA index_list(kit_decisions)').all().map((i) => String(i.name));
    expect(idx).toContain('kit_decisions_by_report');
    db.close();
  });

  it('upgrades a version 8 database without touching its rows', () => {
    const db = new DatabaseSync(':memory:');
    const old = openStore({ db, migrations: MIGRATIONS.slice(0, 8) });
    expect(old.schemaVersion()).toBe(8);
    insertOldReport(db, report('r1', NOW));
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(store.loadReport('r1')?.id).toBe('r1');
    expect(store.findDecision('k')).toBeNull();
    db.close();
  });

  it('a failing migration 9 leaves version 8 and no table', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 8) });
    const broken = [...MIGRATIONS.slice(0, 8), { version: 9, sql: `${MIGRATIONS[8]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    expect(tables).not.toContain('kit_decisions');
    db.close();
  });
});

describe('migration 10: kit_reports.bad_faith_evidence', () => {
  it('is version 10 and adds one nullable TEXT column at the end of kit_reports', () => {
    expect(MIGRATIONS[9]?.version).toBe(10);
    const { db, store } = env();
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    const info = db.prepare('PRAGMA table_info(kit_reports)').all();
    const col = info.find((c) => c.name === 'bad_faith_evidence');
    expect(col).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    // It was the last column when it was added; migration 17 has since added two more after it.
    expect(info.map((c) => String(c.name)).slice(-3)).toEqual(['bad_faith_evidence', 'reported_reason', 'detail_at']);
    db.close();
  });

  it('upgrades a version 9 database keeping every report row; old reports read back with no evidence', () => {
    const db = new DatabaseSync(':memory:');
    const old = openStore({ db, migrations: MIGRATIONS.slice(0, 9) });
    expect(old.schemaVersion()).toBe(9);
    insertOldReport(db, report('r1', NOW));
    insertOldReport(db, report('r2', NOW, { reporterSubject: 's_other', roomId: 'R2' }));
    // K2's closeReport, as SQL: the column does not exist yet.
    db.prepare("UPDATE kit_reports SET status = 'dismissed', bad_faith = 1, actioned_at = ?, actioned_by = 'mod-a', mod_note = 'K2 bad faith' WHERE id = 'r2'").run(NOW + 1);
    old.insertDecision('k2-key-with-old-verdict', 'r2', NOW + 1, JSON.stringify({ groups: [] }));
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    expect(store.loadReport('r1')).toMatchObject({ status: 'open', badFaith: false, badFaithEvidence: null });
    expect(store.loadReport('r2')).toMatchObject({ status: 'dismissed', badFaith: true, actionedBy: 'mod-a', badFaithEvidence: null });
    // a K2 stored decision still replays by its exact key
    expect(store.findDecision('k2-key-with-old-verdict')).toMatchObject({ reportId: 'r2' });
    expect(count(db, 'kit_reports')).toBe(2);
    db.close();
  });

  it('a failing migration 10 leaves version 9 and no new column', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 9) });
    const broken = [...MIGRATIONS.slice(0, 9), { version: 10, sql: `${MIGRATIONS[9]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(db.prepare('PRAGMA table_info(kit_reports)').all().map((c) => String(c.name))).not.toContain('bad_faith_evidence');
    expect(openStore({ db }).schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    db.close();
  });
});

describe('loadReport / closeReport', () => {
  it('loadReport round-trips an open report with null decision columns', () => {
    const { store } = env();
    const r = report('r1', NOW);
    store.insertReport(r);
    expect(store.loadReport('r1')).toEqual({
      ...r,
      reportedReason: null,
      detailAt: null,
      badFaith: false,
      actionedAt: null,
      actionedBy: null,
      modNote: null,
      badFaithEvidence: null,
    });
  });

  it('loadReport is null for an unknown id', () => {
    const { store } = env();
    expect(store.loadReport('nope')).toBeNull();
  });

  it('closeReport closes an open report once: status, bad-faith mark, time, actor and note', () => {
    const { store } = env();
    store.insertReport(report('r1', NOW));
    expect(store.closeReport('r1', 'dismissed', true, 'mod-a', NOW + 5, 'spiteful')).toBe(true);
    expect(store.loadReport('r1')).toMatchObject({
      status: 'dismissed',
      badFaith: true,
      actionedAt: NOW + 5,
      actionedBy: 'mod-a',
      modNote: 'spiteful',
    });
  });

  it('closeReport stores the bad-faith evidence (staff only, returned by loadReport); no evidence reads back null', () => {
    const { store, db } = env();
    store.insertReport(report('r1', NOW));
    store.insertReport(report('r2', NOW, { reporterSubject: 's_other', roomId: 'R2' }));
    expect(store.closeReport('r1', 'dismissed', true, 'mod-a', NOW + 5, 'spiteful', 'same false report three times')).toBe(true);
    expect(store.closeReport('r2', 'dismissed', false, 'mod-a', NOW + 5, 'plain')).toBe(true);
    expect(store.loadReport('r1')).toMatchObject({ badFaith: true, badFaithEvidence: 'same false report three times' });
    expect(store.loadReport('r2')).toMatchObject({ badFaith: false, badFaithEvidence: null });
    expect((db.prepare('SELECT bad_faith_evidence AS e FROM kit_reports WHERE id = ?').get('r2') as { e: unknown }).e).toBeNull();
  });

  it('a second close never overwrites the first evidence', () => {
    const { store } = env();
    store.insertReport(report('r1', NOW));
    expect(store.closeReport('r1', 'dismissed', true, 'mod-a', NOW, 'first', 'first evidence')).toBe(true);
    expect(store.closeReport('r1', 'dismissed', true, 'mod-b', NOW + 1, 'second', 'second evidence')).toBe(false);
    expect(store.loadReport('r1')?.badFaithEvidence).toBe('first evidence');
  });

  it('a second close changes nothing and returns false (first closer wins)', () => {
    const { store } = env();
    store.insertReport(report('r1', NOW));
    expect(store.closeReport('r1', 'actioned', false, 'mod-a', NOW, 'first')).toBe(true);
    expect(store.closeReport('r1', 'dismissed', true, 'mod-b', NOW + 1, 'second')).toBe(false);
    expect(store.loadReport('r1')).toMatchObject({ status: 'actioned', badFaith: false, actionedBy: 'mod-a', modNote: 'first' });
  });

  it('closeReport on an unknown id is false', () => {
    const { store } = env();
    expect(store.closeReport('nope', 'actioned', false, 'mod', NOW, 'n')).toBe(false);
  });

  it('closeReport rejects an invalid status and writes nothing', () => {
    const { store } = env();
    store.insertReport(report('r1', NOW));
    expect(() => store.closeReport('r1', 'open' as never, false, 'mod', NOW, 'n')).toThrow();
    expect(store.loadReport('r1')?.status).toBe('open');
  });

  it('a closed bad-faith report feeds loadBadFaithMarks', () => {
    const { store } = env();
    store.insertReport(report('r1', NOW));
    store.closeReport('r1', 'dismissed', true, 'mod', NOW + 1, 'n');
    expect(store.loadBadFaithMarks(NOW)).toEqual([{ reporter: 's_rep_r1', actionedAt: NOW + 1 }]);
  });

  it('a close rolls back with the surrounding transaction', () => {
    const { store } = env();
    store.insertReport(report('r1', NOW));
    expect(() =>
      store.transaction(() => {
        store.closeReport('r1', 'actioned', false, 'mod', NOW, 'n');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.loadReport('r1')?.status).toBe('open');
  });
});

describe('insertDecision / findDecision', () => {
  it('stores and finds a decision', () => {
    const { store } = env();
    store.insertDecision('k1', 'r1', NOW, '{"groups":[]}');
    expect(store.findDecision('k1')).toEqual({ key: 'k1', reportId: 'r1', at: NOW, resultJson: '{"groups":[]}' });
    expect(store.findDecision('k2')).toBeNull();
  });

  it('a duplicate key throws and leaves the first row alone', () => {
    const { store } = env();
    store.insertDecision('k1', 'r1', NOW, 'a');
    expect(() => store.insertDecision('k1', 'r2', NOW + 1, 'b')).toThrow();
    expect(store.findDecision('k1')).toMatchObject({ reportId: 'r1', resultJson: 'a' });
  });

  it('rolls back with the surrounding transaction', () => {
    const { store } = env();
    expect(() =>
      store.transaction(() => {
        store.insertDecision('k1', 'r1', NOW, 'a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.findDecision('k1')).toBeNull();
  });
});

describe('purge against SQLite: bad-faith marks, decisions and open gaps', () => {
  it('spares a live bad-faith mark past the 90 d cutoff; a plain dismissal and an expired mark go', async () => {
    const { db, store } = env();
    for (const id of ['live', 'edge', 'old', 'plain']) store.insertReport(report(id, NOW - 100 * DAY));
    store.closeReport('live', 'dismissed', true, 'mod', NOW - 10 * DAY, 'n');
    store.closeReport('edge', 'dismissed', true, 'mod', NOW - 30 * DAY, 'n');
    store.closeReport('old', 'dismissed', true, 'mod', NOW - 30 * DAY - 1, 'n');
    store.closeReport('plain', 'dismissed', false, 'mod', NOW - DAY, 'n');
    expect((await purge(store, NOW)).reports).toBe(2);
    expect(db.prepare('SELECT id FROM kit_reports ORDER BY id').all().map((r) => r.id)).toEqual(['edge', 'live']);
  });

  it('badFaithMs moves the window', async () => {
    const { store } = env();
    store.insertReport(report('a', NOW - 100 * DAY));
    store.closeReport('a', 'dismissed', true, 'mod', NOW - 40 * DAY, 'n');
    expect((await purge(store, NOW, { badFaithMs: 45 * DAY })).reports).toBe(0);
    expect((await purge(store, NOW, { badFaithMs: 39 * DAY })).reports).toBe(1);
  });

  it('a bad-faith row with a null actioned_at is not spared', async () => {
    const { db, store } = env();
    store.insertReport(report('a', NOW - 100 * DAY));
    db.prepare('UPDATE kit_reports SET bad_faith = 1 WHERE id = ?').run('a');
    expect((await purge(store, NOW)).reports).toBe(1);
  });

  it('deletes the decisions of purged reports and keeps those of kept ones', async () => {
    const { db, store } = env();
    store.insertReport(report('gone', NOW - 100 * DAY));
    store.insertReport(report('spared', NOW - 100 * DAY));
    store.insertReport(report('fresh', NOW - DAY));
    store.closeReport('spared', 'dismissed', true, 'mod', NOW - DAY, 'n');
    store.insertDecision('k-gone', 'gone', NOW - 100 * DAY, '{}');
    store.insertDecision('k-spared', 'spared', NOW - DAY, '{}');
    store.insertDecision('k-fresh', 'fresh', NOW - DAY, '{}');
    await purge(store, NOW);
    expect(db.prepare('SELECT key FROM kit_decisions ORDER BY key').all().map((r) => r.key)).toEqual(['k-fresh', 'k-spared']);
  });

  it('a purge that deletes no report leaves every decision', async () => {
    const { db, store } = env();
    store.insertDecision('orphan', 'no-such-report', NOW, '{}');
    await purge(store, NOW);
    expect(count(db, 'kit_decisions')).toBe(1);
  });

  it('spares an old ended sanction with an open gap; purges it once the gap is closed', async () => {
    const { db, store, subjects } = env();
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: null });
    if (s === null) throw new Error('expected a subject');
    const gap = await applySanction(
      store,
      subjects,
      { kind: 'chat', subject: s, includeIp: false, durationMs: DAY, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 'uncovered', gapNote: 'no rule fits' },
      NOW - 200 * DAY,
    );
    await applySanction(
      store,
      subjects,
      { kind: 'chat', subject: s, includeIp: false, durationMs: DAY, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 1 },
      NOW - 200 * DAY,
    );
    expect((await purge(store, NOW)).sanctions).toBe(1);
    expect(count(db, 'kit_sanctions')).toBe(1);
    expect(store.closeGap(gap.groupId, 'ruled', '9', 'mod', NOW)).toBe(true);
    expect((await purge(store, NOW)).sanctions).toBe(1);
    expect(count(db, 'kit_sanctions')).toBe(0);
  });
});

describe('DecisionService against SQLite', () => {
  function decideEnv() {
    const e = env();
    const clock = { now: () => NOW };
    const index = new SanctionIndex({ enabled: () => true, subjects: e.subjects });
    const notices = new NoticeService({ store: e.store, subjects: e.subjects, rules: new CommunityRules(STARTER_RULES), clock, logger: { warn() {} } });
    const decisions = new DecisionService({
      store: e.store,
      subjects: e.subjects,
      rules: new CommunityRules(STARTER_RULES),
      notices,
      clock,
      index,
      logger: { warn() {} },
    });
    const who = (k: string) => {
      const sub = e.subjects.resolve({ clientKey: k, accountId: null, ipHash: null });
      if (sub === null) throw new Error('expected a subject');
      return sub;
    };
    const reporter = who('rep');
    const target = who('tgt');
    e.store.insertReport(
      report('r1', NOW - DAY, {
        reporterSubject: reporter,
        targetSubject: target,
        people: [target],
        excerpt: [{ lineId: 'L1', ts: NOW - 5, seatId: 'p2', handle: 'Tgt', raw: 'hello', delivered: 'hello', blocked: false, audience: null, p: 0 }],
      }),
    );
    return { ...e, index, notices, decisions, reporter, target };
  }

  it('an upheld decision closes the report, writes the sanction, the notices and the decision row; a repeat is a replay', async () => {
    const e = decideEnv();
    const input = {
      reportId: 'r1',
      verdict: 'upheld' as const,
      actions: [{ subject: e.target, kind: 'chat' as const, durationMs: DAY, rule: 2, lineIds: ['L1'] }],
      actor: 'mod',
      reason: 'clear',
    };
    const first = await e.decisions.decide(input);
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(e.store.loadReport('r1')).toMatchObject({ status: 'actioned', actionedBy: 'mod', modNote: 'clear' });
    expect(count(e.db, 'kit_sanctions')).toBe(1);
    expect(count(e.db, 'kit_notices')).toBe(2);
    expect(count(e.db, 'kit_decisions')).toBe(1);
    expect(e.notices.pending(e.target)[0]?.excerpt.map((l) => l.text)).toEqual(['hello']);

    const second = await e.decisions.decide(input);
    expect(second).toMatchObject({ ok: true, replay: true });
    expect(second.ok && first.ok && second.groups).toEqual(first.ok && first.groups);
    expect(count(e.db, 'kit_sanctions')).toBe(1);
    expect(count(e.db, 'kit_notices')).toBe(2);
    expect(await e.decisions.decide({ ...input, verdict: 'no_action', actions: [] })).toEqual({ ok: false, error: 'already_decided' });
  });

  it('a failure part-way rolls the whole decision back in SQLite', async () => {
    const e = decideEnv();
    let calls = 0;
    const real = e.store.insertNotice.bind(e.store);
    e.store.insertNotice = (row) => {
      if (++calls === 2) throw new Error('disk full'); // the reporter outcome
      real(row);
    };
    await expect(
      e.decisions.decide({
        reportId: 'r1',
        verdict: 'upheld',
        actions: [{ subject: e.target, kind: 'ban', durationMs: null, rule: 1 }],
        actor: 'mod',
        reason: 'clear',
      }),
    ).rejects.toThrow('disk full');
    expect(e.store.loadReport('r1')?.status).toBe('open');
    expect(count(e.db, 'kit_sanctions')).toBe(0);
    expect(count(e.db, 'kit_notices')).toBe(0);
    expect(count(e.db, 'kit_decisions')).toBe(0);
    expect(e.index.active('ban', { clientKey: null, accountId: null, ipHash: null }, e.target, NOW)).toBeNull();
  });

  it('revokeAndWithdraw revokes the rows and withdraws the notice together', async () => {
    const e = decideEnv();
    const res = await e.decisions.decide({
      reportId: 'r1',
      verdict: 'upheld',
      actions: [{ subject: e.target, kind: 'warning', durationMs: null, rule: 3 }],
      actor: 'mod',
      reason: 'clear',
    });
    if (!res.ok) throw new Error('expected ok');
    const out = await revokeAndWithdraw(e.store, res.groups[0]?.groupId ?? '', 'mod2', 'appeal', {
      notices: e.notices,
      clock: { now: () => NOW },
      index: e.index,
    });
    expect(out).toEqual({ revoked: true, withdrawn: 1 });
    expect(e.notices.pending(e.target)).toEqual([]);
    expect(Number((e.db.prepare('SELECT COUNT(*) AS n FROM kit_sanctions WHERE revoked_at IS NOT NULL').get() as { n: number }).n)).toBe(1);
  });

  it('three bad-faith decisions leave marks the reporter suspension reads', async () => {
    const e = decideEnv();
    for (const id of ['b1', 'b2']) {
      e.store.insertReport(report(id, NOW - DAY, { reporterSubject: e.reporter, targetSubject: `s_x_${id}`, roomId: `R-${id}`, people: [] }));
    }
    for (const id of ['r1', 'b1', 'b2']) {
      expect(await e.decisions.decide({ reportId: id, verdict: 'bad_faith', evidence: 'repeat false reports', actions: [], actor: 'mod', reason: 'spite' })).toMatchObject({ ok: true });
    }
    expect(e.store.loadBadFaithMarks(NOW - 30 * DAY).filter((m) => m.reporter === e.reporter)).toHaveLength(3);
  });
});
