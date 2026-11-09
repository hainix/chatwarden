import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubjectIndex } from '../src/subjects.js';
import * as core from '../src/index.js';
import type { Identifiers, Logger, SanctionRow, SubjectId, SubjectIdRecord, SubjectRecord } from '../src/types.js';
import { MemoryStore, memoryStore } from './memoryStore.js';

const HOUR = 3_600_000;
const ID_RE = /^s_[A-Za-z0-9_-]{22}$/;

function makeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    advance: (d: number) => {
      t += d;
    },
  };
}

function who(clientKey: string | null, accountId: string | null = null, ipHash: string | null = null): Identifiers {
  return { clientKey, accountId, ipHash };
}

function silent(): Logger & { calls: Array<[string, Record<string, string | number | boolean> | undefined]> } {
  const calls: Array<[string, Record<string, string | number | boolean> | undefined]> = [];
  return {
    calls,
    warn(event, detail) {
      calls.push([event, detail]);
    },
  };
}

function setup(start = 1_000) {
  const store = memoryStore();
  const clock = makeClock(start);
  const logger = silent();
  const index = new SubjectIndex(store, clock, { logger });
  return { store, clock, logger, index };
}

function mustResolve(index: SubjectIndex, ids: Identifiers): SubjectId {
  const id = index.resolve(ids);
  if (id === null) throw new Error('expected a subject');
  return id;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SubjectIndex: finding and creating', () => {
  it('key alone creates a subject', async () => {
    const { index, store } = setup();
    await index.load();
    const id = mustResolve(index, who('k1'));
    expect(id).toMatch(ID_RE);
    await index.flush();
    const { subjects, ids } = await store.loadSubjects();
    expect(subjects.map((s) => s.id)).toEqual([id]);
    expect(ids.map((r) => [r.kind, r.value])).toEqual([['key', 'k1']]);
  });

  it('account alone creates a subject', async () => {
    const { index } = setup();
    await index.load();
    expect(mustResolve(index, who(null, 'acct-1'))).toMatch(ID_RE);
  });

  it('same key resolves to the same subject', async () => {
    const { index } = setup();
    await index.load();
    expect(mustResolve(index, who('k1'))).toBe(mustResolve(index, who('k1')));
  });

  it('same account resolves to the same subject', async () => {
    const { index } = setup();
    await index.load();
    expect(mustResolve(index, who(null, 'a1'))).toBe(mustResolve(index, who(null, 'a1')));
  });

  it('different keys are different subjects; different accounts are different subjects', async () => {
    const { index } = setup();
    await index.load();
    expect(mustResolve(index, who('k1'))).not.toBe(mustResolve(index, who('k2')));
    expect(mustResolve(index, who(null, 'a1'))).not.toBe(mustResolve(index, who(null, 'a2')));
  });

  it('a key and an account with the same text are different identifiers', async () => {
    const { index } = setup();
    await index.load();
    expect(mustResolve(index, who('same'))).not.toBe(mustResolve(index, who(null, 'same')));
  });

  it('key then key+account links', async () => {
    const { index } = setup();
    await index.load();
    const first = mustResolve(index, who('k1'));
    expect(mustResolve(index, who('k1', 'a1'))).toBe(first);
    // the account alone now finds the same person
    expect(mustResolve(index, who(null, 'a1'))).toBe(first);
  });

  it('account seen first, then a key together with it, links the key', async () => {
    const { index } = setup();
    await index.load();
    const first = mustResolve(index, who(null, 'a1'));
    expect(mustResolve(index, who('k9', 'a1'))).toBe(first);
    expect(mustResolve(index, who('k9'))).toBe(first);
  });

  it('a new key and a new account together create one subject', async () => {
    const { index } = setup();
    await index.load();
    const id = mustResolve(index, who('k1', 'a1'));
    expect(mustResolve(index, who('k1'))).toBe(id);
    expect(mustResolve(index, who(null, 'a1'))).toBe(id);
  });

  it('one key signing in to two accounts links both accounts to that key', async () => {
    const { index } = setup();
    await index.load();
    const id = mustResolve(index, who('k1', 'a1'));
    expect(mustResolve(index, who('k1', 'a2'))).toBe(id);
    expect(mustResolve(index, who(null, 'a2'))).toBe(id);
  });

  it('resolve with all-null or empty identifiers returns null and creates nothing', async () => {
    const { index, store } = setup();
    await index.load();
    expect(index.resolve(who(null))).toBeNull();
    expect(index.resolve({ clientKey: '', accountId: '', ipHash: '' })).toBeNull();
    await index.flush();
    expect((await store.loadSubjects()).subjects).toEqual([]);
  });

  it('resolve is synchronous', async () => {
    const { index } = setup();
    await index.load();
    const out = index.resolve(who('k1'));
    expect(typeof out).toBe('string');
  });
});

