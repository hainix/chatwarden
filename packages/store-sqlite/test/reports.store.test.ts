import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySanction,
  EvidenceBuffer,
  ReportService,
  RoomRoster,
  SubjectIndex,
  type Identifiers,
  type SanctionKind,
  type Source,
  type StoredReport,
} from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-report-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
}

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
  excerpt: [
    { lineId: '3', ts: NOW - 5, seatId: 'p2', handle: 'Tgt', raw: 'zorbak "you"', delivered: null, blocked: true, audience: ['p1'], p: 0 },
    { lineId: '4', ts: NOW - 4, seatId: 'bot', handle: 'Bot', raw: 'beep', delivered: 'beep', blocked: false, audience: null, p: null },
  ],
  people: ['s_tgt'],
  status: 'open',
  ...over,
});

function env() {
  const db = new DatabaseSync(':memory:');
  const store = openStore({ db });
  return { db, store };
}

const cols = (db: DatabaseSync, table: string) => db.prepare(`PRAGMA table_info(${table})`).all();

describe('migration 6: kit_reports', () => {
  it('is version 6 and creates the table with the documented columns and defaults', () => {
    expect(MIGRATIONS[5]?.version).toBe(6);
    const { db, store } = env();
    expect(store.schemaVersion()).toBeGreaterThanOrEqual(6);
    const info = cols(db, 'kit_reports');
    expect(info.map((c) => String(c.name))).toEqual([
      'id', 'created_at', 'room_id', 'tags_json', 'reporter_subject', 'reporter_seat', 'reporter_handle',
      'target_subject', 'target_seat', 'target_handle', 'category', 'note', 'line_id', 'excerpt_json',
      'people_json', 'status', 'bad_faith', 'actioned_at', 'actioned_by', 'mod_note',
    ]);
    const by = (n: string) => info.find((c) => c.name === n);
    expect(by('status')?.dflt_value).toBe("'open'");
    expect(by('bad_faith')?.dflt_value).toBe('0');
    for (const n of ['note', 'line_id', 'actioned_at', 'actioned_by', 'mod_note']) expect(by(n)?.notnull).toBe(0);
    for (const n of ['reporter_subject', 'target_subject', 'room_id', 'excerpt_json', 'people_json']) expect(by(n)?.notnull).toBe(1);
    db.close();
  });

  it('has the three indexes and the UNIQUE (reporter, target, room) constraint', () => {
    const { db } = env();
    const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kit_reports'").all();
    const defs = idx.map((r) => String(r.sql ?? ''));
    expect(defs.some((d) => /target_subject,\s*created_at/.test(d))).toBe(true);
    expect(defs.some((d) => /reporter_subject,\s*created_at/.test(d))).toBe(true);
    expect(defs.some((d) => /status,\s*created_at/.test(d))).toBe(true);
    const unique = db.prepare("PRAGMA index_list('kit_reports')").all().filter((i) => i.unique === 1);
    const uniqueCols = unique.map((i) =>
      db.prepare(`PRAGMA index_info('${String(i.name)}')`).all().map((c) => String(c.name)),
    );
    expect(uniqueCols).toContainEqual(['reporter_subject', 'target_subject', 'room_id']);
    db.close();
  });

  it('rejects an unknown status and a bad_faith other than 0 or 1', () => {
    const { db, store } = env();
    store.insertReport(report());
    expect(() => db.prepare("UPDATE kit_reports SET status = 'weird'").run()).toThrow();
    expect(() => db.prepare('UPDATE kit_reports SET bad_faith = 2').run()).toThrow();
    for (const s of ['open', 'actioned', 'dismissed']) db.prepare('UPDATE kit_reports SET status = ?').run(s);
    db.close();
  });

  it('upgrades a version 5 database in place and keeps its rows', async () => {
    const path = tmpPath();
    const v5 = openStore({ path, migrations: MIGRATIONS.slice(0, 5) });
    await v5.saveSubject({ id: 's_a', createdAt: 5, mergedInto: null });
    expect(v5.schemaVersion()).toBe(5);
    v5.close();
    const v6 = openStore({ path });
    expect(v6.schemaVersion()).toBeGreaterThanOrEqual(6);
    expect((await v6.loadSubjects()).subjects).toHaveLength(1);
    expect(v6.loadReportActivity(0)).toEqual([]);
    v6.close();
  });

  it('only touches kit_ tables', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    openStore({ db });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    expect(names.filter((n) => !n.startsWith('kit_') && !n.startsWith('sqlite_'))).toEqual(['users']);
    db.close();
  });
});

