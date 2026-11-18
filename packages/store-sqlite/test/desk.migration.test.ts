import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 26, the urgent-lane and desk block (spec section 13): the `kit_reports` columns for urgent, evidence, hand-off and escalation, the partial index, the
// comment table and the daily line counts. Shared migration: assertions are about the schema AFTER it ran, never about the number, and about this block's names only.

const NOW = 1_800_000_000_000;
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
const memDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
};
const UP_TO_25 = MIGRATIONS.slice(0, 25);
const names = (db: DatabaseSync, type: 'table' | 'index'): string[] => db.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}' ORDER BY name`).all().map((r) => String(r.name));
const columns = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));

const DESK_REPORT_COLUMNS = ['urgent', 'handoff_at', 'handoff_by', 'escalated_to', 'escalated_by', 'escalated_at', 'evidence_ref'];

/** A report written the way 0.1.x wrote it (no reporting reason, no origin), at every status. */
function seedOld(db: DatabaseSync): void {
  const ins = db.prepare(
    `INSERT INTO kit_reports (id, created_at, room_id, tags_json, reporter_subject, reporter_seat, reporter_handle, target_subject, target_seat, target_handle, category, note, line_id, excerpt_json, people_json, status, bad_faith, actioned_at, actioned_by, mod_note)
     VALUES (?, ?, 'R', '{}', ?, 'p1', 'Rep', 's_t', 'p2', 'Tgt', 'spam', 'a note', NULL, '[]', '[]', ?, ?, ?, ?, ?)`,
  );
  ins.run('r_open', NOW, 's_1', 'open', 0, null, null, null);
  ins.run('r_actioned', NOW + 1, 's_2', 'actioned', 0, NOW + 5, 'mod_a', 'done');
  ins.run('r_dismissed', NOW + 2, 's_3', 'dismissed', 0, NOW + 6, 'mod_b', 'no');
  ins.run('r_badfaith', NOW + 3, 's_4', 'dismissed', 1, NOW + 7, 'mod_c', 'bad');
}