describe('SubjectIndex: merging', () => {
  async function twoSubjects() {
    const ctx = setup(100);
    await ctx.index.load();
    const older = mustResolve(ctx.index, who('k1')); // created at 100
    ctx.clock.set(200);
    const newer = mustResolve(ctx.index, who(null, 'a1')); // created at 200
    ctx.clock.set(300);
    return { ...ctx, older, newer };
  }

  it('two subjects merge when an account ties them; the older survives; canonical(alias) is the survivor', async () => {
    const { index, older, newer } = await twoSubjects();
    expect(older).not.toBe(newer);
    const merged = mustResolve(index, who('k1', 'a1'));
    expect(merged).toBe(older);
    expect(index.canonical(newer)).toBe(older);
    expect(index.canonical(older)).toBe(older);
    // each identifier alone now finds the survivor
    expect(mustResolve(index, who('k1'))).toBe(older);
    expect(mustResolve(index, who(null, 'a1'))).toBe(older);
  });

  it('the older survives whichever identifier is the older subject (account older than key)', async () => {
    const ctx = setup(100);
    await ctx.index.load();
    const older = mustResolve(ctx.index, who(null, 'a1'));
    ctx.clock.set(200);
    const newer = mustResolve(ctx.index, who('k1'));
    ctx.clock.set(300);
    expect(mustResolve(ctx.index, who('k1', 'a1'))).toBe(older);
    expect(ctx.index.canonical(newer)).toBe(older);
  });

  it('on equal created_at the lexicographically smaller id survives', async () => {
    for (let i = 0; i < 25; i++) {
      const { index } = setup(500);
      await index.load();
      const a = mustResolve(index, who(`k${i}`));
      const b = mustResolve(index, who(null, `a${i}`));
      const smaller = a < b ? a : b;
      const larger = a < b ? b : a;
      expect(mustResolve(index, who(`k${i}`, `a${i}`))).toBe(smaller);
      expect(index.canonical(larger)).toBe(smaller);
    }
  });

  it('persists the merge with markMerged on the absorbed subject', async () => {
    const { index, store, newer, older } = await twoSubjects();
    mustResolve(index, who('k1', 'a1'));
    await index.flush();
    const { subjects } = await store.loadSubjects();
    const byId = new Map(subjects.map((s) => [s.id, s]));
    expect(byId.get(newer)?.mergedInto).toBe(older);
    expect(byId.get(older)?.mergedInto).toBeNull();
  });

  it('the identifier stays attached to the absorbed subject in storage', async () => {
    const { index, store, newer } = await twoSubjects();
    mustResolve(index, who('k1', 'a1'));
    await index.flush();
    const { ids } = await store.loadSubjects();
    const acct = ids.find((r) => r.kind === 'account' && r.value === 'a1');
    expect(acct?.subjectId).toBe(newer);
  });

  it('merges chain: A into B, B into C; canonical follows the chain to the root', async () => {
    const ctx = setup(0);
    await ctx.index.load();
    const c = mustResolve(ctx.index, who('kc', null, 'ip-c')); // oldest
    ctx.clock.set(10);
    const b = mustResolve(ctx.index, who('kb', 'ab'));
    ctx.clock.set(20);
    const a = mustResolve(ctx.index, who('ka', 'aa'));
    ctx.clock.set(30);
    expect(new Set([a, b, c]).size).toBe(3);

    // A joins B (account of B with key of A): B is older, survives
    expect(mustResolve(ctx.index, who('ka', 'ab'))).toBe(b);
    expect(ctx.index.canonical(a)).toBe(b);
    // B-root joins C (key of C with account of B): C is older, survives
    expect(mustResolve(ctx.index, who('kc', 'ab'))).toBe(c);
    expect(ctx.index.canonical(b)).toBe(c);
    expect(ctx.index.canonical(a)).toBe(c);
    expect(ctx.index.canonical(c)).toBe(c);

    // every identifier of every merged subject resolves to the root
    for (const w of [who('ka'), who('kb'), who('kc'), who(null, 'aa'), who(null, 'ab')]) {
      expect(ctx.index.resolve(w)).toBe(c);
    }
    const idents = ctx.index.identifiersOf(c);
    expect(idents.keys).toEqual(['ka', 'kb', 'kc']);
    expect(idents.accounts).toEqual(['aa', 'ab']);
    expect(idents.ips).toEqual(['ip-c']);
    // asking by an alias gives the same answer
    expect(ctx.index.identifiersOf(a)).toEqual(idents);
  });

  it('a chain can also be built in the other order (survivor of the first merge loses the second)', async () => {
    const ctx = setup(0);
    await ctx.index.load();
    const s1 = mustResolve(ctx.index, who('k1'));
    ctx.clock.set(5);
    const s2 = mustResolve(ctx.index, who('k2'));
    ctx.clock.set(6);
    const s3 = mustResolve(ctx.index, who('k3'));
    mustResolve(ctx.index, who('k3', 'x')); // account x -> s3
    mustResolve(ctx.index, who('k2', 'x')); // s3 absorbed into s2
    expect(ctx.index.canonical(s3)).toBe(s2);
    mustResolve(ctx.index, who('k1', 'x')); // s2 absorbed into s1
    expect(ctx.index.canonical(s3)).toBe(s1);
    expect(ctx.index.canonical(s2)).toBe(s1);
  });

  it('linking identifiers that already share a subject does not merge or write markMerged', async () => {
    const { index, store } = setup();
    await index.load();
    const spy = vi.spyOn(store, 'markMerged');
    const id = mustResolve(index, who('k1', 'a1'));
    expect(mustResolve(index, who('k1', 'a1'))).toBe(id);
    await index.flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('after a merge, new identifiers attach to the survivor', async () => {
    const { index, older, newer } = await twoSubjects();
    mustResolve(index, who('k1', 'a1'));
    expect(mustResolve(index, who('k-new', 'a1'))).toBe(older);
    expect(index.identifiersOf(older).keys).toEqual(['k-new', 'k1']);
    expect(index.canonical(newer)).toBe(older);
  });

  it('canonical of an unknown id returns the id itself; identifiersOf an unknown id is empty', async () => {
    const { index } = setup();
    await index.load();
    expect(index.canonical('s_unknownunknownunknown00')).toBe('s_unknownunknownunknown00');
    expect(index.identifiersOf('s_unknownunknownunknown00')).toEqual({ accounts: [], keys: [], ips: [] });
  });
});

describe('SubjectIndex: IP is never used to find or merge', () => {
  it('IP alone resolves null and creates nothing', async () => {
    const { index, store } = setup();
    await index.load();
    expect(index.resolve(who(null, null, 'ip-1'))).toBeNull();
    await index.flush();
    const loaded = await store.loadSubjects();
    expect(loaded.subjects).toEqual([]);
    expect(loaded.ids).toEqual([]);
  });

  it('two keys sharing an IP stay two subjects', async () => {
    const { index } = setup();
    await index.load();
    const a = mustResolve(index, who('k1', null, 'ip-shared'));
    const b = mustResolve(index, who('k2', null, 'ip-shared'));
    expect(a).not.toBe(b);
    expect(index.canonical(a)).toBe(a);
    expect(index.canonical(b)).toBe(b);
    expect(index.identifiersOf(a).ips).toEqual(['ip-shared']);
    expect(index.identifiersOf(b).ips).toEqual(['ip-shared']);
  });

  it('a known IP with no key or account does not find the earlier subject', async () => {
    const { index } = setup();
    await index.load();
    mustResolve(index, who('k1', null, 'ip-1'));
    expect(index.resolve(who(null, null, 'ip-1'))).toBeNull();
  });

  it('two accounts on one household IP stay two subjects', async () => {
    const { index } = setup();
    await index.load();
    const a = mustResolve(index, who(null, 'a1', 'ip-home'));
    const b = mustResolve(index, who(null, 'a2', 'ip-home'));
    expect(a).not.toBe(b);
  });

  it('an IP seen with a known key is recorded on that subject, and on a later merge on the survivor view', async () => {
    const { index, clock } = setup(100);
    await index.load();
    const a = mustResolve(index, who('k1', null, 'ip-1'));
    clock.set(200);
    const b = mustResolve(index, who(null, 'a1', 'ip-2'));
    clock.set(300);
    mustResolve(index, who('k1', 'a1'));
    expect(index.canonical(b)).toBe(a);
    expect(index.identifiersOf(a).ips).toEqual(['ip-1', 'ip-2']);
  });

  it('identifiersOf lists every identifier, ips included', async () => {
    const { index } = setup();
    await index.load();
    const id = mustResolve(index, who('k1', 'a1', 'ip-1'));
    mustResolve(index, who('k2', 'a1', 'ip-2'));
    mustResolve(index, who('k2', 'a2', 'ip-1'));
    expect(index.identifiersOf(id)).toEqual({
      accounts: ['a1', 'a2'],
      keys: ['k1', 'k2'],
      ips: ['ip-1', 'ip-2'],
    });
  });

  it('identifiersOf returns copies: mutating the result does not change the index', async () => {
    const { index } = setup();
    await index.load();
    const id = mustResolve(index, who('k1', 'a1', 'ip-1'));
    index.identifiersOf(id).keys.push('evil');
    expect(index.identifiersOf(id).keys).toEqual(['k1']);
  });
});

describe('SubjectIndex: subject ids', () => {
  it('subject ids match /^s_[A-Za-z0-9_-]{22}$/ and are not derived from any identifier', async () => {
    const one = setup();
    const two = setup();
    await one.index.load();
    await two.index.load();
    const ids: Identifiers = who('k1', 'a1', 'ip-1');
    const a = mustResolve(one.index, ids);
    const b = mustResolve(two.index, ids);
    expect(a).toMatch(ID_RE);
    expect(b).toMatch(ID_RE);
    expect(a).not.toBe(b);
    for (const text of ['k1', 'a1', 'ip-1']) expect(a).not.toContain(text);
  });

  it('every new subject gets a fresh id', async () => {
    const { index } = setup();
    await index.load();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(mustResolve(index, who(`k${i}`)));
    expect(seen.size).toBe(200);
  });

  it('is exported from the package entry point', () => {
    expect(core.SubjectIndex).toBe(SubjectIndex);
  });
});

describe('SubjectIndex: load', () => {
  it('reload restores identifiers and subjects from the store', async () => {
    const { store, clock, index } = setup();
    await index.load();
    const id = mustResolve(index, who('k1', 'a1', 'ip-1'));
    await index.flush();

    const fresh = new SubjectIndex(store, clock, { logger: silent() });
    await fresh.load();
    expect(fresh.resolve(who('k1'))).toBe(id);
    expect(fresh.resolve(who(null, 'a1'))).toBe(id);
    expect(fresh.identifiersOf(id)).toEqual({ accounts: ['a1'], keys: ['k1'], ips: ['ip-1'] });
  });

  it('reload after a merge chain restores aliases and identifiersOf', async () => {
    const { store, clock, index } = setup(0);
    await index.load();
    const c = mustResolve(index, who('kc'));
    clock.set(10);
    const b = mustResolve(index, who('kb'));
    clock.set(20);
    const a = mustResolve(index, who('ka'));
    mustResolve(index, who('ka', 'x'));
    mustResolve(index, who('kb', 'x')); // a into b
    mustResolve(index, who('kc', 'x')); // b into c
    await index.flush();

    const fresh = new SubjectIndex(store, clock, { logger: silent() });
    await fresh.load();
    expect(fresh.canonical(a)).toBe(c);
    expect(fresh.canonical(b)).toBe(c);
    expect(fresh.resolve(who('ka'))).toBe(c);
    expect(fresh.identifiersOf(c)).toEqual(index.identifiersOf(c));
  });

  it('load on an empty store leaves an empty index; load twice is idempotent', async () => {
    const { index } = setup();
    await index.load();
    await index.load();
    const id = mustResolve(index, who('k1'));
    await index.flush();
    await index.load();
    expect(mustResolve(index, who('k1'))).toBe(id);
  });

  it('a damaged merge cycle in storage does not hang canonical()', async () => {
    const store = memoryStore();
    const x: SubjectRecord = { id: 's_xxxxxxxxxxxxxxxxxxxxxx', createdAt: 1, mergedInto: 's_yyyyyyyyyyyyyyyyyyyyyy' };
    const y: SubjectRecord = { id: 's_yyyyyyyyyyyyyyyyyyyyyy', createdAt: 2, mergedInto: 's_xxxxxxxxxxxxxxxxxxxxxx' };
    await store.saveSubject(x);
    await store.saveSubject(y);
    const index = new SubjectIndex(store, makeClock(), { logger: silent() });
    await index.load();
    expect(typeof index.canonical(x.id)).toBe('string');
  });
});

describe('SubjectIndex: last_seen throttle', () => {
  function counting() {
    const store = memoryStore();
    const writes: SubjectIdRecord[] = [];
    const orig = store.saveIdentifier.bind(store);
    store.saveIdentifier = async (rec) => {
      writes.push({ ...rec });
      return orig(rec);
    };
    const clock = makeClock(10_000);
    const index = new SubjectIndex(store, clock, { logger: silent() });
    return { store, clock, index, writes };
  }

  it('writes a new identifier once, then at most once per hour per identifier', async () => {
    const { index, clock, writes } = counting();
    await index.load();
    mustResolve(index, who('k1'));
    await index.flush();
    expect(writes).toHaveLength(1);

    for (let i = 0; i < 50; i++) {
      clock.advance(1_000);
      mustResolve(index, who('k1'));
    }
    await index.flush();
    expect(writes).toHaveLength(1);

    clock.set(10_000 + HOUR - 1);
    mustResolve(index, who('k1'));
    await index.flush();
    expect(writes).toHaveLength(1);

    clock.set(10_000 + HOUR);
    mustResolve(index, who('k1'));
    await index.flush();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.lastSeen).toBe(10_000 + HOUR);
    expect(writes[1]?.firstSeen).toBe(10_000);

    // the window restarts from the last write
    clock.set(10_000 + HOUR + 5);
    mustResolve(index, who('k1'));
    await index.flush();
    expect(writes).toHaveLength(2);
  });

  it('throttles each identifier independently', async () => {
    const { index, clock, writes } = counting();
    await index.load();
    mustResolve(index, who('k1', 'a1', 'ip-1'));
    await index.flush();
    expect(writes).toHaveLength(3);
    clock.advance(HOUR);
    mustResolve(index, who('k1'));
    await index.flush();
    // only the key was seen again
    expect(writes).toHaveLength(4);
    expect(writes[3]?.kind).toBe('key');
    mustResolve(index, who('k1', 'a1', 'ip-1'));
    await index.flush();
    // account and ip are now due; key is not
    expect(writes).toHaveLength(6);
    expect(new Set(writes.slice(4).map((w) => w.kind))).toEqual(new Set(['account', 'ip']));
  });

  it('a reload keeps the throttle: an identifier written minutes ago is not rewritten', async () => {
    const { index, store, clock } = counting();
    await index.load();
    mustResolve(index, who('k1'));
    await index.flush();
    const writes: SubjectIdRecord[] = [];
    const orig = store.saveIdentifier.bind(store);
    store.saveIdentifier = async (rec) => {
      writes.push(rec);
      return orig(rec);
    };
    const fresh = new SubjectIndex(store, clock, { logger: silent() });
    await fresh.load();
    clock.advance(60_000);
    mustResolve(fresh, who('k1'));
    await fresh.flush();
    expect(writes).toHaveLength(0);
  });

  it('a throttled identifier on an absorbed subject updates that stored row, not the survivor', async () => {
    const { index, clock, writes } = counting();
    await index.load();
    const oldSubject = mustResolve(index, who('k1'));
    clock.advance(10);
    const newSubject = mustResolve(index, who(null, 'a1'));
    clock.advance(10);
    mustResolve(index, who('k1', 'a1'));
    await index.flush();
    writes.length = 0;
    clock.advance(HOUR);
    mustResolve(index, who(null, 'a1'));
    await index.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.subjectId).toBe(newSubject);
    expect(writes[0]?.subjectId).not.toBe(oldSubject);
  });
});

