import { afterEach, describe, expect, it, vi } from 'vitest';
import { BODY_MAX_BYTES, HttpError, parseJson } from '../src/index.js';

// The body cap is in UTF-8 bytes. A browser has no `Buffer`, so the count must not need it: every case here runs with the
// `Buffer` global removed, and checks the answer at exactly the limit and one byte past it.

const MAX = BODY_MAX_BYTES;
const enc = new TextEncoder();

/** A JSON string literal of exactly `bytes` UTF-8 bytes: `unit` repeated, padded with ASCII, inside quotes. */
function literal(bytes: number, unit: string): string {
  const unitBytes = enc.encode(unit).length;
  const inner = bytes - 2; // the quotes
  const n = Math.floor(inner / unitBytes);
  const out = `"${unit.repeat(n)}${'x'.repeat(inner - n * unitBytes)}"`;
  expect(enc.encode(out).length).toBe(bytes);
  return out;
}

const status = (raw: string, max?: number): number => {
  try {
    parseJson(raw, max);
    return 200;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
};

const UNITS: Array<[string, string]> = [
  ['ASCII', 'a'],
  ['2-byte (e-acute)', 'é'],
  ['3-byte (euro sign)', '€'],
  ['4-byte astral (emoji)', '\u{1F600}'],
];

describe('parseJson body cap without a Buffer global', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the stub really removes Buffer', () => {
    vi.stubGlobal('Buffer', undefined);
    expect(typeof Buffer).toBe('undefined');
  });

  for (const [name, unit] of UNITS) {
    it(`${name}: exactly the limit passes, limit + 1 byte is 413`, () => {
      const atLimit = literal(MAX, unit);
      const over = literal(MAX + 1, unit);
      vi.stubGlobal('Buffer', undefined);
      expect(status(atLimit)).toBe(200);
      expect(status(over)).toBe(413);
    });

    it(`${name}: well under the limit passes, and far over is 413`, () => {
      const small = literal(1000, unit);
      const huge = literal(MAX * 3, unit);
      vi.stubGlobal('Buffer', undefined);
      expect(status(small)).toBe(200);
      expect(status(huge)).toBe(413);
    });
  }

  it('counts bytes, not characters: 21846 euro signs (65538 bytes of text) is over although few characters', () => {
    const raw = `"${'€'.repeat(21_846)}"`;
    expect(raw.length).toBeLessThan(MAX);
    vi.stubGlobal('Buffer', undefined);
    expect(status(raw)).toBe(413);
  });

  it('counts a lone surrogate as the 3 bytes the encoder gives it (U+FFFD)', () => {
    const lone = '\ud800';
    expect(enc.encode(lone).length).toBe(3);
    // MAX - 2 bytes of ASCII plus the 3-byte lone surrogate, inside quotes, is MAX + 3 - ... over the limit.
    const raw = `"${'x'.repeat(MAX - 2)}${lone}"`;
    expect(enc.encode(raw).length).toBe(MAX + 3);
    vi.stubGlobal('Buffer', undefined);
    expect(status(raw)).toBe(413);
  });

  it('honours a custom max, at the boundary', () => {
    vi.stubGlobal('Buffer', undefined);
    expect(status('"abcdefgh"', 10)).toBe(200); // 10 bytes
    expect(status('"abcdefghi"', 10)).toBe(413); // 11 bytes
    expect(status('"€€€"', 11)).toBe(200); // 2 + 9 bytes
    expect(status('"€€€"', 10)).toBe(413);
    expect(status('"\u{1F600}\u{1F600}"', 10)).toBe(200); // 2 + 8 bytes
    expect(status('"\u{1F600}\u{1F600}"', 9)).toBe(413);
  });

  it('refuses the oversize body before any parsing (not-JSON over the cap is 413, not 400)', () => {
    vi.stubGlobal('Buffer', undefined);
    expect(status('x'.repeat(MAX + 1))).toBe(413);
    expect(status('x'.repeat(10))).toBe(400);
  });

  it('control: still parses and still rejects forbidden keys with no Buffer', () => {
    vi.stubGlobal('Buffer', undefined);
    expect(parseJson('{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(() => parseJson('{"__proto__":1}')).toThrow(HttpError);
    expect(parseJson('')).toBeUndefined();
  });

  it('control: gives the same answers with Buffer present', () => {
    expect(status(literal(MAX, '€'))).toBe(200);
    expect(status(literal(MAX + 1, '€'))).toBe(413);
  });
});
