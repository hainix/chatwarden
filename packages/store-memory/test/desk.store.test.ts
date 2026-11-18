import { describe, expect, it } from 'vitest';
import type { CommentRow, StoredReport } from '@chatwarden/core';
import { MemoryStore } from '../src/index.js';

// The desk contract (test/contract/desk.contract.ts) runs against MemoryStore from contract.test.ts. This file adds what only the in-memory store has to get right: the
// methods are on a bare store (no opt-in wrapper), and what it hands out is a copy.

const NOW = 1_800_000_000_000;
const report = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: 'R',
  tags: {},
  reporterSubject: 's_r',
  reporterSeat: 'p1',
  reporterHandle: 'R',
  targetSubject: 's_t',
  targetSeat: 'p2',
  targetHandle: 'T',
  category: 'spam',
  note: null,
  lineId: null,
  excerpt: [],
  people: [],
  status: 'open',
  ...over,
});
const comment = (id: string, over: Partial<CommentRow> = {}): CommentRow => ({ id, reportId: 'r1', at: NOW, actor: 'mod_ann', role: 'moderator', kind: 'comment', text: 'hello', ...over });

describe('MemoryStore: the desk methods', () => {
  it('a bare store has every desk method, so no wrapper is needed', () => {
    const s = new MemoryStore();
    for (const m of ['setReportUrgent', 'setHandoff', 'setEscalation', 'countOpenUrgent', 'countOpenEscalated', 'insertComment', 'listComments', 'deleteComment', 'countComments', 'purgeReportsByReason', 'addChatCounts', 'chatCounts', 'purgeChatCounts', 'insightRows'] as const) {
      expect(typeof s[m], m).toBe('function');
    }
  });

  it('a comment read back is a copy: changing it changes nothing stored', () => {
    const s = new MemoryStore();
    s.insertReport(report('r1'));
    s.insertComment(comment('c1'));
    const got = s.listComments('r1');
    (got[0] as { text: string | null }).text = 'changed';
    got.length = 0;
    expect(s.listComments('r1')[0]?.text).toBe('hello');
  });

  it('a comment given in is copied: changing the input afterwards changes nothing stored', () => {
    const s = new MemoryStore();
    s.insertReport(report('r1'));
    const row = comment('c1');
    s.insertComment(row);
    row.text = 'changed';
    expect(s.listComments('r1')[0]?.text).toBe('hello');
  });

  it('chat counts read back are copies', () => {
    const s = new MemoryStore();
    s.addChatCounts('2026-11-17', 1, 2);
    const rows = s.chatCounts('2026-11-17', '2026-11-17');
    (rows[0] as { delivered: number }).delivered = 99;
    expect(s.chatCounts('2026-11-17', '2026-11-17')[0]?.delivered).toBe(1);
  });

  it('insightRows are copies of what is stored, not the rows themselves', () => {
    const s = new MemoryStore();
    s.insertReport(report('r1', { urgent: true }));
    const rows = s.insightRows(0, 10);
    (rows[0] as { urgent: boolean }).urgent = false;
    expect(s.loadReport('r1')?.urgent).toBe(true);
  });

  it('a purge that is rolled back brings the comments and the report back', () => {
    const s = new MemoryStore();
    s.insertReport(report('r1', { createdAt: 1, reportedReason: 'welfare', category: 'other' }));
    s.insertComment(comment('c1'));
    expect(() =>
      s.transaction(() => {
        expect(s.purgeReportsByReason('welfare', NOW)).toBe(1);
        throw new Error('undo');
      }),
    ).toThrow('undo');
    expect(s.loadReport('r1')).not.toBeNull();
    expect(s.listComments('r1')).toHaveLength(1);
  });
});
