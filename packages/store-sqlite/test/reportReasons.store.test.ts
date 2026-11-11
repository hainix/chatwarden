import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { RawWho, StoredReport } from '@chatwarden/core';
import { MIGRATIONS, openStore } from '../src/index.js';

// Migration 17 (the reported reason and the follow-up time on a report), the SQLite side of the reporting-reason methods, and an
// existing version 16 database read by the new kit.

const NOW = 1_800_000_000_000;

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
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
const filePath = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-reasons-'));
  dirs.push(d);
  return join(d, 'kit.db');
};
const M17 = MIGRATIONS.find((m) => m.version === 17);

/** A report row as the 0.1.1 kit wrote it: no `reported_reason`, no `detail_at`. */
const OLD_REPORT = `INSERT INTO kit_reports
  (id, created_at, room_id, tags_json, reporter_subject, reporter_seat, reporter_handle, target_subject, target_seat, target_handle,
   category, note, line_id, excerpt_json, people_json, status, bad_faith, actioned_at, actioned_by, mod_note)
  VALUES (?, ?, ?, '{}', ?, 'p1', 'Rep', ?, 'p2', 'Tgt', ?, ?, NULL, '[]', '[]', ?, 0, ?, ?, ?)`;

function v16(): DatabaseSync {
  const db = memDb();
  const old = openStore({ db, migrations: MIGRATIONS.slice(0, 16) });
  expect(old.schemaVersion()).toBe(16);
  return db;
}

