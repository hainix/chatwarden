import { describe, expect, it } from 'vitest';
import { resolveAppeals } from '../src/appeals.js';
import { ProfileError, resolveProfile } from '../src/profile.js';
import { world } from './reportingWorld.js';

// The 0.2.1 appeal settings (linkTtlMs, contact, emailsOutcome, words) and the two createChatwarden options (landingUrl, landingOrigins).

const SENTINEL = 'zorbak-sentinel-value';

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}

describe('linkTtlMs', () => {
  it('defaults to 30 days', () => {
    expect(resolveAppeals(undefined).linkTtlMs).toBe(2_592_000_000);
    expect(resolveAppeals({}).linkTtlMs).toBe(2_592_000_000);
    expect(resolveProfile('standard').appeals.linkTtlMs).toBe(2_592_000_000);
  });

  it('the two edges are accepted; one outside each is refused with the path', () => {
    expect(resolveAppeals({ linkTtlMs: 3_600_000 }).linkTtlMs).toBe(3_600_000);
    expect(resolveAppeals({ linkTtlMs: 31_536_000_000 }).linkTtlMs).toBe(31_536_000_000);
    for (const v of [3_599_999, 31_536_000_001, 0, -3_600_000, 3_600_000.5, Number.NaN, Infinity, '3600000', null, true, {}, [], 2 ** 60]) {
      expect(failure(() => resolveAppeals({ linkTtlMs: v as never })).path, String(v)).toBe('appeals.linkTtlMs');
    }
  });

  it('undefined is the default; the path names where the settings live', () => {
    expect(resolveAppeals({ linkTtlMs: undefined }).linkTtlMs).toBe(2_592_000_000);
    expect(failure(() => resolveAppeals({ linkTtlMs: 1 }, 'profile.appeals')).path).toBe('profile.appeals.linkTtlMs');
  });
});

describe('contact', () => {
  it('null and absent give null; a line is kept trimmed', () => {
    expect(resolveAppeals({}).contact).toBeNull();
    expect(resolveAppeals({ contact: null }).contact).toBeNull();
    expect(resolveAppeals({ contact: undefined }).contact).toBeNull();
    expect(resolveAppeals({ contact: '  help@game.example  ' }).contact).toBe('help@game.example');
    expect(resolveAppeals({ contact: 'x' }).contact).toBe('x');
    expect(resolveAppeals({ contact: 'y'.repeat(200) }).contact).toBe('y'.repeat(200));
    expect(resolveAppeals({ contact: 'Write to us on Discord: #support \u{e9}' }).contact).toBe('Write to us on Discord: #support \u{e9}');
  });

  it('blank, 201 characters, a newline, a control, a bidi mark and a zero-width character are refused', () => {
    const bad = ['', '   ', 'y'.repeat(201), 'two\nlines', 'cr\rlf', 'tab\there', 'nul\u0000', 'bell\u0007', 'rtl\u{202e}', 'isolate\u{2066}', 'zero\u{200b}width', 'b\u{feff}om', 'soft\u{ad}hyphen', 'del\u007f', 5, true, {}, [], ['a']];
    for (const v of bad) expect(failure(() => resolveAppeals({ contact: v as never })).path, JSON.stringify(v)).toBe('appeals.contact');
  });

  it('the 200 limit counts characters after trimming', () => {
    expect(resolveAppeals({ contact: ` ${'y'.repeat(200)} ` }).contact).toBe('y'.repeat(200));
    expect(() => resolveAppeals({ contact: ` ${'y'.repeat(201)} ` })).toThrow(ProfileError);
  });
});

describe('emailsOutcome', () => {
  it('a boolean, default false; anything else refused', () => {
    expect(resolveAppeals({}).emailsOutcome).toBe(false);
    expect(resolveAppeals({ emailsOutcome: true }).emailsOutcome).toBe(true);
    expect(resolveAppeals({ emailsOutcome: false }).emailsOutcome).toBe(false);
    for (const v of [1, 0, 'true', null, {}, []]) expect(failure(() => resolveAppeals({ emailsOutcome: v as never })).path).toBe('appeals.emailsOutcome');
  });
});

