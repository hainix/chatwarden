import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import type { Chatwarden } from '../src/chatwarden.js';
import { HISTORY_LOOKBACK_MS } from '../src/ladder.js';
import {
  BLOCKED_MAX,
  PERSON_SANCTIONS_MAX,
  SANCTION_PAGE_DEFAULT,
  SANCTION_PAGE_MAX,
  SanctionQueryError,
  isSanctionActive,
  sanctionGroupView,
} from '../src/staffViews.js';
import type { SanctionGroupView } from '../src/staffViews.js';
import type { Logger, Platform, RawWho, SanctionKind, SanctionRow, Source, StoredReport } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

// The staff read views behind the K4 hub routes: sanction groups (per person and across everyone), the reporter's record and
// the blocked-message list. Run on the in-memory store (the store contract proves SQLite agrees).

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

async function setup() {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const logger: Logger = { warn() {} };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({
    store,
    secret: 'views-secret',
    platform,
    clock,
    logger,
    retention: false,
    matcher: { match: (t: string) => (t.includes('zorbak') ? { termId: 'term-z' } : null) },
  });
  let n = 0;
  /** A seated person in a room of their own; returns the canonical subject. */
  const person = (ip?: string): string => {
    n += 1;
    const room = `room-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `raw-client-key-views-${String(n).padStart(4, '0')}`, ...(ip === undefined ? {} : { ip }) }, `Handle${n}`);
    return cw.rooms.subjectAt(room, 'p1') as string;
  };
  const sanction = (subject: string, over: Partial<Parameters<Chatwarden['sanctions']['apply']>[0]> = {}) =>
    cw.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: DAY,
      reason: 'private reason',
      actor: 'ann',
      source: 'moderator',
      automated: false,
      rule: 2,
      ...over,
    });
  return { cw, store, clock, person, sanction };
}

const KEYS = [
  'groupId', 'refCode', 'kind', 'rule', 'startsAt', 'endsAt', 'reason', 'actor', 'source', 'automated', 'active',
  'revokedAt', 'revokedBy', 'revokeReason',
].sort();

describe('isSanctionActive', () => {
  const base: SanctionRow = {
    id: 'r', groupId: 'g', refCode: 'M-AAAAA', kind: 'chat', targetType: 'subject', value: 's', startsAt: NOW - H, endsAt: NOW + H,
    reason: '', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'a', source: 'moderator', automated: false,
    pending: false, revokedAt: null,
  };
  const at = (over: Partial<SanctionRow>): boolean => isSanctionActive({ ...base, ...over }, NOW);

  it('a timed restriction applies strictly before its end', () => {
    expect(at({})).toBe(true);
    expect(at({ endsAt: NOW + 1 })).toBe(true);
    expect(at({ endsAt: NOW })).toBe(false);
    expect(at({ endsAt: NOW - 1 })).toBe(false);
  });
  it('a permanent one applies until revoked', () => {
    expect(at({ endsAt: null })).toBe(true);
    expect(at({ endsAt: null, revokedAt: NOW - 1 })).toBe(false);
  });
  it('a revoked row is never active, however long it has left', () => {
    expect(at({ revokedAt: NOW })).toBe(false);
    expect(at({ kind: 'ban', endsAt: NOW + DAY, revokedAt: NOW })).toBe(false);
  });
  it('a missing revokedAt reads as not revoked', () => {
    const rest: SanctionRow = { ...base };
    delete rest.revokedAt;
    expect(isSanctionActive(rest, NOW)).toBe(true);
  });
  it.each<SanctionKind>(['warning', 'note'])('a %s counts while it is inside the ladder window (90 days from startsAt), unless revoked', (kind) => {
    const rec = { kind, endsAt: NOW - H }; // a record kind ends where it starts
    expect(at({ ...rec, startsAt: NOW - H })).toBe(true);
    expect(at({ ...rec, startsAt: NOW - HISTORY_LOOKBACK_MS })).toBe(true);
    expect(at({ ...rec, startsAt: NOW - HISTORY_LOOKBACK_MS - 1 })).toBe(false);
    expect(at({ ...rec, startsAt: NOW - H, revokedAt: NOW })).toBe(false);
  });
});

describe('sanctionGroupView', () => {
  const row: SanctionRow = {
    id: 'secret-row-id', groupId: 'g1', refCode: 'M-ABCDE', kind: 'ban', targetType: 'subject', value: 's_subject', startsAt: NOW - H,
    endsAt: null, reason: 'why', rule: '3', gapNote: 'private gap note', gapStatus: 'open', roomId: 'ROOM9', actor: 'ann',
    source: 'moderator', automated: false, pending: true, revokedAt: null, revokedBy: null, revokeReason: null,
  };

  it('holds exactly the view fields and nothing of the row (no id, value, gap note, room or pending)', () => {
    const v = sanctionGroupView(row, NOW);
    expect(Object.keys(v).sort()).toEqual(KEYS);
    expect(v).toEqual({
      groupId: 'g1', refCode: 'M-ABCDE', kind: 'ban', rule: 3, startsAt: NOW - H, endsAt: null, reason: 'why', actor: 'ann',
      source: 'moderator', automated: false, active: true, revokedAt: null, revokedBy: null, revokeReason: null,
    });
  });
  it('reads the rule as a RuleRef: a number, uncovered, or null when none or unreadable', () => {
    expect(sanctionGroupView({ ...row, rule: 'uncovered' }, NOW).rule).toBe('uncovered');
    expect(sanctionGroupView({ ...row, rule: '12' }, NOW).rule).toBe(12);
    expect(sanctionGroupView({ ...row, rule: null }, NOW).rule).toBeNull();
    expect(sanctionGroupView({ ...row, rule: 'banana' }, NOW).rule).toBeNull();
    expect(sanctionGroupView({ ...row, rule: '0' }, NOW).rule).toBeNull();
  });
  it('a warning or note has no end: endsAt is null, not its start', () => {
    expect(sanctionGroupView({ ...row, kind: 'warning', endsAt: row.startsAt }, NOW).endsAt).toBeNull();
    expect(sanctionGroupView({ ...row, kind: 'note', endsAt: row.startsAt }, NOW).endsAt).toBeNull();
    expect(sanctionGroupView({ ...row, kind: 'chat', endsAt: NOW + H }, NOW).endsAt).toBe(NOW + H);
  });
  it('carries the revoke columns and is then inactive', () => {
    const v = sanctionGroupView({ ...row, revokedAt: NOW - 5, revokedBy: 'bob', revokeReason: 'mistake' }, NOW);
    expect(v).toMatchObject({ active: false, revokedAt: NOW - 5, revokedBy: 'bob', revokeReason: 'mistake' });
  });
  it('a row from a load that does not carry the revoke columns reads them as null', () => {
    const bare: SanctionRow = { ...row };
    delete bare.revokedAt;
    delete bare.revokedBy;
    delete bare.revokeReason;
    expect(sanctionGroupView(bare, NOW)).toMatchObject({ revokedAt: null, revokedBy: null, revokeReason: null, active: true });
  });
});

describe('cw.sanctions.forPerson', () => {
  it('is empty for a person with no sanctions and for an id nobody has seen', async () => {
    const { cw, person } = await setup();
    expect(cw.sanctions.forPerson(person())).toEqual([]);
    expect(cw.sanctions.forPerson('never-seen')).toEqual([]);
  });

  it('returns the group as a view of its subject row, with the ref code a player would quote', async () => {
    const { cw, person, sanction } = await setup();
    const subject = person('203.0.113.7');
    const made = await sanction(subject, { includeIp: true, reason: 'spamming the lobby', rule: 4 });
    const views = cw.sanctions.forPerson(subject);
    expect(views).toEqual([
      {
        groupId: made.groupId, refCode: made.refCode, kind: 'chat', rule: 4, startsAt: NOW, endsAt: NOW + DAY, reason: 'spamming the lobby',
        actor: 'ann', source: 'moderator', automated: false, active: true, revokedAt: null, revokedBy: null, revokeReason: null,
      },
    ]);
    // One group with an IP row is still one view, and the view names no ip, value or hash.
    expect(JSON.stringify(views)).not.toMatch(/203\.0\.113|iphash|"value"|"id"/);
  });

  it('is newest first', async () => {
    const { cw, person, sanction, clock } = await setup();
    const subject = person();
    const a = await sanction(subject);
    clock.t += H;
    const b = await sanction(subject, { kind: 'warning', durationMs: null });
    clock.t += H;
    const c = await sanction(subject, { kind: 'note', durationMs: null });
    expect(cw.sanctions.forPerson(subject).map((v) => v.groupId)).toEqual([c.groupId, b.groupId, a.groupId]);
  });

  it('covers the 90 day window plus every active permanent one; an old timed, an old revoked and an old warning fall out', async () => {
    const { cw, person, sanction, clock } = await setup();
    const subject = person();
    const start = clock.t;
    clock.t = start - 100 * DAY;
    const oldTimed = await sanction(subject, { durationMs: 7 * DAY });
    const oldWarning = await sanction(subject, { kind: 'warning', durationMs: null });
    const oldPerm = await sanction(subject, { kind: 'ban', durationMs: null });
    const oldPermRevoked = await sanction(subject, { kind: 'ban', durationMs: null });
    await cw.sanctions.revoke(oldPermRevoked.groupId, 'bob', 'lifted');
    clock.t = start - 89 * DAY;
    const recent = await sanction(subject);
    clock.t = start;
    const ids = cw.sanctions.forPerson(subject).map((v) => v.groupId);
    expect(ids).toEqual([recent.groupId, oldPerm.groupId]);
    expect(ids).not.toContain(oldTimed.groupId);
    expect(ids).not.toContain(oldWarning.groupId);
    expect(ids).not.toContain(oldPermRevoked.groupId);
  });

  it('active: a live timed one, an ended one, a permanent one and a revoked one', async () => {
    const { cw, person, sanction, clock } = await setup();
    const subject = person();
    const live = await sanction(subject, { durationMs: 10 * DAY });
    const ended = await sanction(subject, { durationMs: H });
    const perm = await sanction(subject, { kind: 'ban', durationMs: null });
    const revoked = await sanction(subject, { durationMs: 10 * DAY });
    await cw.sanctions.revoke(revoked.groupId, 'bob', 'sorry');
    clock.t += 2 * H;
    const active = Object.fromEntries(cw.sanctions.forPerson(subject).map((v) => [v.groupId, v.active]));
    expect(active).toEqual({ [live.groupId]: true, [ended.groupId]: false, [perm.groupId]: true, [revoked.groupId]: false });
  });

  it('shows who revoked a group, when and why', async () => {
    const { cw, person, sanction, clock } = await setup();
    const subject = person();
    const made = await sanction(subject);
    clock.t += 5;
    expect(await cw.sanctions.revoke(made.groupId, 'bob', 'it was a mistake')).toBe(true);
    clock.t += 5;
    expect(await cw.sanctions.revoke(made.groupId, 'carol', 'again')).toBe(false);
    expect(cw.sanctions.forPerson(subject)[0]).toMatchObject({
      active: false, revokedAt: NOW + 5, revokedBy: 'bob', revokeReason: 'it was a mistake',
    });
  });

  it('a warning and a note have endsAt null; a rule gap reads as uncovered', async () => {
    const { cw, person, sanction, clock } = await setup();
    const subject = person();
    await sanction(subject, { kind: 'warning', durationMs: null });
    clock.t += 1;
    await sanction(subject, { kind: 'note', durationMs: null, rule: 'uncovered', gapNote: 'not covered by any rule' });
    const views = cw.sanctions.forPerson(subject);
    expect(views.map((v) => [v.kind, v.endsAt, v.rule, v.active])).toEqual([
      ['note', null, 'uncovered', true],
      ['warning', null, 2, true],
    ]);
    // The gap note is private to the gap list and never part of the view.
    expect(JSON.stringify(views)).not.toContain('not covered by any rule');
  });

  it('a row written before rules existed reads rule null', async () => {
    const { cw, store, person } = await setup();
    const subject = person();
    store.insertSanctionGroup([
      {
        id: 'old', groupId: 'gold', refCode: 'M-OLD11', kind: 'chat', targetType: 'subject', value: subject, startsAt: NOW,
        endsAt: NOW + H, reason: 'r', rule: null, gapNote: null, gapStatus: null, roomId: null, actor: 'ann', source: 'moderator',
        automated: false, pending: false,
      },
    ]);
    expect(cw.sanctions.forPerson(subject)[0]?.rule).toBeNull();
  });

  it('follows a merge: a sanction filed under an alias shows for the surviving person, from either id', async () => {
    const { cw, person, sanction } = await setup();
    const a = person();
    const b = person();
    await sanction(a);
    await sanction(b, { kind: 'warning', durationMs: null });
    cw.rooms.seat('merge-room', 'p1', { clientKey: 'raw-client-key-views-0001', accountId: 'acct-1' }, 'X');
    cw.rooms.seat('merge-room', 'p2', { clientKey: 'raw-client-key-views-0002', accountId: 'acct-1' }, 'Y');
    await cw.flush();
    const root = cw.people.canonical(a);
    expect(cw.people.canonical(b)).toBe(root);
    expect(cw.sanctions.forPerson(a)).toHaveLength(2);
    expect(cw.sanctions.forPerson(b)).toHaveLength(2);
  });

  it('is capped at PERSON_SANCTIONS_MAX, newest kept', async () => {
    const { cw, person, sanction, clock } = await setup();
    const subject = person();
    for (let i = 0; i < PERSON_SANCTIONS_MAX + 3; i += 1) {
      clock.t += 1;
      await sanction(subject, { kind: 'warning', durationMs: null });
    }
    const got = cw.sanctions.forPerson(subject);
    expect(got).toHaveLength(PERSON_SANCTIONS_MAX);
    expect(got[0]?.startsAt).toBe(NOW + PERSON_SANCTIONS_MAX + 3);
  });

  it("does not return someone else's sanctions (control)", async () => {
    const { cw, person, sanction } = await setup();
    const a = person();
    const b = person();
    await sanction(b);
    expect(cw.sanctions.forPerson(a)).toEqual([]);
  });
});

describe('cw.sanctions.list', () => {
  const ids = (page: { items: Array<{ groupId: string }> }): string[] => page.items.map((i) => i.groupId);

  it('is empty with next null when nothing was sanctioned', async () => {
    const { cw } = await setup();
    expect(cw.sanctions.list()).toEqual({ items: [], next: null });
  });

  it('lists every person newest first, each a view plus the canonical person', async () => {
    const { cw, person, sanction, clock } = await setup();
    const a = person();
    const b = person();
    const first = await sanction(a);
    clock.t += 1000;
    const second = await sanction(b, { kind: 'warning', durationMs: null, source: 'api' as Source });
    const page = cw.sanctions.list();
    expect(ids(page)).toEqual([second.groupId, first.groupId]);
    expect(page.next).toBeNull();
    expect(page.items[0]).toEqual({
      groupId: second.groupId, refCode: second.refCode, kind: 'warning', rule: 2, startsAt: NOW + 1000, endsAt: null, reason: 'private reason',
      actor: 'ann', source: 'api', automated: false, active: true, revokedAt: null, revokedBy: null, revokeReason: null, person: b,
    });
    expect(page.items[1]?.person).toBe(a);
    for (const item of page.items) expect(Object.keys(item).sort()).toEqual([...KEYS, 'person'].sort());
  });

  it('never lists an ip row: a group with an ip row is one item', async () => {
    const { cw, person, sanction } = await setup();
    const a = person('203.0.113.8');
    await sanction(a, { includeIp: true });
    const page = cw.sanctions.list();
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toMatch(/203\.0\.113|"value"/);
  });

  it('is not windowed: an old sanction is listed', async () => {
    const { cw, person, sanction, clock } = await setup();
    const a = person();
    clock.t -= 200 * DAY;
    const old = await sanction(a, { durationMs: DAY });
    clock.t = NOW;
    expect(ids(cw.sanctions.list())).toEqual([old.groupId]);
  });

  it('pages with an opaque cursor; the default page is 50 and a full last page is followed by an empty one', async () => {
    const { cw, person, sanction, clock } = await setup();
    const a = person();
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      clock.t += 1;
      made.unshift((await sanction(a, { kind: 'warning', durationMs: null })).groupId);
    }
    const p1 = cw.sanctions.list({ limit: 2 });
    expect(ids(p1)).toEqual(made.slice(0, 2));
    expect(p1.next).toMatch(/^[A-Za-z0-9_-]+$/);
    const p2 = cw.sanctions.list({ limit: 2, cursor: p1.next });
    expect(ids(p2)).toEqual(made.slice(2, 4));
    const p3 = cw.sanctions.list({ limit: 2, cursor: p2.next });
    expect(ids(p3)).toEqual(made.slice(4));
    expect(p3.next).toBeNull();

    const exact = cw.sanctions.list({ limit: 5 });
    expect(ids(exact)).toEqual(made);
    expect(exact.next).not.toBeNull();
    expect(cw.sanctions.list({ limit: 5, cursor: exact.next })).toEqual({ items: [], next: null });

    expect(SANCTION_PAGE_DEFAULT).toBe(50);
    expect(cw.sanctions.list().items).toHaveLength(5);
  });

  it('clamps the limit to 1..200 and treats a non-number as the default', async () => {
    const { cw, person, sanction } = await setup();
    const a = person();
    for (let i = 0; i < 3; i += 1) await sanction(a, { kind: 'warning', durationMs: null });
    expect(cw.sanctions.list({ limit: 0 }).items).toHaveLength(1);
    expect(cw.sanctions.list({ limit: -3 }).items).toHaveLength(1);
    expect(cw.sanctions.list({ limit: 2.9 }).items).toHaveLength(2);
    expect(cw.sanctions.list({ limit: 9999 }).items).toHaveLength(3);
    expect(cw.sanctions.list({ limit: Number.NaN }).items).toHaveLength(3);
    expect(SANCTION_PAGE_MAX).toBe(200);
  });

  it('a cursor past the end is an empty page; a null cursor is the first page', async () => {
    const { cw, person, sanction } = await setup();
    await sanction(person());
    const p = cw.sanctions.list({ limit: 1 });
    expect(cw.sanctions.list({ cursor: p.next })).toEqual({ items: [], next: null });
    expect(cw.sanctions.list({ cursor: null }).items).toHaveLength(1);
  });

  it.each(['', '!!!', 'not a cursor', '%%', 'bm90LWEtY3Vyc29y', 'YWJjOjE', 'OjE'])(
    'a cursor we did not issue (%j) is a SanctionQueryError',
    async (cursor) => {
      const { cw } = await setup();
      expect(() => cw.sanctions.list({ cursor })).toThrow(SanctionQueryError);
      try {
        cw.sanctions.list({ cursor });
      } catch (err) {
        expect((err as SanctionQueryError).field).toBe('cursor');
        expect((err as Error).message).not.toContain(cursor === '' ? '\u0000' : cursor);
      }
    },
  );

  it('filters by source; an unknown source is a SanctionQueryError', async () => {
    const { cw, person, sanction } = await setup();
    const a = person();
    const mod = await sanction(a);
    const auto = await sanction(a, { source: 'auto_filter', automated: true, actor: 'chatwarden' });
    expect(ids(cw.sanctions.list({ source: 'auto_filter' }))).toEqual([auto.groupId]);
    expect(ids(cw.sanctions.list({ source: 'moderator' }))).toEqual([mod.groupId]);
    expect(cw.sanctions.list({ source: 'coop' }).items).toEqual([]);
    expect(() => cw.sanctions.list({ source: 'nope' as Source })).toThrow(SanctionQueryError);
    expect(() => cw.sanctions.list({ source: 7 as unknown as Source })).toThrow(SanctionQueryError);
  });

  it('a source filter pages correctly (the cursor keeps the filter)', async () => {
    const { cw, person, sanction, clock } = await setup();
    const a = person();
    const autos: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      clock.t += 1;
      await sanction(a);
      clock.t += 1;
      autos.unshift((await sanction(a, { source: 'auto_filter', automated: true })).groupId);
    }
    const p1 = cw.sanctions.list({ source: 'auto_filter', limit: 2 });
    const p2 = cw.sanctions.list({ source: 'auto_filter', limit: 2, cursor: p1.next });
    expect([...ids(p1), ...ids(p2)]).toEqual(autos);
  });

  it('reports a revoked group as inactive with its revoker', async () => {
    const { cw, person, sanction } = await setup();
    const made = await sanction(person());
    await cw.sanctions.revoke(made.groupId, 'bob', 'oops');
    expect(cw.sanctions.list().items[0]).toMatchObject({ active: false, revokedBy: 'bob', revokeReason: 'oops' });
  });
});

describe('cw.reports.reporterRecord', () => {
  const rep = (over: Partial<StoredReport> & { id: string; reporterSubject: string }): StoredReport => ({
    createdAt: NOW - H,
    roomId: `room-${over.id}`,
    tags: {},
    reporterSeat: 'p1',
    reporterHandle: 'Rep',
    targetSubject: 's_target',
    targetSeat: 'p2',
    targetHandle: 'Tgt',
    category: 'harassment',
    note: null,
    lineId: null,
    excerpt: [],
    people: [],
    status: 'open',
    ...over,
  });
  const file = (store: MemoryStore, r: StoredReport, close?: { status: 'actioned' | 'dismissed'; badFaith: boolean; at: number }) => {
    store.insertReport(r);
    if (close !== undefined) store.closeReport(r.id, close.status, close.badFaith, 'mod', close.at, 'note');
  };

  it('is all zeros and not suspended for a person who never reported', async () => {
    const { cw, person } = await setup();
    expect(cw.reports.reporterRecord(person())).toEqual({ reports: 0, open: 0, actioned: 0, dismissed: 0, badFaith: 0, suspendedUntil: null });
    expect(cw.reports.reporterRecord('never-seen')).toEqual({ reports: 0, open: 0, actioned: 0, dismissed: 0, badFaith: 0, suspendedUntil: null });
  });

  it('counts open, actioned, dismissed and bad faith; reports is the total', async () => {
    const { cw, store, person } = await setup();
    const r = person();
    file(store, rep({ id: 'a', reporterSubject: r }));
    file(store, rep({ id: 'b', reporterSubject: r }), { status: 'actioned', badFaith: false, at: NOW });
    file(store, rep({ id: 'c', reporterSubject: r }), { status: 'dismissed', badFaith: false, at: NOW });
    file(store, rep({ id: 'd', reporterSubject: r }), { status: 'dismissed', badFaith: true, at: NOW - DAY });
    file(store, rep({ id: 'e', reporterSubject: 'someone-else' }));
    expect(cw.reports.reporterRecord(r)).toEqual({ reports: 4, open: 1, actioned: 1, dismissed: 2, badFaith: 1, suspendedUntil: null });
  });

  it('reports filed against the person do not count as theirs (control)', async () => {
    const { cw, store, person } = await setup();
    const r = person();
    file(store, rep({ id: 'a', reporterSubject: 'someone-else', targetSubject: r }));
    expect(cw.reports.reporterRecord(r).reports).toBe(0);
  });

  it('adds up the reports of every alias of the person', async () => {
    const { cw, store, person } = await setup();
    const a = person();
    const b = person();
    file(store, rep({ id: 'a', reporterSubject: a }));
    file(store, rep({ id: 'b', reporterSubject: b }));
    cw.rooms.seat('merge-room', 'p1', { clientKey: 'raw-client-key-views-0001', accountId: 'acct-1' }, 'X');
    cw.rooms.seat('merge-room', 'p2', { clientKey: 'raw-client-key-views-0002', accountId: 'acct-1' }, 'Y');
    await cw.flush();
    expect(cw.reports.reporterRecord(a).reports).toBe(2);
    expect(cw.reports.reporterRecord(b).reports).toBe(2);
  });

  it('is suspended after suspendAfter (3) bad-faith dismissals in 30 days, until the oldest of the deciding marks ages out', async () => {
    const { cw, store, person } = await setup();
    const r = person();
    const window = cw.limits.reports.suspendWindowMs;
    const at = [NOW - 5 * DAY, NOW - 3 * DAY, NOW - DAY];
    at.forEach((t, i) => file(store, rep({ id: `x${i}`, reporterSubject: r }), { status: 'dismissed', badFaith: true, at: t }));
    expect(cw.reports.reporterRecord(r)).toMatchObject({ badFaith: 3, suspendedUntil: at[0]! + window + 1 });
  });

  it('with more marks than the threshold, the suspension ends when enough have aged out to drop below it', async () => {
    const { cw, store, person } = await setup();
    const r = person();
    const window = cw.limits.reports.suspendWindowMs;
    const at = [NOW - 10 * DAY, NOW - 8 * DAY, NOW - 5 * DAY, NOW - 2 * DAY, NOW - DAY]; // 5 marks, threshold 3
    at.forEach((t, i) => file(store, rep({ id: `x${i}`, reporterSubject: r }), { status: 'dismissed', badFaith: true, at: t }));
    // Two must age out for the count to fall to 2: the third-oldest is the first one that still counts.
    expect(cw.reports.reporterRecord(r).suspendedUntil).toBe(at[2]! + window + 1);
  });

  it('two marks are not enough, and marks older than the window do not count', async () => {
    const { cw, store, person } = await setup();
    const r = person();
    file(store, rep({ id: 'a', reporterSubject: r }), { status: 'dismissed', badFaith: true, at: NOW - DAY });
    file(store, rep({ id: 'b', reporterSubject: r }), { status: 'dismissed', badFaith: true, at: NOW - 2 * DAY });
    expect(cw.reports.reporterRecord(r).suspendedUntil).toBeNull();
    file(store, rep({ id: 'c', reporterSubject: r }), { status: 'dismissed', badFaith: true, at: NOW - 31 * DAY });
    const rec = cw.reports.reporterRecord(r);
    expect(rec.suspendedUntil).toBeNull();
    expect(rec.badFaith).toBe(3); // all-time count; the suspension reads the window only
  });

  it('a bad-faith mark by someone else does not suspend this person (control)', async () => {
    const { cw, store, person } = await setup();
    const r = person();
    for (let i = 0; i < 4; i += 1) file(store, rep({ id: `o${i}`, reporterSubject: 'other' }), { status: 'dismissed', badFaith: true, at: NOW - DAY });
    expect(cw.reports.reporterRecord(r).suspendedUntil).toBeNull();
  });

  it('matches what submit enforces: refused at suspendedUntil - 1, allowed at suspendedUntil', async () => {
    const { cw, store, clock } = await setup();
    cw.rooms.seat('rm', 'p1', { clientKey: 'raw-client-key-views-r001' }, 'Rep');
    cw.rooms.seat('rm', 'p2', { clientKey: 'raw-client-key-views-t001' }, 'Tgt');
    cw.rooms.seat('rm2', 'p1', { clientKey: 'raw-client-key-views-r001' }, 'Rep');
    cw.rooms.seat('rm2', 'p2', { clientKey: 'raw-client-key-views-t001' }, 'Tgt');
    const reporter = cw.rooms.subjectAt('rm', 'p1') as string;
    [NOW - 5 * DAY, NOW - 3 * DAY, NOW - DAY].forEach((t, i) =>
      file(store, rep({ id: `x${i}`, reporterSubject: reporter, targetSubject: 's_other' }), { status: 'dismissed', badFaith: true, at: t }),
    );
    const until = cw.reports.reporterRecord(reporter).suspendedUntil as number;
    clock.t = until - 1;
    expect(await cw.reports.submit({ roomId: 'rm', reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' })).toEqual({ ok: false, refused: 'suspended' });
    clock.t = until;
    expect(cw.reports.reporterRecord(reporter).suspendedUntil).toBeNull();
    const res = await cw.reports.submit({ roomId: 'rm2', reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    expect(res.ok).toBe(true);
  });
});

describe('cw.blocked', () => {
  const strike = (store: MemoryStore, id: string, at: number, over: Partial<Parameters<MemoryStore['insertStrike']>[0]> = {}) =>
    store.insertStrike({ id, at, subject: 's_a', roomId: 'ROOM1', termId: 'term1', rawLine: 'a blocked line', ...over });

  it('lists the strikes of the window newest first as { id, at, roomId, termId, person, text }', async () => {
    const { cw, store, clock } = await setup();
    clock.t = NOW;
    strike(store, 'k1', NOW - 3 * H, { rawLine: 'oldest' });
    strike(store, 'k2', NOW - H, { rawLine: 'newest', roomId: 'ROOM2', termId: 'term2' });
    strike(store, 'k3', NOW - 2 * H, { rawLine: 'middle' });
    const items = cw.blocked.list({ days: 1 });
    expect(items.map((i) => i.text)).toEqual(['newest', 'middle', 'oldest']);
    expect(items[0]).toEqual({ id: 'k2', at: NOW - H, roomId: 'ROOM2', termId: 'term2', person: 's_a', text: 'newest' });
    expect(Object.keys(items[0]!).sort()).toEqual(['at', 'id', 'person', 'roomId', 'termId', 'text']);
  });

  it('the window is 1, 7 or 30 days back from now, inclusive at the edge', async () => {
    const { cw, store } = await setup();
    strike(store, 'in1', NOW - DAY);
    strike(store, 'out1', NOW - DAY - 1);
    strike(store, 'in7', NOW - 6 * DAY);
    strike(store, 'out7', NOW - 7 * DAY - 1);
    strike(store, 'in30', NOW - 29 * DAY);
    strike(store, 'out30', NOW - 30 * DAY - 1);
    const at = (days: 1 | 7 | 30) => cw.blocked.list({ days }).map((i) => i.id).sort();
    expect(at(1)).toEqual(['in1']);
    expect(at(7)).toEqual(['in1', 'in7', 'out1']);
    expect(at(30)).toEqual(['in1', 'in30', 'in7', 'out1', 'out7']);
  });

  it('is empty when nothing was blocked', async () => {
    const { cw } = await setup();
    expect(cw.blocked.list({ days: 7 })).toEqual([]);
    expect(cw.blocked.countsByTerm({ days: 30 })).toEqual({});
  });

  it('is capped at BLOCKED_MAX (500), newest kept', async () => {
    const { cw, store } = await setup();
    for (let i = 0; i < BLOCKED_MAX + 5; i += 1) strike(store, `k${String(i).padStart(4, '0')}`, NOW - 1000 + i);
    const items = cw.blocked.list({ days: 1 });
    expect(items).toHaveLength(BLOCKED_MAX);
    expect(items[0]?.id).toBe(`k${String(BLOCKED_MAX + 4).padStart(4, '0')}`);
  });

  it('shows the canonical person even when the strike was filed under a merged alias', async () => {
    const { cw, store, person } = await setup();
    const a = person();
    const b = person();
    strike(store, 'k1', NOW - H, { subject: b });
    cw.rooms.seat('merge-room', 'p1', { clientKey: 'raw-client-key-views-0001', accountId: 'acct-1' }, 'X');
    cw.rooms.seat('merge-room', 'p2', { clientKey: 'raw-client-key-views-0002', accountId: 'acct-1' }, 'Y');
    await cw.flush();
    expect(cw.blocked.list({ days: 1 })[0]?.person).toBe(cw.people.canonical(a));
  });

  it('a real blocked chat line shows up with its raw text', async () => {
    const { cw, clock } = await setup();
    cw.rooms.seat('live', 'p1', { clientKey: 'raw-client-key-views-live1' }, 'Speaker');
    const res = cw.chat.accept('live', 'p1', 'you zorbak');
    expect('refuse' in res).toBe(true);
    clock.t += 1;
    const items = cw.blocked.list({ days: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ roomId: 'live', termId: 'term-z', text: 'you zorbak', person: cw.rooms.subjectAt('live', 'p1') });
  });

  it('rejects a window that is not 1, 7 or 30 days', async () => {
    const { cw } = await setup();
    for (const days of [0, 2, 31, -1, 1.5, Number.NaN, '7', null, undefined]) {
      expect(() => cw.blocked.list({ days: days as never }), String(days)).toThrow(RangeError);
      expect(() => cw.blocked.countsByTerm({ days: days as never }), String(days)).toThrow(RangeError);
    }
  });

  it('countsByTerm counts the strikes per term in the window', async () => {
    const { cw, store } = await setup();
    strike(store, 'a', NOW - H, { termId: 'tA' });
    strike(store, 'b', NOW - 2 * H, { termId: 'tA' });
    strike(store, 'c', NOW - 3 * H, { termId: 'tB' });
    strike(store, 'd', NOW - 10 * DAY, { termId: 'tB' });
    expect(cw.blocked.countsByTerm({ days: 30 })).toEqual({ tA: 2, tB: 2 });
    expect(cw.blocked.countsByTerm({ days: 7 })).toEqual({ tA: 2, tB: 1 });
  });

  it('countsByTerm is not capped at the list size', async () => {
    const { cw, store } = await setup();
    for (let i = 0; i < BLOCKED_MAX + 20; i += 1) strike(store, `k${i}`, NOW - 1000, { termId: 'tA' });
    expect(cw.blocked.countsByTerm({ days: 1 })).toEqual({ tA: BLOCKED_MAX + 20 });
  });
});

describe('the views keep ip and hash out of every shape', () => {
  it('serialises with no value, ip, hash or row id', async () => {
    const { cw, store, person, sanction } = await setup();
    const a = person('198.51.100.20');
    await sanction(a, { includeIp: true });
    store.insertStrike({ id: 'k1', at: NOW - H, subject: a, roomId: 'R', termId: 't', rawLine: 'blocked' });
    const everything = JSON.stringify([
      cw.sanctions.forPerson(a),
      cw.sanctions.list(),
      cw.reports.reporterRecord(a),
      cw.blocked.list({ days: 1 }),
    ]);
    expect(everything).not.toMatch(/198\.51\.100|"value"|"ipHash"|"clientKey"|"accountId"/);
    const view: SanctionGroupView = cw.sanctions.forPerson(a)[0]!;
    expect('id' in view).toBe(false);
    expect('targetType' in view).toBe(false);
  });
});
