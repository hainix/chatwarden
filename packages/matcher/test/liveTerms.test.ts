import { describe, expect, it, vi } from 'vitest';
import { LiveTerms, type TermEditor, type TermPack } from '../src/index.js';
import {
  MemoryTermStore,
  SYNTHETIC_EXCEPTIONS,
  SYNTHETIC_TERMS,
  syntheticTermPack,
} from './fixtures/index.js';

const T0 = 1_700_000_000_000;
const ID = /^[A-Za-z0-9_-]{22}$/;

interface Rig {
  store: MemoryTermStore;
  live: LiveTerms;
  warn: ReturnType<typeof vi.fn>;
  clock: { t: number; now(): number };
}
function rig(over: { pack?: TermPack | null; store?: MemoryTermStore; clock?: Rig['clock'] } = {}): Rig {
  const store = over.store ?? new MemoryTermStore();
  const clock = over.clock ?? { t: T0, now() { return this.t; } };
  const warn = vi.fn();
  const pack = over.pack === undefined ? syntheticTermPack() : over.pack;
  const live = new LiveTerms({ store, pack, clock, logger: { warn } });
  return { store, live, warn, clock };
}
async function loaded(over: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(over);
  await r.live.load();
  return r;
}
const blocked = (live: LiveTerms, text: string) => live.match(text) !== null;
const ok = (r: { ok: boolean }) => r.ok;
const activeIds = (r: Rig) => r.store.state.terms.filter((t) => t.active).map((t) => t.id);

/** Every term word and positive line of the synthetic pack: none may appear in a log line. */
const SECRETS = [...SYNTHETIC_TERMS.map((t) => t.term), 'blorft', 'snoddle', 'wumpity'];
function expectLogsFree(warn: ReturnType<typeof vi.fn>) {
  const text = JSON.stringify(warn.mock.calls).toLowerCase();
  for (const s of SECRETS) expect(text).not.toContain(s);
}

describe('seeding', () => {
  it('seeds from the pack once, then the store rules', async () => {
    const a = await loaded();
    expect(a.store.state.terms.map((t) => t.id)).toEqual(SYNTHETIC_TERMS.map((t) => t.id));
    expect(a.store.state.exceptions.map((e) => e.id)).toEqual(SYNTHETIC_EXCEPTIONS.map((e) => e.id));
    expect(a.store.state.seeded).toEqual(['synthetic']);
    // A moderator turns a term off.
    expect(ok(await a.live.change('alice', (e) => e.setTermActive('syn:zorbak', false)))).toBe(true);
    expect(blocked(a.live, 'you zorbak')).toBe(false);

    // A restart on the same store, with the same pack: the pack is not copied in again.
    const b = rig({ store: a.store, clock: { t: T0 + 5000, now() { return this.t; } } });
    await b.live.load();
    expect(b.live.usingPack).toBe(false);
    expect(blocked(b.live, 'you zorbak')).toBe(false);
    expect(blocked(b.live, 'you vlemmo')).toBe(true);
    expect(a.store.state.terms.find((t) => t.id === 'syn:zorbak')!.active).toBe(false);
    expect(a.store.state.terms).toHaveLength(SYNTHETIC_TERMS.length);
  });

  it('a pack term removed from the store stays removed', async () => {
    const a = await loaded();
    a.store.state.terms = a.store.state.terms.filter((t) => t.id !== 'syn:quissel');
    const b = rig({ store: a.store });
    await b.live.load();
    expect(a.store.state.terms.some((t) => t.id === 'syn:quissel')).toBe(false);
    expect(blocked(b.live, 'you quissel')).toBe(false);
  });

  it('seeded rows keep the pack ids and are stamped seed at the load time', async () => {
    const r = await loaded();
    expect(r.store.state.terms[0]).toEqual({
      id: 'syn:zorbak',
      term: 'zorbak',
      language: 'en',
      active: true,
      note: null,
      addedBy: 'seed',
      addedAt: T0,
      updatedBy: null,
      updatedAt: null,
    });
    expect(r.store.state.exceptions[0]).toMatchObject({ id: 'syn-ex:tarvo-lake', phrase: 'tarvo lake', addedBy: 'seed', addedAt: T0 });
  });

  it('a second load inserts nothing, even with a later clock', async () => {
    const r = await loaded();
    r.clock.t = T0 + 10_000;
    await r.live.load();
    expect(r.store.state.terms.filter((t) => t.addedAt !== T0)).toEqual([]);
    expect(r.store.state.terms).toHaveLength(SYNTHETIC_TERMS.length);
  });

  it('writes no audit rows', async () => {
    const r = await loaded();
    expect(r.store.state.audit).toEqual([]);
  });

  it('keeps a term the pack ships inactive inactive', async () => {
    const pack = syntheticTermPack();
    pack.terms[1]!.active = false;
    const r = await loaded({ pack });
    expect(r.store.state.terms[1]!.active).toBe(false);
    expect(blocked(r.live, 'you vlemmo')).toBe(false);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
  });

  it('a second pack seeds on its own id; a word already in the store is not added twice', async () => {
    const r = await loaded();
    const other = syntheticTermPack({
      id: 'extra',
      terms: [
        { id: 'x:dup', term: 'ZORBAK', language: 'en', active: true, positive: [], negative: [] },
        { id: 'x:new', term: 'blorft', language: 'en', active: true, positive: [], negative: [] },
      ],
      exceptions: [{ id: 'x-ex:dup', phrase: 'Tarvo  Lake', language: 'en', active: true }],
    });
    const two = rig({ store: r.store, pack: other });
    await two.live.load();
    expect(r.store.state.seeded).toEqual(['synthetic', 'extra']);
    expect(r.store.state.terms.map((t) => t.id)).toContain('x:new');
    expect(r.store.state.terms.map((t) => t.id)).not.toContain('x:dup');
    expect(r.store.state.exceptions.map((e) => e.id)).not.toContain('x-ex:dup');
    expect(blocked(two.live, 'you blorft')).toBe(true);
  });

  it('a seeding failure rolls back, leaves no marker, serves the pack, and is retried on the next load', async () => {
    const store = new MemoryTermStore();
    let failInserts = true;
    store.fail = (m) => {
      if (failInserts && m === 'insertException') throw new Error('disk full');
    };
    const r = rig({ store });
    await r.live.load();
    expect(store.state.terms).toEqual([]);
    expect(store.state.seeded).toEqual([]);
    expect(r.live.usingPack).toBe(true);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
    failInserts = false;
    await r.live.load();
    expect(r.live.usingPack).toBe(false);
    expect(store.state.seeded).toEqual(['synthetic']);
    expect(store.state.terms).toHaveLength(SYNTHETIC_TERMS.length);
  });
});

