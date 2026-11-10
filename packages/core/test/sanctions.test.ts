import { describe, expect, it } from 'vitest';
import {
  applySanction,
  refCode,
  revokeSanction,
  SANCTION_KINDS,
  SanctionError,
  SanctionIndex,
  MAX_SANCTION_DURATION_MS,
  validateSanctionInput,
  type SanctionInput,
} from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Identifiers, SanctionKind, SanctionRow, SubjectId } from '../src/types.js';
import { MemoryStore } from './memoryStore.js';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const REF_RE = /^M-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

function who(clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers {
  return { clientKey, accountId, ipHash };
}
const none = who(null);

function setup(opts: { enabled?: () => boolean; store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const index = new SanctionIndex({ enabled: opts.enabled ?? (() => true), subjects });
  return { store, clock, subjects, index };
}

function subjectOf(subjects: SubjectIndex, ids: Identifiers): SubjectId {
  const s = subjects.resolve(ids);
  if (s === null) throw new Error('expected a subject');
  return s;
}

function input(subject: SubjectId, over: Partial<SanctionInput> = {}): SanctionInput {
  return {
    kind: 'chat',
    subject,
    includeIp: false,
    durationMs: H,
    reason: 'slurs',
    actor: 'mod@x.com',
    source: 'moderator',
    automated: false,
    rule: 1,
    ...over,
  };
}

/** The same input with no rule at all (so the rule defaults to uncovered). */
function bare(subject: SubjectId, over: Partial<SanctionInput> = {}): SanctionInput {
  const base = input(subject);
  delete base.rule;
  return { ...base, ...over };
}

/** Standard fixture: one person, one key, one account, one IP. */
async function person() {
  const env = setup();
  const s1 = subjectOf(env.subjects, who('k1', 'a1', 'ip1'));
  return { ...env, s1 };
}

const rows = (store: MemoryStore) => store.rawSanctions();

describe('refCode', () => {
  it('is M- plus 5 characters of the unambiguous alphabet', () => {
    for (let i = 0; i < 2_000; i++) expect(refCode()).toMatch(REF_RE);
  });

  it('never uses the look-alike characters I, L, O, 0 or 1', () => {
    for (let i = 0; i < 2_000; i++) expect(refCode().slice(2)).not.toMatch(/[ILO01]/);
  });

  it('draws vary', () => {
    expect(new Set(Array.from({ length: 50 }, () => refCode())).size).toBeGreaterThan(40);
  });
});

describe('applySanction: rows', () => {
  it('writes ONE subject row without includeIp and returns a group id and a ref code', async () => {
    const { store, subjects, s1 } = await person();
    const res = await applySanction(store, subjects, input(s1), NOW);
    expect(res.groupId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.refCode).toMatch(REF_RE);
    const r = rows(store);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ targetType: 'subject', value: s1, groupId: res.groupId, refCode: res.refCode });
  });

  it('writes the metadata on every row', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(
      store,
      subjects,
      input(s1, { kind: 'area', includeIp: true, durationMs: 2 * H, reason: 'harassment', actor: 'auto', source: 'auto_filter', automated: true, rule: 4 }),
      NOW,
    );
    const r = rows(store);
    expect(r).toHaveLength(2);
    for (const row of r) {
      expect(row).toMatchObject({
        kind: 'area',
        startsAt: NOW,
        endsAt: NOW + 2 * H,
        reason: 'harassment',
        actor: 'auto',
        source: 'auto_filter',
        automated: true,
        rule: '4',
        pending: false,
        revokedBy: null,
        revokedAt: null,
      });
    }
  });

  it('stores the rule as text and automated false for a moderator', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1), NOW);
    expect(rows(store)[0]).toMatchObject({ rule: '1', automated: false, source: 'moderator' });
  });

  it('gives each row a distinct id and each call a distinct group id and ref code', async () => {
    const { store, subjects, s1 } = await person();
    const a = await applySanction(store, subjects, input(s1, { includeIp: true }), NOW);
    const b = await applySanction(store, subjects, input(s1, { includeIp: true }), NOW);
    expect(a.groupId).not.toBe(b.groupId);
    expect(a.refCode).not.toBe(b.refCode);
    const ids = rows(store).map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('every row of a group carries the same ref code', async () => {
    const { store, subjects, s1 } = await person();
    const res = await applySanction(store, subjects, input(s1, { includeIp: true }), NOW);
    expect(rows(store).map((r) => r.refCode)).toEqual([res.refCode, res.refCode]);
  });

  it('stores the CANONICAL subject when handed a subject that was merged away', async () => {
    const { store, subjects, clock, s1 } = await person();
    clock.t = NOW + 1_000; // s2 is younger, so s1 survives the merge
    const s2 = subjectOf(subjects, who('k2'));
    subjectOf(subjects, who('k2', 'a1')); // links k2 and a1: s1 and s2 merge
    expect(subjects.canonical(s2)).toBe(s1);
    await applySanction(store, subjects, input(s2), clock.t);
    expect(rows(store)[0]?.value).toBe(s1);
  });

  it('rejects a NaN, zero, negative or infinite duration and writes nothing', async () => {
    const { store, subjects, index, s1 } = await person();
    for (const durationMs of [Number.NaN, 0, -1, -H, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(applySanction(store, subjects, input(s1, { durationMs }), NOW, index), String(durationMs)).rejects.toThrow(/duration/i);
    }
    expect(rows(store)).toEqual([]);
    expect(index.active('chat', none, s1, NOW)).toBeNull();
  });

  it('accepts null (permanent) and a 1 ms duration', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { durationMs: null }), NOW);
    await applySanction(store, subjects, input(s1, { durationMs: 1 }), NOW);
    expect(rows(store)).toHaveLength(2);
  });

  it('rejects an unknown kind or source and writes nothing', async () => {
    const { store, subjects, s1 } = await person();
    await expect(applySanction(store, subjects, input(s1, { kind: 'nope' as SanctionKind }), NOW)).rejects.toThrow(/kind/i);
    await expect(applySanction(store, subjects, input(s1, { source: 'nope' as never }), NOW)).rejects.toThrow(/source/i);
    expect(rows(store)).toEqual([]);
  });

  it('a failed apply does not poison the next one', async () => {
    const { store, subjects, s1 } = await person();
    await expect(applySanction(store, subjects, input(s1, { durationMs: 0 }), NOW)).rejects.toThrow();
    await applySanction(store, subjects, input(s1), NOW);
    expect(rows(store)).toHaveLength(1);
  });
});

