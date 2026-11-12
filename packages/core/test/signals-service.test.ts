import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import { BUILTIN_SIGNAL_KINDS } from '../src/signals.js';
import type { SignalInput } from '../src/signals.js';
import type { RawWho, SubjectId } from '../src/types.js';
import { DAY, KINDS, MIN, sworld } from './signalsWorld.js';

// cw.signals: record, counts, kinds, boosted and forRecord, through the facade on the memory store.

const rec = (w: Awaited<ReturnType<typeof sworld>>, input: Partial<SignalInput> & Record<string, unknown>): boolean => w.cw.signals.record(input as never);

describe('record: what is accepted and what is refused', () => {
  it('a declared kind records true; the row shows in counts', async () => {
    const w = await sworld();
    const target = w.person('target');
    const by = w.person('by-1');
    expect(w.cw.signals.record({ kind: 'muted_by_player', subject: target, by })).toBe(true);
    expect(w.cw.signals.counts(target)).toMatchObject([{ kind: 'muted_by_player', distinct: 1, weight: 1 }]);
  });

  it('a built-in kind records without being declared', async () => {
    const w = await sworld({ kinds: {} });
    const target = w.person('target');
    expect(w.cw.signals.record({ kind: 'flood_triggered', subject: target, roomId: 'room-1' })).toBe(true);
    expect(w.cw.signals.counts(target)).toMatchObject([{ kind: 'flood_triggered', distinct: 1 }]);
  });

  it('undeclared, non-string kind, missing subject, roomId with a space or over 64, at in the far future or before retention: each false', async () => {
    const w = await sworld();
    const target = w.person('target');
    const by = w.person('by-1');
    const now = w.clock.t;
    const bad: Array<Record<string, unknown>> = [
      { kind: 'not_declared', subject: target, by },
      { kind: 5, subject: target, by },
      { kind: null, subject: target },
      { kind: undefined, subject: target },
      { kind: ['muted_by_player'], subject: target },
      { subject: target },
      { kind: 'muted_by_player' },
      { kind: 'muted_by_player', subject: null },
      { kind: 'muted_by_player', subject: 5 },
      { kind: 'muted_by_player', subject: '' },
      { kind: 'muted_by_player', subject: target, roomId: 'has space' },
      { kind: 'muted_by_player', subject: target, roomId: 'x'.repeat(65) },
      { kind: 'muted_by_player', subject: target, roomId: '' },
      { kind: 'muted_by_player', subject: target, roomId: 5 },
      { kind: 'muted_by_player', subject: target, roomId: 'ünï' },
      { kind: 'muted_by_player', subject: target, at: now + 5 * MIN + 1 },
      { kind: 'muted_by_player', subject: target, at: now + 10 * DAY },
      { kind: 'muted_by_player', subject: target, at: now - 91 * DAY },
      { kind: 'muted_by_player', subject: target, at: Number.NaN },
      { kind: 'muted_by_player', subject: target, at: Number.POSITIVE_INFINITY },
      { kind: 'muted_by_player', subject: target, at: '2027-01-01' },
      { kind: 'muted_by_player', subject: target, weight: -1 },
      { kind: 'muted_by_player', subject: target, weight: 10.5 },
      { kind: 'muted_by_player', subject: target, weight: Number.NaN },
      { kind: 'muted_by_player', subject: target, weight: '1' },
    ];
    for (const input of bad) expect(w.cw.signals.record(input as never), JSON.stringify(input)).toBe(false);
    expect(w.cw.signals.counts(target)).toEqual([]);
  });

  it('accepts the edges: a room id of 64 and of 1 characters, at 5 minutes ahead and at exactly the retention, weight 0 and 10', async () => {
    const w = await sworld();
    const target = w.person('target');
    const now = w.clock.t;
    expect(rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r'.repeat(64) })).toBe(true);
    expect(rec(w, { kind: 'blocked_by_player', subject: target, roomId: 'A' })).toBe(true);
    expect(rec(w, { kind: 'kicked_from_room', subject: target, roomId: 'a.b:c-d_e', at: now + 5 * MIN })).toBe(true);
    expect(rec(w, { kind: 'left_mid_game', subject: target, roomId: 'r1', at: now - 90 * DAY })).toBe(true);
    expect(rec(w, { kind: 'commended', subject: target, roomId: 'r2', weight: 0 })).toBe(true);
    expect(rec(w, { kind: 'commended', subject: target, roomId: 'r3', weight: 10 })).toBe(true);
  });

  it('a record without a time is stamped with the clock', async () => {
    const w = await sworld();
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r1' });
    const [c] = w.cw.signals.counts(target);
    expect(c?.firstAt).toBe(w.clock.t);
    expect(c?.lastAt).toBe(w.clock.t);
  });

  it('an old record inside retention is counted only inside the window asked for', async () => {
    const w = await sworld();
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r1', at: w.clock.t - 20 * DAY });
    expect(w.cw.signals.counts(target, { windowDays: 14 })).toEqual([]);
    expect(w.cw.signals.counts(target, { windowDays: 30 })).toHaveLength(1);
    expect(w.cw.signals.counts(target, { windowDays: 20 })).toHaveLength(1);
  });
});

describe('record never throws (review focus 3)', () => {
  it('a throwing getter, a Proxy, a BigInt, a cyclic object, a symbol, 1 MB strings, null, a kind named constructor or __proto__ that is not declared', async () => {
    const w = await sworld();
    const target = w.person('target');
    const cyclic: Record<string, unknown> = { kind: 'muted_by_player' };
    cyclic['subject'] = cyclic;
    cyclic['self'] = cyclic;
    const throwing = { kind: 'muted_by_player', get subject(): string { throw new Error('boom zorbak'); } };
    const trap = new Proxy({}, { get() { throw new RangeError('proxy'); }, has() { throw new RangeError('proxy'); }, ownKeys() { throw new RangeError('proxy'); }, getPrototypeOf() { throw new RangeError('proxy'); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const big = 'x'.repeat(1_000_000);
    const inputs: unknown[] = [
      throwing,
      trap,
      revoked.proxy,
      cyclic,
      10n,
      Symbol('x'),
      big,
      null,
      undefined,
      [],
      [target],
      () => true,
      class Foo {},
      { kind: big, subject: target },
      { kind: 'muted_by_player', subject: big },
      { kind: 'muted_by_player', subject: target, roomId: big },
      { kind: 'muted_by_player', subject: target, by: big },
      { kind: 'muted_by_player', subject: target, at: 10n },
      { kind: 'muted_by_player', subject: target, weight: 10n },
      { kind: 'muted_by_player', subject: Symbol('s') },
      { kind: Symbol('k'), subject: target },
      { kind: 'muted_by_player', subject: { get clientKey(): string { throw new Error('boom'); } } },
      { kind: 'muted_by_player', subject: trap },
      { kind: 'muted_by_player', subject: target, by: trap },
      { kind: 'muted_by_player', subject: cyclic },
      { kind: 'constructor', subject: target },
      { kind: '__proto__', subject: target },
      { kind: 'toString', subject: target },
      { kind: 'hasOwnProperty', subject: target },
      JSON.parse('{"__proto__": {"kind": "muted_by_player"}, "subject": "x"}'),
      Object.create({ kind: 'muted_by_player', subject: target }),
      Object.freeze({ kind: 'muted_by_player', subject: target, by: undefined, roomId: undefined }),
    ];
    for (const input of inputs) {
      let result: unknown;
      expect(() => {
        result = w.cw.signals.record(input as never);
      }, String(typeof input)).not.toThrow();
      // The last one is a fully valid record in a frozen object; every other one is refused (an inherited property is not a field).
      expect(result, String(typeof input)).toBe(input === inputs[inputs.length - 1]);
    }
    // Nothing leaked through the prototype either way: only the valid frozen record landed.
    expect(w.cw.signals.counts(target)).toHaveLength(1);
  });

  it('counts, kinds, boosted and forRecord never throw for hostile arguments', async () => {
    const w = await sworld({ feeds: { queue: { kinds: ['muted_by_player'], minDistinct: 1, windowDays: 14 }, record: { kinds: '*', windowDays: 14 } } });
    const trap = new Proxy({}, { get() { throw new RangeError('proxy'); }, has() { throw new RangeError('proxy'); }, ownKeys() { throw new RangeError('proxy'); } });
    for (const v of [null, undefined, 5, 'nobody', {}, [], trap, 10n, Symbol('x')]) {
      expect(() => w.cw.signals.counts(v as never), String(typeof v)).not.toThrow();
      expect(() => w.cw.signals.counts('x' as never, v as never)).not.toThrow();
      expect(() => w.cw.signals.forRecord(v as never)).not.toThrow();
      expect(() => w.cw.signals.boosted(v as never)).not.toThrow();
    }
    expect(w.cw.signals.counts('nobody')).toEqual([]);
    expect(w.cw.signals.boosted([5, null, 'nobody', trap] as never)).toEqual(new Set());
  });
});

describe('parties', () => {
  it('subject equal to by is false, also when they differ only by a merge; a merge after recording folds the two sources in counts (review focus 4)', async () => {
    const w = await sworld();
    // Two identities that become one person: first a key only, then an account only, then both together.
    const a = w.person('key-a');
    w.cw.rooms.seat('acct-room', 'p1', { accountId: 'acct-b' }, 'B');
    const b = w.cw.rooms.subjectAt('acct-room', 'p1') as SubjectId;
    expect(a).not.toBe(b);
    const target = w.person('target');
    // Before the merge they are two sources.
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: a })).toBe(true);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: b })).toBe(true);
    expect(w.cw.signals.counts(target)).toMatchObject([{ distinct: 2 }]);
    // The merge.
    w.cw.rooms.seat('merge-room', 'p1', { clientKey: 'key-a', accountId: 'acct-b' }, 'AB');
    expect(w.cw.signals.counts(target)).toMatchObject([{ distinct: 1, weight: 1 }]);
    // Self: the subject and by are one person under either id.
    const merged = w.cw.rooms.subjectAt('merge-room', 'p1') as SubjectId;
    const alias = merged === a ? b : a;
    expect(rec(w, { kind: 'muted_by_player', subject: merged, by: alias })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: alias, by: merged })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: merged, by: merged })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: a, by: b })).toBe(false);
    expect(w.cw.signals.counts(merged)).toEqual([]);
  });

  it('a record about an alias is found under the canonical person and the other way round', async () => {
    const w = await sworld();
    const a = w.person('key-a');
    w.cw.rooms.seat('acct-room', 'p1', { accountId: 'acct-b' }, 'B');
    const b = w.cw.rooms.subjectAt('acct-room', 'p1') as SubjectId;
    const by1 = w.person('by-1');
    const by2 = w.person('by-2');
    rec(w, { kind: 'muted_by_player', subject: a, by: by1 });
    rec(w, { kind: 'muted_by_player', subject: b, by: by2 });
    w.cw.rooms.seat('merge-room', 'p1', { clientKey: 'key-a', accountId: 'acct-b' }, 'AB');
    const merged = w.cw.rooms.subjectAt('merge-room', 'p1') as SubjectId;
    for (const id of [a, b, merged]) expect(w.cw.signals.counts(id), id).toMatchObject([{ distinct: 2 }]);
  });

  it('an unknown RawWho is false and creates no subject', async () => {
    const w = await sworld();
    const target = w.person('target');
    await w.cw.flush();
    const before = (await w.store.loadSubjects()).subjects.length;
    expect(rec(w, { kind: 'muted_by_player', subject: { clientKey: 'never-seen' } as RawWho })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: { clientKey: 'never-seen-either', accountId: 'acct-x', ip: '203.0.113.9' } as RawWho })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: { ip: '203.0.113.9' } as RawWho })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: {} as RawWho })).toBe(false);
    await w.cw.flush();
    expect((await w.store.loadSubjects()).subjects.length).toBe(before);
  });

  it('a seated RawWho is found, by key or by account', async () => {
    const w = await sworld();
    const target = w.person('target');
    w.person('by-key');
    w.cw.rooms.seat('r', 'p9', { accountId: 'acct-9' }, 'Nine');
    expect(rec(w, { kind: 'muted_by_player', subject: { clientKey: 'target' } as RawWho, by: { clientKey: 'by-key' } as RawWho })).toBe(true);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: { accountId: 'acct-9' } as RawWho })).toBe(true);
    expect(w.cw.signals.counts(target)).toMatchObject([{ distinct: 2 }]);
  });

  it('an unknown subject id string is false', async () => {
    const w = await sworld();
    const target = w.person('target');
    expect(rec(w, { kind: 'muted_by_player', subject: 's_never_seen' })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: 's_never_seen' })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: w.person('known-by') })).toBe(true);
  });
});

