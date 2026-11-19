import { describe, expect, it } from 'vitest';
import { registrySubjectColumns } from '@chatwarden/core';
import type { AppealRow, HoldRow, NoticeRow, SanctionRow, Store, StoredReport, StrikeRow } from '@chatwarden/core';

// The contract of the identity age-out (0.2.2, Moxgate audit W6): `purgeIdleSubjects(before)`. A person (a subject and every subject merged into it) whose newest
// `last_seen` is before the cutoff, and who has no record in any table the privacy registry lists, loses its subject and identifier rows. One suite, run against every Store.
// `IDLE_SEEDERS` has one seeder for every `table.column` the registry names as holding a subject id, and the suite fails when the two lists differ, so a new
// person-keyed table fails here until a record in it is proven to keep the person.

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const WINDOW = 400 * DAY;
/** The cutoff the age-out is asked for: a person last seen before it is idle. */
const BEFORE = NOW - WINDOW;
const OLD = BEFORE - 10 * DAY;

type Opt = Required<Pick<Store, 'purgeIdleSubjects' | 'insertAppeal' | 'recordOverturn' | 'insertBlockedName' | 'insertSignal' | 'setNoAutomation' | 'paceUpdate'>>;
const opt = (s: Store): Store & Opt => {
  for (const m of ['purgeIdleSubjects', 'insertAppeal', 'recordOverturn', 'insertBlockedName', 'insertSignal', 'setNoAutomation', 'paceUpdate'] as const) {
    if (s[m] === undefined) throw new Error(`this store has no ${m}`);
  }
  return s as Store & Opt;
};

/** A person with an account, a key and an address row, all last seen at `lastSeen`. */
async function person(s: Store, id: string, lastSeen: number, over: { createdAt?: number; mergedInto?: string | null } = {}): Promise<void> {
  await s.saveSubject({ id, createdAt: over.createdAt ?? lastSeen - 5 * DAY, mergedInto: null });
  if (over.mergedInto !== undefined && over.mergedInto !== null) await s.markMerged(id, over.mergedInto);
  for (const [kind, value] of [['account', `acct-${id}`], ['key', `key-${id}`], ['ip', `ip-${id}`]] as const) {
    await s.saveIdentifier({ subjectId: id, kind, value, firstSeen: lastSeen - 5 * DAY, lastSeen });
  }
}

let seq = 0;
const next = (p: string): string => `${p}${(seq += 1)}`;

const sanction = (value: string): SanctionRow => {
  const n = next('san');
  return {
    id: n,
    groupId: `g-${n}`,
    refCode: `M-${n.toUpperCase().padEnd(5, 'X').slice(0, 5)}`,
    kind: 'chat',
    targetType: 'subject',
    value,
    startsAt: OLD - 3 * DAY,
    endsAt: OLD - 2 * DAY,
    reason: 'r',
    rule: '1',
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'mod_a',
    source: 'moderator',
    automated: false,
    pending: false,
    reportId: null,
  };
};

const notice = (subject: string): NoticeRow => ({ id: next('n'), subject, groupId: null, kind: 'report_outcome', rule: '1', until: null, refCode: null, excerpt: [], createdAt: OLD, ackedAt: null, withdrawnAt: null });

const report = (id: string, reporter: string, target: string, people: string[] = []): StoredReport => ({
  id,
  createdAt: OLD,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: reporter,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: target,
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  reportedReason: 'harassment',
  note: null,
  lineId: null,
  excerpt: [],
  people,
  status: 'open',
});

const appeal = (subject: string): AppealRow => ({
  id: next('ap'),
  subject,
  groupId: next('gap'),
  noticeId: next('nap'),
  reportId: null,
  rule: '1',
  kind: 'chat',
  statement: 'a statement',
  status: 'open',
  createdAt: OLD,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  replacementGroupId: null,
});

type Seeder = (s: Store, id: string) => void | Promise<void>;