describe('applySanction: the IP row', () => {
  it('includeIp writes ONE IP row: the most recently seen IP, not every IP', async () => {
    const { store, subjects, clock } = setup();
    const s = subjectOf(subjects, who('k1', null, 'ip-old'));
    clock.t = NOW + 10 * 60_000;
    subjectOf(subjects, who('k1', null, 'ip-new'));
    await applySanction(store, subjects, input(s, { includeIp: true }), clock.t);
    const ipRows = rows(store).filter((r) => r.targetType === 'ip');
    expect(ipRows.map((r) => r.value)).toEqual(['ip-new']);
  });

  it('writes no IP row when no IP was ever seen (the subject row is still written)', async () => {
    const { store, subjects } = setup();
    const s = subjectOf(subjects, who('k1'));
    await applySanction(store, subjects, input(s, { includeIp: true }), NOW);
    expect(rows(store).map((r) => r.targetType)).toEqual(['subject']);
  });

  it('caps the IP row at 24 h for a 30-day ban, leaving the subject row at 30 days', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { kind: 'ban', includeIp: true, durationMs: 30 * DAY }), NOW);
    const r = rows(store);
    expect(r.find((x) => x.targetType === 'ip')?.endsAt).toBe(NOW + DAY);
    expect(r.find((x) => x.targetType === 'subject')?.endsAt).toBe(NOW + 30 * DAY);
  });

  it('does not stretch the IP row when the sanction is shorter than 24 h', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { includeIp: true, durationMs: 2 * H }), NOW);
    expect(rows(store).find((x) => x.targetType === 'ip')?.endsAt).toBe(NOW + 2 * H);
  });

  it('treats exactly 24 h as unchanged', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { includeIp: true, durationMs: DAY }), NOW);
    expect(rows(store).find((x) => x.targetType === 'ip')?.endsAt).toBe(NOW + DAY);
  });

  it('IP row capped at 24 h even for permanent, while the subject row stays permanent', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { kind: 'ban', includeIp: true, durationMs: null }), NOW);
    const r = rows(store);
    expect(r.find((x) => x.targetType === 'ip')?.endsAt).toBe(NOW + DAY);
    expect(r.find((x) => x.targetType === 'subject')?.endsAt).toBeNull();
  });

  it('the IP is found across merged subjects (latest IP of the merged person)', async () => {
    const { store, subjects, clock } = setup();
    const a = subjectOf(subjects, who('k1', null, 'ip-a'));
    clock.t = NOW + 5 * 60_000;
    subjectOf(subjects, who('k2', null, 'ip-b'));
    clock.t = NOW + 10 * 60_000;
    const merged = subjectOf(subjects, who('k2', 'acct')); // key k2 alone so far
    subjectOf(subjects, who('k1', 'acct')); // links the two subjects
    const root = subjects.canonical(a);
    expect(subjects.canonical(merged)).toBe(root);
    await applySanction(store, subjects, input(root, { includeIp: true }), clock.t);
    expect(rows(store).filter((r) => r.targetType === 'ip').map((r) => r.value)).toEqual(['ip-b']);
  });
});

describe('applySanction: synchronous effect and failures', () => {
  it('the write and the index update have happened by the time the promise exists', async () => {
    const { store, subjects, index, s1 } = await person();
    const p = applySanction(store, subjects, input(s1, { durationMs: 30 * 60_000, automated: true }), NOW, index);
    // No await yet: the chat path must already see the timeout.
    expect(rows(store)).toHaveLength(1);
    expect(index.active('chat', none, s1, NOW)).toMatchObject({ until: NOW + 30 * 60_000, automated: true });
    await p;
  });

  it('revoke is also synchronous', async () => {
    const { store, subjects, index, s1 } = await person();
    const { groupId } = await applySanction(store, subjects, input(s1), NOW, index);
    const p = revokeSanction(store, groupId, 'boss', NOW + 1, 'mistake', index);
    expect(index.active('chat', none, s1, NOW + 1)).toBeNull();
    expect(rows(store)[0]?.revokedAt).toBe(NOW + 1);
    await p;
  });

  it('a write failure rejects and leaves the store and the index untouched', async () => {
    const store = new MemoryStore();
    store.insertSanctionGroup = () => {
      throw new Error('disk full');
    };
    const { subjects, index } = setup({ store });
    const subject = subjectOf(subjects, who('k1', 'a1', 'ip1'));
    await expect(applySanction(store, subjects, input(subject, { includeIp: true }), NOW, index)).rejects.toThrow('disk full');
    expect(rows(store)).toEqual([]);
    expect(index.active('chat', who(null, null, 'ip1'), subject, NOW)).toBeNull();
  });

  it('a revoke failure rejects and leaves the index untouched', async () => {
    const { store, subjects, index, s1 } = await person();
    const { groupId } = await applySanction(store, subjects, input(s1), NOW, index);
    store.revokeSanctionGroup = () => {
      throw new Error('locked');
    };
    await expect(revokeSanction(store, groupId, 'boss', NOW + 1, 'r', index)).rejects.toThrow('locked');
    expect(index.active('chat', none, s1, NOW + 1)).not.toBeNull();
  });

  it('with no index given the store is written and nothing else is needed', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1), NOW);
    const fresh = new SanctionIndex({ enabled: () => true, subjects });
    await fresh.load(store, NOW);
    expect(fresh.active('chat', none, s1, NOW)).not.toBeNull();
  });
});

describe('applySanction: ref codes', () => {
  it('retries on a collision with a new code, up to 5 attempts', async () => {
    const { store, subjects, s1 } = await person();
    const real = store.insertSanctionGroup.bind(store);
    const seen: string[] = [];
    let calls = 0;
    store.insertSanctionGroup = (r) => {
      calls++;
      seen.push(r[0]?.refCode ?? '');
      return calls <= 4 ? false : real(r);
    };
    const res = await applySanction(store, subjects, input(s1), NOW);
    expect(calls).toBe(5);
    expect(res.refCode).toBe(seen[4]);
    expect(new Set(seen).size).toBeGreaterThan(1);
    expect(rows(store)).toHaveLength(1);
  });

  it('throws after 5 collisions and writes nothing', async () => {
    const { store, subjects, index, s1 } = await person();
    let calls = 0;
    store.insertSanctionGroup = () => {
      calls++;
      return false;
    };
    await expect(applySanction(store, subjects, input(s1), NOW, index)).rejects.toThrow(/ref/i);
    expect(calls).toBe(5);
    expect(rows(store)).toEqual([]);
    expect(index.active('chat', none, s1, NOW)).toBeNull();
  });

  it('the group keeps ONE ref code on every row even after a retry', async () => {
    const { store, subjects, s1 } = await person();
    const real = store.insertSanctionGroup.bind(store);
    let calls = 0;
    store.insertSanctionGroup = (r) => (++calls === 1 ? false : real(r));
    const res = await applySanction(store, subjects, input(s1, { includeIp: true }), NOW);
    expect(rows(store).map((r) => r.refCode)).toEqual([res.refCode, res.refCode]);
  });

  it('refCode format and uniqueness over 10 000 draws', async () => {
    const { store, subjects, s1 } = await person();
    const codes = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const res = await applySanction(store, subjects, input(s1, { durationMs: 1 }), NOW);
      expect(res.refCode).toMatch(REF_RE);
      codes.add(res.refCode);
    }
    expect(codes.size).toBe(10_000);
  });
});

