import { describe, expect, it } from 'vitest';
import type { SanctionRow, Store, StoredReport } from '@chatwarden/core';

// The contract of the methods behind the team workbench (K4): the change token, soft claims on a person, the open-case
// listings take-next reads, and saved reasons. One suite, run against every Store.

const MIN = 60_000;
const TTL = 10 * MIN;
const NOW = 1_800_000_000_000;

let seq = 0;
const report = (over: Partial<StoredReport> = {}): StoredReport => {
  seq += 1;
  return {
    id: `trep${String(seq).padStart(4, '0')}`,
    createdAt: NOW + seq,
    roomId: `TROOM${seq}`,
    tags: {},
    reporterSubject: `s_rep${seq}`,
    reporterSeat: 'p1',
    reporterHandle: 'Rep',
    targetSubject: 's_tgt',
    targetSeat: 'p2',
    targetHandle: 'Tgt',
    category: 'harassment',
    note: null,
    lineId: null,
    excerpt: [],
    people: [],
    status: 'open',
    ...over,
  };
};

const sanction = (groupId: string, code: string, over: Partial<SanctionRow> = {}): SanctionRow => {
  seq += 1;
  return {
    id: `tsan${String(seq).padStart(4, '0')}`,
    groupId,
    refCode: code,
    kind: 'chat',
    targetType: 'subject',
    value: 's_a',
    startsAt: NOW,
    endsAt: NOW + MIN,
    reason: 'r',
    rule: '1',
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod',
    source: 'moderator',
    automated: false,
    pending: false,
    ...over,
  };
};

