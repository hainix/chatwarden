import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AIRead, AiReadDone, AiReadPending } from '@chatwarden/core';
import { openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// What is specific to SQLite in the AI methods: the plans the indexes of migration 20 give, two connections racing for one read,
// and rows damaged by hand. The behaviour both stores share is in the shared contract suite (test/contract/ai.contract.ts).

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const memDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
};
const fileDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-ai-store-'));
  dirs.push(d);
  return join(d, 'kit.db');
};
const open = (path: string): SqliteStore => {
  const s = openStore({ path });
  stores.push(s);
  return s;
};

const pending = (over: Partial<AiReadPending> = {}): AiReadPending => ({ reportId: 'r1', inputHash: 'h1', promptVersion: 1, adapter: 'fake:one', ...over });
const read = (over: Partial<AIRead> = {}): AIRead => ({
  severity: 'rude',
  rule: 2,
  summary: 'P1 was rude to P2.',
  evidence: ['L1'],
  confidence: 'medium',
  injectionSuspected: false,
  recommendation: null,
  ...over,
});
const done = (r: AIRead = read()): AiReadDone => ({
  read: r,
  model: 'm',
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicros: 10,
  latencyMs: 5,
});
/** The lease token of every row reserved here, by row id (what completeAiRead and failAiRead must be given). */
const leases = new Map<string, number>();
const reserve = (s: SqliteStore, over: Partial<AiReadPending> = {}, now = NOW, lease = now + 5 * MIN): string => {
  const r = s.reserveAiRead(pending(over), lease, now);
  if (!r.reserved) throw new Error('expected a reservation');
  leases.set(r.id, r.lease);
  return r.id;
};
const complete = (s: SqliteStore, id: string, d: AiReadDone): boolean => s.completeAiRead(id, leases.get(id) ?? 0, d);

/** The statements the store prepares while `run` executes: SQL text plus the arguments it was run with. */
type Seen = { sql: string; args: SQLInputValue[] };
function record(db: DatabaseSync, run: () => void): Seen[] {
  const seen: Seen[] = [];
  const orig = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = orig(sql);
    for (const m of ['all', 'get', 'run'] as const) {
      const f = stmt[m].bind(stmt) as (...a: SQLInputValue[]) => unknown;
      (stmt as unknown as Record<string, unknown>)[m] = (...args: SQLInputValue[]) => {
        seen.push({ sql, args });
        return f(...args);
      };
    }
    return stmt;
  };
  try {
    run();
  } finally {
    delete (db as { prepare?: unknown }).prepare;
  }
  return seen;
}
const planOf = (db: DatabaseSync, hit: Seen): string[] => db.prepare(`EXPLAIN QUERY PLAN ${hit.sql}`).all(...hit.args).map((r) => String(r.detail));
const find = (seen: Seen[], table: string): Seen => {
  const hit = seen.find((h) => h.sql.includes(table));
  if (hit === undefined) throw new Error(`no statement on ${table}: ${JSON.stringify(seen.map((s) => s.sql))}`);
  return hit;
};

/** A store with a few hundred reads and some outcomes, so a plan is not decided by an empty table. */
function seeded(): { db: DatabaseSync; store: SqliteStore } {
  const db = memDb();
  const store = openStore({ db });
  stores.push(store);
  for (let i = 0; i < 300; i++) {
    const id = reserve(store, { reportId: `rep${i % 120}`, inputHash: `h${i}` }, NOW - (i % 50) * 3600_000);
    if (i % 3 === 0) complete(store, id, done());
    else if (i % 3 === 1) store.failAiRead(id, leases.get(id) ?? 0, 'failed', 'retryable', NOW + i * MIN);
  }
  return { db, store };
}

