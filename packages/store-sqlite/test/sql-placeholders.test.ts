import { describe, expect, it } from 'vitest';
import {
  AI_ACTED_COUNT_SQL,
  AI_ACTION_COUNTS_SQL,
  AI_ACTION_DUE_SQL,
  AI_ACTION_INSERT_SQL,
  AI_ACTION_NOTES_SQL,
  AI_ACTION_PURGE_SQL,
  AI_ACTING_UPDATE_SQL,
  AI_GATE_ROWS_SQL,
  AI_READ_INSERT_SQL,
  AI_READ_TAKE_SQL,
  AI_UNREVIEWED_SQL,
  FILTER_HITS_ADD_SQL,
  FILTER_HITS_LIST_SQL,
  FILTER_HITS_PURGE_SQL,
  ORIGIN_REPORTS_COUNT_SQL,
  REPORT_INSERT_SQL,
  filterHitArgs,
  reportInsertArgs,
  aiActionInsertArgs,
  aiActionListSql,
  aiActionsOnSubjectsSql,
  aiActingUpdateArgs,
  aiActionTransitionSql,
  aiReadInsertArgs,
  aiReadTakeArgs,
  aiGateRowsArgs,
} from '../src/sqliteStore.js';
import type { AiActionRow, StoredReport } from '@chatwarden/core';

// node:sqlite on Node 22.13 throws "column index out of range" when more values are bound than a statement has placeholders (newer Node tolerates it), and numbered
// parameters (`?1`) count differently there. So every new statement uses plain `?` and binds exactly as many values as it has, in order. This counts them.