describe('cap', () => {
  it('a second record of the same (kind, subject, by) inside perByWindowMs is false and true after it; a different kind, subject or by is unaffected; an alias of the same by is also capped', async () => {
    const w = await sworld({ guards: { perByWindowMs: 3_600_000 } });
    const target = w.person('target');
    const other = w.person('other');
    const by = w.person('by-1');
    const by2 = w.person('by-2');
    const base = w.clock.t - (w.clock.t % 3_600_000) + 60_000; // inside one cap bucket
    w.clock.t = base;
    expect(rec(w, { kind: 'muted_by_player', subject: target, by })).toBe(true);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by })).toBe(false);
    w.clock.t = base + 59 * MIN - 60_000;
    expect(rec(w, { kind: 'muted_by_player', subject: target, by })).toBe(false);
    // Unaffected: another kind, another subject, another by.
    expect(rec(w, { kind: 'blocked_by_player', subject: target, by })).toBe(true);
    expect(rec(w, { kind: 'muted_by_player', subject: other, by })).toBe(true);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: by2 })).toBe(true);
    // The next bucket.
    w.clock.t = base + 3_600_000;
    expect(rec(w, { kind: 'muted_by_player', subject: target, by })).toBe(true);
    expect(w.cw.signals.counts(target, { kinds: ['muted_by_player'] })).toMatchObject([{ distinct: 2 }]);
  });

  it('recording as an alias of the same by is capped as one source', async () => {
    const w = await sworld();
    const target = w.person('target');
    const a = w.person('key-a');
    w.cw.rooms.seat('acct-room', 'p1', { accountId: 'acct-b' }, 'B');
    const b = w.cw.rooms.subjectAt('acct-room', 'p1') as SubjectId;
    w.cw.rooms.seat('merge-room', 'p1', { clientKey: 'key-a', accountId: 'acct-b' }, 'AB');
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: a })).toBe(true);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: b })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: { clientKey: 'key-a' } as RawWho })).toBe(false);
    expect(rec(w, { kind: 'muted_by_player', subject: target, by: { accountId: 'acct-b' } as RawWho })).toBe(false);
  });

  it('a source-less kind is capped per room per day; another room, or another day, is a new row', async () => {
    const w = await sworld();
    const target = w.person('target');
    const day0 = w.clock.t - (w.clock.t % DAY) + 3_600_000;
    w.clock.t = day0;
    expect(rec(w, { kind: 'left_mid_game', subject: target, roomId: 'room-1' })).toBe(true);
    expect(rec(w, { kind: 'left_mid_game', subject: target, roomId: 'room-1' })).toBe(false);
    expect(rec(w, { kind: 'left_mid_game', subject: target, roomId: 'room-2' })).toBe(true);
    expect(rec(w, { kind: 'left_mid_game', subject: target })).toBe(true);
    expect(rec(w, { kind: 'left_mid_game', subject: target })).toBe(false);
    w.clock.t = day0 + DAY;
    expect(rec(w, { kind: 'left_mid_game', subject: target, roomId: 'room-1' })).toBe(true);
    expect(rec(w, { kind: 'left_mid_game', subject: target })).toBe(true);
  });
});