describe('load and fail-open', () => {
  it('before load() the pack is already in force', () => {
    const r = rig();
    expect(r.live.usingPack).toBe(true);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
    expect(blocked(r.live, 'tarvo lake')).toBe(false);
  });

  it('matches with the rows of the store once loaded, and the pack is no longer used', async () => {
    const r = await loaded();
    expect(r.live.usingPack).toBe(false);
    expect(r.live.match('you zorbak')).toEqual({ termId: 'syn:zorbak' });
    expect(r.live.match('f3nr1sk!')).toEqual({ termId: 'syn:fenrisk' });
    expect(r.live.match('hello there blorft')).toBeNull();
  });

  it('works from a store alone, with no pack', async () => {
    const store = new MemoryTermStore();
    store.state.terms.push({
      id: 't1', term: 'blorft', language: 'en', active: true, note: null, addedBy: 'x', addedAt: 1, updatedBy: null, updatedAt: null,
    });
    const r = await loaded({ store, pack: null });
    expect(r.live.match('what a blorft')).toEqual({ termId: 't1' });
    expect(r.live.usingPack).toBe(false);
  });

  it('rows exposes the matcher rows only', async () => {
    const r = await loaded();
    expect(r.live.rows.terms[0]).toEqual({ id: 'syn:zorbak', term: 'zorbak', language: 'en', active: true });
    expect(r.live.rows.exceptions[0]).toEqual({ id: 'syn-ex:tarvo-lake', phrase: 'tarvo lake', language: 'en', active: true });
    expect(r.live.rows.terms).toHaveLength(SYNTHETIC_TERMS.length);
  });

  it('store failure on load falls back to pack', async () => {
    const store = new MemoryTermStore();
    store.fail = () => {
      throw new Error('db locked');
    };
    const r = rig({ store });
    await expect(r.live.load()).resolves.toBeUndefined();
    expect(r.live.usingPack).toBe(true);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
    // pack exceptions are in force too
    expect(blocked(r.live, 'sorry, tarvo lake today')).toBe(false);
    expect(r.live.rows.terms).toHaveLength(SYNTHETIC_TERMS.length);
    expect(r.warn).toHaveBeenCalledTimes(1);
    expect(r.warn.mock.calls[0]![0]).toBe('terms.load_failed');
    expect(r.warn.mock.calls[0]![1]).toEqual({ error: 'Error' });
    expectLogsFree(r.warn);
  });

  it('a later successful load leaves the pack fallback', async () => {
    const store = new MemoryTermStore();
    let down = true;
    store.fail = () => {
      if (down) throw new Error('db locked');
    };
    const r = rig({ store });
    await r.live.load();
    expect(r.live.usingPack).toBe(true);
    down = false;
    await r.live.load();
    expect(r.live.usingPack).toBe(false);
    expect(store.state.seeded).toEqual(['synthetic']);
  });

  it('a failed reload after a good load keeps the store matcher and does not flip to the pack', async () => {
    const r = await loaded();
    expect(ok(await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' })))).toBe(true);
    await r.live.change('a', (e) => e.setTermActive('syn:zorbak', false));
    r.store.fail = () => {
      throw new Error('db locked');
    };
    await r.live.load();
    expect(r.live.usingPack).toBe(false);
    expect(blocked(r.live, 'you blorft')).toBe(true);
    expect(blocked(r.live, 'you zorbak')).toBe(false);
  });

  it('a store with no active term falls back to the pack', async () => {
    const store = new MemoryTermStore();
    store.state.seeded.push('synthetic');
    store.state.terms.push({
      id: 't1', term: 'blorft', language: 'en', active: false, note: null, addedBy: 'x', addedAt: 1, updatedBy: null, updatedAt: null,
    });
    const r = await loaded({ store });
    expect(r.live.usingPack).toBe(true);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
    expect(r.warn).toHaveBeenCalledTimes(1);
  });

  it('a stored row the matcher cannot build falls back to the pack, and the log does not quote it', async () => {
    const store = new MemoryTermStore();
    store.state.seeded.push('synthetic');
    store.state.terms.push({
      id: 't1', term: 'snoddle wumpity', language: 'en', active: true, note: null, addedBy: 'x', addedAt: 1, updatedBy: null, updatedAt: null,
    });
    const r = await loaded({ store });
    expect(r.live.usingPack).toBe(true);
    expect(r.warn).toHaveBeenCalledTimes(1);
    expectLogsFree(r.warn);
  });

  it('no pack and empty store: matches nothing, never throws', async () => {
    const r = rig({ pack: null });
    await expect(r.live.load()).resolves.toBeUndefined();
    expect(r.live.usingPack).toBe(false);
    expect(() => r.live.match('you zorbak')).not.toThrow();
    expect(r.live.match('you zorbak')).toBeNull();
    expect(r.live.rows).toEqual({ terms: [], exceptions: [] });
  });

  it('no pack and a failing store: matches nothing, never throws, logs once', async () => {
    const store = new MemoryTermStore();
    store.fail = () => {
      throw new Error('db locked');
    };
    const r = rig({ store, pack: null });
    await expect(r.live.load()).resolves.toBeUndefined();
    expect(r.live.usingPack).toBe(false);
    expect(r.live.match('anything at all')).toBeNull();
    expect(r.warn).toHaveBeenCalledTimes(1);
  });

  it('with no logger the default is console.warn', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new MemoryTermStore();
    store.fail = () => {
      throw new Error('db locked');
    };
    await new LiveTerms({ store, pack: null, clock: { now: () => T0 } }).load();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('change on an empty store with no pack can add the first term', async () => {
    const r = await loaded({ pack: null });
    const res = await r.live.change('alice', (e) => e.addTerm({ term: 'blorft', language: 'en' }));
    expect(res.ok).toBe(true);
    expect(blocked(r.live, 'you blorft')).toBe(true);
  });
});

describe('change: terms', () => {
  it('adding a term blocks it on the next match, and returns the new id', async () => {
    const r = await loaded();
    const res = await r.live.change('alice', (e) => e.addTerm({ term: 'Blorft', language: 'en', note: 'n' }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toMatch(ID);
    expect(r.live.match('what a blorft')).toEqual({ termId: res.value });
    expect(r.store.state.terms.at(-1)).toMatchObject({
      id: res.value, term: 'blorft', language: 'en', active: true, note: 'n', addedBy: 'alice', addedAt: T0,
      updatedBy: null, updatedAt: null,
    });
  });

  it('disabling unblocks, enabling blocks again', async () => {
    const r = await loaded();
    expect(blocked(r.live, 'you snerp')).toBe(true);
    await r.live.change('a', (e) => e.setTermActive('syn:snerp', false));
    expect(blocked(r.live, 'you snerp')).toBe(false);
    await r.live.change('a', (e) => e.setTermActive('syn:snerp', true));
    expect(blocked(r.live, 'you snerp')).toBe(true);
  });

  it('updateTerm changes only the patched fields and stamps updatedBy and updatedAt', async () => {
    const r = await loaded();
    r.clock.t = T0 + 50;
    await r.live.change('bob', (e) => e.updateTerm('syn:snerp', { note: 'hello' }));
    expect(r.store.state.terms.find((t) => t.id === 'syn:snerp')).toMatchObject({
      term: 'snerp', language: 'en', note: 'hello', updatedBy: 'bob', updatedAt: T0 + 50, addedBy: 'seed',
    });
  });

  it('a note can be cleared with null', async () => {
    const r = await loaded();
    await r.live.change('bob', (e) => e.updateTerm('syn:snerp', { note: 'x' }));
    await r.live.change('bob', (e) => e.updateTerm('syn:snerp', { note: null }));
    expect(r.store.state.terms.find((t) => t.id === 'syn:snerp')!.note).toBeNull();
  });

  it('editing the word re-points the live matcher', async () => {
    const r = await loaded();
    const res = await r.live.change('a', (e) => e.updateTerm('syn:snerp', { term: 'Blörft' }));
    expect(res.ok).toBe(true);
    expect(blocked(r.live, 'you snerp')).toBe(false);
    expect(r.live.match('you blorft')).toEqual({ termId: 'syn:snerp' });
    expect(r.store.state.terms.find((t) => t.id === 'syn:snerp')!.term).toBe('blorft');
  });

  it('a no-op toggle or empty patch writes nothing and no audit row', async () => {
    const r = await loaded();
    const res = await r.live.change('a', (e) => {
      e.setTermActive('syn:snerp', true);
      e.updateTerm('syn:snerp', {});
      e.setExceptionActive('syn-ex:tarvo-lake', true);
      e.updateException('syn-ex:tarvo-lake', {});
    });
    expect(res.ok).toBe(true);
    expect(r.store.state.audit).toEqual([]);
    expect(r.store.state.terms.find((t) => t.id === 'syn:snerp')!.updatedBy).toBeNull();
  });

  it('a malformed term is refused: rows and audit unchanged, old terms still block', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    for (const bad of ['a b', 'zz', 'aaaa', 'x[yz', '', '   ', 'blorft!', 'bl0rft5']) {
      const res = await r.live.change('a', (e) => e.addTerm({ term: bad, language: 'en' }));
      expect(res.ok, bad).toBe(false);
    }
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
  });

  it('the refusal names the problem and the row, not the term', async () => {
    const r = await loaded();
    const res = await r.live.change('a', (e) => e.addTerm({ term: 'snoddle wumpity', language: 'en' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/single word of plain letters/);
    expect(res.error.toLowerCase()).not.toContain('snoddle');
    expect(res.error.toLowerCase()).not.toContain('wumpity');
  });

  it('editing an existing term to a malformed word rolls the edit back; the old word still blocks', async () => {
    const r = await loaded();
    const res = await r.live.change('a', (e) => e.updateTerm('syn:snerp', { term: 'two words' }));
    expect(res.ok).toBe(false);
    expect(r.store.state.terms.find((t) => t.id === 'syn:snerp')!.term).toBe('snerp');
    expect(blocked(r.live, 'you snerp')).toBe(true);
    expect(r.store.state.audit).toEqual([]);
  });

  it('change refuses removing the last active term and leaves rows unchanged', async () => {
    const pack = syntheticTermPack({ terms: [syntheticTermPack().terms[0]!], exceptions: [] });
    const r = await loaded({ pack });
    const before = structuredClone(r.store.state);
    const res = await r.live.change('a', (e) => e.setTermActive('syn:zorbak', false));
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/no active term/) });
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
  });

  it('refuses disabling every term in one change, but allows disabling all but one', async () => {
    const r = await loaded();
    const ids = SYNTHETIC_TERMS.map((t) => t.id);
    const all = await r.live.change('a', (e) => ids.forEach((id) => e.setTermActive(id, false)));
    expect(all.ok).toBe(false);
    expect(activeIds(r)).toHaveLength(ids.length);
    const allButOne = await r.live.change('a', (e) => ids.slice(1).forEach((id) => e.setTermActive(id, false)));
    expect(allButOne.ok).toBe(true);
    expect(activeIds(r)).toEqual([ids[0]]);
    // and now the last one cannot go
    expect((await r.live.change('a', (e) => e.setTermActive(ids[0]!, false))).ok).toBe(false);
  });

  it('disabling the last term and adding another in the same change is fine', async () => {
    const pack = syntheticTermPack({ terms: [syntheticTermPack().terms[0]!], exceptions: [] });
    const r = await loaded({ pack });
    const res = await r.live.change('a', (e) => {
      e.setTermActive('syn:zorbak', false);
      e.addTerm({ term: 'blorft', language: 'en' });
    });
    expect(res.ok).toBe(true);
    expect(blocked(r.live, 'you blorft')).toBe(true);
    expect(blocked(r.live, 'you zorbak')).toBe(false);
  });

  it('updating or toggling a missing id is refused and writes nothing', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    for (const fn of [
      (e: TermEditor) => e.updateTerm('nope', { note: 'x' }),
      (e: TermEditor) => e.setTermActive('nope', false),
      (e: TermEditor) => e.updateException('nope', { note: 'x' }),
      (e: TermEditor) => e.setExceptionActive('nope', false),
    ]) {
      const res = await r.live.change('a', fn);
      expect(res).toEqual({ ok: false, error: expect.stringMatching(/not found: nope/) });
    }
    expect(r.store.state).toEqual(before);
  });

  it('a refused step undoes the steps before it in the same change', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    const res = await r.live.change('a', (e) => {
      e.setTermActive('syn:snerp', false);
      e.addTerm({ term: 'blorft', language: 'en' });
      e.addTerm({ term: 'x y', language: 'en' });
    });
    expect(res.ok).toBe(false);
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you snerp')).toBe(true);
    expect(blocked(r.live, 'you blorft')).toBe(false);
  });

  it('a throw from the change function rolls back, rejects with that error, and leaves the matcher in step', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    await expect(
      r.live.change('a', (e) => {
        e.addTerm({ term: 'blorft', language: 'en' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you blorft')).toBe(false);
    // not stuck
    expect((await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }))).ok).toBe(true);
  });

  it('an async change function is refused loudly and nothing is written', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    await expect(
      r.live.change('a', (async (e: TermEditor) => {
        e.addTerm({ term: 'blorft', language: 'en' });
        await Promise.resolve();
      }) as never),
    ).rejects.toThrow(/synchronous/);
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you blorft')).toBe(false);
  });

  it('two changes started together both apply, in order', async () => {
    const r = await loaded();
    const [a, b] = await Promise.all([
      r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' })),
      r.live.change('b', (e) => e.addTerm({ term: 'snoddle', language: 'en' })),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(blocked(r.live, 'blorft')).toBe(true);
    expect(blocked(r.live, 'snoddle')).toBe(true);
  });

  it('the store failing during validation refuses the change and keeps the old matcher', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    r.store.fail = (m) => {
      if (m === 'listExceptions') throw new Error('read failed');
    };
    const res = await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }));
    r.store.fail = () => {};
    expect(res.ok).toBe(false);
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you blorft')).toBe(false);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
  });

  it('a commit that fails reports not ok, rolls back, and the matcher mirrors the store', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    const real = r.store.transaction.bind(r.store);
    r.store.transaction = <T>(fn: () => T): T =>
      real(() => {
        fn();
        throw new Error('release failed');
      });
    const res = await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }));
    expect(res.ok).toBe(false);
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you blorft')).toBe(false);
    r.store.transaction = real;
    expect((await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }))).ok).toBe(true);
    expect(blocked(r.live, 'you blorft')).toBe(true);
  });

  it('works when the caller already holds a transaction on the store', async () => {
    const r = await loaded();
    const outer = r.store.transaction(() => {
      // change() is async but its writes are synchronous, so it can start inside a caller's transaction
      return r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }));
    });
    expect((await outer).ok).toBe(true);
    expect(blocked(r.live, 'you blorft')).toBe(true);
  });
});

