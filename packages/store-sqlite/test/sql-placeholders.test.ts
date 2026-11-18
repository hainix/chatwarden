import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  AI_ACTED_COUNT_SQL,
  APPEAL_BY_GROUP_SQL,
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
  CHAT_COUNTS_ADD_SQL,
  CHAT_COUNTS_LIST_SQL,
  CHAT_COUNTS_PURGE_SQL,
  COMMENT_COUNT_SQL,
  COMMENT_DELETE_SQL,
  COMMENT_INSERT_SQL,
  COMMENT_LIST_SQL,
  COMMENTS_ORPHAN_DELETE_SQL,
  ESCALATED_COUNT_SQL,
  FILTER_HITS_ADD_SQL,
  FILTER_HITS_LIST_SQL,
  FILTER_HITS_PURGE_SQL,
  INSIGHT_ROWS_SQL,
  NOTICE_BY_ID_SQL,
  SETUP_LOAD_SQL,
  SETUP_SAVE_SQL,
  OVERTURN_FILTER_COUNTS_SQL,
  OVERTURN_INSERT_SQL,
  OVERTURN_PURGE_SQL,
  OVERTURN_REPORT_SQL,
  OVERTURN_SANCTION_SQL,
  OVERTURN_TERM_COUNTS_SQL,
  ORIGIN_REPORTS_COUNT_SQL,
  PACE_DROP_ROOM_SQL,
  PACE_LOAD_SQL,
  PACE_SWEEP_SQL,
  PACE_UPSERT_SQL,
  REASON_PURGE_WHERE,
  REPORT_ESCALATION_SET_SQL,
  REPORT_HANDOFF_SET_SQL,
  REPORT_INSERT_SQL,
  REPORT_URGENT_SET_SQL,
  URGENT_COUNT_SQL,
  filterHitArgs,
  latestAutoChatStartSql,
  overturnStrikesSql,
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
import { registrySubjectColumns } from '@chatwarden/core';
import type { AiActionRow, StoredReport } from '@chatwarden/core';
import { IDENTIFIER_UPSERT_SQL } from '../src/sqliteStore.js';
import * as PRIV from '../src/privacy.js';
import { openStore } from '../src/index.js';
import { seedWorld } from '../../../test/contract/privacy.contract.js';

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

  it('the report insert has one plain ? for each of its 23 columns and 23 values, the origin pair, then urgent, the evidence ref, the scope and the entity last (0, null, null and null when the report has none)', () => {
    expect(placeholders(REPORT_INSERT_SQL)).toBe(23);
    expect(reportInsertArgs(stored)).toHaveLength(23);
    expect(reportInsertArgs(stored).slice(-6)).toEqual(['filter', 'link.unlisted', 0, null, null, null]);
    const entity = { kind: 'clan', ref: 'clan-1', label: 'Blue Wolves' };
    expect(reportInsertArgs({ ...stored, urgent: true, evidenceRef: 'm_1', scope: 'creator:alice', entity }).slice(-4)).toEqual([1, 'm_1', 'creator:alice', JSON.stringify(entity)]);
    const plain = { ...stored } as Partial<StoredReport>;
    delete plain.origin;
    delete plain.originKey;
    expect(reportInsertArgs(plain as StoredReport).slice(-6)).toEqual([null, null, 0, null, null, null]);
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

describe('the desk statements (migration 26, the urgent-lane block) bind exactly as many values as they have placeholders', () => {
  it('each statement has the number of plain ? placeholders its method binds', () => {
    const counts: Array<[string, string, number]> = [
      ['REPORT_URGENT_SET_SQL', REPORT_URGENT_SET_SQL, 3],
      ['REPORT_HANDOFF_SET_SQL', REPORT_HANDOFF_SET_SQL, 3],
      ['REPORT_ESCALATION_SET_SQL', REPORT_ESCALATION_SET_SQL, 7],
      ['URGENT_COUNT_SQL', URGENT_COUNT_SQL, 0],
      ['ESCALATED_COUNT_SQL', ESCALATED_COUNT_SQL, 0],
      ['COMMENT_INSERT_SQL', COMMENT_INSERT_SQL, 9],
      ['COMMENT_LIST_SQL', COMMENT_LIST_SQL, 1],
      ['COMMENT_COUNT_SQL', COMMENT_COUNT_SQL, 1],
      ['COMMENT_DELETE_SQL', COMMENT_DELETE_SQL, 1],
      ['COMMENTS_ORPHAN_DELETE_SQL', COMMENTS_ORPHAN_DELETE_SQL, 0],
      ['REASON_PURGE_WHERE', REASON_PURGE_WHERE, 2],
      ['CHAT_COUNTS_ADD_SQL', CHAT_COUNTS_ADD_SQL, 3],
      ['CHAT_COUNTS_LIST_SQL', CHAT_COUNTS_LIST_SQL, 2],
      ['CHAT_COUNTS_PURGE_SQL', CHAT_COUNTS_PURGE_SQL, 1],
      ['INSIGHT_ROWS_SQL', INSIGHT_ROWS_SQL, 2],
      ['PACE_LOAD_SQL', PACE_LOAD_SQL, 2],
      ['PACE_UPSERT_SQL', PACE_UPSERT_SQL, 7],
      ['PACE_SWEEP_SQL', PACE_SWEEP_SQL, 1],
      ['PACE_DROP_ROOM_SQL', PACE_DROP_ROOM_SQL, 1],
    ];
    for (const [name, sql, n] of counts) {
      expect(placeholders(sql), name).toBe(n);
      expect(sql, name).not.toMatch(/\?\d/);
      expect(sql, name).not.toMatch(/\s[:@$][a-z]\w*/i);
    }
  });

  it('the reason purge runs its three deletes with the two values each, and the statements run on a real database (a spy sees every bind count)', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    store.insertReport({ id: 'w', createdAt: 1, roomId: 'R', tags: {}, reporterSubject: 's_a', reporterSeat: 'p1', reporterHandle: 'A', targetSubject: 's_b', targetSeat: 'p2', targetHandle: 'B', category: 'other', reportedReason: 'welfare', note: null, lineId: null, excerpt: [], people: [], status: 'open' });
    const known = new Map<string, number>();
    const real = db.prepare.bind(db);
    db.prepare = ((text: string) => {
      const st = real(text);
      const n = placeholders(text);
      known.set(text, n);
      return new Proxy(st, {
        get(target, prop) {
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (typeof v !== 'function') return v;
          if (prop === 'run' || prop === 'all' || prop === 'get') {
            return (...args: unknown[]) => {
              expect(args.length, text.slice(0, 70)).toBe(n);
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return v.bind(target);
        },
      });
    }) as typeof db.prepare;
    store.setReportUrgent?.('w', true);
    store.setReportUrgent?.('w', false);
    store.setHandoff?.('w', 'mod', 5);
    store.setEscalation?.('w', { to: 'senior', by: 'mod', at: 6 });
    store.setEscalation?.('w', null);
    store.insertComment?.({ id: 'c1', reportId: 'w', at: 1, actor: 'mod', role: 'moderator', kind: 'comment', text: 't' });
    store.listComments?.('w');
    store.countComments?.('w');
    store.deleteComment?.('c1');
    store.countOpenUrgent?.();
    store.countOpenEscalated?.();
    store.addChatCounts?.('2026-11-17', 1, 2);
    store.chatCounts?.('2026-11-17', '2026-11-17');
    store.purgeChatCounts?.('2026-11-18');
    store.paceLoad?.('r', 'w');
    store.paceUpdate?.('r', 'w', () => ({ roomId: 'r', who: 'w', lastAt: 1, stamps: [1], recent: [], floodSignalAt: null, touchedAt: 1 }));
    store.paceSweep?.(0);
    store.paceDropRoom?.('r');
    store.insightRows?.(0, 10);
    store.purgeReportsByReason?.('welfare', 10);
    store.purgeReports(10, 0);
    for (const sql of [REPORT_URGENT_SET_SQL, REPORT_HANDOFF_SET_SQL, REPORT_ESCALATION_SET_SQL, COMMENT_INSERT_SQL, COMMENT_LIST_SQL, CHAT_COUNTS_ADD_SQL, INSIGHT_ROWS_SQL]) {
      expect(known.has(sql), sql.slice(0, 60)).toBe(true);
    }
  });
});

// Overturn statements (migration 27, block 1): one plain ? per bound value, the lists in IN (...) sized to the list.
describe('the overturn statements (migration 27) bind exactly as many values as they have placeholders', () => {
  it('each fixed statement has the number of plain ? placeholders its method binds', () => {
    const counts: Array<[string, string, number]> = [
      ['APPEAL_BY_GROUP_SQL', APPEAL_BY_GROUP_SQL, 1],
      ['OVERTURN_INSERT_SQL', OVERTURN_INSERT_SQL, 7],
      ['OVERTURN_SANCTION_SQL', OVERTURN_SANCTION_SQL, 2],
      ['OVERTURN_REPORT_SQL', OVERTURN_REPORT_SQL, 2],
      ['OVERTURN_TERM_COUNTS_SQL', OVERTURN_TERM_COUNTS_SQL, 1],
      ['OVERTURN_FILTER_COUNTS_SQL', OVERTURN_FILTER_COUNTS_SQL, 1],
      ['OVERTURN_PURGE_SQL', OVERTURN_PURGE_SQL, 1],
    ];
    for (const [name, sql, n] of counts) {
      expect(placeholders(sql), name).toBe(n);
      expect(sql, name).not.toMatch(/\?\d/);
      expect(sql, name).not.toMatch(/\s[:@$][a-z]\w*/i);
    }
  });

  it('the sized statements have one ? per listed id plus their fixed values', () => {
    for (const n of [1, 2, 5, 500]) {
      expect(placeholders(overturnStrikesSql(n)), `strikes ${n}`).toBe(n + 2);
      expect(placeholders(latestAutoChatStartSql(n)), `latest ${n}`).toBe(n);
      expect(overturnStrikesSql(n)).not.toMatch(/\?\d/);
      expect(latestAutoChatStartSql(n)).not.toMatch(/\?\d/);
    }
  });

  it('the statements run on a real database and every bind count matches (a spy on each prepared statement)', () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    const known = new Set<string>();
    const real = db.prepare.bind(db);
    db.prepare = ((text: string) => {
      const st = real(text);
      const n = placeholders(text);
      known.add(text);
      return new Proxy(st, {
        get(target, prop) {
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (typeof v !== 'function') return v;
          if (prop === 'run' || prop === 'all' || prop === 'get') {
            return (...args: unknown[]) => {
              expect(args.length, text.slice(0, 70)).toBe(n);
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return v.bind(target);
        },
      });
    }) as typeof db.prepare;
    const o = { groupId: 'g1', at: 5, subject: 's_a', aliases: ['s_a', 's_b', 's_c'], source: 'auto_filter' as const, termId: 't1', filterKey: null, reportId: 'r1', strikes: { from: 1, to: 9 } };
    expect(store.recordOverturn?.(o)).toBe(true);
    expect(store.recordOverturn?.(o)).toBe(false);
    expect(store.recordOverturn?.({ ...o, groupId: 'g2', reportId: null, strikes: null })).toBe(true);
    store.latestAutoChatStart?.(['s_a', 's_b']);
    store.overturnedTermCounts?.(0);
    store.overturnedFilterCounts?.(0);
    store.purgeOverturns?.(100);
    expect(store.loadAppealByGroup?.('g1')).toBeNull();
    for (const sql of [APPEAL_BY_GROUP_SQL, OVERTURN_INSERT_SQL, OVERTURN_SANCTION_SQL, OVERTURN_REPORT_SQL, OVERTURN_TERM_COUNTS_SQL, OVERTURN_FILTER_COUNTS_SQL, OVERTURN_PURGE_SQL, overturnStrikesSql(3), latestAutoChatStartSql(2)]) {
      expect(known.has(sql), sql.slice(0, 60)).toBe(true);
    }
  });
});

describe('the notice lookup (loadNotice, 0.2.1) binds exactly one value', () => {
  it('one plain ? placeholder, and the statement runs with the one value', () => {
    expect(placeholders(NOTICE_BY_ID_SQL)).toBe(1);
    expect(NOTICE_BY_ID_SQL).not.toMatch(/\?\d/);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    expect(store.loadNotice?.('nothing')).toBeNull();
  });
});

describe('the setup state (kit_meta row, 0.2.2) binds exactly as many values as it has placeholders', () => {
  it('the load takes the key (1) and the save the key and the value (2), plain ? only, and both run', () => {
    expect(placeholders(SETUP_LOAD_SQL)).toBe(1);
    expect(placeholders(SETUP_SAVE_SQL)).toBe(2);
    expect(SETUP_LOAD_SQL + SETUP_SAVE_SQL).not.toMatch(/\?\d/);
    expect(SETUP_LOAD_SQL + SETUP_SAVE_SQL).not.toMatch(/\s[:@$][a-z]\w*/i);
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    store.saveSetupState?.({ dismissedAt: 3 });
    expect(store.getSetupState?.()).toEqual({ dismissedAt: 3 });
  });
});

// Privacy statements (0.2.0): each takes its lists as ONE JSON value bound to json_each(?), so the number of placeholders is fixed whatever the size of the set.
describe('the privacy statements bind exactly as many values as they have placeholders', () => {
  const texts = new Map<string, string>([
    ...Object.entries(PRIV)
      .filter(([k, v]) => k.endsWith('_SQL') && typeof v === 'string')
      .map(([k, v]) => [k, v as string] as [string, string]),
    ['IDENTIFIER_UPSERT_SQL', IDENTIFIER_UPSERT_SQL],
    ...Object.entries(PRIV.STRAY_BEFORE_SQL).map(([k, v]) => [`STRAY_BEFORE_SQL.${k}`, v] as [string, string]),
    ...Object.entries(PRIV.STRAY_ONLY_SQL).map(([k, v]) => [`STRAY_ONLY_SQL.${k}`, v] as [string, string]),
    ['AI_ACTION_PURGE_SQL', AI_ACTION_PURGE_SQL],
    ['AI_ACTION_NOTES_SQL', AI_ACTION_NOTES_SQL],
    // the age-out reads every column the registry names, one statement each (built from the registry, so a new column is spied on too)
    ...registrySubjectColumns().plain.map((c) => [`idleReferencedSql(${c})`, PRIV.idleReferencedSql(c)] as [string, string]),
    ...registrySubjectColumns().json.map((c) => [`idleJsonRowsSql(${c})`, PRIV.idleJsonRowsSql(c)] as [string, string]),
  ]);
  const EXPECTED: Record<string, number> = {
    ERASE_CLOSURE_SQL: 1,
    GROUPS_OF_SET_SQL: 1,
    GROUPS_IN_FORCE_SQL: 2,
    GROUPS_OF_HELD_SQL: 1,
    COUNT_GROUP_ROWS_SQL: 1,
    HELD_NAMING_SQL: 4,
    REPORTS_ABOUT_IDS_SQL: 2,
    REPORTS_NAMING_SQL: 3,
    REPORT_SCRUB_SQL: 8,
    NOTICES_DELETE_SQL: 2,
    NOTICES_CLEAR_SQL: 2,
    MUTES_DELETE_SQL: 2,
    APPEALS_DELETE_SQL: 2,
    OVERTURNS_DELETE_SQL: 2,
    OVERTURNS_UNLINK_SQL: 1,
    EXPORT_APPEALS_SQL: 2,
    SIGNALS_DELETE_SQL: 2,
    AUDIT_REWRITE_SQL: 2,
    EPOCH_BUMP_SQL: 1,
    EPOCH_READ_SQL: 1,
    ERASURE_INSERT_SQL: 6,
    ERASURES_PENDING_SQL: 0,
    ERASURES_PURGE_SQL: 1,
    EXPORT_MUTES_SQL: 4,
    PACE_DELETE_SQL: 1,
    EXPORT_PACE_SQL: 1,
    EXPORT_SANCTIONS_SQL: 2,
    'STRAY_BEFORE_SQL.STRIKES': 1,
    'STRAY_BEFORE_SQL.NOTICES': 1,
    'STRAY_ONLY_SQL.SIGNALS': 1,
    'STRAY_ONLY_SQL.NAMES': 1,
    HOLD_PLACE_SQL: 4,
    HOLD_RELEASE_SQL: 3,
    HOLD_LOAD_SQL: 1,
    HOLD_LIST_SQL: 0,
    EXPORT_HOLDS_SQL: 2,
    COMMENTS_SCRUB_SQL: 3,
    EXPORT_COMMENTS_SQL: 3,
    SANCTION_ROWS_LEFT_SQL: 2,
    DECISIONS_NAMING_SQL: 2,
    DECISION_RESULT_SET_SQL: 2,
    WEBHOOK_KEYS_BLANK_SQL: 1,
    EOS_LINKS_DELETE_SQL: 1,
    AI_ACTION_PURGE_SQL: 1,
    AI_ACTION_NOTES_SQL: 1,
    IDENTIFIER_UPSERT_SQL: 6,
    IDLE_CANDIDATES_SQL: 1,
    SUBJECT_LINKS_SQL: 0,
    'idleReferencedSql(kit_notices.subject_id)': 1,
    'idleJsonRowsSql(kit_reports.people_json)': 0,
  };

  it('every statement uses plain ? placeholders (no numbered, named or spliced values)', () => {
    expect(texts.size).toBeGreaterThan(40);
    for (const [k, sql] of texts) {
      expect(sql, k).not.toMatch(/\?\d/);
      expect(sql, k).not.toMatch(/\s[:@$][a-z]\w*/i);
    }
  });

  it('the counts of the statements that are not one-list-one-value are pinned', () => {
    for (const [k, n] of Object.entries(EXPECTED)) {
      expect(texts.has(k), `${k} exists`).toBe(true);
      expect(placeholders(texts.get(k) ?? ''), k).toBe(n);
    }
  });

  it('every statement the age-out builds from the registry binds one list (plain columns) or nothing (JSON columns)', () => {
    const { plain, json } = registrySubjectColumns();
    expect(plain.length).toBeGreaterThan(15);
    for (const c of plain) expect(placeholders(PRIV.idleReferencedSql(c)), c).toBe(1);
    for (const c of json) expect(placeholders(PRIV.idleJsonRowsSql(c)), c).toBe(0);
    expect(() => PRIV.idleReferencedSql('kit_notices.subject_id; DROP TABLE kit_notices')).toThrow();
    expect(() => PRIV.idleJsonRowsSql('notices.x')).toThrow();
  });

  it('a whole erase, finish and export bind exactly as many values as each statement has placeholders (a spy on every prepared privacy statement)', async () => {
    const db = new DatabaseSync(':memory:');
    const store = openStore({ db });
    await seedWorld(store, { ban: true, held: true });
    const known = new Set(texts.values());
    const seen = new Set<string>();
    const real = db.prepare.bind(db);
    db.prepare = ((text: string) => {
      const st = real(text);
      if (!known.has(text)) return st;
      const n = placeholders(text);
      return new Proxy(st, {
        get(target, prop) {
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          if (typeof v !== 'function') return v;
          if (prop === 'run' || prop === 'all' || prop === 'get') {
            return (...args: unknown[]) => {
              expect(args.length, text.slice(0, 60)).toBe(n);
              seen.add(text);
              return (v as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return v.bind(target);
        },
      });
    }) as typeof db.prepare;
    store.exportSubjects(['s_pp']);
    store.eraseSubjects({ subjects: ['s_pp'], mode: 'safety', heldReportIds: new Set(['rHeld']), receiptId: 'e_spy', at: 1_800_000_000_000 });
    store.insertErasure({ id: 'e_spy', at: 1, mode: 'safety', actor: 'o', removed: {}, kept: { identifiers: true, sanctions: 0, heldReports: 0 }, pendingSubject: 's_pp' });
    store.loadPendingErasures();
    store.finishErasure('e_spy', 1_800_000_000_000);
    store.purgeAudit(2);
    await store.saveIdentifier({ subjectId: 's_qq', kind: 'key', value: 'k2', firstSeen: 1, lastSeen: 2 });
    store.erasureEpoch();
    store.purgeStrayRows(5);
    store.purgeStrayRows(0, ['s_gone']);
    // the age-out: one person with no record to take, the rest of the world to leave
    await store.saveSubject({ id: 's_idle', createdAt: 1, mergedInto: null });
    await store.saveIdentifier({ subjectId: 's_idle', kind: 'key', value: 'k-idle', firstSeen: 1, lastSeen: 2 });
    expect(store.purgeIdleSubjects?.(1_700_000_000_000)).toBe(1);
    for (const k of ['IDLE_CANDIDATES_SQL', 'SUBJECT_LINKS_SQL', 'idleReferencedSql(kit_notices.subject_id)', 'idleJsonRowsSql(kit_reports.people_json)']) {
      expect(seen.has(texts.get(k) ?? ''), k).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(20);
    expect(seen.has(IDENTIFIER_UPSERT_SQL)).toBe(true);
    // the statements of the fix round ran too: the decision rewrite, the webhook blank, the EOS links and the finish with a hold in the way
    for (const k of ['DECISIONS_NAMING_SQL', 'DECISION_RESULT_SET_SQL', 'WEBHOOK_KEYS_BLANK_SQL', 'EOS_LINKS_DELETE_SQL', 'SANCTION_ROWS_LEFT_SQL', 'EXPORT_HOLDS_SQL']) {
      expect(seen.has(texts.get(k) ?? ''), k).toBe(true);
    }
  });
});