describe('weights', () => {
  it('the kind\'s weight is the default and a per-call weight overrides it, stored as given', async () => {
    const w = await sworld();
    const target = w.person('target');
    rec(w, { kind: 'kicked_from_room', subject: target, roomId: 'r1' });
    rec(w, { kind: 'left_mid_game', subject: target, roomId: 'r1' });
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r1', weight: 7.5 });
    const by = Object.fromEntries(w.cw.signals.counts(target).map((c) => [c.kind, c.weight]));
    expect(by).toEqual({ muted_by_player: 7.5, kicked_from_room: 2, left_mid_game: 0.5 });
  });

  it('weight 0 records a row that counts for nothing', async () => {
    const w = await sworld();
    const target = w.person('target');
    expect(rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r1', weight: 0 })).toBe(true);
    expect(w.cw.signals.counts(target)).toEqual([]);
  });
});

describe('counts', () => {
  it('one entry per kind with a source, aliases folded, windowDays and kinds options honoured', async () => {
    const w = await sworld();
    const target = w.person('target');
    const bys = [1, 2, 3].map((i) => w.person(`by-${i}`));
    for (const by of bys) rec(w, { kind: 'muted_by_player', subject: target, by });
    rec(w, { kind: 'muted_by_player', subject: target, by: bys[0], at: w.clock.t - 3 * DAY });
    rec(w, { kind: 'blocked_by_player', subject: target, by: bys[0] });
    rec(w, { kind: 'commended', subject: target, by: bys[1] });
    const all = w.cw.signals.counts(target);
    expect(all.map((c) => c.kind)).toEqual(['muted_by_player', 'blocked_by_player', 'commended']);
    expect(all[0]).toMatchObject({ label: 'Muted by other players', polarity: 'negative', distinct: 3, weight: 3 });
    expect(all[2]).toMatchObject({ polarity: 'positive', distinct: 1 });
    expect(w.cw.signals.counts(target, { kinds: ['blocked_by_player', 'nope_kind'] }).map((c) => c.kind)).toEqual(['blocked_by_player']);
    expect(w.cw.signals.counts(target, { kinds: [] })).toEqual([]);
    expect(w.cw.signals.counts(target, { windowDays: 2 })[0]).toMatchObject({ windowDays: 2 });
    expect(w.cw.signals.counts(w.person('nobody'))).toEqual([]);
  });

  it('a store failure reads []', async () => {
    const w = await sworld();
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r' });
    w.store.listSignalSources = () => {
      throw new Error('disk full');
    };
    expect(w.cw.signals.counts(target)).toEqual([]);
  });

  it('the default window is 30 days, held to the retention and to 90 days', async () => {
    const w = await sworld({ retention: { signalsMs: 14 * DAY } });
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r', at: w.clock.t - 13 * DAY });
    expect(w.cw.signals.counts(target)[0]).toMatchObject({ windowDays: 14 });
    expect(w.cw.signals.counts(target, { windowDays: 500 })[0]).toMatchObject({ windowDays: 14 });
    expect(w.cw.signals.counts(target, { windowDays: Number.NaN })[0]).toMatchObject({ windowDays: 14 });
  });
});

describe('kinds()', () => {
  it('lists the built-ins and the declared kinds with builtin flags', async () => {
    const w = await sworld();
    const list = w.cw.signals.kinds();
    expect(list.map((k) => k.kind)).toEqual(['flood_triggered', ...Object.keys(KINDS)]);
    expect(list[0]).toEqual({ kind: 'flood_triggered', label: BUILTIN_SIGNAL_KINDS.flood_triggered.label, polarity: 'negative', weight: 1, builtin: true });
    expect(list.filter((k) => k.builtin).map((k) => k.kind)).toEqual(['flood_triggered']);
    expect(list.find((k) => k.kind === 'kicked_from_room')).toEqual({ kind: 'kicked_from_room', label: 'Kicked from a room', polarity: 'negative', weight: 2, builtin: false });
  });

  it('a redeclared built-in keeps its flag', async () => {
    const w = await sworld({ kinds: { flood_triggered: { label: 'Spammed', polarity: 'negative', weight: 3 } } });
    expect(w.cw.signals.kinds()).toEqual([{ kind: 'flood_triggered', label: 'Spammed', polarity: 'negative', weight: 3, builtin: true }]);
  });

  it('returns copies', async () => {
    const w = await sworld();
    w.cw.signals.kinds()[0]!.label = 'changed';
    expect(w.cw.signals.kinds()[0]?.label).toBe(BUILTIN_SIGNAL_KINDS.flood_triggered.label);
  });
});

describe('boosted and forRecord', () => {
  it('are empty when their feed is off and never read the store', async () => {
    const w = await sworld();
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, by: w.person('by') });
    let reads = 0;
    const orig = w.store.listSignalSources!.bind(w.store);
    w.store.listSignalSources = (...a) => {
      reads += 1;
      return orig(...a);
    };
    expect(w.cw.signals.boosted([target])).toEqual(new Set());
    expect(w.cw.signals.forRecord(target)).toEqual([]);
    expect(reads).toBe(0);
  });

  it('boosted holds the people who meet feeds.queue, as canonical ids, from one grouped read for 200 people', async () => {
    const w = await sworld({ feeds: { queue: { kinds: ['muted_by_player', 'blocked_by_player'], minDistinct: 3, windowDays: 14 } } });
    const bys = [1, 2, 3, 4].map((i) => w.person(`by-${i}`));
    const people: SubjectId[] = [];
    for (let i = 0; i < 200; i += 1) people.push(w.person(`p-${i}`));
    // Person 0: three distinct muters. Person 1: two muters. Person 2: one player who muted and blocked (two sources of two kinds) plus one.
    for (const by of bys.slice(0, 3)) rec(w, { kind: 'muted_by_player', subject: people[0], by });
    for (const by of bys.slice(0, 2)) rec(w, { kind: 'muted_by_player', subject: people[1], by });
    rec(w, { kind: 'muted_by_player', subject: people[2], by: bys[0] });
    rec(w, { kind: 'blocked_by_player', subject: people[2], by: bys[0] });
    rec(w, { kind: 'muted_by_player', subject: people[2], by: bys[1] });
    let reads = 0;
    const orig = w.store.listSignalSources!.bind(w.store);
    w.store.listSignalSources = (...a) => {
      reads += 1;
      return orig(...a);
    };
    const out = w.cw.signals.boosted(people);
    expect(reads).toBe(1);
    expect(out).toEqual(new Set([people[0], people[2]]));
  });

  it('boosted ignores a source older than the window and folds aliases', async () => {
    const w = await sworld({ feeds: { queue: { kinds: ['muted_by_player'], minDistinct: 2, windowDays: 7 } } });
    const target = w.person('target');
    const by1 = w.person('by-1');
    const by2 = w.person('by-2');
    rec(w, { kind: 'muted_by_player', subject: target, by: by1 });
    rec(w, { kind: 'muted_by_player', subject: target, by: by2, at: w.clock.t - 8 * DAY });
    expect(w.cw.signals.boosted([target]).size).toBe(0);
    rec(w, { kind: 'muted_by_player', subject: target, by: by2, at: w.clock.t - 6 * DAY });
    expect(w.cw.signals.boosted([target]).has(target)).toBe(true);
  });

  it('forRecord lists the feed\'s kinds and window only', async () => {
    const w = await sworld({ feeds: { record: { kinds: ['muted_by_player', 'commended'], windowDays: 14 } } });
    const target = w.person('target');
    const by = w.person('by');
    rec(w, { kind: 'muted_by_player', subject: target, by });
    rec(w, { kind: 'blocked_by_player', subject: target, by });
    rec(w, { kind: 'commended', subject: target, by });
    rec(w, { kind: 'muted_by_player', subject: target, by: w.person('by-old'), at: w.clock.t - 20 * DAY });
    const lines = w.cw.signals.forRecord(target);
    expect(lines.map((c) => c.kind)).toEqual(['muted_by_player', 'commended']);
    expect(lines[0]).toMatchObject({ distinct: 1, windowDays: 14 });
  });

  it('forRecord with "*" lists every declared kind', async () => {
    const w = await sworld({ feeds: { record: { kinds: '*', windowDays: 14 } } });
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r' });
    rec(w, { kind: 'flood_triggered', subject: target, roomId: 'r' });
    expect(w.cw.signals.forRecord(target).map((c) => c.kind)).toEqual(['flood_triggered', 'muted_by_player']);
  });

  it('a store failure reads empty', async () => {
    const w = await sworld({ feeds: { queue: { kinds: ['muted_by_player'], minDistinct: 1, windowDays: 14 }, record: { kinds: '*', windowDays: 14 } } });
    const target = w.person('target');
    w.store.listSignalSources = () => {
      throw new Error('disk');
    };
    expect(w.cw.signals.boosted([target])).toEqual(new Set());
    expect(w.cw.signals.forRecord(target)).toEqual([]);
  });
});

