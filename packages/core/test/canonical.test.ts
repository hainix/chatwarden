import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CANONICALIZATION, canonicalJson, signBundle, verifyBundle } from '../src/canonical.js';
import type { BundleIntegrity } from '../src/canonical.js';

// Canonical JSON ("chatwarden-json-1") and the signature over it. The rules are what a verifier outside the kit implements, so each is pinned by a literal here,
// and the digests are cross-checked against node:crypto, an implementation the kit does not share.

const SECRET = 'bundle-secret-bundle-secret-0123456789';

describe('canonicalJson: the bytes', () => {
  it('sorts keys, writes no whitespace and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [3, 1, 2], c: { z: null, y: true } })).toBe('{"a":[3,1,2],"b":1,"c":{"y":true,"z":null}}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(false)).toBe('false');
  });

  it('keys go in code point order, not UTF-16 order: a character above U+FFFF sorts after U+FFFF', () => {
    const o = { '\u{1F600}': 1, '￿': 2, a: 3, B: 4, 'é': 5 };
    expect(canonicalJson(o)).toBe('{"B":4,"a":3,"é":5,"￿":2,"\u{1F600}":1}');
    // JavaScript's own sort would put the emoji (a surrogate pair, D83D) before U+FFFF
    expect(Object.keys(o).sort()[3]).toBe('\u{1F600}');
  });

  it('the same value gives the same bytes whatever order the keys were added in', () => {
    const a: Record<string, unknown> = {};
    a['x'] = 1;
    a['y'] = { q: 1, p: 2 };
    const b: Record<string, unknown> = {};
    b['y'] = { p: 2, q: 1 };
    b['x'] = 1;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('strings are JSON.stringify strings: escapes, quotes, control characters, unicode and a lone surrogate', () => {
    expect(canonicalJson('a"b\\c\n\t\u0001')).toBe('"a\\"b\\\\c\\n\\t\\u0001"');
    expect(canonicalJson('é中\u{1F600}')).toBe('"é中\u{1F600}"');
    expect(canonicalJson('\ud800')).toBe('"\\ud800"');
    expect(canonicalJson({ 'k"ey': 'v' })).toBe('{"k\\"ey":"v"}');
  });

  it('numbers are written as JavaScript writes them: integers as integers', () => {
    expect(canonicalJson([0, 1, -1, 1.5, 100, 1e21, 123456789012, 5e-7, 1_800_000_000_000])).toBe('[0,1,-1,1.5,100,1e+21,123456789012,5e-7,1800000000000]');
  });

  it('a nested array of arrays and objects round-trips through JSON.parse to the same value', () => {
    const v = { list: [{ b: [1, [2, [3]]], a: 'x' }, [], {}], n: null };
    expect(JSON.parse(canonicalJson(v))).toEqual(v);
  });

  it('accepts an object with no prototype', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o['b'] = 1;
    o['a'] = 2;
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
  });
});

describe('canonicalJson: what it refuses (a TypeError, never a guess)', () => {
  it.each<[string, unknown]>([
    ['negative zero', -0],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a bigint', 10n],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a Set', new Set()],
    ['a class instance', new (class Thing {})()],
    ['an undefined property', { a: undefined }],
    ['-0 inside an array', [1, -0]],
    ['NaN inside an object', { a: { b: Number.NaN } }],
    ['a toJSON method (never called)', { toJSON: () => 'x' }],
    ['a sparse array', [1, , 3]], // eslint-disable-line no-sparse-arrays
    ['a typed array', new Uint8Array(2)],
  ])('%s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('a cycle and nesting deeper than 64 levels', () => {
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => canonicalJson(cyc)).toThrow(TypeError);
    const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)]);
    expect(() => canonicalJson(nest(64))).not.toThrow();
    expect(() => canonicalJson(nest(65))).toThrow(TypeError);
  });

  it('an error never carries the offending value', () => {
    try {
      canonicalJson({ secret: Symbol('hunter2-value') });
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('hunter2');
    }
  });
});