describe('words', () => {
  it('default {}; a map is kept, as a deep-frozen copy that shares nothing with the input', () => {
    expect(resolveAppeals({}).words).toEqual({});
    expect(Object.isFrozen(resolveAppeals({}).words)).toBe(true);
    const input = { de: { 'player.appealPage.title': 'Einspruch' }, fr: { 'player.appealPage.sent': 'Envoy\u{e9}' } };
    const r = resolveAppeals({ words: input });
    expect(r.words).toEqual(input);
    expect(r.words).not.toBe(input);
    expect(Object.isFrozen(r.words)).toBe(true);
    expect(Object.isFrozen(r.words.de)).toBe(true);
    input.de['player.appealPage.title'] = 'changed';
    expect(r.words.de?.['player.appealPage.title']).toBe('Einspruch');
    expect(() => {
      (r.words.de as Record<string, string>)['x'] = 'y';
    }).toThrow(TypeError);
  });

  it('structure rules: language keys, entry counts, key and value shapes', () => {
    const ok = (words: unknown) => resolveAppeals({ words: words as never });
    const bad = (words: unknown) => failure(() => ok(words)).path;
    // languages
    for (const lang of ['en', 'es', 'pt', 'fil', 'zh']) expect(ok({ [lang]: {} }).words).toEqual({ [lang]: {} });
    for (const lang of ['e', 'espa', 'EN', 'e1', 'en-US', 'en_US', '', ' en', '__proto__', 'constructor']) expect(bad({ [lang]: {} }), lang).toBe('appeals.words');
    // at most 16 languages
    const langs = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${String.fromCharCode(97 + i)}`, {}]));
    expect(Object.keys(ok(langs(16)).words)).toHaveLength(16);
    expect(bad(langs(17))).toBe('appeals.words');
    // at most 80 entries
    const entries = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 'v']));
    expect(Object.keys(ok({ de: entries(80) }).words.de as object)).toHaveLength(80);
    expect(bad({ de: entries(81) })).toBe('appeals.words');
    // key shapes
    for (const key of ['a', 'player.appealPage.title', 'a_b.C9', 'x'.repeat(64)]) expect(ok({ de: { [key]: 'v' } }).words.de).toEqual({ [key]: 'v' });
    for (const key of ['', 'A', '1a', '_a', '.a', 'a-b', 'a b', 'x'.repeat(65), '__proto__', 'a\u{e9}']) expect(bad({ de: { [key]: 'v' } }), key).toBe('appeals.words');
    // value shapes
    expect(ok({ de: { k: 'v'.repeat(600) } }).words.de).toEqual({ k: 'v'.repeat(600) });
    for (const v of ['', 'v'.repeat(601), 'new\nline', 'tab\t', 'nul\u0000', 'del\u007f', 'c1\u0085', 5, null, undefined, true, {}, []]) expect(bad({ de: { k: v } }), JSON.stringify(v)).toBe('appeals.words');
    // containers
    for (const w of [null, 'x', 5, [], [{}], true]) expect(bad(w), JSON.stringify(w)).toBe('appeals.words');
    for (const l of [null, 'x', 5, [], true]) expect(bad({ de: l }), JSON.stringify(l)).toBe('appeals.words');
  });

  it('a JSON-parsed __proto__ key is refused, not applied', () => {
    const parsed = JSON.parse('{"de":{"__proto__":"x"}}') as unknown;
    expect(failure(() => resolveAppeals({ words: parsed as never })).path).toBe('appeals.words');
    const lang = JSON.parse('{"__proto__":{"k":"v"}}') as unknown;
    expect(failure(() => resolveAppeals({ words: lang as never })).path).toBe('appeals.words');
    expect(({} as Record<string, unknown>)['k']).toBeUndefined();
  });

  it('an object with a different prototype is refused', () => {
    class Words {
      de = {};
    }
    expect(failure(() => resolveAppeals({ words: new Words() as never })).path).toBe('appeals.words');
  });
});

describe('the section as a whole', () => {
  it('every field set is read back; the others keep their defaults', () => {
    expect(resolveAppeals({ enabled: true, linkTtlMs: 7_200_000, contact: 'c', emailsOutcome: true, words: { de: { k: 'v' } } })).toEqual({
      enabled: true,
      perPlayerPerWeek: 3,
      allowSelfReview: false,
      linkTtlMs: 7_200_000,
      contact: 'c',
      emailsOutcome: true,
      words: { de: { k: 'v' } },
    });
    expect(resolveAppeals(undefined)).toEqual({ enabled: false, perPlayerPerWeek: 3, allowSelfReview: false, linkTtlMs: 2_592_000_000, contact: null, emailsOutcome: false, words: {} });
  });

  it('an unknown key under appeals is still refused (landingUrl is an option, not a setting)', () => {
    expect(failure(() => resolveAppeals({ landingUrl: 'https://x.example/' } as never)).path).toBe('appeals.landingUrl');
    expect(failure(() => resolveAppeals({ landingOrigins: [] } as never)).path).toBe('appeals.landingOrigins');
    expect(failure(() => resolveAppeals({ nope: 1 } as never)).path).toBe('appeals.nope');
  });

  it('no message echoes a value', () => {
    const attempts: Array<() => unknown> = [
      () => resolveAppeals({ linkTtlMs: SENTINEL as never }),
      () => resolveAppeals({ contact: `${SENTINEL}\n2` }),
      () => resolveAppeals({ contact: SENTINEL.repeat(20) }),
      () => resolveAppeals({ emailsOutcome: SENTINEL as never }),
      () => resolveAppeals({ words: SENTINEL as never }),
      () => resolveAppeals({ words: { de: { [SENTINEL]: 'v' } } }),
      () => resolveAppeals({ words: { de: { k: `${SENTINEL}\n` } } }),
      () => resolveAppeals({ words: { [SENTINEL]: {} } }),
    ];
    for (const a of attempts) {
      const e = failure(a);
      expect(e.message).not.toContain(SENTINEL);
      expect(e.path).not.toContain(SENTINEL);
    }
  });

  it('values are read once: a getter that changes its answer cannot slip a bad value past the check', () => {
    let reads = 0;
    const input = {
      get contact(): string {
        reads += 1;
        return reads === 1 ? 'fine' : 'two\nlines';
      },
    };
    const r = resolveAppeals(input as never);
    expect(r.contact).toBe('fine');
    expect(reads).toBe(1);
  });

  it('a profile carries them through defineProfile and resolveProfile', () => {
    const p = resolveProfile('standard', { appeals: { enabled: true, linkTtlMs: 3_600_000, contact: 'help', words: { de: { k: 'v' } } } });
    expect(p.appeals).toMatchObject({ enabled: true, linkTtlMs: 3_600_000, contact: 'help', words: { de: { k: 'v' } } });
    expect(() => resolveProfile('standard', { appeals: { linkTtlMs: 5 } })).toThrow(ProfileError);
  });
});

describe('ChatwardenOptions.appeals', () => {
  const create = (appeals: unknown) => world({ appeals: appeals as never });
  const message = async (appeals: unknown): Promise<string> => {
    try {
      await create(appeals);
    } catch (e) {
      expect(e).toBeInstanceOf(RangeError);
      return (e as Error).message;
    }
    throw new Error('expected a RangeError');
  };

  it('nothing set: no landing url and no origins; landingUrl and landingOrigins are read back', async () => {
    const none = await world();
    expect(none.cw.appeals.landingOrigins()).toEqual([]);
    const w = await create({ landingUrl: 'https://game.example/appeal', landingOrigins: ['https://game.example', 'http://localhost:5173'] });
    expect(w.cw.appeals.landingOrigins()).toEqual(['https://game.example', 'http://localhost:5173']);
    expect(Object.isFrozen(w.cw.appeals.landingOrigins())).toBe(true);
    expect(await create({})).toBeDefined();
    expect(await create({ landingUrl: undefined, landingOrigins: undefined })).toBeDefined();
  });

  it('the origins are a frozen copy: changing the array that was passed changes nothing', async () => {
    const origins = ['https://game.example'];
    const w = await create({ landingOrigins: origins });
    origins.push('https://evil.example');
    expect(w.cw.appeals.landingOrigins()).toEqual(['https://game.example']);
  });

  it.each([
    ['credentials', 'https://user:pw@game.example/appeal'],
    ['a user name only', 'https://user@game.example/appeal'],
    ['a fragment', 'https://game.example/appeal#top'],
    ['an empty fragment', 'https://game.example/appeal#'],
    ['a query string', 'https://game.example/appeal?a=1'],
    ['an empty query string', 'https://game.example/appeal?'],
    ['ftp', 'ftp://game.example/appeal'],
    ['javascript', 'javascript:alert(1)'],
    ['a data url', 'data:text/html,hi'],
    ['a relative path', '/appeal'],
    ['not a url', 'not a url'],
    ['empty', ''],
    ['2001 characters', `https://game.example/${'a'.repeat(1980)}${'b'.repeat(2001 - 'https://game.example/'.length - 1980)}`],
    ['a number', 5],
    ['null', null],
    ['an object', {}],
  ])('landingUrl: %s is refused, naming appeals.landingUrl and never the value', async (_name, value) => {
    const m = await message({ landingUrl: value });
    expect(m).toContain('appeals.landingUrl');
    if (typeof value === 'string' && value.length > 3) expect(m).not.toContain(value);
  });

  it('landingUrl: 2000 characters is accepted, and http is allowed (a local game)', async () => {
    const long = `https://game.example/${'a'.repeat(2000 - 'https://game.example/'.length)}`;
    expect(long).toHaveLength(2000);
    expect(await create({ landingUrl: long })).toBeDefined();
    expect(await create({ landingUrl: 'http://localhost:3000/appeal' })).toBeDefined();
  });

  it.each([
    ['a path', ['https://game.example/appeal']],
    ['a trailing slash', ['https://game.example/']],
    ['a wildcard', ['*']],
    ['the string null', ['null']],
    ['a bare host', ['game.example']],
    ['ftp', ['ftp://game.example']],
    ['a query', ['https://game.example?x=1']],
    ['credentials', ['https://u:p@game.example']],
    ['a non-string', [5]],
    ['upper case host', ['https://GAME.example']],
    ['a default port written out', ['https://game.example:443']],
    ['21 origins', Array.from({ length: 21 }, (_, i) => `https://g${i}.example`)],
    ['a string, not a list', 'https://game.example'],
    ['null', null],
  ])('landingOrigins: %s is refused, naming appeals.landingOrigins', async (_name, value) => {
    const m = await message({ landingOrigins: value });
    expect(m).toContain('appeals.landingOrigins');
    if (typeof value === 'string') expect(m).not.toContain(value);
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 3) expect(m).not.toContain(value[0]);
  });

  it('the landingOrigins refusal names no web address: the site bundles core and its dist scan refuses any host that is not its own', async () => {
    for (const value of [null, 'x', ['https://game.example/path'], Array.from({ length: 21 }, (_, i) => `https://g${i}.example`)]) {
      const m = await message({ landingOrigins: value });
      expect(m, JSON.stringify(value).slice(0, 30)).toContain('at most 20 origins');
      expect(m).not.toMatch(/https?:\/\//i);
      expect(m).not.toMatch(/[a-z0-9-]+\.(test|example|com|dev)\b/i);
    }
  });

  it('landingOrigins: 20 origins are accepted; an empty list is fine', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `https://g${i}.example`);
    expect((await create({ landingOrigins: twenty })).cw.appeals.landingOrigins()).toHaveLength(20);
    expect((await create({ landingOrigins: [] })).cw.appeals.landingOrigins()).toEqual([]);
  });

  it('an unknown key, or an options value that is not an object, is refused', async () => {
    expect(await message({ landingUrl: 'https://game.example/', origin: 'x' })).toContain('appeals');
    expect(await message({ landingUrls: 'https://game.example/' })).toContain('appeals');
    for (const v of ['https://game.example', 5, true, [], null]) expect(await message(v)).toContain('appeals');
  });

  it('a refused option throws before the store is touched', async () => {
    let touched = 0;
    const { MemoryStore } = await import('@chatwarden/store-memory');
    const store = new MemoryStore();
    const real = store.loadSubjects.bind(store);
    store.loadSubjects = (...a: Parameters<typeof real>) => {
      touched += 1;
      return real(...a);
    };
    await expect(world({ appeals: { landingUrl: 'ftp://x' } as never }, store)).rejects.toThrow(RangeError);
    expect(touched).toBe(0);
  });
});
