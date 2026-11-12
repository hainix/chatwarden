import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { MESSAGE_NOTICE_KINDS, NoticeService } from '../src/notices.js';
import type { PlayerNotice } from '../src/notices.js';
import { CommunityRules, STARTER_RULES } from '../src/rules.js';
import { SubjectIndex } from '../src/subjects.js';
import type { NoticeKind, NoticeRow, SubjectId } from '../src/types.js';

// The four message kinds (rename_required, appeal_upheld, appeal_reduced, appeal_revoked): created through createMessage, never a
// sanction, never on "My record", never needing an acknowledgement, kept or purged by the report-outcome rule.

const DAY = 86_400_000;
const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const KINDS = ['rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'] as const;
const rules = new CommunityRules(STARTER_RULES);

function setup() {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const warned: string[] = [];
  const pushed: Array<{ subject: SubjectId; count: number }> = [];
  const svc = new NoticeService({
    store,
    subjects,
    rules,
    clock,
    logger: { warn: (event) => void warned.push(event) },
    notify: ((subject: SubjectId, e: { count: number }) => void pushed.push({ subject, count: e.count })) as never,
  });
  const person = (key: string): SubjectId => {
    const s = subjects.resolve({ clientKey: key, accountId: null, ipHash: null });
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  let g = 0;
  const sanction = (subject: SubjectId, over: Partial<Parameters<NoticeService['createForSanction']>[0]> = {}) =>
    svc.createForSanction({ groupId: `grp${++g}`, refCode: `M-AB${g}CD`, kind: 'chat', until: NOW + DAY, rule: 2, subject, ...over });
  return { store, clock, subjects, svc, warned, pushed, person, sanction };
}

const stored = (store: MemoryStore, id: string): NoticeRow => {
  const row = store.rawNotices().find((n) => n.id === id);
  if (row === undefined) throw new Error('no such notice');
  return row;
};

describe('createMessage', () => {
  it('createMessage writes a notice of each of the four kinds with an empty excerpt and no name', () => {
    for (const kind of KINDS) {
      const { svc, store, person } = setup();
      const p = person('k1');
      const id = svc.createMessage(p, kind, { rule: 2, refCode: 'M-ABCDE' });
      expect(typeof id).toBe('string');
      expect(id).not.toBe('');
      expect(stored(store, id)).toMatchObject({ id, subject: p, groupId: null, kind, rule: '2', until: null, refCode: 'M-ABCDE', excerpt: [], ackedAt: null, withdrawnAt: null });
      const shown = svc.pending(p);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ id, kind, rule: 2, ruleLabel: rules.label(2), until: null, refCode: 'M-ABCDE', excerpt: [], mustAcknowledge: false, createdAt: NOW });
    }
  });

  it('the rule and the code are optional: both default to null, an uncovered rule is allowed', () => {
    const { svc, store, person } = setup();
    const p = person('k1');
    const bare = svc.createMessage(p, 'rename_required', {});
    expect(stored(store, bare)).toMatchObject({ rule: null, refCode: null });
    expect(svc.pending(p)[0]).toMatchObject({ rule: null, ruleLabel: null, refCode: null });
    const unc = svc.createMessage(p, 'appeal_upheld', { rule: 'uncovered', refCode: null });
    expect(stored(store, unc).rule).toBe('uncovered');
    const other = svc.createMessage(p, 'appeal_upheld', { rule: null });
    expect(stored(store, other).rule).toBeNull();
  });

  it('the id is random and different each time', () => {
    const { svc, person } = setup();
    const p = person('k1');
    const ids = new Set([1, 2, 3, 4, 5].map(() => svc.createMessage(p, 'appeal_upheld', {})));
    expect(ids.size).toBe(5);
  });

  it('an unknown kind throws and writes nothing', () => {
    const { svc, store, person } = setup();
    const p = person('k1');
    for (const kind of ['warning', 'chat', 'area', 'ban', 'report_outcome', 'bogus', '', 'appeal_moot', undefined, 5]) {
      expect(() => svc.createMessage(p, kind as never, {}), String(kind)).toThrow();
    }
    expect(store.rawNotices()).toEqual([]);
  });

  it('a bad subject, rule or code throws and writes nothing', () => {
    const { svc, store, person } = setup();
    const p = person('k1');
    expect(() => svc.createMessage('' as SubjectId, 'appeal_upheld', {})).toThrow();
    expect(() => svc.createMessage(p, 'appeal_upheld', { rule: 'not a rule' as never })).toThrow();
    expect(() => svc.createMessage(p, 'appeal_upheld', { refCode: 5 as never })).toThrow();
    expect(store.rawNotices()).toEqual([]);
  });

  it('the subject is canonical: a message for a merged alias lists under the person', () => {
    const { svc, subjects, person } = setup();
    const a = person('ka');
    const b = subjects.resolve({ clientKey: 'kb', accountId: 'acct', ipHash: null }) as SubjectId;
    svc.createMessage(a, 'appeal_revoked', {});
    expect(svc.pending(a)).toHaveLength(1);
    expect(svc.pending(b)).toHaveLength(0);
  });

  it('pushes the pending count after the write, and not when notify is false (announce then does)', () => {
    const { svc, pushed, person } = setup();
    const p = person('k1');
    svc.createMessage(p, 'appeal_upheld', {});
    expect(pushed).toEqual([{ subject: p, count: 1 }]);
    svc.createMessage(p, 'appeal_reduced', { notify: false });
    expect(pushed).toHaveLength(1);
    svc.announce(p);
    expect(pushed).toEqual([{ subject: p, count: 1 }, { subject: p, count: 2 }]);
  });

  it('MESSAGE_NOTICE_KINDS lists exactly the four, and createForSanction still refuses them', () => {
    expect([...MESSAGE_NOTICE_KINDS]).toEqual([...KINDS]);
    const { svc, person } = setup();
    const p = person('k1');
    for (const kind of KINDS) {
      expect(() => svc.createForSanction({ groupId: 'g', refCode: 'M-X', kind: kind as never, until: null, rule: 1, subject: p })).toThrow('invalid kind');
    }
  });
});

