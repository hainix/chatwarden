import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryNames } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { BlockedNameRow, Matcher, ProfanityFilter, RawWho, Store } from '../src/types.js';
import { HOUR, NOW, world } from './reportingWorld.js';
import type { Logged } from './reportingWorld.js';

// cw.names.check, extended: the profanity pass, kept evidence (opt in, capped), `who`, and the evidence-free `flagged` read.
// Synthetic terms only: zorbak (a slur-list term here) and snerp (a profanity-list word here).

/** A matcher that reads a name the way the real one does (hidden characters off, accents and a few look-alikes folded, split into words). */
const LOOKALIKE: Record<string, string> = { '\u043e': 'o', '\u0430': 'a', '\u0435': 'e', '\u0441': 'c', '\u0585': 'o' };
const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u200b-\u200f\u202a-\u202e\u2060\ufeff\u00ad]/g, '')
    .replace(/[\u043e\u0430\u0435\u0441\u0585]/g, (c) => LOOKALIKE[c] as string)
    .toLowerCase();
const wordIn = (view: string, word: string): boolean => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(view);

function fakeMatcher(): Matcher & { names: string[] } {
  const names: string[] = [];
  const hit = (n: string) => (wordIn(fold(n).replace(/[_\d]+/g, ' '), 'zorbak') ? { termId: 'syn:zorbak' } : null);
  return { names, match: (t) => hit(t), matchName: (n) => (names.push(n), hit(n)) };
}

/** A profanity filter for the one synthetic word, as the real one reads a LINE: a whole word, where `_` and digits are word characters. */
function fakeFilter(): ProfanityFilter & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    apply: (text) => {
      seen.push(text);
      const hit = /(^|[^\p{L}\p{N}_])snerp([^\p{L}\p{N}_]|$)/iu.test(fold(text));
      return { hit, text };
    },
  };
}

type NamesStore = ReturnType<typeof withMemoryNames<MemoryStore>>;

/** A store that records every blocked-name write (and can be told to fail one). */
function spyStore(): NamesStore & { inserted: BlockedNameRow[]; failNext?: Error; reads: number } {
  const store = withMemoryNames(new MemoryStore()) as NamesStore & { inserted: BlockedNameRow[]; failNext?: Error; reads: number };
  store.inserted = [];
  store.reads = 0;
  const insert = store.insertBlockedName.bind(store);
  store.insertBlockedName = (row) => {
    if (store.failNext !== undefined) {
      const e = store.failNext;
      store.failNext = undefined;
      throw e;
    }
    store.inserted.push(structuredClone(row));
    insert(row);
  };
  const list = store.listBlockedNames.bind(store);
  store.listBlockedNames = (since, limit) => {
    store.reads += 1;
    return list(since, limit);
  };
  return store;
}

async function names(over: Partial<ChatwardenOptions> = {}, settings: Record<string, unknown> = {}, store: Store = new MemoryStore()) {
  return world({ matcher: fakeMatcher(), profanity: fakeFilter(), ...over, overrides: { names: settings, ...(over.overrides ?? {}) } }, store);
}

const OFF = { ok: true } as const;
const SLUR = { ok: false, reason: 'name_not_allowed', rule: 1 } as const;
const PROFANE = { ok: false, reason: 'name_profane', rule: 1 } as const;