describe('SanctionIndex.active', () => {
  it('returns null when nothing is loaded', () => {
    const { index } = setup();
    expect(index.active('chat', none, 's_x', NOW)).toBeNull();
  });

  it('matches by subject and, for an IP row, by ipHash; returns exactly until, automated, groupId, refCode, rule', async () => {
    const { store, subjects, index, s1 } = await person();
    const res = await applySanction(store, subjects, input(s1, { includeIp: true, automated: true }), NOW, index);
    const want = { until: NOW + H, automated: true, groupId: res.groupId, refCode: res.refCode, rule: '1', own: true };
    expect(index.active('chat', none, s1, NOW)).toEqual(want);
    // The same row reached through the shared address alone is a bystander's match: not their own.
    expect(index.active('chat', who(null, null, 'ip1'), null, NOW)).toEqual({ ...want, own: false });
  });

  it('never returns the reason, actor or any identifier (the rule is only its stored number)', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { includeIp: true, rule: 3, reason: 'private note' }), NOW, index);
    const result = index.active('chat', who('k1', 'a1', 'ip1'), s1, NOW);
    expect(result).not.toBeNull();
    // Exactly these keys: nothing else can carry an identifier, reason or actor. The rule is its stored text.
    expect(Object.keys(result ?? {}).sort()).toEqual(['automated', 'groupId', 'own', 'refCode', 'rule', 'until']);
    // The groupId is random, so blank it before the substring scan (it could contain 'k1' by chance).
    const out = JSON.stringify({ ...result, groupId: '' });
    for (const secret of ['private note', '3.1', 'mod@x.com', s1, 'ip1', 'k1', 'a1']) expect(out).not.toContain(secret);
  });

  it('matches by subject across browsers: a new key signed into the sanctioned account', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1), NOW, index);
    const newBrowser = subjectOf(subjects, who('k-new', 'a1'));
    expect(newBrowser).toBe(s1);
    expect(index.active('chat', who('k-new', 'a1'), newBrowser, NOW)).not.toBeNull();
  });

  it('sanction follows a merged subject (sanction the survivor, merge another in)', async () => {
    const { store, subjects, index } = setup();
    const s1 = subjectOf(subjects, who('k1'));
    const s2 = subjectOf(subjects, who('k2'));
    expect(s2).not.toBe(s1);
    await applySanction(store, subjects, input(s1), NOW, index);
    expect(index.active('chat', who('k2'), s2, NOW)).toBeNull(); // not yet linked
    const merged = subjectOf(subjects, who('k2', 'acct'));
    subjectOf(subjects, who('k1', 'acct'));
    const root = subjects.canonical(s2);
    expect(root).toBe(subjects.canonical(s1));
    expect(index.active('chat', who('k2', 'acct'), subjects.canonical(merged), NOW)).not.toBeNull();
    expect(index.active('chat', who('k1', 'acct'), subjects.canonical(s1), NOW)).not.toBeNull();
  });

  it('sanction follows a merge in the other direction (sanction the one that gets merged away)', async () => {
    const { store, subjects, index, clock } = setup();
    const older = subjectOf(subjects, who('k-old'));
    clock.t = NOW + 1_000;
    const younger = subjectOf(subjects, who('k-young'));
    await applySanction(store, subjects, input(younger), clock.t, index);
    expect(index.active('chat', who('k-old'), older, clock.t)).toBeNull();
    subjectOf(subjects, who('k-young', 'acct'));
    const survivor = subjectOf(subjects, who('k-old', 'acct'));
    expect(survivor).toBe(older);
    expect(subjects.canonical(younger)).toBe(older);
    expect(index.active('chat', who('k-old', 'acct'), survivor, clock.t)).not.toBeNull();
  });

  it('a boot-time load also follows merges recorded in the store', async () => {
    const { store, subjects, index, clock } = setup();
    const older = subjectOf(subjects, who('k-old'));
    clock.t = NOW + 1_000;
    const younger = subjectOf(subjects, who('k-young'));
    await applySanction(store, subjects, input(younger), clock.t, index);
    subjectOf(subjects, who('k-young', 'acct'));
    subjectOf(subjects, who('k-old', 'acct'));
    await subjects.flush();
    const subjects2 = new SubjectIndex(store, clock, { logger: { warn() {} } });
    await subjects2.load();
    const index2 = new SanctionIndex({ enabled: () => true, subjects: subjects2 });
    await index2.load(store, clock.t);
    expect(index2.active('chat', who('k-old'), subjects2.canonical(older), clock.t)).not.toBeNull();
  });

  it('household IP: a sanction without includeIp never refuses a different subject on the same IP', async () => {
    const { store, subjects, index } = setup();
    const a = subjectOf(subjects, who('ka', null, 'home'));
    const b = subjectOf(subjects, who('kb', null, 'home'));
    expect(b).not.toBe(a);
    await applySanction(store, subjects, input(a, { kind: 'ban', durationMs: null }), NOW, index);
    expect(index.active('ban', who('kb', null, 'home'), b, NOW)).toBeNull();
    expect(index.active('ban', who(null, null, 'home'), null, NOW)).toBeNull();
    expect(index.active('ban', who('ka', null, 'home'), a, NOW)).not.toBeNull();
  });

  it('with includeIp the IP row is a 24 h speed bump on the shared address, then frees it', async () => {
    const { store, subjects, index } = setup();
    const a = subjectOf(subjects, who('ka', null, 'home'));
    const b = subjectOf(subjects, who('kb', null, 'home'));
    await applySanction(store, subjects, input(a, { kind: 'ban', includeIp: true, durationMs: null }), NOW, index);
    expect(index.active('ban', who('kb', null, 'home'), b, NOW + DAY - 1)).not.toBeNull();
    expect(index.active('ban', who('kb', null, 'home'), b, NOW + DAY)).toBeNull();
    expect(index.active('ban', who('ka', null, 'home'), a, NOW + DAY)).toMatchObject({ until: null });
  });

  it('does not match an unrelated identity', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { includeIp: true }), NOW, index);
    const other = subjectOf(subjects, who('kx', 'ax', 'ipx'));
    expect(index.active('chat', who('kx', 'ax', 'ipx'), other, NOW)).toBeNull();
  });

  it('does not match a null subject with no IP', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1), NOW, index);
    expect(index.active('chat', none, null, NOW)).toBeNull();
  });

  it('only matches the asked kind', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { kind: 'chat' }), NOW, index);
    expect(index.active('area', none, s1, NOW)).toBeNull();
    expect(index.active('ban', none, s1, NOW)).toBeNull();
    expect(index.active('chat', none, s1, NOW)).not.toBeNull();
  });

  it('keeps the value spaces apart: an IP row never matches as a subject, and vice versa', async () => {
    const { store, index, s1 } = await person();
    // An IP row whose value equals a subject id, and a subject row whose value equals an IP hash.
    store.insertSanctionGroup([
      sanctionRow({ id: 'r1', groupId: 'g1', refCode: 'M-AAAAA', targetType: 'ip', value: s1 }),
      sanctionRow({ id: 'r2', groupId: 'g2', refCode: 'M-BBBBB', targetType: 'subject', value: 'ipX', kind: 'ban' }),
    ]);
    await index.load(store, NOW);
    expect(index.active('chat', none, s1, NOW)).toBeNull();
    expect(index.active('ban', who(null, null, 'ipX'), null, NOW)).toBeNull();
    expect(index.active('chat', who(null, null, s1), null, NOW)).not.toBeNull();
    expect(index.active('ban', none, 'ipX', NOW)).not.toBeNull();
  });

  it('a permanent sanction beats a 1-hour one and reports until null', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { durationMs: H }), NOW, index);
    const perm = await applySanction(store, subjects, input(s1, { durationMs: null }), NOW, index);
    expect(index.active('chat', none, s1, NOW)).toEqual({ until: null, automated: false, groupId: perm.groupId, refCode: perm.refCode, rule: '1', own: true });
  });

  it('a permanent sanction beats a longer timed one regardless of insertion order', async () => {
    const { store, subjects, index, s1 } = await person();
    const perm = await applySanction(store, subjects, input(s1, { durationMs: null }), NOW, index);
    await applySanction(store, subjects, input(s1, { durationMs: 30 * DAY }), NOW, index);
    expect(index.active('chat', none, s1, NOW)?.groupId).toBe(perm.groupId);
  });

  it('among timed sanctions the latest end wins, whichever row it matched through', async () => {
    const { store, subjects, index, clock } = setup();
    const a = subjectOf(subjects, who('ka', null, 'ipa'));
    const b = subjectOf(subjects, who('kb', null, 'ipa'));
    await applySanction(store, subjects, input(a, { durationMs: H }), NOW, index);
    const long = await applySanction(store, subjects, input(b, { durationMs: 5 * H }), clock.t, index);
    await applySanction(store, subjects, input(a, { includeIp: true, durationMs: 2 * H }), NOW, index);
    const r = index.active('chat', who('ka', null, 'ipa'), a, NOW);
    expect(r?.until).toBe(NOW + 2 * H);
    expect(index.active('chat', who('kb', null, 'ipa'), b, NOW)?.groupId).toBe(long.groupId);
  });

  it('is inactive once revoked; a revoked permanent does not shadow a live timed one', async () => {
    const { store, subjects, index, s1 } = await person();
    const perm = await applySanction(store, subjects, input(s1, { durationMs: null }), NOW, index);
    const timed = await applySanction(store, subjects, input(s1, { durationMs: H }), NOW, index);
    await revokeSanction(store, perm.groupId, 'boss', NOW + 1, 'wrong person', index);
    expect(index.active('chat', none, s1, NOW + 2)?.groupId).toBe(timed.groupId);
    await revokeSanction(store, timed.groupId, 'boss', NOW + 3, 'wrong person', index);
    expect(index.active('chat', none, s1, NOW + 4)).toBeNull();
  });

  it('ends exactly now is inactive; one ms earlier is still active', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { includeIp: true, durationMs: H }), NOW, index);
    expect(index.active('chat', who(null, null, 'ip1'), s1, NOW + H - 1)).not.toBeNull();
    expect(index.active('chat', who(null, null, 'ip1'), s1, NOW + H)).toBeNull();
    expect(index.active('chat', none, s1, NOW + 2 * H)).toBeNull();
  });

  it('does not load rows that expired before load', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { durationMs: H }), NOW);
    await index.load(store, NOW + 2 * H);
    expect(index.active('chat', none, s1, NOW)).toBeNull();
  });

  it('is inactive before starts_at and active from it', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { durationMs: H }), NOW + 10 * H, index);
    expect(index.active('chat', none, s1, NOW)).toBeNull();
    expect(index.active('chat', none, s1, NOW + 10 * H)).not.toBeNull();
  });

  it('a permanent sanction stays active indefinitely', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { kind: 'ban', durationMs: null }), NOW, index);
    expect(index.active('ban', none, s1, NOW + 3650 * DAY)).toMatchObject({ until: null });
  });

  it('does not see writes made without the index until load is called, and load replaces the set wholesale', async () => {
    const { store, subjects, index, s1 } = await person();
    await index.load(store, NOW);
    const { groupId } = await applySanction(store, subjects, input(s1), NOW);
    expect(index.active('chat', none, s1, NOW)).toBeNull();
    await index.load(store, NOW);
    expect(index.active('chat', none, s1, NOW)).not.toBeNull();
    await revokeSanction(store, groupId, 'boss', NOW + 1, 'r');
    await index.load(store, NOW + 1);
    expect(index.active('chat', none, s1, NOW + 1)).toBeNull();
  });

  it('many short expired sanctions do not disturb a live one', async () => {
    const { store, subjects, index, s1 } = await person();
    for (let i = 0; i < 300; i++) await applySanction(store, subjects, input(s1, { durationMs: 1 }), NOW + i, index);
    const live = await applySanction(store, subjects, input(s1, { durationMs: H }), NOW + 1_000, index);
    expect(index.active('chat', none, s1, NOW + 1_000)?.groupId).toBe(live.groupId);
  });
});

