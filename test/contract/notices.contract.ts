import { describe, expect, it } from 'vitest';
import type { NoticeRow, Store } from '@chatwarden/core';

// The contract of the player-notice methods of the Store. One suite, run against every Store.

const DAY = 86_400_000;
const T = 1_800_000_000_000;

const notice = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id,
  subject: 's_a',
  groupId: 'g1',
  kind: 'warning',
  rule: '2',
  until: null,
  refCode: 'M-AAAAA',
  excerpt: [{ text: 'a masked line', day: '2027-01-15' }],
  createdAt: T,
  ackedAt: null,
  withdrawnAt: null,
  ...over,
});
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

export function noticesContract(name: string, make: () => Store): void {
  describe(`notices contract: ${name}`, () => {
    it('insertNotice then loadNotices round-trips every field, nulls included', () => {
      const s = make();
      const a = notice('n1');
      const b = notice('n2', { groupId: null, kind: 'report_outcome', rule: null, refCode: null, excerpt: [] });
      s.insertNotice(a);
      s.insertNotice(b);
      expect(s.loadNotices(['s_a'])).toEqual([a, b]);
    });

    it('loadNotices matches any of the given subject ids, oldest first, ties in write order', () => {
      const s = make();
      s.insertNotice(notice('late', { createdAt: T + 10 }));
      s.insertNotice(notice('alias', { subject: 's_alias', createdAt: T }));
      s.insertNotice(notice('tie1', { createdAt: T + 5 }));
      s.insertNotice(notice('tie2', { createdAt: T + 5 }));
      s.insertNotice(notice('other', { subject: 's_other', createdAt: T }));
      expect(ids(s.loadNotices(['s_a', 's_alias']))).toEqual(['alias', 'tie1', 'tie2', 'late']);
      expect(ids(s.loadNotices(['s_other']))).toEqual(['other']);
    });

    it('controls: an empty list, an unknown subject and a different case match nothing', () => {
      const s = make();
      s.insertNotice(notice('n1'));
      expect(s.loadNotices([])).toEqual([]);
      expect(s.loadNotices(['s_nobody'])).toEqual([]);
      expect(s.loadNotices(['S_A'])).toEqual([]);
    });

    it('a duplicate id throws and the first row stays', () => {
      const s = make();
      s.insertNotice(notice('n1'));
      expect(() => s.insertNotice(notice('n1', { kind: 'ban' }))).toThrow();
      expect(s.loadNotices(['s_a'])).toEqual([notice('n1')]);
    });

    it('the stored and the loaded notices are copies', () => {
      const s = make();
      const n = notice('n1');
      s.insertNotice(n);
      n.excerpt[0]!.text = 'tampered';
      s.loadNotices(['s_a'])[0]!.excerpt[0]!.day = 'tampered';
      expect(s.loadNotices(['s_a'])[0]?.excerpt).toEqual([{ text: 'a masked line', day: '2027-01-15' }]);
    });

    describe('ackNotice', () => {
      it('marks a notice seen once; a repeat, an unknown id and a withdrawn notice are false', () => {
        const s = make();
        s.insertNotice(notice('n1'));
        s.insertNotice(notice('n2', { groupId: 'g2' }));
        expect(s.ackNotice('n1', T + 5)).toBe(true);
        expect(s.ackNotice('n1', T + 9)).toBe(false);
        expect(s.ackNotice('nope', T)).toBe(false);
        s.withdrawNoticeGroup('g2', T + 1);
        expect(s.ackNotice('n2', T + 2)).toBe(false);
        expect(s.loadNotices(['s_a']).map((n) => n.ackedAt)).toEqual([T + 5, null]);
      });

      it('is undone with its transaction', () => {
        const s = make();
        s.insertNotice(notice('n1'));
        expect(() =>
          s.transaction(() => {
            expect(s.ackNotice('n1', T + 5)).toBe(true);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadNotices(['s_a'])[0]?.ackedAt).toBeNull();
      });
    });

    describe('withdrawNoticeGroup / findNoticeForGroup', () => {
      it('withdraws every not-yet-withdrawn notice of the group and counts them', () => {
        const s = make();
        s.insertNotice(notice('n1', { groupId: 'g1' }));
        s.insertNotice(notice('n2', { groupId: 'g1', subject: 's_b' }));
        s.insertNotice(notice('n3', { groupId: 'g2' }));
        expect(s.withdrawNoticeGroup('g1', T + 5)).toBe(2);
        expect(s.withdrawNoticeGroup('g1', T + 9)).toBe(0);
        expect(s.withdrawNoticeGroup('nope', T)).toBe(0);
        expect(s.loadNotices(['s_a', 's_b']).map((n) => [n.id, n.withdrawnAt])).toEqual([
          ['n1', T + 5],
          ['n2', T + 5],
          ['n3', null],
        ]);
      });

      it('a withdraw is undone with its transaction', () => {
        const s = make();
        s.insertNotice(notice('n1'));
        expect(() =>
          s.transaction(() => {
            s.withdrawNoticeGroup('g1', T + 5);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadNotices(['s_a'])[0]?.withdrawnAt).toBeNull();
      });

      it('findNoticeForGroup: the newest not-withdrawn notice, seen or not; the later write wins a tie', () => {
        const s = make();
        s.insertNotice(notice('old', { createdAt: T }));
        s.insertNotice(notice('tie1', { createdAt: T + 5 }));
        s.insertNotice(notice('tie2', { createdAt: T + 5, subject: 's_b' }));
        s.insertNotice(notice('newer-withdrawn', { createdAt: T + 99, withdrawnAt: T + 100 }));
        s.ackNotice('tie2', T + 7);
        expect(s.findNoticeForGroup('g1')).toEqual({ id: 'tie2', subject: 's_b', ackedAt: T + 7, withdrawnAt: null });
      });

      it('findNoticeForGroup is null for an unknown group and for a fully withdrawn one', () => {
        const s = make();
        s.insertNotice(notice('n1'));
        expect(s.findNoticeForGroup('nope')).toBeNull();
        s.withdrawNoticeGroup('g1', T);
        expect(s.findNoticeForGroup('g1')).toBeNull();
      });
    });

    describe('purgeNotices', () => {
      it('deletes a withdrawn notice older than the cutoff, and keeps a newer one', () => {
        const s = make();
        s.insertNotice(notice('old', { createdAt: T - DAY, withdrawnAt: T, kind: 'ban' }));
        s.insertNotice(notice('new', { createdAt: T + DAY, withdrawnAt: T + DAY, kind: 'ban' }));
        expect(s.purgeNotices(T)).toBe(1);
        expect(ids(s.loadNotices(['s_a']))).toEqual(['new']);
      });

      it('deletes a seen warning or report_outcome older than the cutoff; an unseen one is kept', () => {
        const s = make();
        s.insertNotice(notice('seen-warning', { createdAt: T - DAY, ackedAt: T - 1 }));
        s.insertNotice(notice('seen-outcome', { createdAt: T - DAY, ackedAt: T - 1, kind: 'report_outcome', groupId: null }));
        s.insertNotice(notice('unseen-warning', { createdAt: T - DAY }));
        s.insertNotice(notice('seen-new', { createdAt: T + 1, ackedAt: T + 2 }));
        expect(s.purgeNotices(T)).toBe(2);
        expect(ids(s.loadNotices(['s_a'])).sort()).toEqual(['seen-new', 'unseen-warning']);
      });

      it('a seen notice for a sanction that is still running is kept', () => {
        const s = make();
        s.insertNotice(notice('ban-perm', { createdAt: T - DAY, kind: 'ban', ackedAt: T - 1, until: null }));
        s.insertNotice(notice('ban-running', { createdAt: T - DAY, kind: 'chat', ackedAt: T - 1, until: T + DAY }));
        expect(s.purgeNotices(T)).toBe(0);
      });

      it('deletes a notice whose end is before the cutoff, strictly', () => {
        const s = make();
        s.insertNotice(notice('ended', { kind: 'chat', until: T - 1 }));
        s.insertNotice(notice('edge', { kind: 'chat', until: T }));
        s.insertNotice(notice('later', { kind: 'chat', until: T + 1 }));
        expect(s.purgeNotices(T)).toBe(1);
        expect(ids(s.loadNotices(['s_a'])).sort()).toEqual(['edge', 'later']);
      });

      it('is undone with its transaction', () => {
        const s = make();
        s.insertNotice(notice('ended', { kind: 'chat', until: T - 1 }));
        expect(() =>
          s.transaction(() => {
            expect(s.purgeNotices(T)).toBe(1);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(ids(s.loadNotices(['s_a']))).toEqual(['ended']);
      });
    });
  });
}