describe('unchanged with names.profanity off', () => {
  it('an allowed name; a name blocked by the matcher, in every handle form of the synthetic term', async () => {
    const { cw } = await names();
    for (const n of ['Zorbak_99', 'x_zorbak', 'zorbak123', 'ZORBAK', 'big zorbak', 'ZoRbAk', 'zorbak', '_zorbak_', '99zorbak99']) expect(cw.names.check(n), n).toEqual(SLUR);
    for (const n of ['Alice', 'quill_42', 'Nightowl', 'tarvo', 'fenrisk_7']) expect(cw.names.check(n), n).toEqual(OFF);
  });

  it('unicode look-alikes, hidden characters and full-width letters are read as the matcher reads them (the kit passes the name through whole)', async () => {
    const m = fakeMatcher();
    const { cw } = await names({ matcher: m });
    const variants = ['zorbak', 'z\u200borbak', 'zor\u2060bak', 'z\u043erbak', '\uff5a\uff4f\uff52\uff42\uff41\uff4b', 'Z\u00f3rbak', 'zor\u00adbak', '\u202ezorbak', 'zorbak\ufeff'];
    for (const v of variants) expect(cw.names.check(v), JSON.stringify(v)).toEqual(SLUR);
    expect(m.names).toEqual(variants);
  });

  it('a name that contains the term inside a longer word, or is a part of it, is the matcher\'s call (whole words only here)', async () => {
    const { cw } = await names();
    for (const n of ['zorbakian', 'xzorbak', 'zorba', 'orbak', 'zorbaks']) expect(cw.names.check(n), n).toEqual(OFF);
  });

  it('empty, whitespace-only and very long names answer and never throw', async () => {
    const { cw } = await names();
    expect(cw.names.check('')).toEqual(OFF);
    expect(cw.names.check('   \u200b ')).toEqual(OFF);
    expect(cw.names.check('a'.repeat(200_000))).toEqual(OFF);
    expect(cw.names.check(`${'a'.repeat(50_000)} zorbak`)).toEqual(SLUR);
    expect(cw.names.check('\ud800')).toEqual(OFF);
    expect(cw.names.check('x\u0000zorbak')).toEqual(SLUR);
  });

  it('no matcher lets every name through; a throwing matcher lets it through and logs the class only', async () => {
    const none = await names({ matcher: undefined });
    expect(none.cw.names.check('Zorbak_99')).toEqual(OFF);
    const boom = await names({
      matcher: {
        match: () => {
          throw new RangeError('secret zorbak term');
        },
      },
    });
    expect(boom.cw.names.check('Alice')).toEqual(OFF);
    expect(boom.logged).toContainEqual(['chatwarden.names_matcher_failed', { error: 'RangeError' }]);
    expect(JSON.stringify(boom.logged)).not.toContain('secret');
  });

  it('a matcher that answers undefined (from match or from matchName) is no hit: the name passes, flagged is false, nothing is logged', async () => {
    const viaMatch = await names({ matcher: { match: () => undefined as never } });
    const viaName = await names({ matcher: { match: () => ({ termId: 'x' }), matchName: () => undefined as never } });
    for (const { cw, logged } of [viaMatch, viaName]) {
      for (const n of ['Alice', 'Zorbak_99', '']) {
        expect(cw.names.check(n), n).toEqual(OFF);
        expect(cw.names.flagged(n), n).toBe(false);
      }
      expect(logged).toEqual([]);
    }
  });

  it('control: a hit object with no termId still blocks, with a null term; an undefined answer does not stop the profanity pass', async () => {
    const noTerm = await names({ matcher: { match: () => ({}) as never } }, { keepBlocked: true });
    expect(noTerm.cw.names.check('Alice', { who: { clientKey: 'k1' } })).toEqual(SLUR);
    expect(noTerm.cw.names.flagged('Alice')).toBe(true);
    const undef = await names({ matcher: { match: () => undefined as never } }, { profanity: true });
    expect(undef.cw.names.check('snerp')).toEqual(PROFANE);
    expect(undef.cw.names.check('Alice')).toEqual(OFF);
  });

  it('a non-string is a TypeError, with or without who', async () => {
    const { cw } = await names();
    for (const bad of [undefined, null, 5, {}, ['zorbak'], Symbol('x')]) {
      expect(() => cw.names.check(bad as never)).toThrow(TypeError);
      expect(() => cw.names.check(bad as never, { who: { clientKey: 'k' } })).toThrow(TypeError);
    }
  });

  it('the answer holds no name, term id or subject; the rule is the configured autoRestrictRule', async () => {
    const { cw } = await names({ autoRestrictRule: 1 });
    const out = JSON.stringify(cw.names.check('Zorbak_99'));
    expect(out).not.toMatch(/syn:|Zorbak|s_/);
    const profane = await names({}, { profanity: true });
    expect(JSON.stringify(profane.cw.names.check('snerp'))).toBe('{"ok":false,"reason":"name_profane","rule":1}');
  });

  it('the old one-argument call and a call with an empty options object agree', async () => {
    const { cw } = await names();
    for (const n of ['Zorbak_99', 'Alice']) expect(cw.names.check(n, {})).toEqual(cw.names.check(n));
  });
});