describe('SanctionIndex enabled option', () => {
  it('returns null when disabled, even with a matching sanction', async () => {
    const env = setup({ enabled: () => false });
    const s = subjectOf(env.subjects, who('k1', 'a1', 'ip1'));
    await applySanction(env.store, env.subjects, input(s, { kind: 'ban', durationMs: null, includeIp: true }), NOW, env.index);
    expect(env.index.active('ban', who(null, null, 'ip1'), s, NOW)).toBeNull();
  });

  it('returns null without throwing when disabled and nothing is loaded', () => {
    const env = setup({ enabled: () => false });
    expect(env.index.active('chat', none, 's_x', NOW)).toBeNull();
  });

  it('reads the flag on every call, so flipping it takes effect live', async () => {
    let on = true;
    const env = setup({ enabled: () => on });
    const s = subjectOf(env.subjects, who('k1'));
    await applySanction(env.store, env.subjects, input(s), NOW, env.index);
    expect(env.index.active('chat', none, s, NOW)).not.toBeNull();
    on = false;
    expect(env.index.active('chat', none, s, NOW)).toBeNull();
    on = true;
    expect(env.index.active('chat', none, s, NOW)).not.toBeNull();
  });

  it('pending recorded while disabled, becomes active when enabled', async () => {
    let on = false;
    const env = setup({ enabled: () => on });
    const s = subjectOf(env.subjects, who('k1', null, 'ip1'));
    await applySanction(env.store, env.subjects, input(s, { includeIp: true }), NOW, env.index);
    expect(rows(env.store).map((r) => r.pending)).toEqual([true, true]);
    expect(env.index.active('chat', none, s, NOW)).toBeNull();
    on = true;
    expect(env.index.active('chat', none, s, NOW)).not.toBeNull();
    // Informational: a boot-time load keeps the row and enforces it.
    await env.index.load(env.store, NOW);
    expect(env.index.active('chat', none, s, NOW)).not.toBeNull();
  });

  it('pending is false when the switch is on at write time', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1), NOW, index);
    expect(rows(store)[0]?.pending).toBe(false);
  });
});