describe('migration 17: the reported reason', () => {
  it('is the latest migration and adds two nullable columns and an index', () => {
    expect(MIGRATIONS.at(-1)?.version).toBe(17);
    const db = memDb();
    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(17);
    const cols = db.prepare('PRAGMA table_info(kit_reports)').all();
    for (const name of ['reported_reason', 'detail_at']) {
      const col = cols.find((c) => c.name === name);
      expect(col, name).toBeDefined();
      expect(Number(col?.notnull), name).toBe(0);
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'kit_reports_by_reason'").all()).toHaveLength(1);
    // category is untouched: still NOT NULL, so a consumer of it keeps working.
    expect(Number(cols.find((c) => c.name === 'category')?.notnull)).toBe(1);
  });

  it('upgrades a version 16 database in place: every old row is kept and its category becomes its reason (disruption is griefing)', () => {
    const db = v16();
    const cats = ['harassment', 'hate', 'cheating', 'spam', 'disruption', 'other'];
    cats.forEach((c, i) => db.prepare(OLD_REPORT).run(`old${i}`, NOW + i, `room${i}`, 's_rep', `s_t${i}`, c, `note ${c}`, 'open', null, null, null));
    // One that was decided before the upgrade keeps its decision columns.
    db.prepare(OLD_REPORT).run('done1', NOW, 'roomD', 's_rep', 's_tD', 'hate', null, 'actioned', NOW + 5, 'mod_1', 'handled');

    const store = openStore({ db });
    expect(store.schemaVersion()).toBe(17);
    const got = Object.fromEntries(cats.map((c, i) => [c, store.loadReport(`old${i}`)]));
    expect(Object.entries(got).map(([c, r]) => [c, r?.reportedReason, r?.category, r?.detailAt, r?.note])).toEqual([
      ['harassment', 'harassment', 'harassment', null, 'note harassment'],
      ['hate', 'hate', 'hate', null, 'note hate'],
      ['cheating', 'cheating', 'cheating', null, 'note cheating'],
      ['spam', 'spam', 'spam', null, 'note spam'],
      ['disruption', 'griefing', 'disruption', null, 'note disruption'],
      ['other', 'other', 'other', null, 'note other'],
    ]);
    expect(store.loadReport('done1')).toMatchObject({ status: 'actioned', actionedAt: NOW + 5, actionedBy: 'mod_1', modNote: 'handled', reportedReason: 'hate' });
    expect(store.listReports({ limit: 50 })).toHaveLength(7);
    expect(store.listReports({ reason: 'griefing', limit: 50 }).map((r) => r.id)).toEqual(['old4']);
  });

  it('a stored category that is none of the six (a hand edit) reads as no reason rather than an invented one', () => {
    const db = v16();
    db.prepare(OLD_REPORT).run('odd', NOW, 'room', 's_rep', 's_t', 'weird-category', null, 'open', null, null, null);
    const store = openStore({ db });
    expect(store.loadReport('odd')).toMatchObject({ reportedReason: null, category: 'weird-category' });
  });

  it('works after the upgrade: new reports, the filter, the follow-up, and the old rows are not disturbed', () => {
    const db = v16();
    db.prepare(OLD_REPORT).run('old', NOW, 'oldroom', 's_rep', 's_t', 'spam', null, 'open', null, null, null);
    const store = openStore({ db });
    const fresh: StoredReport = {
      id: 'new', createdAt: NOW + 10, roomId: 'newroom', tags: {}, reporterSubject: 's_rep2', reporterSeat: 'p1', reporterHandle: 'R', targetSubject: 's_t2',
      targetSeat: 'p2', targetHandle: 'T', category: 'other', reportedReason: null, note: null, lineId: null, excerpt: [], people: [], status: 'open',
    };
    expect(store.insertReport(fresh)).toBe(true);
    expect(store.listReports({ reason: null, limit: 10 }).map((r) => r.id)).toEqual(['new']);
    expect(store.addReportDetail?.('new', { reportedReason: 'threat', category: 'harassment', note: 'hi', at: NOW + 11 })).toBe(true);
    expect(store.listReports({ reason: 'threat', limit: 10 }).map((r) => r.id)).toEqual(['new']);
    expect(store.addReportDetail?.('old', { reportedReason: 'hate', category: 'hate', note: null, at: NOW + 12 })).toBe(true);
    expect(store.loadReport('old')).toMatchObject({ reportedReason: 'hate', detailAt: NOW + 12 });
  });

  it('upgrading twice (a second open) changes nothing', () => {
    const path = filePath();
    const a = openStore({ path });
    a.insertReport({
      id: 'r', createdAt: NOW, roomId: 'x', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A', targetSubject: 's_b', targetSeat: 'p2',
      targetHandle: 'B', category: 'hate', reportedReason: 'hate', note: null, lineId: null, excerpt: [], people: [], status: 'open',
    });
    a.close();
    const b = openStore({ path });
    expect(b.schemaVersion()).toBe(17);
    expect(b.loadReport('r')?.reportedReason).toBe('hate');
    b.close();
  });

  it('a failing migration 17 rolls back whole: version 16, no column, no index, no backfill', () => {
    const db = v16();
    db.prepare(OLD_REPORT).run('old', NOW, 'room', 's_rep', 's_t', 'disruption', null, 'open', null, null, null);
    const broken = [...MIGRATIONS.slice(0, 16), { version: 17, sql: `${M17?.sql ?? ''}\nINSERT INTO no_such_table VALUES (1);` }];
    expect(() => openStore({ db, migrations: broken })).toThrow();
    expect(openStore({ db, migrations: MIGRATIONS.slice(0, 16) }).schemaVersion()).toBe(16);
    const cols = db.prepare('PRAGMA table_info(kit_reports)').all().map((c) => String(c.name));
    expect(cols).not.toContain('reported_reason');
    expect(cols).not.toContain('detail_at');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'kit_reports_by_reason'").all()).toHaveLength(0);
    // And it still upgrades afterwards.
    expect(openStore({ db }).loadReport('old')?.reportedReason).toBe('griefing');
  });
});

describe('a version 16 database read by the new kit', () => {
  const WHO = (key: string): RawWho => ({ clientKey: key });
  const OLD_SANCTION = `INSERT INTO kit_sanctions
    (id, group_id, ref_code, kind, target_type, target_value, starts_at, ends_at, reason, rule, actor, source, automated, pending)
    VALUES (?, ?, ?, 'warning', 'subject', ?, ?, NULL, 'r', ?, 'mod', 'moderator', 0, 0)`;

  it('old reports read with their category as the reported reason, the filter finds them, and old decisions count for accuracy', async () => {
    const path = filePath();
    // Written the way the 0.1.1 kit wrote it: raw rows on the version 16 schema.
    const raw = new DatabaseSync(path);
    dbs.push(raw);
    openStore({ db: raw, migrations: MIGRATIONS.slice(0, 16) });
    raw.prepare(OLD_REPORT).run('old0', NOW, 'r0', 's_rep', 's_t0', 'hate', null, 'actioned', NOW + 5, 'mod', 'ok');
    raw.prepare(OLD_REPORT).run('old1', NOW + 1, 'r1', 's_rep', 's_t1', 'disruption', null, 'actioned', NOW + 6, 'mod', 'ok');
    raw.prepare(OLD_REPORT).run('old2', NOW + 2, 'r2', 's_rep', 's_t2', 'spam', null, 'open', null, null, null);
    raw.prepare(OLD_SANCTION).run('s0', 'g0', 'M-AAAA0', 's_t0', NOW + 5, '1');
    raw.prepare(OLD_SANCTION).run('s1', 'g1', 'M-AAAA1', 's_t1', NOW + 6, '2');
    raw.prepare("INSERT INTO kit_decisions (key, report_id, at, result_json) VALUES ('k0', 'old0', ?, ?)").run(NOW + 5, JSON.stringify({ groups: [{ groupId: 'g0' }] }));
    raw.prepare("INSERT INTO kit_decisions (key, report_id, at, result_json) VALUES ('k1', 'old1', ?, ?)").run(NOW + 6, JSON.stringify({ groups: [{ groupId: 'g1' }] }));
    raw.close();

    const store = openStore({ path });
    expect(store.schemaVersion()).toBe(17);
    const clock = { t: NOW + 100, now: () => clock.t };
    const cw = await createChatwarden({ store, secret: 'v16', platform: { identify: (c) => c as RawWho }, clock, retention: false });
    expect(cw.reports.get('old0')?.reportedReason).toBe('hate');
    expect(cw.reports.get('old1')?.reportedReason).toBe('griefing');
    expect(cw.reports.get('old1')?.category).toBe('disruption');
    expect(cw.reports.list({ reason: 'disruption' }).items.map((r) => r.id)).toEqual(['old1']);
    expect(cw.reports.list({ reason: 'griefing' }).items.map((r) => r.id)).toEqual(['old1']);
    expect(cw.reports.list({ reason: null }).items).toEqual([]);
    // hate -> rule 1 (matched); griefing -> rule 6, decided under 2 (not matched); spam is still open.
    expect(cw.reports.reporterRecord('s_rep')).toMatchObject({ reports: 3, open: 1, actioned: 2, reasonDecided: 2, reasonMatched: 1 });
    // A new report with no reason works beside them.
    cw.rooms.seat('r9', 'p1', WHO('key-rep'), 'Rep');
    cw.rooms.seat('r9', 'p2', WHO('key-t9'), 'Tgt');
    expect(await cw.reports.submit({ roomId: 'r9', reporterSeat: 'p1', targetSeat: 'p2' })).toMatchObject({ ok: true });
    expect(cw.reports.list({ reason: null }).items).toHaveLength(1);
    store.close();
  });
});

describe('a corrupted stored profile layer is reported as unreadable (carry-over from 7f)', () => {
  const start = async (layerJson: string) => {
    const db = memDb();
    const store = openStore({ db });
    db.prepare('INSERT INTO kit_policy_layer (id, layer_json, version) VALUES (1, ?, 4)').run(layerJson);
    const cw = await createChatwarden({ store, secret: 's', platform: { identify: (c) => c as RawWho }, retention: false });
    return cw;
  };

  it.each([['{not json'], [''], ['   '], ['nul'], ['[1, 2'], ['"a string"'], ['null'], ['42'], ['[]'], ['true']])('stored text %j is unreadable, with the base live', async (text) => {
    const cw = await start(text);
    const state = cw.policy.get();
    expect(state.layerError).toEqual({ path: 'layer', kind: 'unreadable' });
    expect(state.version).toBe(4);
    expect(state.layer).toEqual({});
    expect(state.effective).toEqual(state.base);
  });

  it('a layer that reads but is not valid is invalid, with its path', async () => {
    const cw = await start(JSON.stringify({ profanity: { mode: 'allow' } }));
    expect(cw.policy.get().layerError).toEqual({ path: 'layer.profanity', kind: 'invalid' });
    const reporting = await start(JSON.stringify({ reporting: { flow: 'nope' } }));
    expect(reporting.policy.get().layerError).toEqual({ path: 'layer.reporting.flow', kind: 'invalid' });
  });

  it('a good layer has no layerError, and saving over an unreadable one repairs it', async () => {
    const good = await start(JSON.stringify({ customDuration: false }));
    expect(good.policy.get().layerError).toBeUndefined();
    const bad = await start('{not json');
    expect(bad.policy.save({ customDuration: false }, { version: 4, actor: 'owner_ann', reason: 'repair' })).toMatchObject({ ok: true });
    expect(bad.policy.get().layerError).toBeUndefined();
  });
});
