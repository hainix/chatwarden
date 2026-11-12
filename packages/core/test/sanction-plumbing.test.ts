import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import { APPEALS_START_TOKEN, applySanction, revokeSanction, SanctionError, writeSanction, validateSanctionInput } from '../src/sanctions.js';
import type { SanctionInput } from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';
import type { AppealRow, SubjectId } from '../src/types.js';
import { world } from './reportingWorld.js';

// Sanction plumbing for appeals: the decided report's id on the row, an internal start time only the appeals service may give, and the
// moot hook (revoking a group closes its open appeal in the same transaction).

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;

function bare() {
  const store = withMemoryAppeals(new MemoryStore());
  const clock = { now: () => NOW };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const person = (key: string): SubjectId => {
    const s = subjects.resolve({ clientKey: key, accountId: null, ipHash: null });
    if (s === null) throw new Error('expected a subject');
    return s;
  };
  const input = (subject: SubjectId, over: Partial<SanctionInput> = {}): SanctionInput => ({
    kind: 'chat',
    subject,
    includeIp: false,
    durationMs: 6 * H,
    reason: 'r',
    actor: 'mod_ann',
    source: 'moderator',
    automated: false,
    rule: 2,
    ...over,
  });
  return { store, subjects, person, input };
}

const appealFor = (groupId: string, over: Partial<AppealRow> = {}): AppealRow => ({
  id: `ap-${groupId}`,
  subject: 's_x',
  groupId,
  noticeId: 'n1',
  reportId: null,
  rule: '2',
  kind: 'chat',
  statement: 'st',
  status: 'open',
  createdAt: NOW,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  replacementGroupId: null,
  ...over,
});

describe('reportId on a sanction', () => {
  it("a moderator decision stores the decided report's id on every subject row of its group; an automatic or direct sanction stores null", async () => {
    const store = new MemoryStore();
    const w = await world({}, store);
    const f = await w.file();
    const res = await w.cw.decide({
      reportId: f.id,
      verdict: 'upheld',
      actor: 'mod@example.test',
      reason: 'private',
      actions: [
        { subject: f.target, kind: 'chat', durationMs: H, rule: 2, lineIds: [] },
        { subject: f.reporter, kind: 'warning', durationMs: null, rule: 3, lineIds: [] },
      ],
    });
    expect(res.ok).toBe(true);
    const rows = store.rawSanctions();
    const subjectRows = rows.filter((r) => r.targetType === 'subject');
    expect(subjectRows).toHaveLength(2);
    for (const r of subjectRows) expect(r.reportId).toBe(f.id);
    // a direct sanction (cw.sanctions.apply) has none
    const direct = await w.cw.sanctions.apply({ kind: 'ban', subject: f.target, includeIp: false, durationMs: null, reason: 'r', actor: 'mod', source: 'moderator', automated: false, rule: 1 });
    const directRow = store.rawSanctions().find((r) => r.groupId === direct.groupId);
    expect(directRow?.reportId ?? null).toBeNull();
    expect(Object.keys(directRow ?? {})).not.toContain('reportId');
  });

  it('an automatic sanction stores no report id', async () => {
    const b = bare();
    const written = writeSanction(b.store, b.subjects, b.input(b.person('k1'), { source: 'auto_filter', automated: true, actor: 'chatwarden' }), NOW, false);
    expect(written.rows[0]?.reportId ?? null).toBeNull();
    expect(b.store.loadSanctionSubjectRow(written.groupId)?.reportId ?? null).toBeNull();
  });

  it('writeSanction stores a given report id on the subject row and loadSanctionSubjectRow reads it', () => {
    const b = bare();
    const written = writeSanction(b.store, b.subjects, b.input(b.person('k1'), { reportId: 'rep_9' }), NOW, false);
    expect(written.rows[0]?.reportId).toBe('rep_9');
    expect(b.store.loadSanctionSubjectRow(written.groupId)?.reportId).toBe('rep_9');
  });

  it('a malformed report id is refused before anything is written', () => {
    const b = bare();
    for (const bad of ['', 5, null, {}]) {
      expect(() => writeSanction(b.store, b.subjects, b.input(b.person('k1'), { reportId: bad as never }), NOW, false), String(bad)).toThrow(SanctionError);
      expect(() => validateSanctionInput(b.input(b.person('k1'), { reportId: bad as never }))).toThrow(SanctionError);
    }
    expect(b.store.rawSanctions()).toEqual([]);
  });

  it('the IP row of a group carries no report id', () => {
    const b = bare();
    const s = b.person('k1');
    b.subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: 'iphash1' });
    const written = writeSanction(b.store, b.subjects, b.input(s, { reportId: 'rep_9', includeIp: true }), NOW, false);
    const ip = written.rows.find((r) => r.targetType === 'ip');
    expect(ip).toBeDefined();
    expect(Object.keys(ip ?? {})).not.toContain('reportId');
  });
});

