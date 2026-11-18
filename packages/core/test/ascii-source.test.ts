import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeForRepeat } from '../src/paceDecide.js';

// Review m1: source files written in this repo carry non-ASCII only as \u escapes (an invisible character inside a regex cannot be read or reviewed).

const BS = String.fromCharCode(92);
const text = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('paceDecide source', () => {
  it('is ASCII only, so the variation-selector class is written with unicode escapes', () => {
    const src = text('../src/paceDecide.ts');
    expect(/^[\p{ASCII}]*$/u.test(src)).toBe(true);
    expect(src).toContain(`[${BS}uFE00-${BS}uFE0F]`);
  });

  it('still treats a keycap line with and without the variation selector as one line, and strips every selector in U+FE00 to U+FE0F', () => {
    expect(normalizeForRepeat('1\uFE0F\u20E3')).toBe(normalizeForRepeat('1\u20E3'));
    for (let cp = 0xfe00; cp <= 0xfe0f; cp++) expect(normalizeForRepeat(`a${String.fromCharCode(cp)}b`)).toBe('ab');
    expect(normalizeForRepeat('a\uFDFFb')).toBe(normalizeForRepeat('a\uFDFFb'));
    expect(normalizeForRepeat('Hello, World!')).toBe('helloworld');
  });
});