function sanctionRow(over: Partial<SanctionRow>): SanctionRow {
  return {
    id: 'r',
    groupId: 'g',
    refCode: 'M-ZZZZZ',
    kind: 'chat',
    targetType: 'subject',
    value: 'v',
    startsAt: NOW,
    endsAt: NOW + H,
    reason: 'x',
    rule: null,
    gapNote: null,
    gapStatus: null,
    roomId: null,
    actor: 'a',
    source: 'moderator',
    automated: false,
    pending: false,
    ...over,
  };
}

describe('revokeSanction', () => {
  it('revokes every row of the group, and only that group', async () => {
    const { store, subjects, index, s1 } = await person();
    const g1 = await applySanction(store, subjects, input(s1, { includeIp: true }), NOW, index);
    const other = subjectOf(subjects, who('k9'));
    const g2 = await applySanction(store, subjects, input(other), NOW, index);
    expect(await revokeSanction(store, g1.groupId, 'boss', NOW + 5, 'appeal', index)).toBe(true);
    for (const r of rows(store).filter((x) => x.groupId === g1.groupId)) expect(r).toMatchObject({ revokedBy: 'boss', revokedAt: NOW + 5, revokeReason: 'appeal' });
    for (const r of rows(store).filter((x) => x.groupId === g2.groupId)) expect(r).toMatchObject({ revokedBy: null, revokedAt: null });
    expect(index.active('chat', who(null, null, 'ip1'), null, NOW + 6)).toBeNull();
    expect(index.active('chat', none, other, NOW + 6)).not.toBeNull();
  });

  it('the first revoke wins: a second keeps the first revoker, time and reason', async () => {
    const { store, subjects, s1 } = await person();
    const g = await applySanction(store, subjects, input(s1, { includeIp: true }), NOW);
    expect(await revokeSanction(store, g.groupId, 'first', NOW + 1, 'first reason')).toBe(true);
    expect(await revokeSanction(store, g.groupId, 'second', NOW + 2, 'second reason')).toBe(false);
    for (const r of rows(store)) expect(r).toMatchObject({ revokedBy: 'first', revokedAt: NOW + 1, revokeReason: 'first reason' });
  });

  it('is a no-op for an unknown group', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1), NOW, index);
    expect(await revokeSanction(store, 'nope', 'm', NOW, 'r', index)).toBe(false);
    expect(rows(store).every((r) => r.revokedAt === null)).toBe(true);
    expect(index.active('chat', none, s1, NOW)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// K2 Task 3: the Warning kind, the cited rule and the rule-gap note
// ---------------------------------------------------------------------------

const GAP = 'private gap note about an odd case';

describe('SANCTION_KINDS', () => {
  it('lists the warning and note kinds', () => {
    expect([...SANCTION_KINDS]).toEqual(['chat', 'area', 'ban', 'warning', 'note']);
  });
});

describe('applySanction: the warning kind', () => {
  it('writes one subject row with no end: ends = starts, no IP row', async () => {
    const { store, subjects, s1 } = await person();
    const res = await applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: null, rule: 2 }), NOW);
    expect(res.refCode).toMatch(REF_RE);
    const r = rows(store);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      kind: 'warning',
      targetType: 'subject',
      value: s1,
      startsAt: NOW,
      endsAt: NOW,
      rule: '2',
      groupId: res.groupId,
    });
  });

  it('refuses a duration (a warning has no end)', async () => {
    const { store, subjects, s1 } = await person();
    for (const d of [H, 1, 0, -5, Number.NaN]) {
      await expect(
        applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: d, rule: 1 }), NOW),
      ).rejects.toBeInstanceOf(SanctionError);
    }
    expect(rows(store)).toEqual([]);
  });

  it('refuses includeIp (a warning never reaches an IP)', async () => {
    const { store, subjects, s1 } = await person();
    await expect(
      applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: null, includeIp: true, rule: 1 }), NOW),
    ).rejects.toBeInstanceOf(SanctionError);
    expect(rows(store)).toEqual([]);
  });

  it('gets a unique ref code and can be revoked', async () => {
    const { store, subjects, s1 } = await person();
    const a = await applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: null, rule: 1 }), NOW);
    const b = await applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: null, rule: 1 }), NOW);
    expect(a.refCode).not.toBe(b.refCode);
    expect(await revokeSanction(store, a.groupId, 'boss', NOW + 1, 'mistake')).toBe(true);
    expect(rows(store).filter((x) => x.revokedAt !== null)).toHaveLength(1);
  });

  it('control: a permanent ban with an IP row is unchanged', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { kind: 'ban', durationMs: null, includeIp: true, rule: 1 }), NOW);
    expect(rows(store).map((r) => [r.targetType, r.endsAt !== null])).toEqual([
      ['subject', false],
      ['ip', true],
    ]);
  });
});