describe('the profanity pass', () => {
  it('is off by default: the filter is never asked about a name', async () => {
    const f = fakeFilter();
    const { cw } = await names({ profanity: f });
    expect(cw.names.check('snerp')).toEqual(OFF);
    expect(cw.names.check('big_snerp_9')).toEqual(OFF);
    expect(f.seen).toEqual([]);
  });

  it('on: a profane name is name_profane with the slur rule, a clean one is allowed', async () => {
    const { cw } = await names({}, { profanity: true });
    expect(cw.names.check('snerp')).toEqual(PROFANE);
    expect(cw.names.check('Big Snerp')).toEqual(PROFANE);
    expect(cw.names.check('SNERP!!')).toEqual(PROFANE);
    for (const n of ['Alice', 'quill_42', 'snerpy', 'asnerp', '', 'tarvo']) expect(cw.names.check(n), n).toEqual(OFF);
  });

  it('on: underscores and digits are read as spaces (the name is also asked with them turned into spaces)', async () => {
    const f = fakeFilter();
    const { cw } = await names({ profanity: f }, { profanity: true });
    for (const n of ['big_snerp_99', 'snerp99', '42snerp', 'x__snerp__x', 'snerp_']) expect(cw.names.check(n), n).toEqual(PROFANE);
    // Both views reach the filter: the name as typed, then the name with `_` and digits as spaces.
    f.seen.length = 0;
    cw.names.check('a_b1c');
    expect(f.seen).toEqual(['a_b1c', 'a b c']);
  });

  it('on: hidden characters, case and look-alikes are the filter\'s business and are passed whole', async () => {
    const { cw } = await names({}, { profanity: true });
    for (const n of ['s\u200bnerp', 'SnErP', 'sn\u0435rp', 'sne\u2060rp']) expect(cw.names.check(n), JSON.stringify(n)).toEqual(PROFANE);
  });

  it('on: a matcher hit wins over a profane hit, and a clean-by-matcher profane name is profane', async () => {
    const { cw } = await names({}, { profanity: true });
    expect(cw.names.check('zorbak_snerp')).toEqual(SLUR);
    expect(cw.names.check('snerp zorbak')).toEqual(SLUR);
    expect(cw.names.check('zorbak')).toEqual(SLUR);
    expect(cw.names.check('snerp')).toEqual(PROFANE);
  });

  it('on: a throwing filter lets the name through (class only in the log); a throwing matcher still leaves the profanity pass', async () => {
    const { cw, logged } = await names(
      {
        profanity: {
          apply: () => {
            throw new TypeError('secret snerp list');
          },
        },
      },
      { profanity: true },
    );
    expect(cw.names.check('snerp')).toEqual(OFF);
    expect(cw.names.check('zorbak')).toEqual(SLUR);
    expect(logged).toContainEqual(['chatwarden.names_filter_failed', { error: 'TypeError' }]);
    expect(JSON.stringify(logged)).not.toMatch(/secret|snerp/);
    const m = await names(
      {
        matcher: {
          match: () => {
            throw new RangeError('x');
          },
        },
      },
      { profanity: true },
    );
    expect(m.cw.names.check('snerp')).toEqual(PROFANE);
    expect(m.logged).toContainEqual(['chatwarden.names_matcher_failed', { error: 'RangeError' }]);
  });

  it('on with no filter configured lets every name through', async () => {
    const { cw } = await names({ profanity: undefined }, { profanity: true });
    expect(cw.names.check('snerp')).toEqual(OFF);
  });

  it('on with a profanity package and a profile that allows swearing: the filter is built for names, once, from the profile config', async () => {
    const built: unknown[] = [];
    const f = fakeFilter();
    const { cw } = await names(
      { profanity: undefined, profanityPackage: { createProfanityFilter: (c) => (built.push(c), f) }, overrides: { profanity: { mode: 'allow' } } },
      { profanity: true },
    );
    expect(built).toHaveLength(0);
    expect(cw.names.check('snerp')).toEqual(PROFANE);
    expect(cw.names.check('Alice')).toEqual(OFF);
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ mode: 'allow' });
  });

  it('a package that cannot build the filter lets names through and logs the class', async () => {
    const { cw, logged } = await names(
      {
        profanity: undefined,
        profanityPackage: {
          createProfanityFilter: () => {
            throw new RangeError('x');
          },
        },
        overrides: { profanity: { mode: 'allow' } },
      },
      { profanity: true },
    );
    expect(cw.names.check('snerp')).toEqual(OFF);
    expect(logged).toContainEqual(['chatwarden.names_filter_failed', { error: 'RangeError' }]);
  });

  it('the setting is read when a name is checked: turning it on in the policy takes effect at once', async () => {
    const { cw } = await names();
    expect(cw.names.check('snerp')).toEqual(OFF);
    cw.policy.save({ names: { profanity: true } }, { version: 0, actor: 'owner', reason: 'family game' });
    expect(cw.names.check('snerp')).toEqual(PROFANE);
  });
});