/** One record that names the person `id`, per `table.column` the registry lists. */
export const IDLE_SEEDERS: Record<string, Seeder> = {
  'kit_sanctions.target_value': (s, id) => void s.insertSanctionGroup([sanction(id)]),
  'kit_notices.subject_id': (s, id) => s.insertNotice(notice(id)),
  'kit_reports.reporter_subject': (s, id) => void s.insertReport(report(next('r'), id, 's_somebody_else')),
  'kit_reports.target_subject': (s, id) => void s.insertReport(report(next('r'), 's_somebody_else', id)),
  'kit_reports.people_json': (s, id) => void s.insertReport(report(next('r'), 's_somebody_else', 's_somebody_else2', ['s_somebody_else', id])),
  'kit_decisions.result_json': (s, id) => {
    const r = next('r');
    s.insertReport(report(r, 's_somebody_else', 's_somebody_else2'));
    s.insertDecision(next('d'), r, OLD, JSON.stringify({ groups: [{ subject: id, groupId: next('gd'), refCode: 'M-DECID', kind: 'warning', noticeId: next('nd') }] }));
  },
  'kit_strikes.subject_id': (s, id) => s.insertStrike({ id: next('st'), at: OLD, subject: id, roomId: 'ROOM-s', termId: 't1', rawLine: 'zorbak' } satisfies StrikeRow),
  'kit_mutes.viewer_id': (s, id) => s.upsertMute({ viewer: id, target: 's_somebody_else', createdAt: OLD, block: false }),
  'kit_mutes.target_id': (s, id) => s.upsertMute({ viewer: 's_somebody_else', target: id, createdAt: OLD, block: true }),
  'kit_blocked_names.subject_id': (s, id) => opt(s).insertBlockedName({ id: next('bn'), subject: id, name: 'vlemmo', termId: null, reason: 'name_profane', at: OLD }),
  'kit_appeals.subject_id': (s, id) => void opt(s).insertAppeal(appeal(id)),
  'kit_overturns.subject_id': (s, id) =>
    void opt(s).recordOverturn({ groupId: next('go'), at: OLD, subject: id, aliases: [id], source: 'moderator', termId: null, filterKey: 'link.unlisted', reportId: null, strikes: null }),
  'kit_signals.subject_id': (s, id) =>
    void opt(s).insertSignal({ id: next('sg'), kind: 'muted_by_player', subject: id, sourceKey: 'd:20000', bySubject: null, roomId: null, at: OLD, weight: 1, capBucket: 1 }),
  'kit_signals.by_subject': (s, id) =>
    void opt(s).insertSignal({ id: next('sg'), kind: 'muted_by_player', subject: 's_somebody_else', sourceKey: `b:${id}`, bySubject: id, roomId: null, at: OLD, weight: 1, capBucket: 1 }),
  'kit_ai_noauto.subject_id': (s, id) => opt(s).setNoAutomation(id, { code: 'streamer', setBy: 'senior_a', setAt: OLD }),
  'kit_claims.person': (s, id) => void s.claimCase(id, 'mod_a', OLD, OLD + 600_000, 'claim'),
  'kit_discord_threads.subject': (s, id) => s.putDiscordThread({ subject: id, threadId: next('th'), label: 'Case AAAAA', createdAt: OLD }),
  'kit_audit.subject_ref': (s, id) => s.insertAudit({ id: next('au'), at: OLD, actor: 'alice', role: 'moderator', action: 'report.view', target: { type: 'person', ref: id } }),
  'kit_pace.who': (s, id) =>
    void opt(s).paceUpdate('room-1', id, () => ({ roomId: 'room-1', who: id, lastAt: OLD, stamps: [OLD], recent: [{ h: '0123456789abcdef', at: OLD }], floodSignalAt: null, touchedAt: OLD })),
};

const hold = (reportId: string): HoldRow => ({ reportId, code: 'legal_proceeding', heldBy: 'senior_a', heldAt: OLD, releasedBy: null, releasedAt: null });