describe('change before load', () => {
  it('with a pack configured, change() before load() is refused as "not loaded": fn never runs, nothing is written', async () => {
    const r = rig();
    const fn = vi.fn((e: TermEditor) => e.addTerm({ term: 'Blorft', language: 'en' }));
    const res = await r.live.change('alice', fn);
    expect(res).toEqual({ ok: false, error: 'not loaded' });
    expect(fn).not.toHaveBeenCalled();
    expect(r.store.state.terms).toEqual([]);
    expect(r.store.state.exceptions).toEqual([]);
    expect(r.store.state.audit).toEqual([]);
    expect(r.store.state.seeded).toEqual([]);
    expect(r.warn).not.toHaveBeenCalled();
  });

  it('the pack still blocks in the meantime, and the same change works after load() (control)', async () => {
    const r = rig();
    expect(blocked(r.live, 'you zorbak')).toBe(true);
    await r.live.change('alice', (e) => e.addTerm({ term: 'Blorft', language: 'en' }));
    await r.live.load();
    const res = await r.live.change('alice', (e) => e.addTerm({ term: 'Blorft', language: 'en' }));
    expect(res.ok).toBe(true);
    expect(blocked(r.live, 'what a blorft')).toBe(true);
    expect(r.store.state.audit).toHaveLength(1);
  });

  it('a rejecting fn is also not run before load (it cannot throw its error out)', async () => {
    const r = rig();
    await expect(
      r.live.change('alice', () => {
        throw new Error('should not run');
      }),
    ).resolves.toEqual({ ok: false, error: 'not loaded' });
  });

  it('with no pack configured the store is the truth, so change() works without load()', async () => {
    const r = rig({ pack: null });
    await r.live.load();
    const res = await r.live.change('alice', (e) => e.addTerm({ term: 'Blorft', language: 'en' }));
    expect(res.ok).toBe(true);
  });
});