describe('startsAt (internal)', () => {
  it("startsAt from the appeals service sets the row's start; from a public call it is refused", async () => {
    const b = bare();
    const s = b.person('k1');
    const start = NOW - 6 * DAY;
    const written = writeSanction(b.store, b.subjects, { ...b.input(s, { durationMs: DAY }), startsAt: start, startsAtToken: APPEALS_START_TOKEN } as SanctionInput, NOW, false);
    expect(written.rows[0]).toMatchObject({ startsAt: start, endsAt: start + DAY });
    expect(written.endsAt).toBe(start + DAY);
    // no token, a wrong token, a token that is not the symbol: RangeError, nothing written
    const before = b.store.rawSanctions().length;
    for (const extra of [{}, { startsAtToken: Symbol('mine') }, { startsAtToken: 'appeals' }, { startsAtToken: true }]) {
      const bad = { ...b.input(s), startsAt: start, ...extra } as SanctionInput;
      expect(() => writeSanction(b.store, b.subjects, bad, NOW, false)).toThrow(RangeError);
      expect(() => validateSanctionInput(bad)).toThrow(RangeError);
      await expect(applySanction(b.store, b.subjects, bad, NOW)).rejects.toThrow(RangeError);
    }
    expect(b.store.rawSanctions()).toHaveLength(before);
  });

  it('the public facade refuses it too', async () => {
    const w = await world();
    const f = await w.file();
    await expect(w.cw.sanctions.apply({ kind: 'chat', subject: f.target, includeIp: false, durationMs: H, reason: 'r', actor: 'm', source: 'moderator', automated: false, rule: 1, startsAt: 1 } as never)).rejects.toThrow(RangeError);
    // even with an undefined value present as a key it is only refused when it has a value
    await expect(w.cw.sanctions.apply({ kind: 'chat', subject: f.target, includeIp: false, durationMs: H, reason: 'r', actor: 'm', source: 'moderator', automated: false, rule: 1, startsAt: undefined } as never)).resolves.toBeDefined();
  });

  it('a start in the future, or one that is not a finite number, is refused even with the token', () => {
    const b = bare();
    const s = b.person('k1');
    for (const bad of [NOW + 1, Number.NaN, Number.POSITIVE_INFINITY, '5', -1, 0.5]) {
      const input = { ...b.input(s), startsAt: bad, startsAtToken: APPEALS_START_TOKEN } as SanctionInput;
      expect(() => writeSanction(b.store, b.subjects, input, NOW, false), String(bad)).toThrow(SanctionError);
    }
    expect(b.store.rawSanctions()).toEqual([]);
  });

  it('a permanent sanction from a start stays permanent, and a warning ends where it starts', () => {
    const b = bare();
    const s = b.person('k1');
    const start = NOW - 3 * DAY;
    const perm = writeSanction(b.store, b.subjects, { ...b.input(s, { durationMs: null }), startsAt: start, startsAtToken: APPEALS_START_TOKEN } as SanctionInput, NOW, false);
    expect(perm.rows[0]).toMatchObject({ startsAt: start, endsAt: null });
    const warn = writeSanction(b.store, b.subjects, { ...b.input(s, { kind: 'warning', durationMs: null }), startsAt: start, startsAtToken: APPEALS_START_TOKEN } as SanctionInput, NOW, false);
    expect(warn.rows[0]).toMatchObject({ startsAt: start, endsAt: start });
  });

  it("a replacement's ladder step is computed from startsAt: the history read finds it by its original start", () => {
    const b = bare();
    const s = b.person('k1');
    const start = NOW - 6 * DAY;
    b.store.transaction(() => writeSanction(b.store, b.subjects, { ...b.input(s, { kind: 'warning', durationMs: null }), startsAt: start, startsAtToken: APPEALS_START_TOKEN } as SanctionInput, NOW, false));
    // inside a window that reaches back past the original start, outside one that starts after it
    expect(b.store.loadSubjectActions(NOW - 7 * DAY).filter((r) => r.kind === 'warning')).toHaveLength(1);
    expect(b.store.loadSubjectActions(NOW - 5 * DAY)).toHaveLength(0);
    // and a sanction written at NOW with no startsAt is a new one, inside both
    writeSanction(b.store, b.subjects, b.input(s, { kind: 'warning', durationMs: null }), NOW, false);
    expect(b.store.loadSubjectActions(NOW - 5 * DAY)).toHaveLength(1);
  });

  it('without startsAt every existing behaviour holds: the row starts now', () => {
    const b = bare();
    const written = writeSanction(b.store, b.subjects, b.input(b.person('k1')), NOW, false);
    expect(written.rows[0]).toMatchObject({ startsAt: NOW, endsAt: NOW + 6 * H });
  });
});