describe('query plans use the indexes of migration 20', () => {
  it("EXPLAIN QUERY PLAN: today's spend uses kit_ai_spend_by_time (the per-attempt ledger)", () => {
    const { db, store } = seeded();
    const hit = find(record(db, () => store.aiSpendSince(NOW - DAY)), 'kit_ai_spend');
    expect(planOf(db, hit).join('\n')).toMatch(/USING (COVERING )?INDEX kit_ai_spend_by_time/);
    expect(planOf(db, hit).join('\n')).not.toMatch(/SCAN kit_ai_spend(?! USING)/);
  });

  it('the sweeper query uses kit_ai_reads_retry', () => {
    const { db, store } = seeded();
    const seen = record(db, () => store.listAiRetries(NOW + 100 * MIN, 20));
    const plan = planOf(db, find(seen, 'kit_ai_reads')).join('\n');
    expect(plan).toMatch(/USING (COVERING )?INDEX kit_ai_reads_retry/);
    expect(plan).not.toMatch(/SCAN kit_ai_reads(?! USING)/);
  });

  it('loadAiReads uses kit_ai_reads_by_report', () => {
    const { db, store } = seeded();
    const seen = record(db, () => store.loadAiReads(['rep1', 'rep2', 'rep3', 'rep4']));
    const plan = planOf(db, find(seen, 'kit_ai_reads')).join('\n');
    expect(plan).toMatch(/USING (COVERING )?INDEX kit_ai_reads_by_report/);
    expect(plan).not.toMatch(/SCAN kit_ai_reads(?! USING)/);
  });

  it('loadAiRead uses kit_ai_reads_by_report', () => {
    const { db, store } = seeded();
    const seen = record(db, () => store.loadAiRead('rep3'));
    expect(planOf(db, find(seen, 'kit_ai_reads')).join('\n')).toMatch(/USING (COVERING )?INDEX kit_ai_reads_by_report/);
  });

  it('the reserve conflict check is the UNIQUE index (no table scan)', () => {
    const { db, store } = seeded();
    const seen = record(db, () => store.reserveAiRead(pending({ reportId: 'rep1', inputHash: 'h1' }), NOW + MIN, NOW));
    for (const hit of seen.filter((h) => /FROM kit_ai_reads/.test(h.sql) && /^\s*SELECT/i.test(h.sql))) {
      expect(planOf(db, hit).join('\n')).not.toMatch(/SCAN kit_ai_reads(?! USING)/);
    }
  });

  it('the retention purge of reads is answered from kit_ai_reads_by_time (and the ledger from kit_ai_spend_by_time)', () => {
    const { db, store } = seeded();
    const hit = find(record(db, () => store.purgeAi(NOW - 90 * DAY, NOW - 365 * DAY, NOW - 180 * DAY)), 'DELETE FROM kit_ai_reads');
    expect(planOf(db, hit).join('\n')).toMatch(/INDEX kit_ai_reads_by_time/);
  });

  it('the ledger sweep of the purge is answered from kit_ai_spend_by_time', () => {
    const { db, store } = seeded();
    const hit = find(record(db, () => store.purgeAi(NOW - 90 * DAY, NOW - 365 * DAY, NOW - 180 * DAY)), 'DELETE FROM kit_ai_spend');
    expect(planOf(db, hit).join('\n')).toMatch(/INDEX kit_ai_spend_by_time/);
  });

  it('the examples query uses kit_ai_outcomes_by_rule', () => {
    const db = memDb();
    const store = openStore({ db });
    stores.push(store);
    for (let i = 0; i < 200; i++) {
      store.insertAiOutcome({
        reportId: `o${i}`,
        readId: null,
        decidedAt: NOW - i * 1000,
        level: 2,
        verdict: 'upheld',
        rule: String(i % 12),
        severity: 'hostile',
        aiVerdict: 'upheld',
        agreement: 'agree',
        detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
        badFaith: false,
        example: { rule: i % 12, severity: 'hostile', verdict: 'upheld', lines: [{ who: 'P1', text: 'zorbak' }] },
      });
    }
    const seen = record(db, () => store.aiExamples('3', 'hostile', 2, 0));
    expect(planOf(db, find(seen, 'kit_ai_outcomes')).join('\n')).toMatch(/INDEX kit_ai_outcomes_by_rule/);
  });
});