describe('insertReport', () => {
  it('stores every field, JSON columns included, with status open and bad_faith 0', () => {
    const { db, store } = env();
    const r = report();
    expect(store.insertReport(r)).toBe(true);
    const row = db.prepare('SELECT * FROM kit_reports').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      id: 'r1',
      created_at: NOW,
      room_id: 'ROOM1',
      reporter_subject: 's_rep',
      reporter_seat: 'p1',
      reporter_handle: 'Rep',
      target_subject: 's_tgt',
      target_seat: 'p2',
      target_handle: 'Tgt',
      category: 'harassment',
      note: 'rude',
      line_id: '3',
      status: 'open',
      bad_faith: 0,
      actioned_at: null,
      actioned_by: null,
      mod_note: null,
    });
    expect(JSON.parse(String(row.tags_json))).toEqual(r.tags);
    expect(JSON.parse(String(row.excerpt_json))).toEqual(r.excerpt);
    expect(JSON.parse(String(row.people_json))).toEqual(r.people);
    db.close();
  });

  it('stores a null note and a null line id as NULL', () => {
    const { db, store } = env();
    store.insertReport(report({ note: null, lineId: null, excerpt: [], people: [], tags: {} }));
    const row = db.prepare('SELECT note, line_id, excerpt_json, people_json, tags_json FROM kit_reports').get() as Record<string, unknown>;
    expect(row).toEqual({ note: null, line_id: null, excerpt_json: '[]', people_json: '[]', tags_json: '{}' });
    db.close();
  });

  it('returns false and writes nothing for the same reporter, target and room', () => {
    const { db, store } = env();
    expect(store.insertReport(report())).toBe(true);
    expect(store.insertReport(report({ id: 'r2', category: 'spam', createdAt: NOW + 1 }))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM kit_reports').get()).toEqual({ n: 1 });
    db.close();
  });

  it('controls: another room, target or reporter is a new row', () => {
    const { store } = env();
    expect(store.insertReport(report())).toBe(true);
    expect(store.insertReport(report({ id: 'r2', roomId: 'ROOM2' }))).toBe(true);
    expect(store.insertReport(report({ id: 'r3', targetSubject: 's_other' }))).toBe(true);
    expect(store.insertReport(report({ id: 'r4', reporterSubject: 's_other' }))).toBe(true);
  });

  it('a duplicate report id throws (primary key) rather than returning false', () => {
    const { store } = env();
    store.insertReport(report());
    expect(() => store.insertReport(report({ roomId: 'ROOM9' }))).toThrow();
  });

  it('is rolled back with the enclosing transaction', () => {
    const { store } = env();
    expect(() =>
      store.transaction(() => {
        store.insertReport(report());
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.loadReportActivity(0)).toEqual([]);
  });
});

describe('loadReportActivity / loadRoomReportPairs', () => {
  it('returns light rows at or after since, oldest first', () => {
    const { store } = env();
    store.insertReport(report({ id: 'c', roomId: 'C', createdAt: NOW + 20 }));
    store.insertReport(report({ id: 'a', roomId: 'A', createdAt: NOW }));
    store.insertReport(report({ id: 'b', roomId: 'B', createdAt: NOW + 10 }));
    expect(store.loadReportActivity(NOW + 10)).toEqual([
      { reporter: 's_rep', target: 's_tgt', roomId: 'B', createdAt: NOW + 10 },
      { reporter: 's_rep', target: 's_tgt', roomId: 'C', createdAt: NOW + 20 },
    ]);
    expect(store.loadReportActivity(0).map((r) => r.roomId)).toEqual(['A', 'B', 'C']);
    expect(store.loadReportActivity(NOW + 21)).toEqual([]);
  });

  it('lists the pairs of one room only', () => {
    const { store } = env();
    store.insertReport(report({ id: 'a', roomId: 'A' }));
    store.insertReport(report({ id: 'b', roomId: 'B', reporterSubject: 's_x' }));
    expect(store.loadRoomReportPairs('A')).toEqual([{ reporter: 's_rep', target: 's_tgt' }]);
    expect(store.loadRoomReportPairs('B')).toEqual([{ reporter: 's_x', target: 's_tgt' }]);
    expect(store.loadRoomReportPairs('none')).toEqual([]);
  });
});

describe('loadBadFaithMarks', () => {
  it('returns bad-faith rows actioned at or after since, and nothing else', () => {
    const { db, store } = env();
    const mark = (id: string, room: string, over: { bad: number; at: number | null; status?: string }) => {
      store.insertReport(report({ id, roomId: room }));
      db.prepare('UPDATE kit_reports SET bad_faith = ?, actioned_at = ?, status = ? WHERE id = ?').run(
        over.bad,
        over.at,
        over.status ?? 'dismissed',
        id,
      );
    };
    mark('a', 'A', { bad: 1, at: NOW - DAY });
    mark('b', 'B', { bad: 1, at: NOW - 30 * DAY }); // exactly since
    mark('c', 'C', { bad: 1, at: NOW - 30 * DAY - 1 }); // too old
    mark('d', 'D', { bad: 0, at: NOW - DAY }); // not bad faith
    mark('e', 'E', { bad: 1, at: null, status: 'open' }); // never closed
    expect(store.loadBadFaithMarks(NOW - 30 * DAY)).toEqual([
      { reporter: 's_rep', actionedAt: NOW - DAY },
      { reporter: 's_rep', actionedAt: NOW - 30 * DAY },
    ]);
    db.close();
  });
});

describe('loadAutoChatGroups', () => {
  const sanction = async (
    s: ReturnType<typeof env>['store'],
    subjects: SubjectIndex,
    subject: string,
    at: number,
    over: { kind?: SanctionKind; source?: Source; includeIp?: boolean } = {},
  ) =>
    applySanction(
      s,
      subjects,
      {
        kind: over.kind ?? 'chat',
        subject,
        includeIp: over.includeIp ?? false,
        durationMs: H,
        reason: 'r',
        actor: 'a',
        source: over.source ?? 'auto_filter',
        automated: (over.source ?? 'auto_filter') === 'auto_filter',
      },
      at,
    );

  it('names each automatic chat group once (subject rows only), since the cutoff', async () => {
    const e = env();
    const subjects = new SubjectIndex(e.store, { now: () => NOW }, { logger: { warn() {} } });
    const a = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'ip-1' } satisfies Identifiers);
    const b = subjects.resolve({ clientKey: 'k2', accountId: null, ipHash: null });
    await subjects.flush();
    if (a === null || b === null) throw new Error('expected subjects');
    const g1 = await sanction(e.store, subjects, a, NOW - DAY, { includeIp: true }); // subject row + ip row
    const g2 = await sanction(e.store, subjects, a, NOW - 2 * DAY);
    await sanction(e.store, subjects, a, NOW - 8 * DAY); // before the cutoff
    await sanction(e.store, subjects, a, NOW - DAY, { source: 'moderator' });
    await sanction(e.store, subjects, a, NOW - DAY, { kind: 'ban' });
    const g3 = await sanction(e.store, subjects, b, NOW - 3 * DAY);
    const rows = e.store.loadAutoChatGroups(NOW - 7 * DAY);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        { subject: a, groupId: g1.groupId },
        { subject: a, groupId: g2.groupId },
        { subject: b, groupId: g3.groupId },
      ]),
    );
    e.db.close();
  });
});