describe('kept evidence', () => {
  it('nothing is stored by default: a blocked name, a profane one and an allowed one leave the store alone', async () => {
    const store = spyStore();
    const { cw } = await names({}, { profanity: true }, store);
    cw.names.check('zorbak', { who: { clientKey: 'k1' } });
    cw.names.check('snerp');
    cw.names.check('Alice');
    expect(store.inserted).toEqual([]);
    expect(store.reads).toBe(0);
  });

  it('blocked and keepBlocked stores one row: the name, term id, reason, time, and the person when who finds one', async () => {
    const store = spyStore();
    const { cw, clock } = await names({}, { keepBlocked: true, profanity: true }, store);
    cw.rooms.seat('room', 'p1', { clientKey: 'k-known' }, 'Known');
    const person = cw.rooms.subjectAt('room', 'p1') as string;
    await cw.flush();
    expect(cw.names.check('Zorbak_99', { who: { clientKey: 'k-known' } })).toEqual(SLUR);
    clock.t += 1000;
    expect(cw.names.check('Big_Snerp', { who: { clientKey: 'k-known' } })).toEqual(PROFANE);
    clock.t += 1000;
    expect(cw.names.check('zorbak')).toEqual(SLUR);
    expect(store.inserted).toEqual([
      { id: expect.any(String), subject: person, name: 'Zorbak_99', termId: 'syn:zorbak', reason: 'name_not_allowed', at: NOW },
      { id: expect.any(String), subject: person, name: 'Big_Snerp', termId: null, reason: 'name_profane', at: NOW + 1000 },
      { id: expect.any(String), subject: null, name: 'zorbak', termId: 'syn:zorbak', reason: 'name_not_allowed', at: NOW + 2000 },
    ]);
    expect(new Set(store.inserted.map((r) => r.id)).size).toBe(3);
    expect(store.listBlockedNames(0, 10)).toHaveLength(3);
  });

  it('an allowed name is never stored, with or without who', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true, profanity: true }, store);
    cw.names.check('Alice', { who: { clientKey: 'k' } });
    cw.names.check('snerpy');
    cw.names.check('');
    expect(store.inserted).toEqual([]);
  });

  it('a profane name is kept only when the profanity pass is on', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true }, store);
    cw.names.check('snerp');
    expect(store.inserted).toEqual([]);
  });

  it('a stored name is the cleaned, capped copy: lone surrogates and NUL out, at most 200 characters, never half an emoji', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true }, store);
    cw.names.check(`${'a'.repeat(5000)} zorbak`);
    cw.names.check('zorbak\ud800x\u0000y\udc00');
    cw.names.check(`${'b'.repeat(199)}\ud83d\ude00 zorbak`);
    const [long, bad, edge] = store.inserted.map((r) => r.name) as [string, string, string];
    expect(long).toHaveLength(200);
    expect(bad).toBe('zorbak\ufffdxy\ufffd');
    expect(edge).toBe('b'.repeat(199));
    for (const n of [long, bad, edge]) expect(() => encodeURIComponent(n)).not.toThrow();
  });

  it('a store without the blocked-name methods, or one that fails, never changes the answer: the failure is absorbed and logged by class only', async () => {
    const plain = await names({}, { keepBlocked: true }, new MemoryStore());
    expect(plain.cw.names.check('zorbak')).toEqual(SLUR);
    const store = spyStore();
    const { cw, logged } = await names({}, { keepBlocked: true }, store);
    store.failNext = new RangeError('disk full while keeping Zorbak_99');
    expect(cw.names.check('Zorbak_99')).toEqual(SLUR);
    expect(logged).toContainEqual(['chatwarden.names_evidence_failed', { error: 'RangeError' }]);
    expect(JSON.stringify(logged)).not.toMatch(/Zorbak|disk/);
    // A failed write did not use up the cap.
    for (let i = 0; i < 5; i++) cw.names.check(`zorbak ${'x'.repeat(i)}`, { who: { clientKey: 'same' } });
    expect(store.inserted).toHaveLength(5);
  });
});