export function idleContract(name: string, make: () => Store): void {
  describe(`identity age-out contract: ${name}`, () => {
    const ids = async (s: Store) => {
      const { subjects, ids: rows } = await s.loadSubjects();
      return { subjects: subjects.map((x) => x.id).sort(), rows: rows.map((r) => r.subjectId).sort() };
    };

    it('has the method', () => {
      expect(typeof make().purgeIdleSubjects).toBe('function');
    });

    it('the seeders cover exactly the columns the registry names (a new person-keyed table fails here until a record in it is shown to keep the person)', () => {
      const { plain, json } = registrySubjectColumns();
      expect(Object.keys(IDLE_SEEDERS).sort()).toEqual([...plain, ...json].sort());
    });

    describe('a person with no record', () => {
      it('last seen before the cutoff loses the subject and every identifier row; the count is subject rows', async () => {
        const s = opt(make());
        await person(s, 's_idle', BEFORE - 1);
        await person(s, 's_recent', NOW - DAY);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
        expect(await ids(s)).toEqual({ subjects: ['s_recent'], rows: ['s_recent', 's_recent', 's_recent'] });
      });

      it('the cutoff is strict: last seen exactly at it is kept, one millisecond before it goes', async () => {
        const s = opt(make());
        await person(s, 's_edge', BEFORE);
        await person(s, 's_before', BEFORE - 1);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
        expect((await ids(s)).subjects).toEqual(['s_edge']);
        expect(s.purgeIdleSubjects(BEFORE + 1)).toBe(1);
        expect((await ids(s)).subjects).toEqual([]);
      });

      it('last seen is the newest identifier of the person: one recent key keeps old accounts and addresses', async () => {
        const s = opt(make());
        await person(s, 's_mixed', BEFORE - 50 * DAY);
        await s.saveIdentifier({ subjectId: 's_mixed', kind: 'key', value: 'key-new', firstSeen: NOW - 2 * DAY, lastSeen: NOW - DAY });
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
        expect((await ids(s)).subjects).toEqual(['s_mixed']);
      });

      it('a saved identifier moves last_seen forward only, so a touch keeps a person the next age-out would have taken', async () => {
        const s = opt(make());
        await person(s, 's_touch', BEFORE - 10 * DAY);
        for (const [kind, value] of [['account', 'acct-s_touch'], ['key', 'key-s_touch'], ['ip', 'ip-s_touch']] as const) {
          await s.saveIdentifier({ subjectId: 's_touch', kind, value, firstSeen: BEFORE - 15 * DAY, lastSeen: BEFORE + DAY });
        }
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
        // an older write does not move it back
        await s.saveIdentifier({ subjectId: 's_touch', kind: 'key', value: 'key-s_touch', firstSeen: BEFORE - 15 * DAY, lastSeen: BEFORE - 30 * DAY });
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
      });

      it('a subject with no identifier row counts from its creation time', async () => {
        const s = opt(make());
        await s.saveSubject({ id: 's_bare_old', createdAt: BEFORE - DAY, mergedInto: null });
        await s.saveSubject({ id: 's_bare_new', createdAt: BEFORE + DAY, mergedInto: null });
        expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
        expect((await ids(s)).subjects).toEqual(['s_bare_new']);
      });

      it('moves the erasure epoch when it deleted something, and leaves it alone when it did not', async () => {
        const s = opt(make());
        await person(s, 's_idle', BEFORE - 1);
        const e0 = s.erasureEpoch();
        expect(s.purgeIdleSubjects(BEFORE - 100 * DAY)).toBe(0);
        expect(s.erasureEpoch()).toBe(e0);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
        expect(s.erasureEpoch()).toBe(e0 + 1);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
        expect(s.erasureEpoch()).toBe(e0 + 1);
      });

      it('an empty store and a repeated call do nothing', async () => {
        const s = opt(make());
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
        await person(s, 's_idle', BEFORE - 1);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
      });

      it('runs inside a transaction that fails: nothing is deleted', async () => {
        const s = opt(make());
        await person(s, 's_idle', BEFORE - 1);
        expect(() =>
          s.transaction(() => {
            expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
            throw new Error('boom');
          }),
        ).toThrow('boom');
        expect((await ids(s)).subjects).toEqual(['s_idle']);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
      });
    });

    describe('one record of any kind keeps the person (one test per column the registry lists)', () => {
      for (const [column, seed] of Object.entries(IDLE_SEEDERS)) {
        it(`${column}`, async () => {
          const s = opt(make());
          await person(s, 's_idle', BEFORE - 1);
          await person(s, 's_free', BEFORE - 1);
          await seed(s, 's_idle');
          // the control: the same person-with-nothing next to it goes
          expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
          const left = await ids(s);
          expect(left.subjects).toEqual(['s_idle']);
          expect(left.rows).toEqual(['s_idle', 's_idle', 's_idle']);
          // a second call finds nothing more to take: the record still names the person
          expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
        });
      }

      it('a report held for legal reasons keeps the person it names', async () => {
        const s = opt(make());
        await person(s, 's_idle', BEFORE - 1);
        s.insertReport(report('rHeld', 's_somebody_else', 's_idle'));
        expect(s.placeHold(hold('rHeld'))).toBe(true);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
      });

      it('an in-force ban keeps the person', async () => {
        const s = opt(make());
        await person(s, 's_idle', BEFORE - 1);
        s.insertSanctionGroup([{ ...sanction('s_idle'), kind: 'ban', startsAt: BEFORE - 5 * DAY, endsAt: null }]);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
      });

      it('a record of another person does not keep this one, and nobody else loses a row', async () => {
        const s = opt(make());
        await person(s, 's_idle', BEFORE - 1);
        await person(s, 's_other', BEFORE - 1);
        s.insertStrike({ id: 'st-other', at: OLD, subject: 's_other', roomId: 'R', termId: 't', rawLine: 'zorbak' });
        expect(s.purgeIdleSubjects(BEFORE)).toBe(1);
        expect((await ids(s)).subjects).toEqual(['s_other']);
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
      });
    });

    describe('a person is the subject and everything merged into it', () => {
      it('an old alias and an old root go together when nothing names either', async () => {
        const s = opt(make());
        await person(s, 's_root', BEFORE - 20 * DAY);
        await person(s, 's_alias', BEFORE - 30 * DAY, { mergedInto: 's_root' });
        expect(s.purgeIdleSubjects(BEFORE)).toBe(2);
        expect(await ids(s)).toEqual({ subjects: [], rows: [] });
      });

      it('a recent alias keeps the old root (the person was seen lately), and a recent root keeps the old alias', async () => {
        const s = opt(make());
        await person(s, 's_root', BEFORE - 20 * DAY);
        await person(s, 's_alias', NOW - DAY, { mergedInto: 's_root' });
        await person(s, 's_root2', NOW - DAY);
        await person(s, 's_alias2', BEFORE - 30 * DAY, { mergedInto: 's_root2' });
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
        expect((await ids(s)).subjects).toEqual(['s_alias', 's_alias2', 's_root', 's_root2']);
      });

      it('a record on the alias keeps the root and the alias; a record on the root keeps both too', async () => {
        const s = opt(make());
        await person(s, 's_root', BEFORE - 20 * DAY);
        await person(s, 's_alias', BEFORE - 30 * DAY, { mergedInto: 's_root' });
        await person(s, 's_root2', BEFORE - 20 * DAY);
        await person(s, 's_alias2', BEFORE - 30 * DAY, { mergedInto: 's_root2' });
        s.insertStrike({ id: 'st-a', at: OLD, subject: 's_alias', roomId: 'R', termId: 't', rawLine: 'zorbak' });
        s.insertStrike({ id: 'st-r', at: OLD, subject: 's_root2', roomId: 'R', termId: 't', rawLine: 'zorbak' });
        expect(s.purgeIdleSubjects(BEFORE)).toBe(0);
        expect((await ids(s)).subjects).toEqual(['s_alias', 's_alias2', 's_root', 's_root2']);
      });

      it('a chain of merges (a into b into c) goes whole, and stops whole when the newest link is recent', async () => {
        const s = opt(make());
        await person(s, 's_c', BEFORE - 10 * DAY);
        await person(s, 's_b', BEFORE - 20 * DAY, { mergedInto: 's_c' });
        await person(s, 's_a', BEFORE - 30 * DAY, { mergedInto: 's_b' });
        await person(s, 's_z_c', BEFORE - 10 * DAY);
        await person(s, 's_z_b', BEFORE - 20 * DAY, { mergedInto: 's_z_c' });
        await person(s, 's_z_a', NOW - DAY, { mergedInto: 's_z_b' });
        expect(s.purgeIdleSubjects(BEFORE)).toBe(3);
        expect((await ids(s)).subjects).toEqual(['s_z_a', 's_z_b', 's_z_c']);
      });
    });
  });
}