const placeholders = (sql: string): number => (sql.replace(/'[^']*'/g, '').match(/\?/g) ?? []).length;

describe('SQL placeholders and bound values agree (Node 22.13 binds strictly)', () => {
  it('the gate query uses plain ? placeholders, no numbered or named ones', () => {
    expect(AI_GATE_ROWS_SQL).not.toMatch(/\?\d/);
    expect(AI_GATE_ROWS_SQL).not.toMatch(/\s[:@$][a-z]\w*/i);
  });

  it('the gate query binds exactly as many values as it has placeholders', () => {
    expect(placeholders(AI_GATE_ROWS_SQL)).toBe(3);
    expect(aiGateRowsArgs(10, 20)).toHaveLength(placeholders(AI_GATE_ROWS_SQL));
  });

  it('in SQL order: the window start, then the recent window start twice', () => {
    expect(aiGateRowsArgs(10, 20)).toEqual([10, 20, 20]);
    const since = AI_GATE_ROWS_SQL.indexOf('decided_at >= ?');
    const recent = AI_GATE_ROWS_SQL.indexOf('decided_at >= ?', since + 1);
    expect(since).toBeGreaterThan(0);
    expect(recent).toBeGreaterThan(since);
    expect(placeholders(AI_GATE_ROWS_SQL.slice(0, recent))).toBe(1);
  });

  it('the counter itself sees a surplus (a control)', () => {
    expect(placeholders('SELECT ? , ?')).toBe(2);
    expect(placeholders("SELECT '?' , ?")).toBe(1);
  });
});

describe('the action statements (migration 25) bind exactly as many values as they have placeholders', () => {
  const row: AiActionRow = {
    id: 'a', reportId: 'r', readId: 'x', confirmReadId: null, rule: '3', severity: 'hostile', state: 'queued', refusedCode: null, notBefore: 1, createdAt: 1,
    groupId: null, kind: null, durationMs: null, actedAt: null, reviewDueAt: null, reviewedAt: null, reviewedBy: null, undoCode: null, undoNote: null, adapter: null, promptVersion: null,
  };

  it('the insert has one plain ? for each of the 21 columns, and the args are as many', () => {
    expect(placeholders(AI_ACTION_INSERT_SQL)).toBe(21);
    expect(aiActionInsertArgs(row)).toHaveLength(21);
    expect(AI_ACTION_INSERT_SQL).not.toMatch(/\?\d/);
  });

  it('the transition has a ? for each new value, the id and each state', () => {
    for (const [columns, states] of [[['state'], 1], [['state', 'refused_code', 'acted_at'], 3], [['kind', 'duration_ms'], 7]] as const) {
      expect(placeholders(aiActionTransitionSql(columns, states))).toBe(columns.length + 1 + states);
    }
  });

  it('the retention statements take one cutoff each, as plain ?', () => {
    expect(placeholders(AI_ACTION_PURGE_SQL)).toBe(1);
    expect(placeholders(AI_ACTION_NOTES_SQL)).toBe(1);
    expect(AI_ACTION_PURGE_SQL + AI_ACTION_NOTES_SQL).not.toMatch(/\?\d/);
  });

  it('the due, counts, acted-count and unreviewed statements', () => {
    expect(placeholders(AI_ACTION_DUE_SQL)).toBe(2);
    expect(placeholders(AI_ACTION_COUNTS_SQL)).toBe(1);
    expect(placeholders(AI_ACTED_COUNT_SQL)).toBe(1);
    expect(placeholders(AI_UNREVIEWED_SQL)).toBe(0);
  });

  it('the listing: the states, a cursor of three, then the limit', () => {
    for (const states of [0, 1, 4]) {
      expect(placeholders(aiActionListSql(states, false))).toBe(states + 1);
      expect(placeholders(aiActionListSql(states, true))).toBe(states + 3 + 1);
    }
  });

  it('the actions on subjects: the two times, then one for each subject', () => {
    for (const n of [1, 2, 9]) expect(placeholders(aiActionsOnSubjectsSql(n))).toBe(2 + n);
  });

  it('every statement uses plain ? placeholders: no numbered or named ones', () => {
    for (const sql of [AI_ACTION_INSERT_SQL, AI_ACTION_DUE_SQL, AI_ACTION_COUNTS_SQL, AI_ACTED_COUNT_SQL, aiActionListSql(2, true), aiActionsOnSubjectsSql(3), aiActionTransitionSql(['state'], 2)]) {
      expect(sql).not.toMatch(/\?\d/);
      expect(sql).not.toMatch(/\s[:@$][a-z]\w*/i);
    }
  });
});

describe('the read reservation and the acting state bind exactly as many values as they have placeholders', () => {
  const pending = { reportId: 'r', inputHash: 'h', adapter: 'fake', promptVersion: 5, purpose: 'confirm' } as never;

  it('the reserve INSERT: eight ?, eight values, the purpose last (and "read" when none is given)', () => {
    expect(placeholders(AI_READ_INSERT_SQL)).toBe(8);
    expect(aiReadInsertArgs('id', pending, 100, 50)).toEqual(['id', 'r', 'h', 100, 'fake', 5, 50, 'confirm']);
    expect(aiReadInsertArgs('id', { ...(pending as object), purpose: undefined } as never, 100, 50)).toHaveLength(8);
    expect(aiReadInsertArgs('id', { ...(pending as object), purpose: undefined } as never, 100, 50)[7]).toBe('read');
    expect(AI_READ_INSERT_SQL).not.toMatch(/\?\d/);
  });

  it('the reserve take-over UPDATE: seven ?, seven values, in SQL order', () => {
    for (const retake of [0, 1] as const) {
      expect(placeholders(AI_READ_TAKE_SQL)).toBe(7);
      expect(aiReadTakeArgs(pending, 100, 50, retake)).toEqual([100, retake, 'r', 'h', 50, 50, retake]);
    }
    expect(AI_READ_TAKE_SQL).not.toMatch(/\?\d/);
  });

  it('the acting UPDATE: eight ?, eight values, the new row first and then what it expects', () => {
    const next = { mode: 'shadow', modeSince: 5, modeBy: 'owen', paused: false, pausedSince: null, pausedBy: null } as const;
    expect(placeholders(AI_ACTING_UPDATE_SQL)).toBe(8);
    expect(aiActingUpdateArgs({ mode: 'off', paused: true }, next)).toEqual(['shadow', 5, 'owen', 0, null, null, 'off', 1]);
    expect(aiActingUpdateArgs({ mode: 'shadow', paused: false }, { ...next, paused: true, pausedSince: 9, pausedBy: 'sam' })).toHaveLength(placeholders(AI_ACTING_UPDATE_SQL));
    expect(AI_ACTING_UPDATE_SQL).not.toMatch(/\?\d/);
  });
});

describe('the filter statements (migration 26) bind exactly as many values as they have placeholders', () => {
  const stored: StoredReport = {
    id: 'r', createdAt: 1, roomId: 'x', tags: { a: 'b' }, reporterSubject: 'filter:r', reporterSeat: '', reporterHandle: '', targetSubject: 's', targetSeat: 'p2', targetHandle: 'T',
    category: 'spam', reportedReason: 'spam', note: null, lineId: null, excerpt: [], people: [], status: 'open', origin: 'filter', originKey: 'link.unlisted',
  };

  it('the report insert has one plain ? for each of its 19 columns and 19 values, the origin pair last (null when the report has none)', () => {
    expect(placeholders(REPORT_INSERT_SQL)).toBe(19);
    expect(reportInsertArgs(stored)).toHaveLength(19);
    expect(reportInsertArgs(stored).slice(-2)).toEqual(['filter', 'link.unlisted']);
    const plain = { ...stored } as Partial<StoredReport>;
    delete plain.origin;
    delete plain.originKey;
    expect(reportInsertArgs(plain as StoredReport).slice(-2)).toEqual([null, null]);
    expect(reportInsertArgs(plain as StoredReport)).toHaveLength(placeholders(REPORT_INSERT_SQL));
    expect(REPORT_INSERT_SQL).not.toMatch(/\?\d/);
  });

  it('the hit upsert takes four values, the list two (the days), the purge one, the origin count two', () => {
    expect(placeholders(FILTER_HITS_ADD_SQL)).toBe(4);
    expect(filterHitArgs({ day: 1, key: 'k', action: 'count', hits: 2 })).toEqual([1, 'k', 'count', 2]);
    expect(placeholders(FILTER_HITS_LIST_SQL)).toBe(2);
    expect(placeholders(FILTER_HITS_PURGE_SQL)).toBe(1);
    expect(placeholders(ORIGIN_REPORTS_COUNT_SQL)).toBe(2);
    for (const sql of [FILTER_HITS_ADD_SQL, FILTER_HITS_LIST_SQL, FILTER_HITS_PURGE_SQL, ORIGIN_REPORTS_COUNT_SQL]) {
      expect(sql).not.toMatch(/\?\d/);
      expect(sql).not.toMatch(/\s[:@$][a-z]\w*/i);
    }
  });

  it('the hit upsert adds to the stored count instead of replacing it', () => {
    expect(FILTER_HITS_ADD_SQL).toMatch(/ON CONFLICT \(day, key, action\) DO UPDATE SET hits = hits \+ excluded\.hits/);
  });
});