describe('the hourly caps', () => {
  it('5 per person an hour: the sixth check still answers and stores nothing; another person still stores', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true }, store);
    const who: RawWho = { clientKey: 'k-prober' };
    for (let i = 0; i < 9; i++) expect(cw.names.check(`zorbak${'_'.repeat(i + 1)}a`, { who })).toEqual(SLUR);
    expect(store.inserted).toHaveLength(5);
    expect(cw.names.check('zorbak other', { who: { clientKey: 'k-other' } })).toEqual(SLUR);
    expect(store.inserted).toHaveLength(6);
  });

  it('one cap per found person, whether found by key or by account', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true }, store);
    cw.rooms.seat('room', 'p1', { clientKey: 'k-both', accountId: 'acct-both' }, 'Both');
    await cw.flush();
    for (let i = 0; i < 3; i++) cw.names.check(`zorbak ${i}`, { who: { clientKey: 'k-both' } });
    for (let i = 0; i < 6; i++) cw.names.check(`zorbak b${i}`, { who: { accountId: 'acct-both' } });
    expect(store.inserted).toHaveLength(5);
    expect(new Set(store.inserted.map((r) => r.subject)).size).toBe(1);
  });

  it('a who nobody knows is capped as itself (5 an hour); without who the cap is per name', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true }, store);
    for (let i = 0; i < 8; i++) cw.names.check(`zorbak u${i}`, { who: { clientKey: 'unknown-prober' } });
    expect(store.inserted).toHaveLength(5);
    const bare = spyStore();
    const b = await names({}, { keepBlocked: true }, bare);
    for (const n of ['zorbak', 'ZORBAK', 'Zorbak', 'zorbak', 'zORBAK', 'zorbak']) b.cw.names.check(n);
    expect(bare.inserted).toHaveLength(5);
    b.cw.names.check('zorbak again');
    expect(bare.inserted).toHaveLength(6);
  });

  it('200 an hour overall, in memory; the check still answers past it', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true }, store);
    for (let i = 0; i < 260; i++) expect(cw.names.check(`zorbak ${i}`)).toEqual(SLUR);
    expect(store.inserted).toHaveLength(200);
    expect(cw.names.check('Alice')).toEqual(OFF);
    expect(cw.names.check('zorbak late', { who: { clientKey: 'someone-new' } })).toEqual(SLUR);
    expect(store.inserted).toHaveLength(200);
  });

  it('the window resets with the clock: a capped person stores again an hour after the oldest row, and not a moment before', async () => {
    const store = spyStore();
    const { cw, clock } = await names({}, { keepBlocked: true }, store);
    const who: RawWho = { clientKey: 'k-window' };
    for (let i = 0; i < 5; i++) {
      cw.names.check(`zorbak ${'x'.repeat(i)}`, { who });
      clock.t += 10;
    }
    expect(store.inserted).toHaveLength(5);
    clock.t = NOW + HOUR - 1;
    cw.names.check('zorbak too soon', { who });
    expect(store.inserted).toHaveLength(5);
    clock.t = NOW + HOUR;
    cw.names.check('zorbak a first window row has left', { who });
    expect(store.inserted).toHaveLength(6);
    clock.t = NOW + HOUR + 20;
    cw.names.check('zorbak and a second', { who });
    expect(store.inserted).toHaveLength(7);
    // Overall: fill 200, then an hour later the table is open again.
    const s2 = spyStore();
    const w2 = await names({}, { keepBlocked: true }, s2);
    for (let i = 0; i < 205; i++) w2.cw.names.check(`zorbak ${i}`);
    expect(s2.inserted).toHaveLength(200);
    w2.clock.t += HOUR;
    w2.cw.names.check('zorbak fresh');
    expect(s2.inserted).toHaveLength(201);
  });

  it('the overall cap is per hour: five hours of probing keep 200 an hour', async () => {
    const store = spyStore();
    const { cw, clock } = await names({}, { keepBlocked: true }, store);
    for (let h = 0; h < 5; h++) {
      for (let i = 0; i < 300; i++) cw.names.check(`zorbak ${h} ${'z'.repeat(i + 1)}`, { who: { clientKey: `k${i}` } });
      clock.t += HOUR;
    }
    expect(store.inserted).toHaveLength(1000);
  });
});