describe('change: exceptions', () => {
  it('an exception shields a term match after the change; disabling it blocks again; editing moves it', async () => {
    const r = await loaded();
    expect(blocked(r.live, 'the vlemmo bay')).toBe(true);
    const add = await r.live.change('a', (e) => e.addException({ phrase: 'The Vlemmo  Bay', language: 'en' }));
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect(add.value).toMatch(ID);
    expect(r.store.state.exceptions.at(-1)!.phrase).toBe('the vlemmo bay');
    expect(blocked(r.live, 'the vlemmo bay')).toBe(false);
    await r.live.change('a', (e) => e.setExceptionActive(add.value, false));
    expect(blocked(r.live, 'the vlemmo bay')).toBe(true);
    await r.live.change('a', (e) => e.setExceptionActive(add.value, true));
    await r.live.change('a', (e) => e.updateException(add.value, { phrase: 'the vlemmo coast' }));
    expect(blocked(r.live, 'the vlemmo bay')).toBe(true);
    expect(blocked(r.live, 'the vlemmo coast')).toBe(false);
  });

  it('an empty or blank phrase is refused and rolled back', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    for (const phrase of ['', '   ', '\t\n']) {
      expect((await r.live.change('a', (e) => e.addException({ phrase, language: 'en' }))).ok).toBe(false);
    }
    expect(r.store.state).toEqual(before);
  });

  it('exception canary refuses an exception that unblocks a positive line', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    const res = await r.live.change('a', (e) => e.addException({ phrase: 'zorbak', language: 'en' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/would unblock/);
    expect(res.error).toContain('syn:zorbak');
    expect(res.error.toLowerCase()).not.toContain('zorbak!');
    expect(r.store.state).toEqual(before);
    expect(blocked(r.live, 'you zorbak')).toBe(true);
  });

  it('the canary also catches an exception that shields one line only', async () => {
    const r = await loaded();
    const res = await r.live.change('a', (e) => e.addException({ phrase: 'you fenrisk', language: 'en' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('syn:fenrisk');
  });

  it('the canary also guards editing an exception', async () => {
    const r = await loaded();
    const add = await r.live.change('a', (e) => e.addException({ phrase: 'blorft stew', language: 'en' }));
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const res = await r.live.change('a', (e) => e.updateException(add.value, { phrase: 'quissel' }));
    expect(res.ok).toBe(false);
    expect(r.store.state.exceptions.at(-1)!.phrase).toBe('blorft stew');
    expect(blocked(r.live, 'you quissel')).toBe(true);
  });

  it('the canary also guards re-enabling an exception', async () => {
    const r = await loaded();
    // Smuggle a shielding exception into the store as a disabled row, then try to switch it on.
    r.store.state.exceptions.push({
      id: 'bad', phrase: 'drakkuun', language: 'en', active: false, note: null, addedBy: 'x', addedAt: 1, updatedBy: null, updatedAt: null,
    });
    await r.live.load();
    const res = await r.live.change('a', (e) => e.setExceptionActive('bad', true));
    expect(res.ok).toBe(false);
    expect(blocked(r.live, 'you drakkuun')).toBe(true);
  });

  it('control: a legitimate exception passes the canary', async () => {
    const r = await loaded();
    for (const phrase of ['blorft stew', 'glarn quissel', 'a vlemmo bay', 'unrelated words here']) {
      expect((await r.live.change('a', (e) => e.addException({ phrase, language: 'en' }))).ok, phrase).toBe(true);
    }
  });

  it('control: the whole shipped pack passes its own canary, and an ordinary change goes through', async () => {
    const r = await loaded();
    expect((await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }))).ok).toBe(true);
  });

  it('the canary only counts lines the terms alone block: an exception for a disabled term is fine', async () => {
    const r = await loaded();
    const res = await r.live.change('a', (e) => {
      e.setTermActive('syn:snerp', false);
      e.addException({ phrase: 'snerp', language: 'en' });
    });
    expect(res.ok).toBe(true);
    expect(blocked(r.live, 'you snerp')).toBe(false);
  });

  it('with no pack there is no canary', async () => {
    const r = await loaded({ pack: null });
    await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }));
    expect((await r.live.change('a', (e) => e.addException({ phrase: 'blorft', language: 'en' }))).ok).toBe(true);
  });
});