describe('a warning is never active', () => {
  it('active() returns null for every kind, through add() and through load()', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: null, rule: 1 }), NOW, index);
    const kinds: SanctionKind[] = ['chat', 'area', 'ban', 'warning', 'note'];
    for (const k of kinds) expect(index.active(k, who('k1', 'a1', 'ip1'), s1, NOW)).toBeNull();
    for (const k of kinds) expect(index.active(k, none, s1, NOW - 1)).toBeNull();
    // The store hands the row back for a load made before its (equal) start and end; the index must skip it.
    expect(store.loadSanctions(NOW - 1).map((r) => r.kind)).toEqual(['warning']);
    const fresh = new SanctionIndex({ enabled: () => true, subjects });
    await fresh.load(store, NOW - 1);
    for (const k of kinds) expect(fresh.active(k, none, s1, NOW - 1)).toBeNull();
    for (const k of kinds) expect(fresh.active(k, none, s1, NOW)).toBeNull();
  });

  it('does not disturb a real restriction of the same person', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: null, rule: 1 }), NOW, index);
    await applySanction(store, subjects, input(s1, { durationMs: 2 * H, rule: 1 }), NOW, index);
    expect(index.active('chat', none, s1, NOW + 1)).toMatchObject({ until: NOW + 2 * H });
    expect(index.active('warning', none, s1, NOW + 1)).toBeNull();
    await applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: null, rule: 1 }), NOW + 5, index);
    expect(index.active('chat', none, s1, NOW + 6)).toMatchObject({ until: NOW + 2 * H });
  });

  it('revoking a warning leaves the index alone', async () => {
    const { store, subjects, index, s1 } = await person();
    const w = await applySanction(store, subjects, input(s1, { kind: 'warning', durationMs: null, rule: 1 }), NOW, index);
    await applySanction(store, subjects, input(s1, { kind: 'ban', durationMs: null, rule: 1 }), NOW, index);
    await revokeSanction(store, w.groupId, 'boss', NOW + 1, 'x', index);
    expect(index.active('ban', none, s1, NOW + 2)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// K3a Task 2: the Note kind (stored like a warning: on the record, never punishing)
// ---------------------------------------------------------------------------

const noteInput = (subject: SubjectId, over: Partial<SanctionInput> = {}): SanctionInput =>
  input(subject, { kind: 'note', durationMs: null, rule: 2, ...over });

describe('applySanction: the note kind', () => {
  it('writes one subject row with no end: ends = starts, no IP row, the cited rule', async () => {
    const { store, subjects, s1 } = await person();
    const res = await applySanction(store, subjects, noteInput(s1), NOW);
    expect(res.refCode).toMatch(REF_RE);
    const r = rows(store);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      kind: 'note',
      targetType: 'subject',
      value: s1,
      startsAt: NOW,
      endsAt: NOW,
      rule: '2',
      groupId: res.groupId,
      roomId: null,
    });
  });

  it('refuses a duration (a note has no end)', async () => {
    const { store, subjects, s1 } = await person();
    for (const d of [H, 1, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(applySanction(store, subjects, noteInput(s1, { durationMs: d }), NOW)).rejects.toBeInstanceOf(SanctionError);
    }
    expect(rows(store)).toEqual([]);
  });

  it('refuses includeIp (a note never reaches an IP)', async () => {
    const { store, subjects, s1 } = await person();
    await expect(applySanction(store, subjects, noteInput(s1, { includeIp: true }), NOW)).rejects.toBeInstanceOf(SanctionError);
    expect(rows(store)).toEqual([]);
  });

  it('needs the gap note when no rule is cited, like a warning', async () => {
    const { store, subjects, s1 } = await person();
    await expect(applySanction(store, subjects, noteInput(s1, { rule: 'uncovered' }), NOW)).rejects.toBeInstanceOf(SanctionError);
    await applySanction(store, subjects, noteInput(s1, { rule: 'uncovered', gapNote: GAP }), NOW);
    expect(rows(store)[0]).toMatchObject({ kind: 'note', gapNote: GAP, gapStatus: 'open' });
  });

  it('gets a unique ref code and can be revoked', async () => {
    const { store, subjects, s1 } = await person();
    const a = await applySanction(store, subjects, noteInput(s1), NOW);
    const b = await applySanction(store, subjects, noteInput(s1), NOW);
    expect(a.refCode).not.toBe(b.refCode);
    expect(await revokeSanction(store, a.groupId, 'boss', NOW + 1, 'mistake')).toBe(true);
    expect(rows(store).filter((x) => x.revokedAt !== null)).toHaveLength(1);
  });
});

describe('a note is never active', () => {
  it('active() returns null for every kind, through add() and through load()', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, noteInput(s1), NOW, index);
    for (const k of SANCTION_KINDS) expect(index.active(k, who('k1', 'a1', 'ip1'), s1, NOW)).toBeNull();
    for (const k of SANCTION_KINDS) expect(index.active(k, none, s1, NOW - 1)).toBeNull();
    expect(store.loadSanctions(NOW - 1).map((r) => r.kind)).toEqual(['note']);
    const fresh = new SanctionIndex({ enabled: () => true, subjects });
    await fresh.load(store, NOW - 1);
    for (const k of SANCTION_KINDS) expect(fresh.active(k, none, s1, NOW - 1)).toBeNull();
    for (const k of SANCTION_KINDS) expect(fresh.active(k, none, s1, NOW)).toBeNull();
  });

  it('does not disturb a real restriction of the same person, before or after it', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, noteInput(s1), NOW, index);
    await applySanction(store, subjects, input(s1, { durationMs: 2 * H, rule: 1 }), NOW, index);
    await applySanction(store, subjects, noteInput(s1), NOW + 5, index);
    expect(index.active('chat', none, s1, NOW + 6)).toMatchObject({ until: NOW + 2 * H });
    expect(index.active('note', none, s1, NOW + 6)).toBeNull();
  });

  it('revoking a note leaves the index alone', async () => {
    const { store, subjects, index, s1 } = await person();
    const n = await applySanction(store, subjects, noteInput(s1), NOW, index);
    await applySanction(store, subjects, input(s1, { kind: 'ban', durationMs: null, rule: 1 }), NOW, index);
    await revokeSanction(store, n.groupId, 'boss', NOW + 1, 'x', index);
    expect(index.active('ban', none, s1, NOW + 2)).not.toBeNull();
  });
});

describe('applySanction: roomId', () => {
  it('stores the room on every row of the group when given, for any kind', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, noteInput(s1, { roomId: 'room-7' }), NOW);
    await applySanction(store, subjects, input(s1, { includeIp: true, roomId: 'room-8' }), NOW);
    expect(rows(store).map((x) => [x.kind, x.targetType, x.roomId])).toEqual([
      ['note', 'subject', 'room-7'],
      ['chat', 'subject', 'room-8'],
      ['chat', 'ip', 'room-8'],
    ]);
  });

  it('absent or null roomId stores null', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1), NOW);
    await applySanction(store, subjects, input(s1, { roomId: null }), NOW);
    expect(rows(store).map((x) => x.roomId)).toEqual([null, null]);
  });

  it.each([
    ['empty', ''],
    ['a number', 7],
    ['an object', {}],
  ])('refuses a roomId that is %s', async (_name, bad) => {
    const { store, subjects, s1 } = await person();
    await expect(applySanction(store, subjects, input(s1, { roomId: bad as never }), NOW)).rejects.toBeInstanceOf(SanctionError);
    expect(rows(store)).toEqual([]);
  });
});

describe('applySanction: the cited rule', () => {
  it('stores a rule number as its decimal text', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { rule: 7 }), NOW);
    expect(rows(store)[0]?.rule).toBe('7');
  });

  it('defaults to uncovered when no rule is given', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, bare(s1, { source: 'auto_filter', automated: true }), NOW);
    expect(rows(store)[0]).toMatchObject({ rule: 'uncovered', gapNote: null, gapStatus: null });
  });

  it('stores an explicit uncovered the same way', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { rule: 'uncovered', gapNote: GAP }), NOW);
    expect(rows(store)[0]?.rule).toBe('uncovered');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, '4.2', '1', 'covered', '', null])(
    'refuses the rule %j',
    async (bad) => {
      const { store, subjects, s1 } = await person();
      await expect(applySanction(store, subjects, input(s1, { rule: bad as never }), NOW)).rejects.toBeInstanceOf(
        SanctionError,
      );
      expect(rows(store)).toEqual([]);
    },
  );

  it('writes the rule on the IP row as well', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { includeIp: true, rule: 3 }), NOW);
    expect(rows(store).map((r) => r.rule)).toEqual(['3', '3']);
  });
});