// node:sqlite is synchronous and these tests run in one process, so the calls below happen one after the other: they prove that two
// connections on one file see each other's writes and that the UNIQUE index and the conditional UPDATE leave exactly one winner, not
// a true interleaving. (The reserve statements run in one savepoint that starts with a write, which is what holds the lock.)
describe('two connections on one file, one call after the other', () => {
  it('two connections reserving the same report and hash in turn: exactly one wins', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const first = a.reserveAiRead(pending(), NOW + 5 * MIN, NOW);
    const second = b.reserveAiRead(pending(), NOW + 5 * MIN, NOW);
    expect([first.reserved, second.reserved].filter(Boolean)).toHaveLength(1);
    expect(first.reserved).toBe(true);
    if (first.reserved && !second.reserved) expect(second.existing.id).toBe(first.id);
    expect(a.aiSpendSince(0).calls).toBe(1);
    expect(b.aiSpendSince(0).calls).toBe(1);
  });

  it('two connections trying an expired lease in turn: exactly one takes it', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const id = reserve(a, {}, NOW, NOW + MIN);
    const later = NOW + 2 * MIN;
    const ra = a.reserveAiRead(pending(), later + 5 * MIN, later);
    const rb = b.reserveAiRead(pending(), later + 5 * MIN, later + 1);
    expect([ra.reserved, rb.reserved].filter(Boolean)).toHaveLength(1);
    const winner = ra.reserved ? ra : rb;
    expect(winner).toEqual({ reserved: true, id, lease: 2 });
    expect(a.listAiRetries(later + 2, 10)).toEqual([]);
  });

  it('a completion by one connection is seen by the other, and moves the shared change token', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const id = reserve(a);
    const before = b.changeToken();
    expect(complete(a, id, done())).toBe(true);
    expect(b.changeToken()).not.toBe(before);
    expect(b.loadAiRead('r1')?.id).toBe(id);
    // The other process cannot complete it a second time.
    expect(b.completeAiRead(id, 1, done(read({ summary: 'again' })))).toBe(false);
    expect(b.loadAiRead('r1')?.read?.summary).toBe('P1 was rude to P2.');
  });

  it('the retake marker is on the row in the file: another connection, and a reopened file, refuse a second retake', () => {
    const path = fileDb();
    const a = open(path);
    const id = reserve(a);
    expect(a.failAiRead(id, 1, 'declined', 'declined', null)).toBe(true);
    expect(a.reserveAiRead(pending(), NOW + 9 * MIN, NOW + MIN, { retake: true })).toEqual({ reserved: true, id, lease: 2 });
    expect(a.failAiRead(id, 2, 'declined', 'declined', null)).toBe(true);
    const b = open(path);
    const refused = b.reserveAiRead(pending(), NOW + 9 * MIN, NOW + 2 * MIN, { retake: true });
    expect(refused.reserved).toBe(false);
    a.close();
    stores.splice(stores.indexOf(a), 1);
    const c = open(path);
    const again = c.reserveAiRead(pending(), NOW + 9 * MIN, NOW + 3 * MIN, { retake: true });
    expect(again.reserved).toBe(false);
    if (!again.reserved) expect(again.existing).toMatchObject({ attempts: 2, retaken: true, status: 'declined' });
    expect(c.aiSpendSince(0).calls).toBe(2);
  });

  it('a retake and an ordinary take-over of the same final row in turn: exactly one wins, and only the retake sets the marker', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const id = reserve(a);
    expect(a.failAiRead(id, 1, 'invalid', 'invalid', null)).toBe(true);
    const ra = a.reserveAiRead(pending(), NOW + 9 * MIN, NOW + MIN, { retake: true });
    const rb = b.reserveAiRead(pending(), NOW + 9 * MIN, NOW + MIN, { retake: true });
    expect([ra.reserved, rb.reserved]).toEqual([true, false]);
    expect(b.loadAiReadFor('r1', 'h1')).toMatchObject({ retaken: true, attempts: 2 });
  });

  it('spend adds up across connections', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    complete(a, reserve(a, { reportId: 'x' }), done());
    complete(b, reserve(b, { reportId: 'y' }), done());
    expect(a.aiSpendSince(NOW - 1)).toEqual({ micros: 20, calls: 2 });
  });
});

