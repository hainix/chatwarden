import { describe, expect, it } from 'vitest';
import { buildMatcher, loadTermPack } from '../src/index.js';
import { SYNTHETIC_TERMS, syntheticTermPack } from '../src/fixtures/index.js';

/** A pack as it would arrive from disk or the network. */
const json = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(JSON.parse(JSON.stringify(syntheticTermPack())) as Record<string, unknown>),
  ...over,
});
const errorOf = (input: unknown): string => {
  try {
    loadTermPack(input);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected loadTermPack to throw');
};

describe('loadTermPack: accepts', () => {
  it('a pack that went through JSON, unchanged', () => {
    expect(loadTermPack(json())).toEqual(syntheticTermPack());
  });

  it('the loaded pack builds a matcher that blocks every positive line and no negative line', () => {
    const pack = loadTermPack(json());
    const m = buildMatcher(pack.terms, pack.exceptions);
    for (const t of pack.terms) {
      for (const line of t.positive) expect(m.match(line), `positive of ${t.id}`).not.toBeNull();
      for (const line of t.negative) expect(m.match(line), `negative of ${t.id}`).toBeNull();
    }
  });

  it('active defaults to true on terms and exceptions when omitted', () => {
    const raw = json({
      terms: [{ id: 'a', term: 'zorbak', language: 'en', positive: [], negative: [] }],
      exceptions: [{ id: 'b', phrase: 'glarn zorbak', language: 'en' }],
    });
    const pack = loadTermPack(raw);
    expect(pack.terms[0]!.active).toBe(true);
    expect(pack.exceptions[0]!.active).toBe(true);
  });

  it('keeps an explicit active: false', () => {
    const raw = json({
      terms: [
        { id: 'a', term: 'zorbak', language: 'en', positive: [], negative: [] },
        { id: 'c', term: 'vlemmo', language: 'en', active: false, positive: [], negative: [] },
      ],
    });
    expect(loadTermPack(raw).terms[1]!.active).toBe(false);
  });

  it('empty exceptions, negativeCorpus and knownLosses are fine', () => {
    const pack = loadTermPack(json({ exceptions: [], negativeCorpus: [], knownLosses: [] }));
    expect(pack.exceptions).toEqual([]);
  });

  it('does not alias the input', () => {
    const raw = json();
    const pack = loadTermPack(raw);
    (raw.negativeCorpus as string[]).push('later');
    expect(pack.negativeCorpus).not.toContain('later');
  });
});

describe('loadTermPack: rejects', () => {
  it.each([null, undefined, 'x', 7, [], true])('a non-object (%s)', (bad) => {
    expect(() => loadTermPack(bad)).toThrow(/pack/);
  });

  it('an unknown top-level key', () => {
    expect(() => loadTermPack(json({ extra: 1 }))).toThrow(/unknown top-level key/);
  });

  it.each(['id', 'version', 'terms', 'exceptions', 'negativeCorpus', 'knownLosses'])('a missing %s', (key) => {
    const raw = json();
    delete raw[key];
    expect(() => loadTermPack(raw)).toThrow(new RegExp(key));
  });

  it.each([
    ['id', ''],
    ['id', 5],
    ['version', ''],
    ['version', 1],
    ['terms', {}],
    ['exceptions', 'x'],
    ['negativeCorpus', [1]],
    ['knownLosses', [null]],
  ])('a wrong-typed %s (%j)', (key, value) => {
    expect(() => loadTermPack(json({ [key]: value }))).toThrow();
  });

  it('a term row with an unknown key', () => {
    const raw = json({ terms: [{ id: 'a', term: 'zorbak', language: 'en', positive: [], negative: [], mechanism: 'x' }] });
    expect(() => loadTermPack(raw)).toThrow(/terms\[0\] has an unknown key/);
  });

  it('an exception row with an unknown key', () => {
    const raw = json({ exceptions: [{ id: 'a', phrase: 'glarn zorbak', language: 'en', extra: 1 }] });
    expect(() => loadTermPack(raw)).toThrow(/exceptions\[0\] has an unknown key/);
  });

  it.each([
    ['id', ''],
    ['term', ''],
    ['language', ''],
    ['language', '   '],
    ['active', 'yes'],
    ['positive', 'zorbak'],
    ['negative', [3]],
  ])('a term row with a bad %s (%j)', (key, value) => {
    const row = { id: 'a', term: 'zorbak', language: 'en', positive: [], negative: [], [key]: value };
    expect(() => loadTermPack(json({ terms: [row] }))).toThrow(/terms\[0\]/);
  });

  it('a term row with positive or negative missing', () => {
    expect(() => loadTermPack(json({ terms: [{ id: 'a', term: 'zorbak', language: 'en', negative: [] }] }))).toThrow(/positive/);
    expect(() => loadTermPack(json({ terms: [{ id: 'a', term: 'zorbak', language: 'en', positive: [] }] }))).toThrow(/negative/);
  });

  it.each([
    ['phrase', ''],
    ['language', ''],
    ['id', ''],
    ['active', 0],
  ])('an exception row with a bad %s (%j)', (key, value) => {
    const row = { id: 'a', phrase: 'glarn zorbak', language: 'en', [key]: value };
    expect(() => loadTermPack(json({ exceptions: [row] }))).toThrow(/exceptions\[0\]/);
  });

  it('a duplicate id between two terms', () => {
    const t = (term: string) => ({ id: 'dup', term, language: 'en', positive: [], negative: [] });
    expect(errorOf(json({ terms: [t('zorbak'), t('vlemmo')] }))).toMatch(/duplicate row id "dup"/);
  });

  it('a duplicate id between two exceptions', () => {
    const e = (phrase: string) => ({ id: 'dup', phrase, language: 'en' });
    expect(errorOf(json({ exceptions: [e('glarn zorbak'), e('tarvo lake')] }))).toMatch(/duplicate row id "dup"/);
  });

  it('a duplicate id between a term and an exception', () => {
    const raw = json({
      terms: [{ id: 'dup', term: 'zorbak', language: 'en', positive: [], negative: [] }],
      exceptions: [{ id: 'dup', phrase: 'glarn zorbak', language: 'en' }],
    });
    expect(errorOf(raw)).toMatch(/duplicate row id "dup"/);
  });

  it('two terms that read as the same word (case, accent, collapsed double)', () => {
    const t = (id: string, term: string) => ({ id, term, language: 'en', positive: [], negative: [] });
    expect(errorOf(json({ terms: [t('a', 'vlemmo'), t('b', 'VLÉMO')] }))).toMatch(/terms\[1\] .* terms\[0\]|same word/);
  });

  it('a term the matcher cannot build, naming the row id', () => {
    const t = { id: 'bad-1', term: 'a b', language: 'en', positive: [], negative: [] };
    expect(errorOf(json({ terms: [t] }))).toMatch(/bad-1/);
  });

  it('a term below the minimum length once collapsed', () => {
    const t = { id: 'short-1', term: 'aaaa', language: 'en', positive: [], negative: [] };
    expect(errorOf(json({ terms: [t] }))).toMatch(/short-1/);
  });

  it('an exception the matcher cannot build, naming the row id', () => {
    const e = { id: 'ex-bad', phrase: '   ', language: 'en' };
    // phrase is non-empty as a string but blank once trimmed
    expect(errorOf(json({ exceptions: [e] }))).toMatch(/ex-bad/);
  });
});

describe('loadTermPack: errors never carry term text', () => {
  const secret = SYNTHETIC_TERMS.flatMap((t) => [t.term, ...t.positive.slice(0, 3)]).filter((w) => w.length > 3);
  const cases: Record<string, unknown>[] = [
    json({ terms: [{ id: 'a', term: 'zorbak glarn', language: 'en', positive: ['zorbak'], negative: [] }] }),
    json({ terms: [{ id: 'a', term: 'zorbak', language: '', positive: ['zorbak'], negative: [] }] }),
    json({ terms: [{ id: 'a', term: 'zorbak', language: 'en', positive: ['zorbak'], negative: [], zorbak: 1 }] }),
    json({
      terms: [
        { id: 'a', term: 'zorbak', language: 'en', positive: [], negative: [] },
        { id: 'b', term: 'ZORBAK', language: 'en', positive: [], negative: [] },
      ],
    }),
    json({ terms: [{ id: 'a', term: 'zz', language: 'en', positive: [], negative: [] }] }),
    json({ exceptions: [{ id: 'a', phrase: 'glarn zorbak', language: '' }] }),
    json({ negativeCorpus: ['zorbak', 5] }),
    json({ zorbak: 1 }),
    json({ terms: [{ id: 'a', term: 'zorbak', language: 'en', positive: [], negative: [], 'vlemmo': 1 }] }),
  ];
  it.each(cases.map((c, i) => [i, c] as const))('case %i', (_i, input) => {
    const msg = errorOf(input);
    for (const word of secret) expect(msg.toLowerCase()).not.toContain(word.toLowerCase());
    expect(msg).not.toContain('glarn');
  });
});

describe('loadTermPack: positiveCorpus (optional flat canary)', () => {
  it('accepts a flat list of lines and returns a copy', () => {
    const raw = json({ positiveCorpus: ['you zorbak', 'f3nr1sk!'] });
    const pack = loadTermPack(raw);
    expect(pack.positiveCorpus).toEqual(['you zorbak', 'f3nr1sk!']);
    (raw.positiveCorpus as string[]).push('later');
    expect(pack.positiveCorpus).not.toContain('later');
  });

  it('is optional: absent stays absent (no key on the loaded pack)', () => {
    const raw = json();
    delete raw.positiveCorpus;
    expect('positiveCorpus' in loadTermPack(raw)).toBe(false);
  });

  it('an empty list is fine', () => {
    expect(loadTermPack(json({ positiveCorpus: [] })).positiveCorpus).toEqual([]);
  });

  it.each([['x'], [{}], [[1]], [[null]], [[['a']]], [null]])('rejects a bad positiveCorpus (%j) naming the field only', (bad) => {
    expect(errorOf(json({ positiveCorpus: bad }))).toBe('pack.positiveCorpus must be an array of strings');
  });

  it('is not required, but other required keys still are', () => {
    const raw = json();
    delete raw.positiveCorpus;
    delete raw.knownLosses;
    expect(() => loadTermPack(raw)).toThrow(/knownLosses/);
  });
});
