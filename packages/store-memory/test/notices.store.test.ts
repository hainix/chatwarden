import { describe, expect, it } from 'vitest';
import type { NoticeKind, NoticeRow } from '@chatwarden/core';
import { MemoryStore } from '../src/index.js';

// What is specific to MemoryStore in the notice methods: the purge of the four message kinds. The SQLite side (a table rebuilt to
// hold them) is covered with migration 22; the old kinds are covered by the shared contract suite.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const MESSAGE_KINDS: NoticeKind[] = ['rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'];

const row = (over: Partial<NoticeRow> = {}): NoticeRow => ({
  id: 'n1',
  subject: 's1',
  groupId: null,
  kind: 'appeal_upheld',
  rule: null,
  until: null,
  refCode: null,
  excerpt: [],
  createdAt: NOW,
  ackedAt: null,
  withdrawnAt: null,
  ...over,
});

const ids = (s: MemoryStore): string[] => s.rawNotices().map((n) => n.id);

describe('purgeNotices and the message kinds', () => {
  it('a seen message notice goes after the cutoff, for each of the four kinds', () => {
    for (const kind of MESSAGE_KINDS) {
      const s = new MemoryStore();
      s.insertNotice(row({ id: 'old', kind, createdAt: NOW - 100 * DAY, ackedAt: NOW - 99 * DAY }));
      s.insertNotice(row({ id: 'new', kind, createdAt: NOW - 10 * DAY, ackedAt: NOW - 9 * DAY }));
      expect(s.purgeNotices(NOW - 90 * DAY), kind).toBe(1);
      expect(ids(s), kind).toEqual(['new']);
    }
  });

  it('the cutoff is strict: a seen message notice created exactly on the line is kept', () => {
    const s = new MemoryStore();
    s.insertNotice(row({ id: 'edge', createdAt: NOW - 90 * DAY, ackedAt: NOW }));
    expect(s.purgeNotices(NOW - 90 * DAY)).toBe(0);
    expect(s.purgeNotices(NOW - 90 * DAY + 1)).toBe(1);
  });

  it('an unseen rename_required is kept past the cutoff, until it is seen or withdrawn', () => {
    const s = new MemoryStore();
    s.insertNotice(row({ id: 'rename', kind: 'rename_required', createdAt: NOW - 400 * DAY }));
    expect(s.purgeNotices(NOW - 90 * DAY)).toBe(0);
    expect(ids(s)).toEqual(['rename']);
    s.ackNotice('rename', NOW);
    expect(s.purgeNotices(NOW - 90 * DAY)).toBe(1);
  });

  it('an unseen appeal outcome follows the report-outcome rule: kept while unseen, removed once seen and old, or once withdrawn and old', () => {
    const s = new MemoryStore();
    s.insertNotice(row({ id: 'report', kind: 'report_outcome', createdAt: NOW - 200 * DAY }));
    s.insertNotice(row({ id: 'upheld', kind: 'appeal_upheld', createdAt: NOW - 200 * DAY }));
    s.insertNotice(row({ id: 'withdrawn', kind: 'appeal_revoked', createdAt: NOW - 200 * DAY, withdrawnAt: NOW - 199 * DAY }));
    // a report outcome and an appeal outcome are treated alike
    expect(s.purgeNotices(NOW - 90 * DAY)).toBe(1);
    expect(ids(s)).toEqual(['report', 'upheld']);
    s.ackNotice('upheld', NOW);
    s.ackNotice('report', NOW);
    expect(s.purgeNotices(NOW - 90 * DAY)).toBe(2);
    expect(ids(s)).toEqual([]);
  });

  it('the old kinds are purged as before: a seen chat notice with no end stays, a seen warning goes', () => {
    const s = new MemoryStore();
    s.insertNotice(row({ id: 'chat', kind: 'chat', groupId: 'g1', until: null, createdAt: NOW - 200 * DAY, ackedAt: NOW }));
    s.insertNotice(row({ id: 'warn', kind: 'warning', groupId: 'g2', createdAt: NOW - 200 * DAY, ackedAt: NOW }));
    s.insertNotice(row({ id: 'ended', kind: 'ban', groupId: 'g3', until: NOW - 100 * DAY, createdAt: NOW - 200 * DAY }));
    expect(s.purgeNotices(NOW - 90 * DAY)).toBe(2);
    expect(ids(s)).toEqual(['chat']);
  });

  it('a purge that finds nothing changes nothing', () => {
    const s = new MemoryStore();
    s.insertNotice(row({ id: 'fresh', ackedAt: NOW }));
    expect(s.purgeNotices(NOW - 90 * DAY)).toBe(0);
    expect(ids(s)).toEqual(['fresh']);
  });
});

describe('the message kinds in storage', () => {
  it('a message notice with no group is stored and loaded as written, and withdrawNoticeGroup leaves it alone', () => {
    const s = new MemoryStore();
    s.insertNotice(row({ id: 'm', kind: 'rename_required', rule: '2', refCode: 'M-ABCDE' }));
    expect(s.loadNotices(['s1'])).toEqual([row({ id: 'm', kind: 'rename_required', rule: '2', refCode: 'M-ABCDE' })]);
    expect(s.withdrawNoticeGroup('anything', NOW)).toBe(0);
    expect(s.findNoticeForGroup('anything')).toBeNull();
    expect(s.loadNotices(['s1'])[0]?.withdrawnAt).toBeNull();
  });
});