describe('a store without signals', () => {
  class NoSignals extends MemoryStore {}
  const bare = (): MemoryStore => {
    const s = new NoSignals();
    for (const m of ['insertSignal', 'listSignalSources', 'purgeSignals']) Object.defineProperty(s, m, { value: undefined });
    return s;
  };
  const opts = (store: MemoryStore, signals?: unknown) => ({
    store,
    secret: 's',
    platform: { identify: (ctx: unknown) => ctx as RawWho },
    retention: false as const,
    ...(signals === undefined ? {} : { overrides: { signals: signals as never } }),
  });

  it('createChatwarden throws with kinds declared, or with feeds', async () => {
    await expect(createChatwarden(opts(bare(), { kinds: KINDS }))).rejects.toThrow(/signal/i);
    await expect(createChatwarden(opts(bare(), { feeds: {} , kinds: { x_kind: { label: 'X', polarity: 'negative' } } }))).rejects.toThrow(/insertSignal/);
    await expect(createChatwarden(opts(bare(), { kinds: { muted_by_player: KINDS.muted_by_player! }, feeds: { record: { kinds: '*', windowDays: 7 } } }))).rejects.toThrow(/signal/i);
  });

  it('pacing alone (no declared kinds, no feeds) starts, record is false and is logged once as unsupported', async () => {
    const logged: Array<[string, unknown]> = [];
    const cw = await createChatwarden({ ...opts(bare()), logger: { warn: (e, d) => void logged.push([e, d]) } });
    const target = 's_x';
    expect(cw.signals.record({ kind: 'flood_triggered', subject: target })).toBe(false);
    expect(cw.signals.record({ kind: 'flood_triggered', subject: target })).toBe(false);
    expect(logged.filter(([e]) => e === 'chatwarden.signals_store_unsupported')).toHaveLength(1);
    expect(cw.signals.counts(target)).toEqual([]);
    expect(cw.signals.boosted([target])).toEqual(new Set());
  });

  it('kinds() and the rest still answer', async () => {
    const cw = await createChatwarden(opts(bare()));
    expect(cw.signals.kinds().map((k) => k.kind)).toEqual(['flood_triggered']);
  });
});