describe('duplicates (same folded form)', () => {
  const dupTerm = async (r: Rig, term: string, language = 'en') =>
    r.live.change('a', (e) => e.addTerm({ term, language }));

  it('duplicate term (same folded form) refused', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    for (const variant of ['zorbak', 'ZORBAK', '  zorbak ', 'zórbak', 'Zörbäk']) {
      const res = await dupTerm(r, variant);
      expect(res.ok, variant).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/duplicate term: matches existing row syn:zorbak/);
    }
    expect(r.store.state).toEqual(before);
  });

  it('is refused in any language', async () => {
    const r = await loaded();
    expect((await dupTerm(r, 'zorbak', 'pt')).ok).toBe(false);
  });

  it('repeated letters the matcher collapses count as the same word', async () => {
    const r = await loaded();
    expect((await dupTerm(r, 'vlemo')).ok).toBe(false);
    expect((await dupTerm(r, 'vlemmmo')).ok).toBe(false);
    expect((await dupTerm(r, 'drakun')).ok).toBe(false);
  });

  it('a letter the matcher keeps doubled is a different word, and accepted', async () => {
    const r = await loaded();
    expect((await dupTerm(r, 'quisel')).ok).toBe(true);
  });

  it('a different word is accepted', async () => {
    const r = await loaded();
    expect((await dupTerm(r, 'blorft')).ok).toBe(true);
  });

  it('an inactive row still blocks a duplicate', async () => {
    const r = await loaded();
    await r.live.change('a', (e) => e.setTermActive('syn:snerp', false));
    expect((await dupTerm(r, 'snerp')).ok).toBe(false);
  });

  it('updateTerm cannot rename a row onto another row word, but may re-case its own', async () => {
    const r = await loaded();
    const mine = await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }));
    if (!mine.ok) throw new Error('setup');
    expect((await r.live.change('a', (e) => e.updateTerm(mine.value, { term: 'ZORBAK' }))).ok).toBe(false);
    expect((await r.live.change('a', (e) => e.updateTerm(mine.value, { term: 'BLORFT' }))).ok).toBe(true);
    expect(r.store.state.terms.find((t) => t.id === mine.value)!.term).toBe('blorft');
  });

  it('two additions of the same word in one change: the second is refused and both undone', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    const res = await r.live.change('a', (e) => {
      e.addTerm({ term: 'blorft', language: 'en' });
      e.addTerm({ term: 'Blorft', language: 'en' });
    });
    expect(res.ok).toBe(false);
    expect(r.store.state).toEqual(before);
  });

  it('exception phrases: case and whitespace variants are refused, a different phrase accepted', async () => {
    const r = await loaded();
    for (const phrase of ['tarvo lake', 'TARVO LAKE', '  tarvo   lake ']) {
      const res = await r.live.change('a', (e) => e.addException({ phrase, language: 'en' }));
      expect(res.ok, phrase).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/duplicate exception: matches existing row syn-ex:tarvo-lake/);
    }
    expect((await r.live.change('a', (e) => e.addException({ phrase: 'tarvo pond', language: 'en' }))).ok).toBe(true);
  });

  it('updateException cannot collide, but may re-case its own', async () => {
    const r = await loaded();
    expect((await r.live.change('a', (e) => e.updateException('syn-ex:tarvo-lake', { phrase: 'Glarn  Zorbak' }))).ok).toBe(false);
    expect((await r.live.change('a', (e) => e.updateException('syn-ex:tarvo-lake', { phrase: 'TARVO LAKE' }))).ok).toBe(true);
    expect(r.store.state.exceptions[0]!.phrase).toBe('tarvo lake');
  });

  it('rows come back in insertion order', async () => {
    const r = await loaded();
    await r.live.change('a', (e) => {
      e.addTerm({ term: 'blorft', language: 'en' });
      e.addTerm({ term: 'snoddle', language: 'en' });
    });
    expect(r.live.rows.terms.slice(-2).map((t) => t.term)).toEqual(['blorft', 'snoddle']);
  });
});