describe('applySanction: the rule-gap note', () => {
  it('is required for a moderator sanction with no rule or an uncovered one', async () => {
    const { store, subjects, s1 } = await person();
    await expect(applySanction(store, subjects, bare(s1), NOW)).rejects.toBeInstanceOf(SanctionError);
    await expect(applySanction(store, subjects, input(s1, { rule: 'uncovered' }), NOW)).rejects.toBeInstanceOf(
      SanctionError,
    );
    expect(rows(store)).toEqual([]);
  });

  it.each(['', '   ', '\n\t'])('refuses a blank note %j', async (note) => {
    const { store, subjects, s1 } = await person();
    await expect(
      applySanction(store, subjects, input(s1, { rule: 'uncovered', gapNote: note }), NOW),
    ).rejects.toBeInstanceOf(SanctionError);
    expect(rows(store)).toEqual([]);
  });

  it('accepts 500 characters and refuses 501', async () => {
    const { store, subjects, s1 } = await person();
    await expect(
      applySanction(store, subjects, input(s1, { rule: 'uncovered', gapNote: 'x'.repeat(501) }), NOW),
    ).rejects.toBeInstanceOf(SanctionError);
    await applySanction(store, subjects, input(s1, { rule: 'uncovered', gapNote: 'x'.repeat(500) }), NOW);
    expect(rows(store)).toHaveLength(1);
  });

  it('refuses a non-string note', async () => {
    const { store, subjects, s1 } = await person();
    await expect(
      applySanction(store, subjects, input(s1, { rule: 'uncovered', gapNote: 5 as never }), NOW),
    ).rejects.toBeInstanceOf(SanctionError);
  });

  it('stores the trimmed note, status open, on the subject row only', async () => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { includeIp: true, rule: 'uncovered', gapNote: `  ${GAP}  ` }), NOW);
    const r = rows(store);
    expect(r[0]).toMatchObject({ targetType: 'subject', gapNote: GAP, gapStatus: 'open' });
    expect(r[1]).toMatchObject({ targetType: 'ip', gapNote: null, gapStatus: null });
  });

  it('is refused when a numbered rule is cited', async () => {
    const { store, subjects, s1 } = await person();
    await expect(applySanction(store, subjects, input(s1, { rule: 1, gapNote: GAP }), NOW)).rejects.toBeInstanceOf(
      SanctionError,
    );
    expect(rows(store)).toEqual([]);
  });

  it.each(['auto_filter', 'coop', 'api', 'ai'] as const)(
    'is refused for the non-moderator source %s, which needs none',
    async (source) => {
      const { store, subjects, s1 } = await person();
      await expect(
        applySanction(store, subjects, input(s1, { source, rule: 'uncovered', gapNote: GAP }), NOW),
      ).rejects.toBeInstanceOf(SanctionError);
      await applySanction(store, subjects, bare(s1, { source }), NOW);
      expect(rows(store)).toHaveLength(1);
    },
  );

  it('a warning needs the note when uncovered', async () => {
    const { store, subjects, s1 } = await person();
    const w = { kind: 'warning' as const, durationMs: null };
    await expect(applySanction(store, subjects, input(s1, { ...w, rule: 'uncovered' }), NOW)).rejects.toBeInstanceOf(
      SanctionError,
    );
    await applySanction(store, subjects, input(s1, { ...w, rule: 'uncovered', gapNote: GAP }), NOW);
    expect(rows(store)[0]).toMatchObject({ kind: 'warning', gapNote: GAP, gapStatus: 'open' });
  });

  it('a validation error carries no identifier and no note text', async () => {
    const { store, subjects, s1 } = await person();
    const errs: Error[] = [];
    const attempts: Partial<SanctionInput>[] = [
      { rule: 1, gapNote: GAP },
      { rule: 'uncovered', gapNote: 'x'.repeat(501) },
      { rule: undefined },
      { kind: 'warning', durationMs: H, rule: 1 },
      { kind: 'warning', durationMs: null, includeIp: true, rule: 1 },
      { rule: 99.5 },
    ];
    for (const a of attempts) {
      try {
        await applySanction(store, subjects, input(s1, a), NOW);
        expect.unreachable();
      } catch (e) {
        errs.push(e as Error);
      }
    }
    expect(errs).toHaveLength(attempts.length);
    for (const e of errs) {
      expect(e).toBeInstanceOf(SanctionError);
      expect(e.message).not.toContain(s1);
      expect(e.message).not.toContain(GAP);
      expect(e.message).not.toContain('xxxx');
      expect(e.message).not.toContain('k1');
      expect(e.message).not.toContain('mod@x.com');
    }
  });
});