describe('message notices in the lists', () => {
  it('pending lists a message notice; record never does', () => {
    for (const kind of KINDS) {
      const { svc, person } = setup();
      const p = person('k1');
      svc.createMessage(p, kind, { rule: 1 });
      expect(svc.pending(p).map((n) => n.kind)).toEqual([kind]);
      expect(svc.record(p)).toEqual([]);
    }
  });

  it('record keeps sanction kinds only, with message notices in between', () => {
    const { svc, person, sanction, clock } = setup();
    const p = person('k1');
    sanction(p, { kind: 'warning', until: null });
    clock.t += 1;
    svc.createMessage(p, 'appeal_reduced', { rule: 2 });
    clock.t += 1;
    svc.createReportOutcome(p);
    clock.t += 1;
    sanction(p, { kind: 'ban', until: null });
    expect(svc.record(p).map((n) => n.kind)).toEqual(['warning', 'ban']);
    expect(svc.pending(p).map((n) => n.kind)).toEqual(['warning', 'appeal_reduced', 'report_outcome', 'ban']);
  });

  it('ack works; mustAcknowledge is false for all four, while a warning still must be acknowledged', () => {
    const { svc, person, sanction } = setup();
    const p = person('k1');
    const other = person('k2');
    const w = sanction(p, { kind: 'warning', until: null });
    const ids = KINDS.map((k) => svc.createMessage(p, k, {}));
    const all: PlayerNotice[] = svc.pending(p);
    expect(all.filter((n) => n.mustAcknowledge).map((n) => n.id)).toEqual([w]);
    expect(svc.pendingWarning(p)).toBe(true);
    expect(svc.ack(other, ids[0] as string)).toBe(false);
    for (const id of ids) expect(svc.ack(p, id)).toBe(true);
    expect(svc.ack(p, ids[0] as string)).toBe(true);
    expect(svc.pending(p).map((n) => n.id)).toEqual([w]);
  });

  it('a message notice never makes pendingWarning true', () => {
    const { svc, person } = setup();
    const p = person('k1');
    for (const k of KINDS) svc.createMessage(p, k, {});
    expect(svc.pendingWarning(p)).toBe(false);
  });

  it('withdrawGroup and noticeIdForGroup ignore message notices', () => {
    const { svc, person, sanction, store } = setup();
    const p = person('k1');
    const s = sanction(p, { groupId: 'g-live' });
    const m = svc.createMessage(p, 'appeal_upheld', { rule: 2 });
    expect(svc.noticeIdForGroup('g-live', p)).toBe(s);
    expect(svc.withdrawGroup('g-live')).toBe(1);
    expect(stored(store, m).withdrawnAt).toBeNull();
    expect(svc.pending(p).map((n) => n.id)).toEqual([m]);
    expect(svc.noticeIdForGroup('g-live', p)).toBeNull();
    expect(svc.noticeIdForGroup('', p)).toBeNull();
  });

  it('a notice of an unknown kind read from a store is skipped, not thrown', () => {
    const { svc, person, store, subjects } = setup();
    const p = person('k1');
    const row = (kind: string, id: string): NoticeRow => ({ id, subject: subjects.canonical(p), groupId: null, kind: kind as NoticeKind, rule: null, until: null, refCode: null, excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null });
    store.insertNotice(row('from_the_future', 'n-future'));
    store.insertNotice(row('', 'n-empty'));
    const known = svc.createMessage(p, 'appeal_upheld', {});
    expect(() => svc.pending(p)).not.toThrow();
    expect(svc.pending(p).map((n) => n.id)).toEqual([known]);
    expect(() => svc.record(p)).not.toThrow();
    expect(svc.record(p)).toEqual([]);
    expect(svc.pendingWarning(p)).toBe(false);
    // it is still there for the tooling that knows it, and it can be acknowledged by id
    expect(store.rawNotices().map((n) => n.id)).toContain('n-future');
  });

  it('the old kinds behave exactly as before (a sanction notice, a warning, a report outcome)', () => {
    const { svc, person, sanction } = setup();
    const p = person('k1');
    const w = sanction(p, { kind: 'warning', until: null });
    const c = sanction(p, { kind: 'chat' });
    const o = svc.createReportOutcome(p);
    const got = svc.pending(p);
    expect(got.map((n) => [n.id, n.kind, n.mustAcknowledge])).toEqual([
      [w, 'warning', true],
      [c, 'chat', false],
      [o, 'report_outcome', false],
    ]);
    expect(svc.record(p).map((n) => n.id)).toEqual([w, c]);
  });
});
