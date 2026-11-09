import { describe, expect, it } from 'vitest';
import { BODY_MAX_BYTES, HttpError, parseJson } from '@chatwarden/http';

const fail = (raw: string | undefined, max?: number): HttpError => {
  try {
    parseJson(raw, max);
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('did not throw');
};

describe('parseJson', () => {
  it('parses JSON values', () => {
    expect(parseJson('{"a":1,"b":[true,null,"x"]}')).toEqual({ a: 1, b: [true, null, 'x'] });
    expect(parseJson('[1,2]')).toEqual([1, 2]);
    expect(parseJson('"s"')).toBe('s');
    expect(parseJson('0')).toBe(0);
    expect(parseJson('null')).toBeNull();
    expect(parseJson(' {"a":1} \n')).toEqual({ a: 1 });
  });

  it('treats an empty body as undefined, not an error', () => {
    expect(parseJson('')).toBeUndefined();
    expect(parseJson(undefined)).toBeUndefined();
  });

  it('does not treat whitespace as empty', () => {
    expect(fail('   ').status).toBe(400);
  });

  it('defaults the cap to 65536 bytes', () => {
    expect(BODY_MAX_BYTES).toBe(65536);
    const fits = JSON.stringify({ a: 'x'.repeat(65536 - 8) });
    expect(Buffer.byteLength(fits)).toBe(65536);
    expect(parseJson(fits)).toBeDefined();
    const over = JSON.stringify({ a: 'x'.repeat(65536 - 7) });
    expect(Buffer.byteLength(over)).toBe(65537);
    const e = fail(over);
    expect(e.status).toBe(413);
    expect(e.code).toBe('payload_too_large');
  });

  it('measures bytes, not characters', () => {
    // 3-byte characters: 30000 chars is 90000 bytes, and well under 65536 chars.
    const wide = JSON.stringify({ a: '€'.repeat(30000) });
    expect(wide.length).toBeLessThan(65536);
    expect(fail(wide).status).toBe(413);
    // An emoji is 4 bytes in UTF-8 and 2 UTF-16 units.
    const emoji = `"${'😀'.repeat(16384)}"`;
    expect(Buffer.byteLength(emoji)).toBe(65536 + 2);
    expect(fail(emoji).status).toBe(413);
    expect(parseJson(`"${'😀'.repeat(16383)}"`)).toBeDefined();
  });

  it('honours a custom cap', () => {
    expect(parseJson('{"a":1}', 7)).toEqual({ a: 1 });
    expect(fail('{"a":12}', 7).status).toBe(413);
  });

  it('checks the size before parsing (a huge non-JSON body is 413, not 400)', () => {
    expect(fail('x'.repeat(70000)).status).toBe(413);
  });

  it('answers 400 for non-JSON', () => {
    for (const bad of ['not json', '{', '{"a":}', "{'a':1}", '{"a":1,}', 'undefined', '<html>', '{"a":1}{"b":2}']) {
      const e = fail(bad);
      expect(e).toBeInstanceOf(HttpError);
      expect(e.status).toBe(400);
      expect(e.code).toBe('invalid_json');
    }
  });

  it('never puts the input in the error', () => {
    const e = fail('{"secret-token-abc": nope');
    expect(e.message).not.toContain('secret-token-abc');
    expect(e.message).toBe('The request body is not valid JSON.');
  });

  describe('prototype pollution keys', () => {
    const bad = [
      '{"__proto__":{"x":1}}',
      '{"constructor":{"prototype":{"x":1}}}',
      '{"prototype":1}',
      '{"a":{"__proto__":1}}',
      '{"a":{"b":{"c":{"constructor":null}}}}',
      '[{"__proto__":1}]',
      '[[{"a":[{"prototype":0}]}]]',
      '{"a":[1,{"b":{"constructor":1}}]}',
      '{"a":1,"__proto__":{"polluted":true}}',
      '{"\\u005f\\u005fproto\\u005f\\u005f":1}',
    ];
    it.each(bad)('rejects %s with 400', (raw) => {
      const e = fail(raw);
      expect(e.status).toBe(400);
      expect(e.code).toBe('forbidden_key');
    });

    it('does not pollute Object.prototype', () => {
      fail('{"__proto__":{"polluted":true}}');
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('allows look-alike keys and the words as values', () => {
      expect(parseJson('{"proto":1,"__proto":2,"constructors":3,"prototypes":4,"Constructor":5}')).toBeDefined();
      expect(parseJson('{"a":"__proto__","b":["constructor","prototype"]}')).toEqual({
        a: '__proto__',
        b: ['constructor', 'prototype'],
      });
    });
  });

  it('copes with very deep nesting without a stack overflow', () => {
    const depth = 30000;
    const deep = '['.repeat(depth) + ']'.repeat(depth);
    let outcome: number | 'ok';
    try {
      parseJson(deep);
      outcome = 'ok';
    } catch (e) {
      outcome = (e as HttpError).status;
    }
    expect([400, 'ok']).toContain(outcome);
    // And a pollution key at the bottom of a deep tree is still found.
    const deepBad = '['.repeat(5000) + '{"__proto__":1}' + ']'.repeat(5000);
    expect(fail(deepBad).status).toBe(400);
  });
});