describe('signBundle and verifyBundle', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    format: 'test',
    list: [1, 2, { z: 'zorbak', a: 'vlemmo' }],
    integrity: { algorithm: 'sha256', sha256: '', hmacSha256: null, signedAt: 0, canonicalization: CANONICALIZATION } as BundleIntegrity,
    ...over,
  });
  const NOW = 1_800_000_000_000;

  it('the digests match node:crypto over the canonical bytes (signedAt included, the two digests themselves excluded)', () => {
    const signed = signBundle(draft(), SECRET, NOW);
    const bytes = '{"format":"test","integrity":{"algorithm":"sha256","canonicalization":"chatwarden-json-1","signedAt":1800000000000},"list":[1,2,{"a":"vlemmo","z":"zorbak"}]}';
    expect(signed.integrity.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(signed.integrity.hmacSha256).toBe(createHmac('sha256', SECRET).update(bytes).digest('hex'));
    expect(signed.integrity.signedAt).toBe(NOW);
    expect(signed.integrity.canonicalization).toBe('chatwarden-json-1');
    expect(signed.integrity.algorithm).toBe('sha256');
  });

  it('verifies: sha256 and hmac, and a returned bundle is a new object', () => {
    const d = draft();
    const signed = signBundle(d, SECRET, NOW);
    expect(signed).not.toBe(d);
    expect(d.integrity.sha256).toBe('');
    expect(verifyBundle(signed, SECRET)).toEqual({ sha256: true, hmac: true });
    expect(verifyBundle(JSON.parse(JSON.stringify(signed)) as typeof signed, SECRET)).toEqual({ sha256: true, hmac: true });
  });

  it('with no secret given the hmac says null, and the sha256 still checks', () => {
    expect(verifyBundle(signBundle(draft(), SECRET, NOW))).toEqual({ sha256: true, hmac: null });
  });

  it('with no bundleSecret the bundle is unsigned: hmacSha256 is null, verifyBundle says null, and a verifier holding a secret says false', () => {
    const unsigned = signBundle(draft(), undefined, NOW);
    expect(unsigned.integrity.hmacSha256).toBeNull();
    expect(typeof unsigned.integrity.sha256).toBe('string');
    expect(verifyBundle(unsigned)).toEqual({ sha256: true, hmac: null });
    expect(verifyBundle(unsigned, SECRET)).toEqual({ sha256: true, hmac: false });
  });

  it('the wrong secret fails the hmac and leaves the sha256 true', () => {
    expect(verifyBundle(signBundle(draft(), SECRET, NOW), `${SECRET}x`)).toEqual({ sha256: true, hmac: false });
  });

  it('one changed byte in any field fails both: a value, a key, an array item, signedAt, an added field, a removed field', () => {
    const signed = signBundle(draft(), SECRET, NOW);
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(signed)) as Record<string, unknown>;
    const tampered: Array<[string, Record<string, unknown>]> = [];
    const a = clone();
    (a['list'] as unknown[])[0] = 3;
    tampered.push(['array item', a]);
    const b = clone();
    ((b['list'] as Array<Record<string, string>>)[2] as Record<string, string>)['z'] = 'zorbaK';
    tampered.push(['nested value', b]);
    const c = clone();
    c['format'] = 'tesT';
    tampered.push(['top value', c]);
    const d = clone();
    (d['integrity'] as Record<string, unknown>)['signedAt'] = NOW + 1;
    tampered.push(['signedAt', d]);
    const e = clone();
    e['extra'] = 1;
    tampered.push(['added field', e]);
    const f = clone();
    delete f['list'];
    tampered.push(['removed field', f]);
    const g = clone();
    (g['integrity'] as Record<string, unknown>)['canonicalization'] = 'other';
    tampered.push(['canonicalization', g]);
    for (const [name, t] of tampered) expect(verifyBundle(t as unknown as typeof signed, SECRET), name).toEqual({ sha256: false, hmac: false });
  });

  it('an edited bundle with its sha256 recomputed passes the sha256 but not the hmac: the secret is what makes it the kit\'s', () => {
    const signed = signBundle(draft(), SECRET, NOW);
    const forged = { ...signed, list: [9] } as typeof signed;
    const reSigned = signBundle({ ...forged, integrity: { ...forged.integrity } }, undefined, NOW);
    const mixed = { ...reSigned, integrity: { ...reSigned.integrity, hmacSha256: signed.integrity.hmacSha256 } };
    expect(verifyBundle(mixed, SECRET)).toEqual({ sha256: true, hmac: false });
  });

  it('a secret shorter than 32 characters is refused by sign and the message never holds it', () => {
    expect(() => signBundle(draft(), 'short-secret', NOW)).toThrow(RangeError);
    try {
      signBundle(draft(), 'short-secret-value', NOW);
    } catch (err) {
      expect((err as Error).message).not.toContain('short-secret-value');
    }
    expect(() => signBundle(draft(), 'x'.repeat(31), NOW)).toThrow(RangeError);
    expect(() => signBundle(draft(), 'x'.repeat(32), NOW)).not.toThrow();
  });

  it('garbage and a missing integrity count as failing, never as an error', () => {
    expect(verifyBundle({} as never, SECRET)).toEqual({ sha256: false, hmac: false });
    expect(verifyBundle({ integrity: null } as never)).toEqual({ sha256: false, hmac: null });
    expect(verifyBundle({ integrity: { algorithm: 'md5' } } as never, SECRET)).toEqual({ sha256: false, hmac: false });
  });

  it('refuses to sign a bundle canonicalJson refuses', () => {
    expect(() => signBundle(draft({ bad: Number.NaN }), SECRET, NOW)).toThrow(TypeError);
    expect(() => signBundle(draft({ when: new Date(0) }), SECRET, NOW)).toThrow(TypeError);
  });
});