describe('SubjectIndex: store failures never reach the chat path', () => {
  class FailingStore extends MemoryStore {
    override async saveSubject(): Promise<void> {
      throw new TypeError('disk on fire k1');
    }
  }

  it('a failing write is logged (no identifiers in the log) and resolve still answers', async () => {
    const logger = silent();
    const index = new SubjectIndex(new FailingStore(), makeClock(), { logger });
    await index.load();
    const id = mustResolve(index, who('k-secret', 'acct-secret', 'ip-secret'));
    expect(mustResolve(index, who('k-secret'))).toBe(id);
    await index.flush();
    expect(logger.calls.length).toBeGreaterThan(0);
    const text = JSON.stringify(logger.calls);
    for (const secret of ['k-secret', 'acct-secret', 'ip-secret', id, 'disk on fire']) {
      expect(text).not.toContain(secret);
    }
    expect(logger.calls[0]?.[0]).toBe('subjects.write_failed');
    expect(logger.calls[0]?.[1]).toMatchObject({ error: 'TypeError' });
  });

  it('a later write still runs after an earlier one failed', async () => {
    const store = memoryStore();
    let fail = true;
    const orig = store.saveSubject.bind(store);
    store.saveSubject = async (s) => {
      if (fail) throw new Error('boom');
      return orig(s);
    };
    const logger = silent();
    const index = new SubjectIndex(store, makeClock(), { logger });
    await index.load();
    mustResolve(index, who('k1'));
    await index.flush();
    fail = false;
    const id2 = mustResolve(index, who('k2'));
    await index.flush();
    const { subjects } = await store.loadSubjects();
    expect(subjects.map((s) => s.id)).toEqual([id2]);
  });

  it('a store method that throws synchronously is also contained', async () => {
    const store = memoryStore();
    store.saveSubject = (() => {
      throw new RangeError('sync boom');
    }) as unknown as typeof store.saveSubject;
    const logger = silent();
    const index = new SubjectIndex(store, makeClock(), { logger });
    await index.load();
    expect(() => index.resolve(who('k1'))).not.toThrow();
    await index.flush();
    expect(logger.calls[0]?.[1]).toMatchObject({ error: 'RangeError' });
  });

  it('defaults the logger to console.warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = new SubjectIndex(new FailingStore(), makeClock());
    await index.load();
    mustResolve(index, who('k1'));
    await index.flush();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('k1');
  });

  it('a logger that throws does not break resolve or flush', async () => {
    const index = new SubjectIndex(new FailingStore(), makeClock(), {
      logger: {
        warn() {
          throw new Error('logger down');
        },
      },
    });
    await index.load();
    expect(() => mustResolve(index, who('k1'))).not.toThrow();
    await expect(index.flush()).resolves.toBeUndefined();
  });

  it('writes reach the store in order: the subject before its identifiers', async () => {
    const store = memoryStore();
    const order: string[] = [];
    const s = store.saveSubject.bind(store);
    const i = store.saveIdentifier.bind(store);
    const m = store.markMerged.bind(store);
    store.saveSubject = async (r) => {
      order.push('subject');
      return s(r);
    };
    store.saveIdentifier = async (r) => {
      order.push(`id:${r.kind}`);
      return i(r);
    };
    store.markMerged = async (a, b) => {
      order.push('merged');
      return m(a, b);
    };
    const clock = makeClock(1);
    const index = new SubjectIndex(store, clock, { logger: silent() });
    await index.load();
    mustResolve(index, who('k1', 'a1', 'ip'));
    expect(order).toEqual([]); // queued, not yet run synchronously
    await index.flush();
    expect(order[0]).toBe('subject');
    expect(order.slice(1).sort()).toEqual(['id:account', 'id:ip', 'id:key']);
  });
});