describe('end to end through ReportService', () => {
  it('a report is stored, canonical subjects and all, and the suspension reads bad-faith marks from SQL', async () => {
    const { db, store } = env();
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const roster = new RoomRoster();
    const buffer = new EvidenceBuffer({ clock });
    const seen: Array<{ n: number; rooms: number }> = [];
    const svc = new ReportService({
      roster,
      buffer,
      subjects,
      store,
      clock,
      onReport: (_r, c) => void seen.push({ n: c.reports7d, rooms: c.rooms7d }),
    });
    const rep = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: null });
    const tgt = subjects.resolve({ clientKey: 'k2', accountId: null, ipHash: null });
    roster.seat('R1', 'p1', rep, 'Rep');
    roster.seat('R1', 'p2', tgt, 'Tgt');
    buffer.append('R1', { ts: NOW, seatId: 'p2', handle: 'Tgt', subject: tgt, raw: 'zorbak', delivered: null, blocked: true, audience: null });
    const res = await svc.submit({ roomId: 'R1', reporterSeat: 'p1', targetSeat: 'p2', category: 'hate', note: ' n ' });
    expect(res).toMatchObject({ ok: true, remaining: 9 });
    expect(seen).toEqual([{ n: 1, rooms: 1 }]);
    const row = db.prepare('SELECT * FROM kit_reports').get() as Record<string, unknown>;
    expect(row).toMatchObject({ reporter_subject: rep, target_subject: tgt, note: 'n', category: 'hate' });
    expect(JSON.parse(String(row.people_json))).toEqual([tgt]);
    expect(JSON.parse(String(row.excerpt_json))[0]).toMatchObject({ p: 0, raw: 'zorbak', blocked: true });
    expect(await svc.submit({ roomId: 'R1', reporterSeat: 'p1', targetSeat: 'p2', category: 'hate' })).toEqual({
      ok: false,
      refused: 'duplicate',
    });

    // Three bad-faith dismissals in the last 30 days (rows set directly; dismissing is K2).
    for (let i = 0; i < 3; i++) {
      store.insertReport(report({ id: `old${i}`, roomId: `old-room-${i}`, reporterSubject: rep as string, createdAt: NOW - 40 * DAY }));
      db.prepare('UPDATE kit_reports SET bad_faith = 1, actioned_at = ?, status = ? WHERE id = ?').run(NOW - DAY, 'dismissed', `old${i}`);
    }
    roster.seat('R1', 'p3', subjects.resolve({ clientKey: 'k3', accountId: null, ipHash: null }), 'Third');
    expect(await svc.submit({ roomId: 'R1', reporterSeat: 'p1', targetSeat: 'p3', category: 'spam' })).toEqual({
      ok: false,
      refused: 'suspended',
    });
    db.close();
  });
});
