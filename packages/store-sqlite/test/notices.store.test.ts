import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommunityRules,
  NoticeService,
  ownLines,
  purge,
  STARTER_RULES,
  SubjectIndex,
  type NoticeRow,
  type ReportExcerptLine,
  type StoredReport,
} from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-notice-'));
  tmpDirs.push(dir);
  return join(dir, 'kit.db');
}

const notice = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id,
  subject: 's_a',
  groupId: `g-${id}`,
  kind: 'chat',
  rule: '2',
  until: NOW + DAY,
  refCode: 'M-AAAAA',
  excerpt: [{ text: 'hello', day: '2027-01-14' }],
  createdAt: NOW,
  ackedAt: null,
  withdrawnAt: null,
  ...over,
});

const count = (db: DatabaseSync): number => Number((db.prepare('SELECT COUNT(*) AS n FROM kit_notices').get() as { n: number }).n);

describe('migration 8: kit_notices', () => {
  it('is version 8, after 7', () => {
    expect(MIGRATIONS[7]?.version).toBe(8);
    expect(MIGRATIONS.at(-1)?.version).toBeGreaterThanOrEqual(8);
  });

  it('creates the table with the documented columns and the subject index', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const cols = db.prepare('PRAGMA table_info(kit_notices)').all().map((c) => String(c.name));
    expect(cols).toEqual([
      'id', 'subject_id', 'group_id', 'kind', 'rule', 'until', 'ref_code', 'excerpt_json', 'created_at', 'acked_at', 'withdrawn_at',
    ]);
    const idx = db.prepare('PRAGMA index_list(kit_notices)').all().map((i) => String(i.name));
    expect(idx).toContain('kit_notices_by_subject');
    const cols2 = db.prepare("PRAGMA index_info('kit_notices_by_subject')").all().map((c) => String(c.name));
    expect(cols2).toEqual(['subject_id', 'acked_at', 'withdrawn_at']);
    db.close();
  });

  it('refuses a bad kind at the database', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(() => store.insertNotice(notice('x', { kind: 'nope' as never }))).toThrow();
    expect(count(db)).toBe(0);
    db.close();
  });

  it('upgrades a version 7 database without touching its rows', () => {
    const path = tmpPath();
    const old = openStore({ path, migrations: MIGRATIONS.slice(0, 7) });
    expect(old.schemaVersion()).toBe(7);
    old.close();
    const store = openStore({ path });
    expect(store.schemaVersion()).toBe(MIGRATIONS.at(-1)?.version);
    store.insertNotice(notice('n1'));
    expect(store.loadNotices(['s_a'])).toHaveLength(1);
    store.close();
  });

  it('a failing migration 8 leaves version 7 and no table', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db, migrations: MIGRATIONS.slice(0, 7) });
    const broken = [...MIGRATIONS.slice(0, 7), { version: 8, sql: `${MIGRATIONS[7]?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    expect(tables).not.toContain('kit_notices');
    expect(String((db.prepare("SELECT value FROM kit_meta WHERE key='schema_version'").get() as { value: unknown }).value)).toBe('7');
    db.close();
  });
});

describe('SqliteStore notices', () => {
  it('round-trips a row, excerpt included', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    const row = notice('n1', { excerpt: [{ text: 'a "quoted" line', day: '2027-01-14' }, { text: 'two', day: '2027-01-15' }] });
    store.insertNotice(row);
    expect(store.loadNotices(['s_a'])).toEqual([row]);
  });

  it('keeps nulls null (report outcome)', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    const row = notice('o1', { kind: 'report_outcome', groupId: null, rule: null, until: null, refCode: null, excerpt: [] });
    store.insertNotice(row);
    expect(store.loadNotices(['s_a'])).toEqual([row]);
  });

  it('loads by any of the given stored subjects, oldest first, and no others', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    store.insertNotice(notice('n2', { subject: 's_b', createdAt: NOW + 2 }));
    store.insertNotice(notice('n1', { subject: 's_a', createdAt: NOW + 1 }));
    store.insertNotice(notice('n3', { subject: 's_c', createdAt: NOW + 3 }));
    expect(store.loadNotices(['s_a', 's_b']).map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(store.loadNotices(['s_c']).map((n) => n.id)).toEqual(['n3']);
    expect(store.loadNotices([])).toEqual([]);
    expect(store.loadNotices(['s_none'])).toEqual([]);
  });

  it('ties on created_at keep insertion order', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    for (const id of ['z', 'y', 'x']) store.insertNotice(notice(id));
    expect(store.loadNotices(['s_a']).map((n) => n.id)).toEqual(['z', 'y', 'x']);
  });

  it('a duplicate id is refused', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    store.insertNotice(notice('n1'));
    expect(() => store.insertNotice(notice('n1'))).toThrow();
  });

  it('ackNotice sets the time once and reports whether this call did it', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    store.insertNotice(notice('n1'));
    expect(store.ackNotice('n1', 5)).toBe(true);
    expect(store.ackNotice('n1', 9)).toBe(false);
    expect(store.ackNotice('missing', 9)).toBe(false);
    expect(store.loadNotices(['s_a'])[0]?.ackedAt).toBe(5);
  });

  it('ackNotice does nothing to a withdrawn notice', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    store.insertNotice(notice('n1', { withdrawnAt: 3 }));
    expect(store.ackNotice('n1', 5)).toBe(false);
    expect(store.loadNotices(['s_a'])[0]?.ackedAt).toBeNull();
  });

  it('withdrawNoticeGroup withdraws the group once, leaving other groups and groupless rows', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    store.insertNotice(notice('n1', { groupId: 'g1' }));
    store.insertNotice(notice('n2', { groupId: 'g2' }));
    store.insertNotice(notice('o1', { groupId: null, kind: 'report_outcome' }));
    expect(store.withdrawNoticeGroup('g1', 7)).toBe(1);
    expect(store.withdrawNoticeGroup('g1', 8)).toBe(0);
    const byId = Object.fromEntries(store.loadNotices(['s_a']).map((n) => [n.id, n.withdrawnAt]));
    expect(byId).toEqual({ n1: 7, n2: null, o1: null });
  });

  it('withdrawing an acked notice still sets withdrawn_at', () => {
    const store = openStore({ db: new DatabaseSync(':memory:') });
    store.insertNotice(notice('n1', { groupId: 'g1', ackedAt: 2 }));
    expect(store.withdrawNoticeGroup('g1', 7)).toBe(1);
    expect(store.loadNotices(['s_a'])[0]).toMatchObject({ ackedAt: 2, withdrawnAt: 7 });
  });

  it('is rolled back with the transaction', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(() =>
      store.transaction(() => {
        store.insertNotice(notice('n1'));
        throw new Error('x');
      }),
    ).toThrow('x');
    expect(count(db)).toBe(0);
  });

  it('persists across reopen', () => {
    const path = tmpPath();
    const a = openStore({ path });
    a.insertNotice(notice('n1'));
    a.close();
    const b = openStore({ path });
    expect(b.loadNotices(['s_a']).map((n) => n.id)).toEqual(['n1']);
    b.close();
  });
});

describe('SqliteStore purgeNotices', () => {
  const ids = (db: DatabaseSync) => db.prepare('SELECT id FROM kit_notices ORDER BY id').all().map((r) => String(r.id));

  it('deletes acked or withdrawn notices created before the cutoff (strict)', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const cut = NOW - 90 * DAY;
    store.insertNotice(notice('acked-old', { createdAt: cut - 1, ackedAt: 1, until: null }));
    store.insertNotice(notice('wd-old', { createdAt: cut - 1, withdrawnAt: 1, until: null }));
    store.insertNotice(notice('acked-edge', { createdAt: cut, ackedAt: 1, until: null }));
    store.insertNotice(notice('unacked-old-perm', { createdAt: cut - 1000 * DAY, until: null }));
    expect(store.purgeNotices(cut)).toBe(2);
    expect(ids(db)).toEqual(['acked-edge', 'unacked-old-perm']);
  });

  it('deletes any notice whose end is before the cutoff (strict), seen or not', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const cut = NOW - 90 * DAY;
    store.insertNotice(notice('a', { createdAt: NOW, until: cut - 1 }));
    store.insertNotice(notice('b', { createdAt: NOW, until: cut - 1, ackedAt: 1 }));
    store.insertNotice(notice('edge', { createdAt: NOW, until: cut }));
    store.insertNotice(notice('running', { createdAt: NOW - 500 * DAY, until: NOW + DAY }));
    expect(store.purgeNotices(cut)).toBe(2);
    expect(ids(db)).toEqual(['edge', 'running']);
  });

  it('purge() counts notices and keeps the other tables', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    store.insertNotice(notice('old', { createdAt: NOW - 200 * DAY, ackedAt: NOW - 199 * DAY }));
    store.insertNotice(notice('keep', { createdAt: NOW - DAY }));
    expect(await purge(store, NOW)).toEqual({ reports: 0, sanctions: 0, strikes: 0, mutes: 0, notices: 1 });
    expect(ids(db)).toEqual(['keep']);
  });

  it('purge() rolls the notices back when a later step fails', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    store.insertNotice(notice('old', { createdAt: NOW - 200 * DAY, ackedAt: NOW - 199 * DAY }));
    store.purgeMutes = () => {
      throw new Error('disk full');
    };
    await expect(purge(store, NOW)).rejects.toThrow('disk full');
    expect(ids(db)).toEqual(['old']);
  });
});

describe('NoticeService on SQLite', () => {
  const rules = new CommunityRules(STARTER_RULES);
  const ln = (over: Partial<ReportExcerptLine>): ReportExcerptLine => ({
    lineId: 'L1', ts: Date.UTC(2027, 0, 14, 10), seatId: 'seat-x', handle: 'HandleX', raw: 'hello', delivered: 'hello',
    blocked: false, audience: null, p: 0, ...over,
  });

  function env() {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const pushed: number[] = [];
    const svc = new NoticeService({
      store,
      subjects,
      rules,
      clock,
      matcher: {
        match: (t) => (/zorbak/.test(t) ? { termId: 't' } : null),
        spans: (t) => [...t.matchAll(/zorbak/g)].map((m) => ({ start: m.index, end: m.index + 6, termId: 't' })),
      },
      notify: (_s, e) => void pushed.push(e.count),
    });
    const person = (key: string, account: string | null = null) => {
      const s = subjects.resolve({ clientKey: key, accountId: account, ipHash: null });
      if (s === null) throw new Error('expected a subject');
      return s;
    };
    return { db, store, subjects, svc, pushed, person };
  }

  it('creates, lists, acks, records and withdraws against the real store', () => {
    const e = env();
    const a = e.person('ka');
    const id = e.svc.createForSanction(
      { groupId: 'g1', refCode: 'M-ABCDE', kind: 'chat', until: NOW + DAY, rule: 2, subject: a },
      [ln({ raw: 'you zorbak', delivered: null, blocked: true })],
    );
    expect(e.pushed).toEqual([1]);
    expect(e.svc.pending(a)[0]).toMatchObject({ id, kind: 'chat', refCode: 'M-ABCDE', rule: 2, excerpt: [{ text: 'you ******', day: '2027-01-14' }] });
    expect(JSON.stringify(e.db.prepare('SELECT * FROM kit_notices').all())).not.toContain('zorbak');
    expect(e.svc.ack(a, id)).toBe(true);
    expect(e.svc.pending(a)).toEqual([]);
    expect(e.svc.record(a)).toHaveLength(1);
    expect(e.svc.withdrawGroup('g1')).toBe(1);
    expect(e.svc.record(a)).toEqual([]);
  });

  it('a notice follows a merge', () => {
    const e = env();
    const a = e.person('ka');
    e.person('kb', 'acct-b');
    e.svc.createForSanction({ groupId: 'g1', refCode: 'M-ABCDE', kind: 'warning', until: null, rule: 1, subject: a }, []);
    const merged = e.person('ka', 'acct-b');
    expect(e.svc.pending(merged)).toHaveLength(1);
    expect(e.svc.pendingWarning(merged)).toBe(true);
  });

  it('ownLines + createForSanction keep another player out of the stored row', () => {
    const e = env();
    const a = e.person('ka');
    const b = e.person('kb');
    const rep: StoredReport = {
      id: 'r', createdAt: NOW, roomId: 'ROOM-SECRET', tags: {}, reporterSubject: b, reporterSeat: 'p2', reporterHandle: 'R',
      targetSubject: a, targetSeat: 'p1', targetHandle: 'T', category: 'harassment', note: null, lineId: null,
      excerpt: [ln({ lineId: 'x1', p: 0, raw: 'mine', delivered: 'mine' }), ln({ lineId: 'y1', p: 1, raw: 'theirs', delivered: 'theirs' })],
      people: [a, b], status: 'open',
    };
    expect(() => ownLines(rep, a, ['y1'], e.subjects)).toThrow();
    e.svc.createForSanction({ groupId: 'g1', refCode: 'M-ABCDE', kind: 'chat', until: NOW + DAY, rule: 2, subject: a }, ownLines(rep, a, ['x1'], e.subjects));
    const stored = JSON.stringify(e.db.prepare('SELECT * FROM kit_notices').all());
    expect(stored).toContain('mine');
    expect(stored).not.toMatch(/theirs|ROOM-SECRET|HandleX|seat-x/);
  });
});
