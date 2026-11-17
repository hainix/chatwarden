import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommentRow, StoredReport } from '@chatwarden/core';
import { openStore } from '../src/index.js';

// The desk contract (test/contract/desk.contract.ts) runs against SqliteStore from contract.test.ts. This file adds what only SQLite has to get right: two
// connections adding to the same day, one transaction for a purge, the rows a failed write leaves behind, and what the raw tables hold.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const report = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: `R-${id}`,
  tags: {},
  reporterSubject: `s_r_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'R',
  targetSubject: `s_t_${id}`,
  targetSeat: 'p2',
  targetHandle: 'T',
  category: 'spam',
  note: 'quissel note',
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  ...over,
});
const comment = (id: string, reportId: string, over: Partial<CommentRow> = {}): CommentRow => ({ id, reportId, at: NOW, actor: 'mod_ann', role: 'moderator', kind: 'comment', text: 'hello', ...over });

const cleanup: Array<() => void> = [];
afterEach(() => {
  // Reverse order: a database is closed before its folder is removed (Windows refuses to delete an open file).
  for (const f of cleanup.splice(0).reverse()) f();
});
const fileDb = (): { path: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-desk-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { path: join(dir, 'kit.db') };
};
const open = (path: string) => {
  const db = new DatabaseSync(path);
  cleanup.push(() => {
    try {
      db.close();
    } catch {
      /* closed */
    }
  });
  return { db, store: openStore({ db }) };
};

describe('SqliteStore: the daily line counts across connections', () => {
  it('two connections adding to the same day sum, never replace', () => {
    const { path } = fileDb();
    const a = open(path);
    const b = open(path);
    for (let i = 0; i < 20; i++) {
      a.store.addChatCounts?.('2026-11-17', 3, 1);
      b.store.addChatCounts?.('2026-11-17', 2, 4);
    }
    expect(a.store.chatCounts?.('2026-11-17', '2026-11-17')).toEqual([{ day: '2026-11-17', delivered: 100, refused: 100 }]);
    expect(b.store.chatCounts?.('2026-11-17', '2026-11-17')).toEqual([{ day: '2026-11-17', delivered: 100, refused: 100 }]);
  });

  it('a first add inside a transaction that is rolled back leaves no row', () => {
    const { store } = open(':memory:');
    expect(() =>
      store.transaction(() => {
        store.addChatCounts?.('2026-11-17', 1, 1);
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(store.chatCounts?.('2026-11-01', '2026-11-30')).toEqual([]);
  });
});

describe('SqliteStore: purges are one transaction', () => {
  it('purgeReportsByReason deletes the report, its comments and its decision together, and a failure in the middle undoes all of it', () => {
    const { db, store } = open(':memory:');
    store.insertReport(report('w', { createdAt: NOW - 60 * DAY, reportedReason: 'welfare', category: 'other' }));
    store.insertComment?.(comment('c1', 'w'));
    store.insertDecision('k', 'w', NOW, '{"groups":[]}');
    // make the last statement of the purge fail: a trigger on the comments table that raises on delete
    db.exec("CREATE TRIGGER no_comment_delete BEFORE DELETE ON kit_report_comments BEGIN SELECT RAISE(ABORT, 'no'); END;");
    expect(() => store.purgeReportsByReason?.('welfare', NOW - 30 * DAY)).toThrow();
    expect(store.loadReport('w')).not.toBeNull();
    expect(store.listComments?.('w')).toHaveLength(1);
    expect(store.findDecision('k')).not.toBeNull();
    db.exec('DROP TRIGGER no_comment_delete');
    expect(store.purgeReportsByReason?.('welfare', NOW - 30 * DAY)).toBe(1);
    expect(store.listComments?.('w')).toEqual([]);
    expect(store.findDecision('k')).toBeNull();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM kit_report_comments').get()?.n)).toBe(0);
  });

  it('purgeReports leaves no orphan comment behind (the table holds only comments of existing reports)', () => {
    const { db, store } = open(':memory:');
    store.insertReport(report('old', { createdAt: NOW - 100 * DAY }));
    store.insertReport(report('new', { createdAt: NOW }));
    store.insertComment?.(comment('c1', 'old'));
    store.insertComment?.(comment('c2', 'new'));
    expect(store.purgeReports(NOW - 90 * DAY, 0)).toBe(1);
    expect(db.prepare('SELECT report_id FROM kit_report_comments').all().map((r) => String(r.report_id))).toEqual(['new']);
  });
});

describe('SqliteStore: the raw rows', () => {
  it('a comment with no text (an ask without a note) is stored as NULL, and the staff role is the one given', () => {
    const { db, store } = open(':memory:');
    store.insertReport(report('r1'));
    store.insertComment?.(comment('c1', 'r1', { kind: 'ask', text: null, role: 'senior', actor: 'sen_bo' }));
    const row = db.prepare('SELECT kind, text, role, actor FROM kit_report_comments').get();
    expect({ ...row }).toEqual({ kind: 'ask', text: null, role: 'senior', actor: 'sen_bo' });
  });

  it('the urgent flag is stored as 0 or 1 and an escalation as its three columns', () => {
    const { db, store } = open(':memory:');
    store.insertReport(report('r1'));
    store.setReportUrgent?.('r1', true);
    store.setEscalation?.('r1', { to: 'owner', by: 'sen_bo', at: NOW + 1 });
    expect({ ...db.prepare('SELECT urgent, escalated_to, escalated_by, escalated_at FROM kit_reports').get() }).toEqual({ urgent: 1, escalated_to: 'owner', escalated_by: 'sen_bo', escalated_at: NOW + 1 });
  });

  it('a report inserted without urgent or evidenceRef stores 0 and NULL', () => {
    const { db, store } = open(':memory:');
    store.insertReport(report('r1'));
    expect({ ...db.prepare('SELECT urgent, evidence_ref FROM kit_reports').get() }).toEqual({ urgent: 0, evidence_ref: null });
  });

  it('the 51st comment is refused even when two connections insert at once (the count and the insert are one statement or one transaction)', () => {
    const { path } = fileDb();
    const a = open(path);
    const b = open(path);
    a.store.insertReport(report('r1'));
    let accepted = 0;
    for (let i = 0; i < 60; i++) {
      const store = i % 2 === 0 ? a.store : b.store;
      if (store.insertComment?.(comment(`c${String(i).padStart(3, '0')}`, 'r1')) === true) accepted += 1;
    }
    expect(accepted).toBe(50);
    expect(a.store.countComments?.('r1')).toBe(50);
  });
});