describe('audit trail', () => {
  it('audit row per change: add, edit, disable, enable, each with before and after', async () => {
    const r = await loaded();
    const added = await r.live.change('alice', (e) => e.addTerm({ term: 'blorft', language: 'en', note: 'n' }));
    if (!added.ok) throw new Error('setup');
    const id = added.value;
    expect(r.store.state.audit).toHaveLength(1);
    expect(r.store.state.audit[0]).toMatchObject({
      at: T0, actor: 'alice', action: 'add', subjectType: 'term', subjectRef: id, beforeJson: null,
    });
    expect(JSON.parse(r.store.state.audit[0]!.afterJson)).toMatchObject({ id, term: 'blorft', language: 'en', active: true, note: 'n' });

    r.clock.t = T0 + 1;
    await r.live.change('bob', (e) => e.updateTerm(id, { note: 'm' }));
    r.clock.t = T0 + 2;
    await r.live.change('bob', (e) => e.setTermActive(id, false));
    r.clock.t = T0 + 3;
    await r.live.change('carol', (e) => e.setTermActive(id, true));
    const rows = r.store.state.audit;
    expect(rows.map((a) => [a.at, a.actor, a.action])).toEqual([
      [T0, 'alice', 'add'],
      [T0 + 1, 'bob', 'edit'],
      [T0 + 2, 'bob', 'disable'],
      [T0 + 3, 'carol', 'enable'],
    ]);
    expect(JSON.parse(rows[1]!.beforeJson!).note).toBe('n');
    expect(JSON.parse(rows[1]!.afterJson).note).toBe('m');
    expect(JSON.parse(rows[2]!.beforeJson!).active).toBe(true);
    expect(JSON.parse(rows[2]!.afterJson).active).toBe(false);
    expect(JSON.parse(rows[3]!.beforeJson!).active).toBe(false);
    expect(JSON.parse(rows[3]!.afterJson).active).toBe(true);
    expect(rows.every((a) => a.subjectType === 'term' && a.subjectRef === id)).toBe(true);
  });

  it('exception writes audit with subjectType exception and the row id', async () => {
    const r = await loaded();
    const add = await r.live.change('alice', (e) => e.addException({ phrase: 'blorft stew', language: 'en' }));
    if (!add.ok) throw new Error('setup');
    await r.live.change('alice', (e) => e.updateException(add.value, { phrase: 'blorft soup' }));
    await r.live.change('alice', (e) => e.setExceptionActive(add.value, false));
    await r.live.change('alice', (e) => e.setExceptionActive(add.value, true));
    const rows = r.store.state.audit;
    expect(rows.map((a) => a.action)).toEqual(['add', 'edit', 'disable', 'enable']);
    expect(rows.every((a) => a.subjectType === 'exception' && a.subjectRef === add.value)).toBe(true);
    expect(rows[0]!.beforeJson).toBeNull();
    expect(JSON.parse(rows[0]!.afterJson)).toMatchObject({ id: add.value, phrase: 'blorft stew', active: true });
    expect(JSON.parse(rows[1]!.beforeJson!).phrase).toBe('blorft stew');
    expect(JSON.parse(rows[1]!.afterJson).phrase).toBe('blorft soup');
  });

  it('a change with several steps writes one audit row per step', async () => {
    const r = await loaded();
    await r.live.change('a', (e) => {
      e.addTerm({ term: 'blorft', language: 'en' });
      e.setTermActive('syn:snerp', false);
      e.addException({ phrase: 'blorft stew', language: 'en' });
    });
    expect(r.store.state.audit.map((a) => [a.subjectType, a.action])).toEqual([
      ['term', 'add'],
      ['term', 'disable'],
      ['exception', 'add'],
    ]);
  });

  it('a refused change leaves the audit exactly as it was', async () => {
    const r = await loaded();
    await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }));
    const before = structuredClone(r.store.state.audit);
    const res = await r.live.change('a', (e) => {
      e.setTermActive('syn:snerp', false);
      e.addTerm({ term: 'snoddle', language: 'en' });
      e.addTerm({ term: 'x y', language: 'en' });
    });
    expect(res.ok).toBe(false);
    expect(r.store.state.audit).toEqual(before);
  });

  it('hits are stored in after_json next to the row; no hits argument means no hits key', async () => {
    const r = await loaded();
    const t = await r.live.change('a', (e) => e.addTerm({ term: 'blorft', language: 'en' }, ['line one', 'line two']));
    const x = await r.live.change('a', (e) => e.addException({ phrase: 'blorft stew', language: 'en' }, ['stew']));
    if (!t.ok || !x.ok) throw new Error('setup');
    await r.live.change('a', (e) => e.updateTerm(t.value, { note: 'n' }, ['edited']));
    await r.live.change('a', (e) => e.updateException(x.value, { note: 'n' }, ['edited too']));
    await r.live.change('a', (e) => e.addTerm({ term: 'snoddle', language: 'en' }));
    const after = r.store.state.audit.map((a) => JSON.parse(a.afterJson) as Record<string, unknown>);
    expect(after[0]!.hits).toEqual(['line one', 'line two']);
    expect(after[1]!.hits).toEqual(['stew']);
    expect(after[2]!.hits).toEqual(['edited']);
    expect(after[3]!.hits).toEqual(['edited too']);
    expect('hits' in after[4]!).toBe(false);
  });
});