describe('the moot hook in revoke', () => {
  it('revoking a group closes its open appeal as moot in the same transaction', async () => {
    const b = bare();
    const written = writeSanction(b.store, b.subjects, b.input(b.person('k1')), NOW, false);
    b.store.insertAppeal(appealFor(written.groupId));
    expect(await revokeSanction(b.store, written.groupId, 'mod_cy', NOW + 5, 'lifted')).toBe(true);
    expect(b.store.loadAppeal(`ap-${written.groupId}`)).toMatchObject({ status: 'moot', decidedBy: 'mod_cy', decidedAt: NOW + 5, decisionReason: null });
    expect(b.store.countOpenAppeals()).toBe(0);
  });

  it('cw.sanctions.revoke (revoke and withdraw) closes it too, and withdraws the notice as before', async () => {
    const store = withMemoryAppeals(new MemoryStore());
    const w = await world({}, store);
    const f = await w.file();
    const res = await w.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'mod@example.test', reason: 'p', actions: [{ subject: f.target, kind: 'chat', durationMs: H, rule: 2, lineIds: [] }] });
    if (!res.ok) throw new Error('expected a decision');
    const group = res.groups[0]?.groupId as string;
    store.insertAppeal(appealFor(group));
    expect(await w.cw.sanctions.revoke(group, 'mod_cy', 'lifted')).toBe(true);
    expect(store.loadAppeal(`ap-${group}`)?.status).toBe('moot');
    const notices = store.rawNotices().filter((n) => n.groupId === group);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((n) => n.withdrawnAt !== null)).toBe(true);
  });

  it('a failed revoke leaves it open and the sanction live', async () => {
    const b = bare();
    const written = writeSanction(b.store, b.subjects, b.input(b.person('k1')), NOW, false);
    b.store.insertAppeal(appealFor(written.groupId));
    const real = b.store.closeAppealsForGroup.bind(b.store);
    b.store.closeAppealsForGroup = (g: string, by: string, at: number) => {
      real(g, by, at);
      throw new Error('disk full');
    };
    await expect(revokeSanction(b.store, written.groupId, 'mod_cy', NOW + 5, 'lifted')).rejects.toThrow('disk full');
    expect(b.store.loadAppeal(`ap-${written.groupId}`)?.status).toBe('open');
    expect(b.store.loadSanctions(NOW).some((r) => r.groupId === written.groupId)).toBe(true);
  });

  it('a failed revoke-and-withdraw leaves the appeal open', async () => {
    const store = withMemoryAppeals(new MemoryStore());
    const w = await world({}, store);
    const f = await w.file();
    const res = await w.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'mod@example.test', reason: 'p', actions: [{ subject: f.target, kind: 'chat', durationMs: H, rule: 2, lineIds: [] }] });
    if (!res.ok) throw new Error('expected a decision');
    const group = res.groups[0]?.groupId as string;
    store.insertAppeal(appealFor(group));
    store.withdrawNoticeGroup = () => {
      throw new Error('boom');
    };
    await expect(w.cw.sanctions.revoke(group, 'mod_cy', 'lifted')).rejects.toThrow('boom');
    expect(store.loadAppeal(`ap-${group}`)?.status).toBe('open');
    expect(store.loadSanctions(NOW).some((r) => r.groupId === group)).toBe(true);
  });

  it('with appealStatementsMs 0 the moot clears the statement at once, like a decision; otherwise the text stays for retention', async () => {
    const b = bare();
    const w1 = writeSanction(b.store, b.subjects, b.input(b.person('k1')), NOW, false);
    const w2 = writeSanction(b.store, b.subjects, b.input(b.person('k2')), NOW, false);
    b.store.insertAppeal(appealFor(w1.groupId));
    b.store.insertAppeal(appealFor(w2.groupId));
    await revokeSanction(b.store, w1.groupId, 'mod_cy', NOW + 5, 'lifted', undefined, { clearStatement: true });
    await revokeSanction(b.store, w2.groupId, 'mod_cy', NOW + 5, 'lifted');
    expect(b.store.loadAppeal(`ap-${w1.groupId}`)).toMatchObject({ status: 'moot', statement: null });
    expect(b.store.loadAppeal(`ap-${w2.groupId}`)).toMatchObject({ status: 'moot', statement: 'st' });
  });

  it('cw.sanctions.revoke follows the kit\'s retention: appealStatementsMs 0 clears the statement as it moots', async () => {
    for (const [policy, expected] of [[{ appealStatementsMs: 0 }, null], [{}, 'st']] as const) {
      const store = withMemoryAppeals(new MemoryStore());
      const w = await world({ retention: policy }, store);
      const f = await w.file();
      const res = await w.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'mod@example.test', reason: 'p', actions: [{ subject: f.target, kind: 'chat', durationMs: H, rule: 2, lineIds: [] }] });
      if (!res.ok) throw new Error('expected a decision');
      const group = res.groups[0]?.groupId as string;
      store.insertAppeal(appealFor(group));
      await w.cw.sanctions.revoke(group, 'mod_cy', 'lifted');
      expect(store.loadAppeal(`ap-${group}`)).toMatchObject({ status: 'moot', statement: expected });
      await w.cw.close?.();
    }
  });

  it('an already decided appeal is untouched', async () => {
    const b = bare();
    const written = writeSanction(b.store, b.subjects, b.input(b.person('k1')), NOW, false);
    b.store.insertAppeal(appealFor(written.groupId));
    b.store.decideAppeal(`ap-${written.groupId}`, { status: 'upheld', at: NOW + 1, by: 'bea', reason: 'stands', replacementGroupId: null });
    const before = b.store.loadAppeal(`ap-${written.groupId}`);
    await revokeSanction(b.store, written.groupId, 'mod_cy', NOW + 5, 'lifted');
    expect(b.store.loadAppeal(`ap-${written.groupId}`)).toEqual(before);
  });

  it('no appeal means no extra write; a second revoke and an unknown group do not call the hook', async () => {
    const b = bare();
    const written = writeSanction(b.store, b.subjects, b.input(b.person('k1')), NOW, false);
    const calls: string[] = [];
    const real = b.store.closeAppealsForGroup.bind(b.store);
    b.store.closeAppealsForGroup = (g: string, by: string, at: number) => {
      calls.push(g);
      return real(g, by, at);
    };
    const token = b.store.changeToken();
    expect(await revokeSanction(b.store, written.groupId, 'mod_cy', NOW + 5, 'lifted')).toBe(true);
    expect(calls).toEqual([written.groupId]);
    expect(b.store.listAppeals({ limit: 10 })).toEqual([]);
    // the revoke itself moved the token once; the hook found nothing and moved nothing more
    const after = b.store.changeToken();
    expect(after).not.toBe(token);
    expect(await revokeSanction(b.store, written.groupId, 'mod_cy', NOW + 6, 'again')).toBe(false);
    expect(await revokeSanction(b.store, 'no-such-group', 'mod_cy', NOW + 6, 'x')).toBe(false);
    expect(calls).toEqual([written.groupId]);
    expect(b.store.changeToken()).toBe(after);
  });

  it('a store without the appeal methods revokes as before', async () => {
    const store = new MemoryStore();
    const clock = { now: () => NOW };
    const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
    const s = subjects.resolve({ clientKey: 'k1', accountId: null, ipHash: null }) as SubjectId;
    const written = writeSanction(store, subjects, { kind: 'chat', subject: s, includeIp: false, durationMs: H, reason: 'r', actor: 'm', source: 'moderator', automated: false, rule: 1 }, NOW, false);
    expect((store as unknown as Record<string, unknown>).closeAppealsForGroup).toBeUndefined();
    expect(await revokeSanction(store, written.groupId, 'mod_cy', NOW + 5, 'lifted')).toBe(true);
  });
});