export function teamContract(name: string, make: () => Store): void {
  /** Claim as `by` at `now` with the standard 10 minute lifetime. */
  const claim = (s: Store, person: string, by: string, now: number, mode: 'claim' | 'free' | 'takeover' = 'claim') =>
    s.claimCase(person, by, now, now + TTL, mode);

  describe(`team contract: ${name}`, () => {
    describe('claimCase', () => {
      it('the first claim wins and states who, since when and until when', () => {
        const s = make();
        expect(claim(s, 's_p1', 'ann', NOW)).toEqual({
          won: true,
          from: null,
          claim: { person: 's_p1', by: 'ann', since: NOW, until: NOW + TTL },
        });
        expect(s.loadClaims(['s_p1'], NOW)).toEqual([{ person: 's_p1', by: 'ann', since: NOW, until: NOW + TTL }]);
      });

      it('a second moderator loses while the claim is live, and sees who holds it', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        const res = claim(s, 's_p1', 'bea', NOW + MIN);
        expect(res).toEqual({ won: false, claim: { person: 's_p1', by: 'ann', since: NOW, until: NOW + TTL } });
        // And the stored claim is untouched.
        expect(s.loadClaims(['s_p1'], NOW + MIN)).toEqual([{ person: 's_p1', by: 'ann', since: NOW, until: NOW + TTL }]);
      });

      it('the holder claiming again is a heartbeat: until moves, since stays, from is null', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        const res = claim(s, 's_p1', 'ann', NOW + 4 * MIN);
        expect(res).toEqual({
          won: true,
          from: null,
          claim: { person: 's_p1', by: 'ann', since: NOW, until: NOW + 4 * MIN + TTL },
        });
      });

      it('is live strictly before until: the instant of until is free for anyone', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(claim(s, 's_p1', 'bea', NOW + TTL - 1).won).toBe(false);
        const res = claim(s, 's_p1', 'bea', NOW + TTL);
        expect(res).toEqual({ won: true, from: null, claim: { person: 's_p1', by: 'bea', since: NOW + TTL, until: NOW + TTL + TTL } });
      });

      it('an expired claim reads as absent in loadClaims', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(s.loadClaims(['s_p1'], NOW + TTL - 1)).toHaveLength(1);
        expect(s.loadClaims(['s_p1'], NOW + TTL)).toEqual([]);
      });

      it('the old holder returning after expiry starts a new claim (since resets)', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        const res = claim(s, 's_p1', 'ann', NOW + TTL + 5);
        expect(res).toEqual({ won: true, from: null, claim: { person: 's_p1', by: 'ann', since: NOW + TTL + 5, until: NOW + TTL + 5 + TTL } });
      });

      it('take over moves a live claim to the caller and names who it came from', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        const res = claim(s, 's_p1', 'sam', NOW + 2 * MIN, 'takeover');
        expect(res).toEqual({ won: true, from: 'ann', claim: { person: 's_p1', by: 'sam', since: NOW + 2 * MIN, until: NOW + 2 * MIN + TTL } });
        // Ann is now the one locked out.
        expect(claim(s, 's_p1', 'ann', NOW + 3 * MIN).won).toBe(false);
      });

      it('take over of an unclaimed or an expired case is just a claim (from null)', () => {
        const s = make();
        expect(claim(s, 's_p1', 'sam', NOW, 'takeover')).toMatchObject({ won: true, from: null });
        claim(s, 's_p2', 'ann', NOW);
        expect(claim(s, 's_p2', 'sam', NOW + TTL + 1, 'takeover')).toMatchObject({ won: true, from: null });
      });

      it('take over by the holder is a heartbeat (from null, since kept)', () => {
        const s = make();
        claim(s, 's_p1', 'sam', NOW);
        expect(claim(s, 's_p1', 'sam', NOW + MIN, 'takeover')).toEqual({
          won: true,
          from: null,
          claim: { person: 's_p1', by: 'sam', since: NOW, until: NOW + MIN + TTL },
        });
      });

      it("'free' wins only a case nobody holds: not another's, not its own live one, but an expired one", () => {
        const s = make();
        expect(claim(s, 's_p1', 'ann', NOW, 'free').won).toBe(true);
        expect(claim(s, 's_p1', 'bea', NOW + MIN, 'free').won).toBe(false);
        const own = claim(s, 's_p1', 'ann', NOW + MIN, 'free');
        expect(own).toEqual({ won: false, claim: { person: 's_p1', by: 'ann', since: NOW, until: NOW + TTL } });
        expect(claim(s, 's_p1', 'bea', NOW + TTL, 'free')).toMatchObject({ won: true, from: null });
      });

      it('claims on different people are independent', () => {
        const s = make();
        expect(claim(s, 's_p1', 'ann', NOW).won).toBe(true);
        expect(claim(s, 's_p2', 'bea', NOW).won).toBe(true);
        expect(s.loadClaims(['s_p1', 's_p2'], NOW).map((c) => [c.person, c.by])).toEqual([['s_p1', 'ann'], ['s_p2', 'bea']]);
      });

      it('two moderators claiming back to back: exactly one wins, in either order', async () => {
        for (const order of [['ann', 'bea'], ['bea', 'ann']]) {
          const s = make();
          const tries = await Promise.all(order.map(async (who) => Promise.resolve().then(() => claim(s, 's_race', who, NOW))));
          expect(tries.filter((t) => t.won)).toHaveLength(1);
          const winner = tries.find((t) => t.won)?.claim.by;
          expect(winner).toBe(order[0]);
          expect(s.loadClaims(['s_race'], NOW)[0]?.by).toBe(winner);
        }
      });

      it('five claimants back to back: one claim winner, take over is the only way to move it', async () => {
        const s = make();
        const tries = await Promise.all(
          ['a', 'b', 'c', 'd', 'e'].map(async (who) => Promise.resolve().then(() => claim(s, 's_race', who, NOW))),
        );
        expect(tries.filter((t) => t.won)).toHaveLength(1);
        const taken = claim(s, 's_race', 'boss', NOW + 1, 'takeover');
        expect(taken.won).toBe(true);
        expect(s.loadClaims(['s_race'], NOW + 1)[0]?.by).toBe('boss');
      });

      it('returned rows are copies', () => {
        const s = make();
        const res = claim(s, 's_p1', 'ann', NOW);
        res.claim.by = 'mallory';
        const loaded = s.loadClaims(['s_p1'], NOW);
        loaded[0]!.by = 'mallory';
        expect(s.loadClaims(['s_p1'], NOW)[0]?.by).toBe('ann');
      });

      it('a claim written in a transaction that throws is undone', () => {
        const s = make();
        expect(() =>
          s.transaction(() => {
            claim(s, 's_p1', 'ann', NOW);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadClaims(['s_p1'], NOW)).toEqual([]);
        expect(claim(s, 's_p1', 'bea', NOW).won).toBe(true);
      });

      it('a heartbeat in a transaction that throws is undone', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(() =>
          s.transaction(() => {
            claim(s, 's_p1', 'ann', NOW + MIN);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadClaims(['s_p1'], NOW)[0]?.until).toBe(NOW + TTL);
      });
    });

    describe('releaseClaim', () => {
      it('the holder releases a live claim (true) and the case is free again', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(s.releaseClaim('s_p1', 'ann', NOW + MIN)).toBe(true);
        expect(s.loadClaims(['s_p1'], NOW + MIN)).toEqual([]);
        expect(claim(s, 's_p1', 'bea', NOW + MIN).won).toBe(true);
      });

      it("someone else cannot release it, and an absent claim releases nothing (false)", () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(s.releaseClaim('s_p1', 'bea', NOW + MIN)).toBe(false);
        expect(s.loadClaims(['s_p1'], NOW + MIN)[0]?.by).toBe('ann');
        expect(s.releaseClaim('s_nobody', 'ann', NOW)).toBe(false);
      });

      it('releasing your own expired claim answers false (it was already absent)', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(s.releaseClaim('s_p1', 'ann', NOW + TTL)).toBe(false);
        expect(s.loadClaims(['s_p1'], NOW + TTL)).toEqual([]);
      });

      it('releasing twice: true then false', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(s.releaseClaim('s_p1', 'ann', NOW)).toBe(true);
        expect(s.releaseClaim('s_p1', 'ann', NOW)).toBe(false);
      });

      it('a release in a transaction that throws is undone', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(() =>
          s.transaction(() => {
            s.releaseClaim('s_p1', 'ann', NOW);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.loadClaims(['s_p1'], NOW)).toHaveLength(1);
      });
    });

    describe('loadClaims', () => {
      it('is empty for no people and for people nobody holds, and ignores people not asked for', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        claim(s, 's_p2', 'bea', NOW);
        expect(s.loadClaims([], NOW)).toEqual([]);
        expect(s.loadClaims(['s_zzz'], NOW)).toEqual([]);
        expect(s.loadClaims(['s_p2'], NOW).map((c) => c.person)).toEqual(['s_p2']);
      });

      it('lists only the live ones among those asked for, ordered by person', () => {
        const s = make();
        claim(s, 's_b', 'ann', NOW);
        claim(s, 's_a', 'bea', NOW - TTL);
        claim(s, 's_c', 'cy', NOW);
        expect(s.loadClaims(['s_c', 's_a', 's_b'], NOW).map((c) => c.person)).toEqual(['s_b', 's_c']);
      });

      it('takes a long list (more than a statement parameter batch)', () => {
        const s = make();
        claim(s, 's_p0777', 'ann', NOW);
        const many = Array.from({ length: 1500 }, (_, i) => `s_p${String(i).padStart(4, '0')}`);
        expect(s.loadClaims(many, NOW).map((c) => c.person)).toEqual(['s_p0777']);
      });
    });

    describe('changeToken', () => {
      /** The token after each step; every step that must move it is checked to differ from the one before. */
      const moves = (s: Store, step: () => unknown): boolean => {
        const before = s.changeToken();
        step();
        return s.changeToken() !== before;
      };

      it('is a non-empty string, the same on every read of an untouched store', () => {
        const s = make();
        const t = s.changeToken();
        expect(typeof t).toBe('string');
        expect(t).not.toBe('');
        expect(s.changeToken()).toBe(t);
        expect(make().changeToken()).toBe(t);
      });

      it('moves when a report is filed, and not when the filing is refused as a duplicate', () => {
        const s = make();
        const r = report();
        expect(moves(s, () => expect(s.insertReport(r)).toBe(true))).toBe(true);
        expect(moves(s, () => expect(s.insertReport({ ...r, id: 'other-id' })).toBe(false))).toBe(false);
      });

      it('moves when a report is decided, and not on a second close', () => {
        const s = make();
        const r = report();
        s.insertReport(r);
        expect(moves(s, () => expect(s.closeReport(r.id, 'actioned', false, 'mod', NOW, 'n')).toBe(true))).toBe(true);
        expect(moves(s, () => expect(s.closeReport(r.id, 'dismissed', false, 'mod', NOW, 'n')).toBe(false))).toBe(false);
        expect(moves(s, () => expect(s.closeReport('nope', 'dismissed', false, 'mod', NOW, 'n')).toBe(false))).toBe(false);
      });

      it('moves when a sanction is applied (a refused ref code does not) and when one is revoked (revoking again does not)', () => {
        const s = make();
        expect(moves(s, () => expect(s.insertSanctionGroup([sanction('g1', 'M-AAAAA')])).toBe(true))).toBe(true);
        expect(moves(s, () => expect(s.insertSanctionGroup([sanction('g2', 'M-AAAAA')])).toBe(false))).toBe(false);
        expect(moves(s, () => s.revokeSanctionGroup('g1', 'mod', NOW, 'lifted'))).toBe(true);
        expect(moves(s, () => expect(s.revokeSanctionGroup('g1', 'mod', NOW, 'again')).toBe(0))).toBe(false);
        expect(moves(s, () => expect(s.revokeSanctionGroup('g-none', 'mod', NOW, 'none')).toBe(0))).toBe(false);
      });

      it('moves when a rule gap is closed, and not when it cannot be', () => {
        const s = make();
        s.insertSanctionGroup([sanction('g1', 'M-GAPPP', { rule: 'uncovered', gapNote: 'a gap', gapStatus: 'open' })]);
        expect(moves(s, () => expect(s.closeGap('g1', 'not_a_rule', null, 'owner', NOW)).toBe(true))).toBe(true);
        expect(moves(s, () => expect(s.closeGap('g1', 'not_a_rule', null, 'owner', NOW)).toBe(false))).toBe(false);
        expect(moves(s, () => expect(s.closeGap('g-none', 'ruled', '3', 'owner', NOW)).toBe(false))).toBe(false);
      });

      it('moves when a claim is taken, taken over or released, and not on a heartbeat or a lost attempt', () => {
        const s = make();
        expect(moves(s, () => claim(s, 's_p1', 'ann', NOW))).toBe(true);
        expect(moves(s, () => claim(s, 's_p1', 'ann', NOW + MIN))).toBe(false); // heartbeat
        expect(moves(s, () => claim(s, 's_p1', 'ann', NOW + 2 * MIN, 'takeover'))).toBe(false); // heartbeat as takeover
        expect(moves(s, () => claim(s, 's_p1', 'bea', NOW + 3 * MIN))).toBe(false); // lost
        expect(moves(s, () => claim(s, 's_p1', 'bea', NOW + 3 * MIN, 'free'))).toBe(false); // lost
        expect(moves(s, () => claim(s, 's_p1', 'sam', NOW + 4 * MIN, 'takeover'))).toBe(true); // owner changed
        expect(moves(s, () => s.releaseClaim('s_p1', 'ann', NOW + 5 * MIN))).toBe(false); // not the holder
        expect(moves(s, () => s.releaseClaim('s_p1', 'sam', NOW + 5 * MIN))).toBe(true);
        expect(moves(s, () => s.releaseClaim('s_p1', 'sam', NOW + 5 * MIN))).toBe(false); // already free
      });

      it('moves when a claim is taken over an expired one (a new owner), and when the old holder starts afresh', () => {
        const s = make();
        claim(s, 's_p1', 'ann', NOW);
        expect(moves(s, () => claim(s, 's_p1', 'bea', NOW + TTL))).toBe(true);
        expect(moves(s, () => claim(s, 's_p1', 'bea', NOW + 3 * TTL))).toBe(true); // bea's own claim lapsed: a fresh one
      });

      it('moves when a saved reason is added, edited or switched, and not when nothing changes', () => {
        const s = make();
        expect(moves(s, () => s.insertReason({ id: 'r1', label: 'Spam', text: 'Spamming the lobby.', active: true }))).toBe(true);
        expect(moves(s, () => expect(s.updateReason('r1', { label: 'Spam!' })).toBe(true))).toBe(true);
        expect(moves(s, () => expect(s.updateReason('r1', { label: 'Spam!' })).toBe(true))).toBe(false); // same value
        expect(moves(s, () => expect(s.updateReason('nope', { label: 'x' })).toBe(false))).toBe(false);
        expect(moves(s, () => expect(s.setReasonActive('r1', false)).toBe(true))).toBe(true);
        expect(moves(s, () => expect(s.setReasonActive('r1', false)).toBe(true))).toBe(false); // already off
        expect(moves(s, () => expect(s.setReasonActive('nope', true)).toBe(false))).toBe(false);
      });

      it('does not move on reads, the audit trail, or a strike', () => {
        const s = make();
        const t = s.changeToken();
        s.loadClaims(['s_p1'], NOW);
        s.listReasons();
        s.listOpenReports({ limit: 5 });
        s.listOpenReportsByPerson(['s_tgt'], 5);
        s.listReports({ limit: 5 });
        s.insertAudit({ id: 'a1', at: NOW, actor: 'ann', role: 'moderator', action: 'report.view', target: null });
        s.insertStrike({ id: 'st1', at: NOW, subject: 's_x', roomId: 'R', termId: 't', rawLine: 'l' });
        expect(s.changeToken()).toBe(t);
      });

      it('never repeats: every event gives a token not seen before', () => {
        const s = make();
        const seen = new Set<string>([s.changeToken()]);
        for (let i = 0; i < 12; i++) {
          claim(s, `s_p${i}`, 'ann', NOW);
          const t = s.changeToken();
          expect(seen.has(t)).toBe(false);
          seen.add(t);
        }
      });

      it('an event undone with its transaction leaves the token as it was', () => {
        const s = make();
        const t = s.changeToken();
        expect(() =>
          s.transaction(() => {
            s.insertReport(report());
            claim(s, 's_p1', 'ann', NOW);
            expect(s.changeToken()).not.toBe(t);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.changeToken()).toBe(t);
      });

      it('a decision (report closed, sanction written, claim released) lands as one transaction with one token move at the end', () => {
        const s = make();
        const r = report({ targetSubject: 's_p9' });
        s.insertReport(r);
        claim(s, 's_p9', 'ann', NOW);
        const before = s.changeToken();
        s.transaction(() => {
          s.closeReport(r.id, 'actioned', false, 'ann', NOW, 'ok');
          s.insertSanctionGroup([sanction('gd', 'M-DECID', { value: 's_p9' })]);
          s.releaseClaim('s_p9', 'ann', NOW);
        });
        expect(s.changeToken()).not.toBe(before);
      });
    });

    describe('listOpenReports (take next)', () => {
      it('lists only open reports, oldest first, ties by id', () => {
        const s = make();
        const a = report({ createdAt: NOW + 30 });
        const b = report({ createdAt: NOW + 10 });
        const c = report({ createdAt: NOW + 10 });
        const closed = report({ createdAt: NOW + 5 });
        for (const r of [a, b, c, closed]) s.insertReport(r);
        s.closeReport(closed.id, 'actioned', false, 'mod', NOW + 50, 'n');
        const ids = s.listOpenReports({ limit: 10 }).map((r) => r.id);
        // b and c were filed at the same instant: the lower id comes first (ids are issued in ascending order here).
        expect(b.id < c.id).toBe(true);
        expect(ids).toEqual([b.id, c.id, a.id]);
      });

      it('filters by category', () => {
        const s = make();
        const h = report({ category: 'harassment', createdAt: NOW + 2 });
        const sp = report({ category: 'spam', createdAt: NOW + 1 });
        s.insertReport(h);
        s.insertReport(sp);
        expect(s.listOpenReports({ category: 'spam', limit: 10 }).map((r) => r.id)).toEqual([sp.id]);
        expect(s.listOpenReports({ category: 'cheating', limit: 10 })).toEqual([]);
      });

      it('pages by keyset (after, afterId) with no repeat and no gap, ties included', () => {
        const s = make();
        const rows = [10, 10, 10, 20, 30].map((d) => report({ createdAt: NOW + d }));
        for (const r of rows) s.insertReport(r);
        const all = s.listOpenReports({ limit: 10 });
        expect(all).toHaveLength(5);
        const seen: string[] = [];
        let page = s.listOpenReports({ limit: 2 });
        while (page.length > 0) {
          seen.push(...page.map((r) => r.id));
          const last = page[page.length - 1]!;
          page = s.listOpenReports({ limit: 2, after: last.createdAt, afterId: last.id });
        }
        expect(seen).toEqual(all.map((r) => r.id));
      });

      it('after without afterId keeps reports strictly newer than that instant', () => {
        const s = make();
        const a = report({ createdAt: NOW + 1 });
        const b = report({ createdAt: NOW + 2 });
        s.insertReport(a);
        s.insertReport(b);
        expect(s.listOpenReports({ limit: 10, after: NOW + 1 }).map((r) => r.id)).toEqual([b.id]);
      });

      it('clamps the limit to 1..200 and floors a fraction', () => {
        const s = make();
        for (let i = 0; i < 3; i++) s.insertReport(report());
        expect(s.listOpenReports({ limit: 0 })).toHaveLength(1);
        expect(s.listOpenReports({ limit: -5 })).toHaveLength(1);
        expect(s.listOpenReports({ limit: 2.9 })).toHaveLength(2);
        expect(s.listOpenReports({ limit: 9999 })).toHaveLength(3);
      });

      it('returns whole records that are copies', () => {
        const s = make();
        const r = report({ excerpt: [] });
        s.insertReport(r);
        const [got] = s.listOpenReports({ limit: 1 });
        expect(got).toMatchObject({ id: r.id, status: 'open', badFaith: false, actionedAt: null });
        got!.note = 'changed';
        expect(s.listOpenReports({ limit: 1 })[0]?.note).toBeNull();
      });
    });

    describe('listOpenReportsByPerson', () => {
      it('lists the open reports against any of the given subjects, newest first, and never a closed one', () => {
        const s = make();
        const a = report({ targetSubject: 's_one', createdAt: NOW + 1 });
        const b = report({ targetSubject: 's_two', createdAt: NOW + 3 });
        const c = report({ targetSubject: 's_one', createdAt: NOW + 2 });
        const d = report({ targetSubject: 's_other', createdAt: NOW + 4 });
        const gone = report({ targetSubject: 's_one', createdAt: NOW + 5 });
        for (const r of [a, b, c, d, gone]) s.insertReport(r);
        s.closeReport(gone.id, 'dismissed', false, 'mod', NOW + 9, 'n');
        expect(s.listOpenReportsByPerson(['s_one', 's_two'], 10).map((r) => r.id)).toEqual([b.id, c.id, a.id]);
      });

      it('an empty list matches nobody, the limit is clamped to 1..200', () => {
        const s = make();
        for (let i = 0; i < 3; i++) s.insertReport(report({ targetSubject: 's_one' }));
        expect(s.listOpenReportsByPerson([], 10)).toEqual([]);
        expect(s.listOpenReportsByPerson(['s_one'], 0)).toHaveLength(1);
        expect(s.listOpenReportsByPerson(['s_one'], 500)).toHaveLength(3);
      });
    });

    describe('audit rows of the team actions', () => {
      it('round-trips case.takeover on a person and reason.* on a reason, and filters by the new actions', () => {
        const s = make();
        s.insertAudit({ id: 'a1', at: NOW, actor: 'sam', role: 'senior', action: 'case.takeover', target: { type: 'person', ref: 's_p1' } });
        s.insertAudit({ id: 'a2', at: NOW + 1, actor: 'sam', role: 'senior', action: 'reason.add', target: { type: 'reason', ref: 'r1' } });
        s.insertAudit({ id: 'a3', at: NOW + 2, actor: 'sam', role: 'senior', action: 'reason.update', target: { type: 'reason', ref: 'r1' } });
        s.insertAudit({ id: 'a4', at: NOW + 3, actor: 'sam', role: 'senior', action: 'reason.toggle', target: { type: 'reason', ref: 'r1' } });
        const all = s.listAudit({ limit: 10 });
        expect(all.map((r) => [r.action, r.target])).toEqual([
          ['reason.toggle', { type: 'reason', ref: 'r1' }],
          ['reason.update', { type: 'reason', ref: 'r1' }],
          ['reason.add', { type: 'reason', ref: 'r1' }],
          ['case.takeover', { type: 'person', ref: 's_p1' }],
        ]);
        expect(s.listAudit({ limit: 10, action: 'case.takeover' }).map((r) => r.id)).toEqual(['a1']);
      });
    });

    describe('saved reasons', () => {
      it('starts empty, lists in the order they were added, and returns the stored fields', () => {
        const s = make();
        expect(s.listReasons()).toEqual([]);
        s.insertReason({ id: 'r2', label: 'Second', text: 'two', active: true });
        s.insertReason({ id: 'r1', label: 'First', text: 'one', active: false });
        expect(s.listReasons()).toEqual([
          { id: 'r2', label: 'Second', text: 'two', active: true },
          { id: 'r1', label: 'First', text: 'one', active: false },
        ]);
      });

      it('a duplicate id throws and writes nothing', () => {
        const s = make();
        s.insertReason({ id: 'r1', label: 'A', text: 'a', active: true });
        const t = s.changeToken();
        expect(() => s.insertReason({ id: 'r1', label: 'B', text: 'b', active: true })).toThrow();
        expect(s.listReasons()).toEqual([{ id: 'r1', label: 'A', text: 'a', active: true }]);
        expect(s.changeToken()).toBe(t);
      });

      it('updates the label, the text or both, and leaves the rest as it was', () => {
        const s = make();
        s.insertReason({ id: 'r1', label: 'A', text: 'a', active: true });
        expect(s.updateReason('r1', { label: 'AA' })).toBe(true);
        expect(s.listReasons()[0]).toEqual({ id: 'r1', label: 'AA', text: 'a', active: true });
        expect(s.updateReason('r1', { text: 'aa' })).toBe(true);
        expect(s.listReasons()[0]).toEqual({ id: 'r1', label: 'AA', text: 'aa', active: true });
        expect(s.updateReason('r1', { label: 'B', text: 'b' })).toBe(true);
        expect(s.listReasons()[0]).toEqual({ id: 'r1', label: 'B', text: 'b', active: true });
        expect(s.updateReason('r1', {})).toBe(true);
        expect(s.listReasons()[0]).toEqual({ id: 'r1', label: 'B', text: 'b', active: true });
      });

      it('an unknown id updates nothing (false)', () => {
        const s = make();
        expect(s.updateReason('nope', { label: 'x' })).toBe(false);
        expect(s.setReasonActive('nope', false)).toBe(false);
        expect(s.listReasons()).toEqual([]);
      });

      it('switches active off and on', () => {
        const s = make();
        s.insertReason({ id: 'r1', label: 'A', text: 'a', active: true });
        expect(s.setReasonActive('r1', false)).toBe(true);
        expect(s.listReasons()[0]?.active).toBe(false);
        expect(s.setReasonActive('r1', true)).toBe(true);
        expect(s.listReasons()[0]?.active).toBe(true);
      });

      it('keeps text with quotes, newlines and non-latin characters exactly', () => {
        const s = make();
        const text = 'Line one\n"quoted" \'single\' é中😀 ; DROP TABLE kit_reasons;--';
        s.insertReason({ id: 'r1', label: 'é中', text, active: true });
        expect(s.listReasons()[0]).toEqual({ id: 'r1', label: 'é中', text, active: true });
      });

      it('returned rows are copies', () => {
        const s = make();
        s.insertReason({ id: 'r1', label: 'A', text: 'a', active: true });
        s.listReasons()[0]!.label = 'changed';
        expect(s.listReasons()[0]?.label).toBe('A');
      });

      it('writes in a transaction that throws are undone', () => {
        const s = make();
        s.insertReason({ id: 'r1', label: 'A', text: 'a', active: true });
        expect(() =>
          s.transaction(() => {
            s.insertReason({ id: 'r2', label: 'B', text: 'b', active: true });
            s.updateReason('r1', { label: 'changed' });
            s.setReasonActive('r1', false);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect(s.listReasons()).toEqual([{ id: 'r1', label: 'A', text: 'a', active: true }]);
      });
    });
  });
}