describe('check', () => {
  const pack = (over: Partial<TermPack> = {}) => syntheticTermPack(over);

  it('check reports negative-corpus hits and ignores known losses', async () => {
    const r = await loaded({ pack: pack({ knownLosses: ['zorba!'] }) });
    const res = r.live.check('zorba', 'en', []);
    expect(res).toEqual({ ok: true, hits: ['zorba'] });
  });

  it('without known losses the same candidate hits both lines', async () => {
    const r = await loaded();
    const res = r.live.check('zorba', 'en', []);
    expect(res.ok && res.hits.sort()).toEqual(['zorba', 'zorba!']);
  });

  it('a harmless unrelated word has no hits', async () => {
    const r = await loaded();
    expect(r.live.check('blorft', 'en', [])).toEqual({ ok: true, hits: [] });
  });

  it('also checks recent lines, deduplicated against the corpus', async () => {
    const r = await loaded();
    const res = r.live.check('zorba', 'en', ['we like zorba a lot', 'zorba', 'nothing here']);
    expect(res.ok && res.hits.sort()).toEqual(['we like zorba a lot', 'zorba', 'zorba!']);
  });

  it('never reports a known-loss line, from the corpus or from recent lines', async () => {
    const r = await loaded({ pack: pack({ knownLosses: ['zorba', 'we like zorba a lot'] }) });
    const res = r.live.check('zorba', 'en', ['we like zorba a lot', 'she said zorba']);
    expect(res.ok && res.hits.sort()).toEqual(['she said zorba', 'zorba!']);
  });

  it('does not report a hit that an active exception already shields', async () => {
    const r = await loaded();
    // the corpus holds "tarvo lake" lines; the pack exception shields them
    expect(r.live.check('tarvo', 'en', [])).toEqual({ ok: true, hits: [] });
    await r.live.change('a', (e) => e.setExceptionActive('syn-ex:tarvo-lake', false));
    const res = r.live.check('tarvo', 'en', []);
    expect(res.ok && res.hits).toContain('tarvo lake');
  });

  it('a candidate that cannot be built is an error result, not a throw, and does not quote it', async () => {
    const r = await loaded();
    for (const bad of ['two words', 'zz', '', 'x[y']) {
      const res = r.live.check(bad, 'en', []);
      expect(res.ok, bad).toBe(false);
    }
    const res = r.live.check('snoddle wumpity', 'en', []);
    expect(res.ok === false && res.error.toLowerCase()).not.toContain('snoddle');
  });

  it('uses the candidate alone: existing terms do not show up as hits', async () => {
    const r = await loaded({ pack: pack({ negativeCorpus: ['you zorbak', 'plain words'] }) });
    expect(r.live.check('blorft', 'en', [])).toEqual({ ok: true, hits: [] });
    expect(r.live.check('zorbak', 'en', [])).toEqual({ ok: true, hits: ['you zorbak'] });
  });

  it('with no pack the corpus is empty and only recent lines count', async () => {
    const r = await loaded({ pack: null });
    expect(r.live.check('blorft', 'en', ['a blorft', 'b'])).toEqual({ ok: true, hits: ['a blorft'] });
  });

  it('is a dry run: it writes nothing', async () => {
    const r = await loaded();
    const before = structuredClone(r.store.state);
    r.live.check('blorft', 'en', ['blorft']);
    expect(r.store.state).toEqual(before);
  });
});
