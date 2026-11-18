import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import { normalizeRefCode } from '../src/sanctions.js';
import type { Logger, Platform, RawWho, Store } from '../src/types.js';
import { MemoryStore } from '@chatwarden/store-memory';

// `cw.sanctions.byRef(refCode)` (K5 design 5.2): a reference code finds its group's staff view, with the person. Run on the in-memory
// store; the store contract proves SQLite agrees on `sanctionGroupByRef`.

const H = 3_600_000;
const DAY = 24 * H;
const NOW = 1_800_000_000_000;
const KEYS = [
  'groupId', 'refCode', 'kind', 'rule', 'startsAt', 'endsAt', 'reason', 'actor', 'source', 'automated', 'active', 'pending',
  'revokedAt', 'revokedBy', 'revokeReason', 'person',
].sort();

/** A store with `sanctionGroupByRef` hidden: the shape of a custom store written before 0.1.12. Counts the listing reads. */
function withoutByRef(inner: MemoryStore): { store: Store; reads: { n: number } } {
  const reads = { n: 0 };
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'sanctionGroupByRef') return undefined;
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        if (prop === 'listSubjectSanctions') reads.n += 1;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Store;
  return { store, reads };
}

async function setup(store: Store = new MemoryStore()) {
  const clock = { t: NOW, now: () => clock.t };
  const logger: Logger = { warn() {} };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({ store, secret: 'by-ref-secret', platform, clock, logger, retention: false });
  let n = 0;
  const person = (accountId?: string): string => {
    n += 1;
    const room = `room-${n}`;
    cw.rooms.seat(room, 'p1', { clientKey: `raw-client-key-byref-${String(n).padStart(4, '0')}`, ...(accountId === undefined ? {} : { accountId }) }, `Handle${n}`);
    return cw.rooms.subjectAt(room, 'p1') as string;
  };
  const sanction = (subject: string, over: Partial<Parameters<typeof cw.sanctions.apply>[0]> = {}) =>
    cw.sanctions.apply({
      kind: 'chat',
      subject,
      includeIp: false,
      durationMs: DAY,
      reason: 'zorbak reason',
      actor: 'ann',
      source: 'moderator',
      automated: false,
      rule: 2,
      ...over,
    });
  return { cw, clock, person, sanction };
}

describe('normalizeRefCode', () => {
  it.each([
    ['M-7K3Q9', 'M-7K3Q9'],
    ['m-7k3q9', 'M-7K3Q9'],
    ['7K3Q9', 'M-7K3Q9'],
    ['7k3q9', 'M-7K3Q9'],
    [' M-7K3Q9 ', 'M-7K3Q9'],
    ['\tm-7k3q9\n', 'M-7K3Q9'],
  ])('reads %j as %s', (input, want) => {
    expect(normalizeRefCode(input)).toBe(want);
  });

  it('U is a valid code letter (the alphabet keeps it; only I, L, O, 0 and 1 are ambiguous)', () => {
    expect(normalizeRefCode('m-7k3qu')).toBe('M-7K3QU');
  });

  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['four characters', 'M-7K3Q'],
    ['six characters', 'M-7K3Q9A'],
    ['a bare four', '7K3Q'],
    ['a bare six', '7K3Q9A'],
    ['I', 'M-7K3QI'],
    ['L', 'M-7K3QL'],
    ['O', 'M-7K3QO'],
    ['zero', 'M-7K3Q0'],
    ['one', 'M-7K3Q1'],
    ['a bare ambiguous letter', 'I7K3Q'],
    ['another prefix', 'X-7K3Q9'],
    ['no dash', 'M7K3Q9'],
    ['a space inside', 'M-7K 3Q9'],
    ['a long s that upper-cases into a valid letter', 'M-\u017F7K3Q'],
    ['a dotless i', 'M-7K3Q\u0131'],
    ['punctuation', 'M-7K3Q!'],
  ])('refuses %s', (_why, input) => {
    expect(normalizeRefCode(input)).toBeNull();
  });

  it('throws TypeError for a non-string', () => {
    for (const v of [123, null, undefined, {}, ['M-7K3Q9']]) expect(() => normalizeRefCode(v as never)).toThrow(TypeError);
  });
});