describe('who', () => {
  it('never changes the answer, for any name and any kind of who', async () => {
    const { cw } = await names({}, { profanity: true, keepBlocked: true }, spyStore());
    const hostile: unknown[] = [undefined, null, 5, 'x', {}, [], { clientKey: 5 }, { accountId: {} }, { ip: 7 }, { clientKey: '' }, Object.create(null)];
    for (const n of ['Zorbak_99', 'snerp', 'Alice', '']) {
      const bare = cw.names.check(n);
      for (const who of hostile) expect(cw.names.check(n, { who: who as never }), `${n} ${JSON.stringify(who)}`).toEqual(bare);
      expect(cw.names.check(n, { who: { clientKey: 'k', accountId: 'a', ip: '203.0.113.5' } })).toEqual(bare);
    }
    expect(cw.names.check('Alice', null as never)).toEqual(OFF);
  });

  it('a who that throws when read is absorbed (the answer stands)', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true }, store);
    const who = {
      get clientKey(): string {
        throw new Error('boom');
      },
    };
    expect(cw.names.check('zorbak', { who })).toEqual(SLUR);
    expect(cw.names.check('Alice', { who })).toEqual(OFF);
  });

  it('an unknown who creates no subject, and no identity is written; an IP alone finds nobody', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true }, store);
    await cw.flush();
    const before = await store.loadSubjects();
    cw.names.check('zorbak', { who: { clientKey: 'never-seen', accountId: 'acct-never', ip: '203.0.113.7' } });
    cw.names.check('Alice', { who: { clientKey: 'never-seen-2' } });
    await cw.flush();
    expect(await store.loadSubjects()).toEqual(before);
    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0]?.subject).toBeNull();
    // An address alone, even one a known person once used, is not a person.
    cw.rooms.seat('room', 'p1', { clientKey: 'k-ip', ip: '203.0.113.50' }, 'Ip');
    await cw.flush();
    cw.names.check('zorbak ip', { who: { ip: '203.0.113.50' } });
    expect(store.inserted[1]?.subject).toBeNull();
  });
});