describe('MemoryStore listGaps and closeGap', () => {
  async function gapFixture() {
    const f = await person();
    const a = await applySanction(f.store, f.subjects, input(f.s1, { rule: 'uncovered', gapNote: 'first' }), NOW);
    const b = await applySanction(
      f.store,
      f.subjects,
      input(f.s1, { includeIp: true, rule: 'uncovered', gapNote: 'second' }),
      NOW + 10,
    );
    await applySanction(f.store, f.subjects, input(f.s1, { rule: 1 }), NOW + 20);
    return { ...f, a, b };
  }

  it('lists only subject rows that carry a note, newest first', async () => {
    const { store, a, b } = await gapFixture();
    const gaps = store.listGaps();
    expect(gaps.map((g) => g.groupId)).toEqual([b.groupId, a.groupId]);
    expect(gaps.every((g) => g.targetType === 'subject' && g.gapStatus === 'open')).toBe(true);
    expect(gaps.map((g) => g.gapNote)).toEqual(['second', 'first']);
  });

  it('closes a gap as ruled with a reference, once', async () => {
    const { store, a } = await gapFixture();
    expect(store.closeGap(a.groupId, 'ruled', '9', 'boss', NOW + 100)).toBe(true);
    expect(store.listGaps().find((g) => g.groupId === a.groupId)?.gapStatus).toBe('ruled');
    expect(rows(store).find((r) => r.groupId === a.groupId)).toMatchObject({ gapRef: '9', gapClosedBy: 'boss', gapClosedAt: NOW + 100 });
    expect(store.closeGap(a.groupId, 'not_a_rule', null, 'boss', NOW + 101)).toBe(false);
    expect(store.listGaps().find((g) => g.groupId === a.groupId)?.gapStatus).toBe('ruled');
  });

  it('closes a gap as not_a_rule with no reference', async () => {
    const { store, b } = await gapFixture();
    expect(store.closeGap(b.groupId, 'not_a_rule', null, 'boss', NOW + 100)).toBe(true);
    expect(store.listGaps().find((x) => x.groupId === b.groupId)?.gapStatus).toBe('not_a_rule');
    expect(rows(store).find((r) => r.groupId === b.groupId && r.targetType === 'subject')?.gapRef).toBeNull();
  });

  it('returns false for an unknown group and for a group with no note', async () => {
    const { store } = await gapFixture();
    expect(store.closeGap('nope', 'ruled', '1', 'boss', NOW)).toBe(false);
    const cited = rows(store).find((r) => r.rule === '1');
    expect(store.closeGap(cited?.groupId ?? '', 'ruled', '1', 'boss', NOW)).toBe(false);
  });

  it('a failed transaction undoes a close', async () => {
    const { store, a } = await gapFixture();
    expect(() =>
      store.transaction(() => {
        store.closeGap(a.groupId, 'ruled', '2', 'boss', NOW);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.listGaps().find((g) => g.groupId === a.groupId)?.gapStatus).toBe('open');
    expect(rows(store).find((r) => r.groupId === a.groupId)?.gapRef).toBeNull();
  });

  it('a closed gap stays listed with its status', async () => {
    const { store, a } = await gapFixture();
    store.closeGap(a.groupId, 'ruled', '2', 'boss', NOW);
    expect(store.listGaps()).toHaveLength(2);
  });
});

describe('MemoryStore loadSubjectActions', () => {
  const row = (id: string, over: Partial<SanctionRow>): SanctionRow => ({
    id, groupId: `g_${id}`, refCode: `M-${id.toUpperCase().padEnd(5, 'A')}`, kind: 'chat', targetType: 'subject', value: 's_x',
    startsAt: NOW, endsAt: NOW + H, reason: 'private', rule: '1', gapNote: null, gapStatus: null, roomId: null, actor: 'mod',
    source: 'moderator', automated: false, pending: false, ...over,
  });

  it('returns subject rows at or after since, revoked and ended ones included, flagged', () => {
    const store = new MemoryStore();
    store.insertSanctionGroup([row('a', { startsAt: NOW - 10 })]);
    store.insertSanctionGroup([row('b', { startsAt: NOW - 11 })]);
    store.insertSanctionGroup([row('c', { startsAt: NOW + 5, endsAt: null }), row('cip', { groupId: 'g_c', targetType: 'ip', value: 'h' })]);
    store.revokeSanctionGroup('g_a', 'mod', NOW, 'oops');
    const got = store.loadSubjectActions(NOW - 10);
    expect(got.map((r) => r.id)).toEqual(['a', 'c']);
    expect(got.find((r) => r.id === 'a')?.revokedAt).toBe(NOW);
    expect(got.find((r) => r.id === 'c')?.revokedAt ?? null).toBeNull();
  });

  it('a transaction that rolls back leaves no trace in the history', () => {
    const store = new MemoryStore();
    expect(() =>
      store.transaction(() => {
        store.insertSanctionGroup([row('z', {})]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.loadSubjectActions(0)).toEqual([]);
  });
});

describe('SanctionIndex.active: own', () => {
  it('is true for the person, false for a bystander matched only through the shared address', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1, { includeIp: true }), NOW, index);
    expect(index.active('chat', who('k1', null, 'ip1'), s1, NOW)?.own).toBe(true);
    expect(index.active('chat', who('k2', null, 'ip1'), null, NOW)?.own).toBe(false);
  });

  it('a person with no IP row of their own match still sees their sanction as own', async () => {
    const { store, subjects, index, s1 } = await person();
    await applySanction(store, subjects, input(s1), NOW, index);
    expect(index.active('chat', none, s1, NOW)?.own).toBe(true);
  });
});

describe('MemoryStore.sanctionRefCode', () => {
  it('returns the ref code of a known group and null for an unknown one', async () => {
    const { MemoryStore } = await import('./memoryStore.js');
    const store = new MemoryStore();
    const row = {
      id: 'r1',
      groupId: 'g1',
      refCode: 'M-ABCDE',
      kind: 'chat' as const,
      targetType: 'subject' as const,
      value: 's_x',
      startsAt: 1,
      endsAt: 2,
      reason: 'r',
      rule: '1',
      gapNote: null,
      gapStatus: null,
      roomId: null,
      actor: 'mod',
      source: 'moderator' as const,
      automated: false,
      pending: false,
    };
    store.transaction(() => store.insertSanctionGroup([row]));
    expect(store.sanctionRefCode('g1')).toBe('M-ABCDE');
    expect(store.sanctionRefCode('nope')).toBeNull();
    expect(store.sanctionRefCode('')).toBeNull();
  });
});

describe('MAX_SANCTION_DURATION_MS: null is the only permanent value', () => {
  it('is 365 days', () => {
    expect(MAX_SANCTION_DURATION_MS).toBe(365 * DAY);
  });

  it.each(['chat', 'area', 'ban'] as const)('a %s at exactly the cap is accepted', async (kind) => {
    const { store, subjects, s1 } = await person();
    await applySanction(store, subjects, input(s1, { kind, durationMs: MAX_SANCTION_DURATION_MS }), NOW);
    expect(rows(store)).toHaveLength(1);
  });

  it.each([MAX_SANCTION_DURATION_MS + 1, MAX_SANCTION_DURATION_MS + DAY, 9e15, Number.MAX_SAFE_INTEGER, 1e300, 2 ** 60])(
    'a duration of %s is refused with SanctionError and nothing is written',
    async (durationMs) => {
      const { store, subjects, index, s1 } = await person();
      await expect(applySanction(store, subjects, input(s1, { durationMs }), NOW, index)).rejects.toThrow(SanctionError);
      await expect(applySanction(store, subjects, input(s1, { kind: 'ban', durationMs }), NOW, index)).rejects.toThrow(/duration/i);
      expect(rows(store)).toEqual([]);
      expect(index.active('chat', none, s1, NOW)).toBeNull();
    },
  );

  it('validateSanctionInput refuses the same way, and null (permanent) stays valid', async () => {
    const { s1 } = await person();
    expect(() => validateSanctionInput(input(s1, { durationMs: MAX_SANCTION_DURATION_MS + 1 }))).toThrow(SanctionError);
    expect(() => validateSanctionInput(input(s1, { durationMs: MAX_SANCTION_DURATION_MS }))).not.toThrow();
    expect(() => validateSanctionInput(input(s1, { kind: 'ban', durationMs: null }))).not.toThrow();
  });

  it('the cap does not touch a warning or a note (they take null only)', async () => {
    const { s1 } = await person();
    expect(() => validateSanctionInput(input(s1, { kind: 'warning', durationMs: null }))).not.toThrow();
    expect(() => validateSanctionInput(input(s1, { kind: 'note', durationMs: null }))).not.toThrow();
  });
});