describe('logs', () => {
  it('hold event names and reason codes only: no subject, by, room, kind id or label appears in any captured log line', async () => {
    const w = await sworld();
    const target = w.person('target-secret-key');
    const by = w.person('by-secret-key');
    w.logged.length = 0;
    for (const input of [
      { kind: 'zz_undeclared_kind', subject: target },
      { kind: 'muted_by_player', subject: target, roomId: 'room with space' },
      { kind: 'muted_by_player', subject: target, by: target },
      { kind: 'muted_by_player', subject: 's_unknown_subject_id' },
      { kind: 'muted_by_player', subject: target, at: 1 },
      { kind: 'muted_by_player', subject: target, by },
      { kind: 'muted_by_player', subject: target, by },
    ]) {
      w.clock.t += 2 * MIN;
      rec(w, input);
    }
    const text = JSON.stringify(w.logged);
    for (const secret of [target, by, 'secret-key', 'room with space', 'zz_undeclared_kind', 'muted_by_player', 'Muted by other players', 's_unknown_subject_id']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(w.logged.length).toBeGreaterThan(0);
    for (const [event, detail] of w.logged) {
      expect(event).toBe('chatwarden.signal_refused');
      expect(Object.keys(detail ?? {}).sort()).toEqual(expect.arrayContaining(['reason']));
    }
  });

  it('the refusal log is throttled to one a minute with a held count', async () => {
    const w = await sworld();
    const target = w.person('target');
    w.logged.length = 0;
    for (let i = 0; i < 5; i += 1) rec(w, { kind: 'zz_undeclared', subject: target });
    expect(w.logged).toEqual([['chatwarden.signal_refused', { reason: 'undeclared' }]]);
    w.clock.t += 61_000;
    rec(w, { kind: 'zz_undeclared', subject: target });
    expect(w.logged[1]).toEqual(['chatwarden.signal_refused', { reason: 'undeclared', suppressed: 4 }]);
  });

  it('each reason has its code', async () => {
    const w = await sworld();
    const target = w.person('target');
    const by = w.person('by');
    const reasons: string[] = [];
    const next = (input: Record<string, unknown>): void => {
      w.logged.length = 0;
      w.clock.t += 2 * MIN;
      rec(w, input);
      reasons.push(String((w.logged[0]?.[1] as { reason?: string } | undefined)?.reason));
    };
    next({ kind: 'nope_kind', subject: target });
    next({ kind: 5, subject: target });
    next({ kind: 'muted_by_player', subject: 's_unknown' });
    next({ kind: 'muted_by_player', subject: target, by: target });
    next({ kind: 'muted_by_player', subject: target, at: 1 });
    rec(w, { kind: 'muted_by_player', subject: target, by });
    next({ kind: 'muted_by_player', subject: target, by });
    expect(reasons).toEqual(['undeclared', 'malformed', 'unknown_subject', 'self', 'time', 'capped']);
  });

  it('a store failure is a store_failed refusal with the error class only', async () => {
    const w = await sworld();
    const target = w.person('target');
    w.store.insertSignal = () => {
      throw new TypeError('secret detail s_abc');
    };
    w.logged.length = 0;
    expect(rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r' })).toBe(false);
    expect(w.logged).toEqual([['chatwarden.signal_refused', { reason: 'store_failed', error: 'TypeError' }]]);
  });
});

describe('the stored row', () => {
  it('holds ids and numbers only', async () => {
    const w = await sworld();
    const target = w.person('target-key');
    const by = w.person('by-key');
    rec(w, { kind: 'muted_by_player', subject: target, by, roomId: 'room-1' });
    rec(w, { kind: 'left_mid_game', subject: target, roomId: 'room-9' });
    const dump = JSON.stringify([...(w.store as unknown as { signalRows: Map<string, unknown> }).signalRows.values()]);
    for (const secret of ['target-key', 'by-key', 'H-target', 'Muted by']) expect(dump).not.toContain(secret);
    const rows = [...(w.store as unknown as { signalRows: Map<string, { sourceKey: string; subject: string; bySubject: string | null; roomId: string | null }> }).signalRows.values()];
    expect(rows.map((r) => r.sourceKey).sort()).toEqual([`b:${by}`, 'r:room-9']);
    expect(rows.every((r) => r.subject === target)).toBe(true);
  });

  it('a by-less record without a room is a day source', async () => {
    const w = await sworld();
    const target = w.person('target');
    rec(w, { kind: 'left_mid_game', subject: target });
    const [row] = [...(w.store as unknown as { signalRows: Map<string, { sourceKey: string; capBucket: number }> }).signalRows.values()];
    expect(row?.sourceKey).toBe(`d:${new Date(w.clock.t).toISOString().slice(0, 10)}`);
    expect(row?.capBucket).toBe(Math.floor(w.clock.t / DAY));
  });
});

describe('purge and the feeds', () => {
  it('purge(policy) with a signalsMs below a saved feed window is refused naming the field, and deletes nothing', async () => {
    const w = await sworld({ feeds: { record: { kinds: '*', windowDays: 30 } } });
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'r', at: w.clock.t - 40 * DAY });
    await expect(w.cw.purge({ signalsMs: 20 * DAY })).rejects.toMatchObject({ name: 'ProfileError', path: 'profile.signals.feeds.record.windowDays' });
    expect(w.cw.signals.counts(target, { windowDays: 90 })).toHaveLength(1);
    await expect(w.cw.purge({ signalsMs: 30 * DAY })).resolves.toBeDefined();
  });

  it('purge deletes rows older than signalsMs and reports them', async () => {
    const w = await sworld();
    const target = w.person('target');
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'old', at: w.clock.t - 60 * DAY });
    rec(w, { kind: 'muted_by_player', subject: target, roomId: 'new' });
    const res = await w.cw.purge({ signalsMs: 30 * DAY });
    expect(res.signals).toBe(1);
  });
});