describe('flagged', () => {
  it('is the matcher only: true for a blocked name, false for allowed and for profane, and it never asks the profanity filter', async () => {
    const f = fakeFilter();
    const { cw } = await names({ profanity: f }, { profanity: true });
    expect(cw.names.flagged('Zorbak_99')).toBe(true);
    expect(cw.names.flagged('Alice')).toBe(false);
    expect(cw.names.flagged('snerp')).toBe(false);
    expect(cw.names.flagged('')).toBe(false);
    expect(f.seen).toEqual([]);
  });

  it('never writes, whatever keepBlocked says, and does not use up the evidence cap', async () => {
    const store = spyStore();
    const { cw } = await names({}, { keepBlocked: true, profanity: true }, store);
    for (let i = 0; i < 400; i++) cw.names.flagged(`zorbak ${'x'.repeat(i)}`);
    expect(store.inserted).toEqual([]);
    expect(store.reads).toBe(0);
    for (let i = 0; i < 5; i++) cw.names.check(`zorbak ${'y'.repeat(i)}`, { who: { clientKey: 'k' } });
    expect(store.inserted).toHaveLength(5);
  });

  it('is false when the matcher throws, and for a non-string: it never throws; the failure is logged once a minute, by class', async () => {
    const { cw, logged, clock } = await names({
      matcher: {
        match: () => {
          throw new RangeError('secret zorbak');
        },
      },
    });
    for (let i = 0; i < 50; i++) expect(cw.names.flagged('Alice')).toBe(false);
    expect(logged.filter(([e]) => e === 'chatwarden.names_matcher_failed')).toEqual([['chatwarden.names_matcher_failed', { error: 'RangeError' }]]);
    clock.t += 61_000;
    cw.names.flagged('Alice');
    expect(logged.filter(([e]) => e === 'chatwarden.names_matcher_failed')).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain('secret');
    for (const bad of [undefined, null, 5, {}, ['zorbak']]) expect(cw.names.flagged(bad as never)).toBe(false);
  });

  it('with no matcher nothing is flagged; hostile text is read and answered', async () => {
    const none = await names({ matcher: undefined });
    expect(none.cw.names.flagged('zorbak')).toBe(false);
    const { cw } = await names();
    expect(cw.names.flagged('a'.repeat(300_000))).toBe(false);
    expect(cw.names.flagged('\ud800\u0000z\u200borbak')).toBe(true);
  });
});

describe('logs', () => {
  it('no log line contains a name, whichever part fails', async () => {
    const name = 'Zorbak_Quissel_77';
    const store = spyStore();
    const { cw, logged } = await names(
      {
        matcher: {
          match: (t) => {
            throw new Error(`matcher ${t}`);
          },
        },
        profanity: {
          apply: (t) => {
            throw new Error(`filter ${t}`);
          },
        },
      },
      { profanity: true, keepBlocked: true },
      store,
    );
    cw.names.check(name, { who: { clientKey: 'k' } });
    cw.names.flagged(name);
    const ok = await names({}, { keepBlocked: true }, store);
    store.failNext = new Error(`store ${name}`);
    ok.cw.names.check(name);
    for (const lines of [logged, ok.logged] as Logged[]) {
      const flat = JSON.stringify(lines);
      expect(flat).not.toMatch(/quissel|zorbak/i);
      for (const [, detail] of lines) if (detail !== undefined) expect(Object.keys(detail).every((k) => k === 'error' || k === 'suppressed')).toBe(true);
    }
  });
});

describe('createChatwarden directly: the kit holds up with no names settings at all', () => {
  it('check and flagged answer with the default settings (profanity off, keepBlocked off)', async () => {
    const cw = await createChatwarden({
      store: new MemoryStore(),
      secret: 's',
      platform: { identify: (c) => c as RawWho },
      clock: { now: () => NOW },
      logger: { warn() {} },
      retention: false,
      matcher: fakeMatcher(),
    });
    expect(cw.names.check('zorbak')).toEqual(SLUR);
    expect(cw.names.flagged('zorbak')).toBe(true);
  });
});