describe('rows damaged by hand never break a read', () => {
  it('an unreadable read row is skipped by loadAiRead and loadAiReads, and an older good one is returned', () => {
    const db = memDb();
    const store = openStore({ db });
    stores.push(store);
    const good = reserve(store, { inputHash: 'good' }, NOW);
    complete(store, good, done());
    const bad = reserve(store, { inputHash: 'bad' }, NOW + MIN);
    complete(store, bad, done());
    db.prepare('UPDATE kit_ai_reads SET evidence_json = ? WHERE id = ?').run('not json', bad);
    expect(store.loadAiRead('r1')?.id).toBe(good);
    expect(store.loadAiReads(['r1']).map((r) => r.id)).toEqual([good]);
  });

  it('a read with an unknown severity or rule text is treated as unreadable', () => {
    const db = memDb();
    const store = openStore({ db });
    stores.push(store);
    const id = reserve(store);
    complete(store, id, done());
    db.prepare("UPDATE kit_ai_reads SET rule = 'banana' WHERE id = ?").run(id);
    expect(store.loadAiRead('r1')).toBeNull();
    db.prepare("UPDATE kit_ai_reads SET rule = '2', severity = 'nuclear' WHERE id = ?").run(id);
    expect(store.loadAiRead('r1')).toBeNull();
  });

  it('reserve on a hand-damaged ok row does not throw: the row is taken over for a fresh read', () => {
    const db = memDb();
    const store = openStore({ db });
    stores.push(store);
    const id = reserve(store);
    complete(store, id, done());
    db.prepare("UPDATE kit_ai_reads SET evidence_json = 'not json' WHERE id = ?").run(id);
    expect(store.loadAiRead('r1')).toBeNull();
    const again = store.reserveAiRead(pending(), NOW + 9 * MIN, NOW + MIN);
    expect(again).toEqual({ reserved: true, id, lease: 2 });
    expect(store.completeAiRead(id, 2, done(read({ summary: 'fresh' })))).toBe(true);
    expect(store.loadAiRead('r1')?.read?.summary).toBe('fresh');
    expect(store.aiSpendSince(0).calls).toBe(2);
  });

  it('an outcome with unreadable detail still loads (empty detail) and an unreadable example is not an example', () => {
    const db = memDb();
    const store = openStore({ db });
    stores.push(store);
    store.insertAiOutcome({
      reportId: 'o1',
      readId: null,
      decidedAt: NOW,
      level: 2,
      verdict: 'upheld',
      rule: '3',
      severity: 'hostile',
      aiVerdict: 'upheld',
      agreement: 'agree',
      detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false },
      badFaith: false,
      example: { rule: 3, severity: 'hostile', verdict: 'upheld', lines: [{ who: 'P1', text: 'zorbak' }] },
    });
    db.prepare("UPDATE kit_ai_outcomes SET detail_json = '{{', example_json = '[1' WHERE report_id = 'o1'").run();
    expect(store.loadAiOutcome('o1')).toMatchObject({ detail: { verdict: false, rule: false, lines: 0, outcome: 'none', oneClick: false }, example: null, verdict: 'upheld' });
    expect(store.aiExamples('3', 'hostile', 5, 0)).toEqual([]);
    // The stats still answer: a detail nobody can read is not a one-click accept.
    expect(store.aiStats(0)).toEqual([{ rule: '3', decided: 1, agree: 1, override: 0, none: 0, falsePositives: 0, oneClick: 0 }]);
  });
});