describe('memoryStore', () => {
  it('saveIdentifier is an upsert that keeps first_seen and the latest last_seen', async () => {
    const store = memoryStore();
    await store.saveSubject({ id: 's1', createdAt: 1, mergedInto: null });
    await store.saveIdentifier({ subjectId: 's1', kind: 'key', value: 'k', firstSeen: 5, lastSeen: 5 });
    await store.saveIdentifier({ subjectId: 's1', kind: 'key', value: 'k', firstSeen: 9, lastSeen: 9 });
    const { ids } = await store.loadSubjects();
    expect(ids).toEqual([{ subjectId: 's1', kind: 'key', value: 'k', firstSeen: 5, lastSeen: 9 }]);
  });

  it('transaction rolls back on throw and rethrows', async () => {
    const store = memoryStore();
    expect(() =>
      store.transaction(() => {
        void store.saveSubject({ id: 's1', createdAt: 1, mergedInto: null });
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect((await store.loadSubjects()).subjects).toEqual([]);
  });
});

describe('SubjectIndex.latestIp', () => {
  it('is null for a subject with no IP and for an unknown subject', async () => {
    const { index } = setup();
    await index.load();
    const s = mustResolve(index, who('k1'));
    expect(index.latestIp(s)).toBeNull();
    expect(index.latestIp('s_unknown')).toBeNull();
  });

  it('returns the only IP seen', async () => {
    const { index } = setup();
    await index.load();
    const s = mustResolve(index, who('k1', null, 'ip-a'));
    expect(index.latestIp(s)).toBe('ip-a');
  });

  it('returns the most recently seen IP, even within the store write throttle window', async () => {
    const { index, clock } = setup();
    await index.load();
    const s = mustResolve(index, who('k1', null, 'ip-a'));
    clock.advance(1_000);
    mustResolve(index, who('k1', null, 'ip-b'));
    expect(index.latestIp(s)).toBe('ip-b');
    clock.advance(1_000);
    mustResolve(index, who('k1', null, 'ip-a')); // back on the first address
    expect(index.latestIp(s)).toBe('ip-a');
  });

  it('looks across every subject merged into the root', async () => {
    const { index, clock } = setup();
    await index.load();
    const a = mustResolve(index, who('k1', null, 'ip-a'));
    clock.advance(1_000);
    const b = mustResolve(index, who('k2', null, 'ip-b'));
    clock.advance(1_000);
    mustResolve(index, who('k1', 'acct'));
    mustResolve(index, who('k2', 'acct')); // merge
    const root = index.canonical(a);
    expect(index.canonical(b)).toBe(root);
    expect(index.latestIp(root)).toBe('ip-b');
    expect(index.latestIp(a)).toBe('ip-b');
    expect(index.latestIp(b)).toBe('ip-b');
  });

  it('survives a reload from the store (uses the stored last seen)', async () => {
    const { index, clock, store } = setup();
    await index.load();
    const s = mustResolve(index, who('k1', null, 'ip-a'));
    clock.advance(2 * HOUR);
    mustResolve(index, who('k1', null, 'ip-b'));
    clock.advance(2 * HOUR);
    mustResolve(index, who('k1', null, 'ip-a'));
    await index.flush();
    const again = new SubjectIndex(store, clock, { logger: silent() });
    await again.load();
    expect(again.latestIp(s)).toBe('ip-a');
  });

  it('is deterministic on a tie (the smaller value)', async () => {
    const { index } = setup();
    await index.load();
    const s = mustResolve(index, who('k1', null, 'ip-b'));
    mustResolve(index, who('k1', null, 'ip-a'));
    expect(index.latestIp(s)).toBe('ip-a');
  });
});

describe('memoryStore transactions (journaled rollback)', () => {
  const srow = (id: string, groupId: string, refCode: string): SanctionRow => ({
    id, groupId, refCode, kind: 'chat', targetType: 'subject', value: 's', startsAt: 0, endsAt: null,
    reason: 'r', rule: null, gapNote: null, gapStatus: null, roomId: null, actor: 'a', source: 'api', automated: false, pending: false,
  });

  it('an outer failure undoes writes of a successful inner transaction', async () => {
    const store = memoryStore();
    expect(() =>
      store.transaction(() => {
        store.transaction(() => {
          void store.saveSubject({ id: 's1', createdAt: 1, mergedInto: null });
          store.insertSanctionGroup([srow('r1', 'g1', 'M-AAAAA')]);
        });
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect((await store.loadSubjects()).subjects).toEqual([]);
    expect(store.rawSanctions()).toEqual([]);
    expect(store.insertSanctionGroup([srow('r2', 'g2', 'M-AAAAA')])).toBe(true); // the code is free again
  });

  it('an inner failure caught by the outer fn undoes only the inner writes', async () => {
    const store = memoryStore();
    store.transaction(() => {
      void store.saveSubject({ id: 'keep', createdAt: 1, mergedInto: null });
      try {
        store.transaction(() => {
          void store.saveSubject({ id: 'drop', createdAt: 2, mergedInto: null });
          throw new Error('inner');
        });
      } catch {
        /* swallowed */
      }
    });
    expect((await store.loadSubjects()).subjects.map((s) => s.id)).toEqual(['keep']);
  });

  it('rolls back an identifier upsert, a merge mark and a revoke to their prior values', async () => {
    const store = memoryStore();
    await store.saveSubject({ id: 's1', createdAt: 1, mergedInto: null });
    await store.saveSubject({ id: 's2', createdAt: 2, mergedInto: null });
    await store.saveIdentifier({ subjectId: 's1', kind: 'key', value: 'k', firstSeen: 5, lastSeen: 5 });
    store.insertSanctionGroup([srow('r1', 'g1', 'M-AAAAA')]);
    expect(() =>
      store.transaction(() => {
        void store.saveIdentifier({ subjectId: 's1', kind: 'key', value: 'k', firstSeen: 9, lastSeen: 9 });
        void store.markMerged('s2', 's1');
        store.revokeSanctionGroup('g1', 'm', 7, 'why');
        throw new Error('x');
      }),
    ).toThrow('x');
    const { subjects, ids } = await store.loadSubjects();
    expect(ids[0]?.lastSeen).toBe(5);
    expect(subjects.find((s) => s.id === 's2')?.mergedInto).toBeNull();
    expect(store.rawSanctions()[0]).toMatchObject({ revokedBy: null, revokedAt: null, revokeReason: null });
  });

  it('a ref-code collision leaves the earlier group and its code intact', () => {
    const store = memoryStore();
    expect(store.insertSanctionGroup([srow('r1', 'g1', 'M-AAAAA')])).toBe(true);
    expect(store.insertSanctionGroup([srow('r2', 'g2', 'M-AAAAA')])).toBe(false);
    expect(store.rawSanctions()).toHaveLength(1);
  });
});

describe('SubjectIndex.lookup (read-only)', () => {
  it('finds the subject of a known key, a known account, or both', () => {
    const { index } = setup();
    const s = mustResolve(index, who('k1', 'a1', 'ip1'));
    expect(index.lookup(who('k1'))).toBe(s);
    expect(index.lookup(who(null, 'a1'))).toBe(s);
    expect(index.lookup(who('k1', 'a1', 'other-ip'))).toBe(s);
  });

  it('returns null for an unknown key or account and for an IP alone', () => {
    const { index } = setup();
    mustResolve(index, who('k1', 'a1', 'ip1'));
    expect(index.lookup(who('nope'))).toBeNull();
    expect(index.lookup(who(null, 'nope'))).toBeNull();
    expect(index.lookup(who(null, null, 'ip1'))).toBeNull();
    expect(index.lookup(who(null))).toBeNull();
    expect(index.lookup(who('', ''))).toBeNull();
  });

  it('never creates a subject, records an identifier, or writes to the store', async () => {
    const { index, store } = setup();
    mustResolve(index, who('k1'));
    await index.flush();
    const before = await store.loadSubjects();
    expect(index.lookup(who('stranger', 'stranger-acct', 'ip9'))).toBeNull();
    expect(index.lookup(who('k1', 'new-acct', 'ip9'))).not.toBeNull();
    await index.flush();
    expect(await store.loadSubjects()).toEqual(before);
    // the unknown account was not attached to k1's subject
    expect(index.lookup(who(null, 'new-acct'))).toBeNull();
    expect(index.lookup(who('stranger'))).toBeNull();
  });

  it('never links or merges: a key and an account of two subjects stay two subjects', () => {
    const { index } = setup(1_000);
    const a = mustResolve(index, who('k1'));
    const b = mustResolve(index, who(null, 'a1'));
    expect(a).not.toBe(b);
    index.lookup(who('k1', 'a1'));
    expect(index.canonical(a)).toBe(a);
    expect(index.canonical(b)).toBe(b);
  });

  it('with a key and an account on two subjects, answers the one a merge would keep (the older)', () => {
    const { index, clock } = setup(1_000);
    const older = mustResolve(index, who('k1'));
    clock.advance(10);
    const newer = mustResolve(index, who(null, 'a1'));
    expect(index.lookup(who('k1', 'a1'))).toBe(older);
    expect(index.lookup(who(null, 'a1'))).toBe(newer);
  });

  it('answers the canonical (surviving) subject after a merge', () => {
    const { index, clock } = setup(1_000);
    const a = mustResolve(index, who('k1'));
    clock.advance(10);
    mustResolve(index, who(null, 'a1'));
    expect(mustResolve(index, who('k1', 'a1'))).toBe(a);
    expect(index.lookup(who(null, 'a1'))).toBe(a);
    expect(index.lookup(who('k1'))).toBe(a);
  });
});