describe('migration 26, the desk block, from a version-25 database', () => {
  it('keeps every report row and id, adds the columns with urgent 0 and the others NULL, and creates the comment table, the day counts and the partial index', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    seedOld(db);
    const before = db.prepare('SELECT id, created_at, status, bad_faith, actioned_at, actioned_by, mod_note, note FROM kit_reports ORDER BY id').all();
    for (const c of DESK_REPORT_COLUMNS) expect(columns(db, 'kit_reports'), c).not.toContain(c);
    expect(names(db, 'table')).not.toContain('kit_report_comments');
    expect(names(db, 'table')).not.toContain('kit_chat_days');

    openStore({ db });

    for (const c of DESK_REPORT_COLUMNS) expect(columns(db, 'kit_reports'), c).toContain(c);
    expect(names(db, 'table')).toContain('kit_report_comments');
    expect(names(db, 'table')).toContain('kit_chat_days');
    expect(names(db, 'index')).toContain('kit_reports_urgent_open');
    expect(db.prepare('SELECT id, created_at, status, bad_faith, actioned_at, actioned_by, mod_note, note FROM kit_reports ORDER BY id').all()).toEqual(before);
    const rows = db.prepare('SELECT urgent, handoff_at, handoff_by, escalated_to, escalated_by, escalated_at, evidence_ref FROM kit_reports').all();
    expect(rows).toHaveLength(4);
    for (const r of rows) expect({ ...r }).toEqual({ urgent: 0, handoff_at: null, handoff_by: null, escalated_to: null, escalated_by: null, escalated_at: null, evidence_ref: null });
  });

  it('an old report reads back through the store as not urgent, with no evidence ref, hand-off or escalation', () => {
    const db = memDb();
    openStore({ db, migrations: UP_TO_25 });
    seedOld(db);
    const store = openStore({ db });
    for (const id of ['r_open', 'r_actioned', 'r_dismissed', 'r_badfaith']) {
      expect(store.loadReport(id), id).toMatchObject({ urgent: false, evidenceRef: null, handoffAt: null, handoffBy: null, escalatedTo: null, escalatedBy: null, escalatedAt: null });
    }
    expect(store.countOpenUrgent?.()).toBe(0);
  });

  it('the new columns are the ones the spec names: urgent NOT NULL DEFAULT 0, the escalation target checked, the rest nullable', () => {
    const db = memDb();
    openStore({ db });
    const info = Object.fromEntries(db.prepare('PRAGMA table_info(kit_reports)').all().map((c) => [String(c.name), c]));
    expect(Number(info.urgent?.notnull)).toBe(1);
    expect(String(info.urgent?.dflt_value)).toBe('0');
    for (const c of ['handoff_at', 'handoff_by', 'escalated_to', 'escalated_by', 'escalated_at', 'evidence_ref']) expect(Number(info[c]?.notnull), c).toBe(0);
    const ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_reports'").get()?.sql);
    expect(ddl).toMatch(/escalated_to[^,]*CHECK \(escalated_to IN \('senior', ?'owner'\)\)/);
  });

  it('the partial index is on (created_at, id) for open urgent reports', () => {
    const db = memDb();
    openStore({ db });
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_reports_urgent_open'").get();
    expect(String(idx?.sql)).toMatch(/\(created_at, id\)/);
    expect(String(idx?.sql)).toMatch(/WHERE urgent = 1 AND status = 'open'/);
  });

  it('the reporter-outcome index gains the reason, so the accuracy read that leaves out a welfare report is still one covering index', () => {
    const db = memDb();
    const store = openStore({ db });
    // Migration 27 (0.2.1) replaced it with the same index plus `overturned_at`: it is the one the accuracy read uses now.
    expect(names(db, 'index')).toContain('kit_reports_by_reporter_outcome_overturned');
    expect(names(db, 'index')).not.toContain('kit_reports_by_reporter_outcome_reason');
    expect(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kit_reports_by_reporter_outcome_overturned'").get()?.sql)).toMatch(/\(reporter_subject, created_at, status, bad_faith, reported_reason, overturned_at\)/);
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT reporter_subject, SUM(status = 'actioned' AND overturned_at IS NULL), SUM(status = 'actioned' AND overturned_at IS NOT NULL) FROM kit_reports WHERE reporter_subject IN (?) AND created_at >= ? AND status != 'open' AND (reported_reason IS NULL OR reported_reason <> 'welfare') GROUP BY reporter_subject")
      .all('s_a', 0)
      .map((r) => String(r.detail))
      .join(' | ');
    expect(plan).toMatch(/COVERING INDEX kit_reports_by_reporter_outcome_overturned/);
    expect(store.reporterOutcomes?.(['s_a'], 0)).toEqual([]);
  });

  it('the comment table has the spec columns, the (report_id, at, id) index and a kind CHECK that refuses an unknown kind', () => {
    const db = memDb();
    openStore({ db });
    expect(columns(db, 'kit_report_comments')).toEqual(['id', 'report_id', 'at', 'actor', 'role', 'kind', 'text']);
    expect(db.prepare('PRAGMA table_info(kit_report_comments)').all().filter((c) => Number(c.pk) === 1).map((c) => String(c.name))).toEqual(['id']);
    const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_report_comments' AND sql IS NOT NULL").all();
    expect(idx).toHaveLength(1);
    expect(String(idx[0]?.sql)).toMatch(/\(report_id, at, id\)/);
    const ins = db.prepare("INSERT INTO kit_report_comments (id, report_id, at, actor, role, kind, text) VALUES (?, 'r1', 1, 'a', 'moderator', ?, NULL)");
    for (const kind of ['comment', 'ask', 'escalate', 'clear']) ins.run(`c_${kind}`, kind);
    expect(() => ins.run('c_bad', 'note')).toThrow();
  });

  it('the day counts table is (day TEXT key, delivered, refused) and refuses a missing count', () => {
    const db = memDb();
    openStore({ db });
    const cols = db.prepare('PRAGMA table_info(kit_chat_days)').all();
    expect(cols.map((c) => String(c.name))).toEqual(['day', 'delivered', 'refused']);
    expect(cols.filter((c) => Number(c.pk) === 1).map((c) => String(c.name))).toEqual(['day']);
    expect(String(cols[0]?.type)).toBe('TEXT');
    expect(() => db.prepare("INSERT INTO kit_chat_days (day, delivered) VALUES ('2026-11-17', 1)").run()).toThrow();
  });

  it('a database migrated from 25 has the same desk schema as a fresh one', () => {
    const a = memDb();
    openStore({ db: a });
    const b = memDb();
    openStore({ db: b, migrations: UP_TO_25 });
    openStore({ db: b });
    expect(names(b, 'table')).toEqual(names(a, 'table'));
    expect(names(b, 'index')).toEqual(names(a, 'index'));
    expect(columns(b, 'kit_reports').sort()).toEqual(columns(a, 'kit_reports').sort());
    expect(columns(b, 'kit_report_comments')).toEqual(columns(a, 'kit_report_comments'));
  });

  it('a rerun of the block is refused: its statements fail on a database that already has them, so the runner cannot apply it twice', () => {
    const db = memDb();
    openStore({ db });
    const sql = MIGRATIONS.find((m) => m.version === 26)?.sql ?? '';
    expect(sql).toContain('kit_report_comments');
    expect(() => db.exec(sql)).toThrow();
    // and the store still opens: nothing was half applied by the failed rerun that matters
    expect(() => openStore({ db })).not.toThrow();
  });

  it('this block touches no other theme\'s tables: every table that exists after 26 and not after 25 is named, and the others keep their columns', () => {
    const a = memDb();
    openStore({ db: a, migrations: UP_TO_25 });
    const tablesBefore = names(a, 'table');
    const colsBefore = Object.fromEntries(tablesBefore.map((t) => [t, columns(a, t)]));
    openStore({ db: a });
    const added = names(a, 'table').filter((t) => !tablesBefore.includes(t));
    // the whole release adds these tables; this block's are the two below
    expect(added).toEqual(expect.arrayContaining(['kit_report_comments', 'kit_chat_days']));
    for (const t of tablesBefore) {
      const now = columns(a, t);
      const gained = now.filter((c) => !colsBefore[t]?.includes(c));
      // The release adds columns to a table from more than one theme (scope, the entity, the block flag, ...): this block's own are asserted by membership, never by the whole list.
      if (t === 'kit_reports') expect(gained, t).toEqual(expect.arrayContaining([...DESK_REPORT_COLUMNS, 'origin', 'origin_key']));
      expect(now.slice(0, colsBefore[t]?.length), t).toEqual(colsBefore[t]);
    }
  });

  it('EXPLAIN QUERY PLAN: the urgent open scan and count use kit_reports_urgent_open; listComments and the thread count use the (report_id, at, id) index', () => {
    const db = memDb();
    const store = openStore({ db });
    store.insertReport({ id: 'r1', createdAt: NOW, roomId: 'R', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A', targetSubject: 's_b', targetSeat: 'p2', targetHandle: 'B', category: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open', urgent: true });
    // The plan is asked for the statement exactly as the store issues it: record what each method prepares, then explain that text.
    const seen: Array<{ sql: string; args: unknown[] }> = [];
    const real = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const st = real(sql);
      return new Proxy(st, {
        get(target, prop) {
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (typeof v !== 'function') return v;
          if (prop === 'all' || prop === 'get' || prop === 'run') {
            return (...args: unknown[]) => {
              seen.push({ sql, args });
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return v.bind(target);
        },
      });
    }) as typeof db.prepare;
    const planOf = (fn: () => unknown): string => {
      seen.length = 0;
      fn();
      const last = seen.filter((x) => /^\s*(SELECT|INSERT)/i.test(x.sql) && !/kit_meta/.test(x.sql)).at(-1);
      expect(last, 'the method prepared a statement').toBeDefined();
      return real(`EXPLAIN QUERY PLAN ${last?.sql ?? ''}`)
        .all(...((last?.args ?? []) as Array<string | number | null>))
        .map((r) => String(r.detail))
        .join(' | ');
    };
    const p1 = planOf(() => store.listOpenReports({ urgent: true, limit: 5 }));
    expect(p1, p1).toContain('kit_reports_urgent_open');
    const p2 = planOf(() => store.listOpenReports({ urgent: true, after: NOW, afterId: 'a', category: 'spam', limit: 5 }));
    expect(p2, p2).toContain('kit_reports_urgent_open');
    const p3 = planOf(() => store.countOpenUrgent?.());
    expect(p3, p3).toContain('kit_reports_urgent_open');
    expect(planOf(() => store.listComments?.('r1'))).toMatch(/INDEX kit_report_comments_by_report/);
    expect(planOf(() => store.countComments?.('r1'))).toMatch(/INDEX kit_report_comments_by_report/);
  });
});