describe('cw.sanctions.byRef', () => {
  it('finds a live group, an ended group and a lifted group, with person and the SanctionGroupView fields', async () => {
    const { cw, clock, person, sanction } = await setup();
    const a = person();
    const live = await sanction(a, { kind: 'ban', durationMs: null });
    const ending = await sanction(a, { durationMs: H });
    const lifting = await sanction(a, { kind: 'area', durationMs: DAY });
    await cw.sanctions.revoke(lifting.groupId, 'bea', 'a mistake about vlemmo');
    clock.t += 2 * H; // `ending` has ended now

    const got = cw.sanctions.byRef(live.refCode);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({ groupId: live.groupId, refCode: live.refCode, kind: 'ban', rule: 2, endsAt: null, actor: 'ann', source: 'moderator', active: true, revokedAt: null, person: cw.people.canonical(a) });

    const ended = cw.sanctions.byRef(ending.refCode);
    expect(ended).toMatchObject({ groupId: ending.groupId, active: false, revokedAt: null });
    expect(ended?.endsAt).toBe(NOW + H);

    const lifted = cw.sanctions.byRef(lifting.refCode);
    expect(lifted).toMatchObject({ groupId: lifting.groupId, active: false, revokedBy: 'bea', revokeReason: 'a mistake about vlemmo' });
    expect(lifted?.revokedAt).toBe(NOW);
  });

  it('answers the same view sanctions.forPerson gives for that group', async () => {
    const { cw, person, sanction } = await setup();
    const a = person();
    const g = await sanction(a, { kind: 'warning', durationMs: null });
    const mine = cw.sanctions.forPerson(a).find((v) => v.groupId === g.groupId);
    const { person: who, ...rest } = cw.sanctions.byRef(g.refCode) as NonNullable<ReturnType<typeof cw.sanctions.byRef>>;
    expect(rest).toEqual(mine);
    expect(who).toBe(cw.people.canonical(a));
  });

  it('accepts lower case, surrounding spaces and a bare five character code; rejects four and six characters, an ambiguous letter (I, L, O, 0, 1) and an empty string', async () => {
    const { cw, person, sanction } = await setup();
    const g = await sanction(person());
    const code = g.refCode; // 'M-' plus five
    expect(code).toMatch(/^M-[A-HJKMNP-Z2-9]{5}$/);
    const five = code.slice(2);
    for (const form of [code, code.toLowerCase(), ` ${code} `, five, five.toLowerCase(), `  ${five.toLowerCase()}\n`]) {
      expect(cw.sanctions.byRef(form)?.groupId, form).toBe(g.groupId);
    }
    const four = five.slice(0, 4);
    for (const bad of ['', '   ', code.slice(0, -1), `${code}A`, four, `${five}A`, `M-${four}I`, `M-${four}L`, `M-${four}O`, `M-${four}0`, `M-${four}1`]) {
      expect(cw.sanctions.byRef(bad), bad).toBeNull();
    }
  });

  it('answers null for a well-formed code nobody holds', async () => {
    const { cw, person, sanction } = await setup();
    const g = await sanction(person());
    const other = g.refCode === 'M-AAAAA' ? 'M-BBBBB' : 'M-AAAAA';
    expect(cw.sanctions.byRef(other)).toBeNull();
    expect(cw.sanctions.byRef(other.slice(2).toLowerCase())).toBeNull();
  });

  it('never returns an IP row, a hash or a stored value (the object holds exactly the SanctionGroupView keys plus person)', async () => {
    const { cw, person, sanction } = await setup();
    const g = await sanction(person(), { includeIp: true, ip: '203.0.113.9' } as never);
    const got = cw.sanctions.byRef(g.refCode);
    expect(Object.keys(got ?? {}).sort()).toEqual(KEYS);
    const text = JSON.stringify(got);
    expect(text).not.toContain('203.0.113.9');
    expect(text).not.toContain('iphash');
    expect(text).not.toContain('raw-client-key');
  });

  it('for a merged person returns the canonical person', async () => {
    const { cw, person, sanction } = await setup();
    const a = person('acct-byref-1');
    const b = person('acct-byref-1');
    await cw.flush();
    const root = cw.people.canonical(a);
    expect(cw.people.canonical(b)).toBe(root);
    const g = await sanction(b);
    expect(cw.sanctions.byRef(g.refCode)?.person).toBe(root);
  });

  it('byRef(123) throws TypeError, for every non-string', async () => {
    const { cw } = await setup();
    for (const v of [123, null, undefined, {}, ['M-7K3Q9'], true]) expect(() => cw.sanctions.byRef(v as never), String(v)).toThrow(TypeError);
  });
});

describe('cw.sanctions.byRef on a store without sanctionGroupByRef', () => {
  it('a store without sanctionGroupByRef falls back to the newest 1000 groups and finds a recent code, and answers null for an old one', async () => {
    const { store, reads } = withoutByRef(new MemoryStore());
    const { cw, clock, person, sanction } = await setup(store);
    expect(store.sanctionGroupByRef).toBeUndefined();
    const a = person();
    clock.t += 1;
    const oldest = await sanction(a, { kind: 'warning', durationMs: null });
    const codes: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      clock.t += 1;
      codes.push((await sanction(a, { kind: 'warning', durationMs: null })).refCode);
    }
    // 1001 groups: the first is outside the newest 1000.
    expect(cw.sanctions.byRef(oldest.refCode)).toBeNull();
    reads.n = 0;
    const newest = codes[codes.length - 1] as string;
    expect(cw.sanctions.byRef(newest)?.refCode).toBe(newest);
    const edge = codes[0] as string; // the 1000th newest: still inside
    expect(cw.sanctions.byRef(edge)?.refCode).toBe(edge);
    expect(reads.n).toBeGreaterThan(0);
  });

  it('answers null on an empty store', async () => {
    const { store } = withoutByRef(new MemoryStore());
    const { cw } = await setup(store);
    expect(cw.sanctions.byRef('M-AAAAA')).toBeNull();
  });
});
