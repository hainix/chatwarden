import { buildMatcher } from '@chatwarden/matcher';
import { describe, expect, it } from 'vitest';
import { MAX_GENERATED_POSITIVE, positiveTemplates } from '../src/build/templates.js';

// Positive-line templates (design 6.6): invented words only. The cap is the service's own, well under the kit parser's 50 a row.

const blocks = (term: string, line: string): boolean => buildMatcher([{ id: 'x', term, language: 'en', active: true }], []).match(line) !== null;

describe('positiveTemplates', () => {
  it('the cap is stated: 8 lines a term, well under the kit parser\u2019s 50 (the canary cost is linear in it)', () => {
    expect(MAX_GENERATED_POSITIVE).toBe(8);
    expect(MAX_GENERATED_POSITIVE).toBeLessThan(50 / 4);
  });

  it.each(['zorbak', 'vlemmo', 'Quissel', 'drakkuun', 'fenrisk', 'tarvo', 'sn\u00e9rp', 'glarn', 'zorbakkk'])('%s: at most the cap, distinct, each blocked by its own term, bare first', (term) => {
    const lines = positiveTemplates(term);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.length).toBeLessThanOrEqual(MAX_GENERATED_POSITIVE);
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines[0]).toBe(term);
    for (const line of lines) expect(blocks(term, line), JSON.stringify(line)).toBe(true);
  });

  it('covers the five shapes of the design: bare, upper case, in a sentence, glued punctuation, a look-alike spelling', () => {
    const lines = positiveTemplates('zorbak');
    expect(lines).toContain('zorbak');
    expect(lines).toContain('ZORBAK');
    expect(lines.some((l) => /^you zorbak$/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('zorbak!!'))).toBe(true);
    expect(lines.some((l) => /zorbakkk|z\u200borbak|zor\u200bbak|zorb\u200bak/.test(l))).toBe(true);
  });

  it('every line is at most 200 characters, also for the longest term', () => {
    const long = 'zorbakvlemmoquisselvlemmozorbakglarnsnerpa'.slice(0, 40);
    for (const line of positiveTemplates(long)) expect(line.length).toBeLessThanOrEqual(200);
  });

  it('is deterministic and holds no word but the term and ordinary ones', () => {
    expect(positiveTemplates('glarn')).toEqual(positiveTemplates('glarn'));
    const noTerm = positiveTemplates('glarn').map((l) => l.replaceAll(/glarn|GLARN|g[\u200b]?larn/gi, ''));
    for (const rest of noTerm) expect(rest).toMatch(/^[ a-z!".\u200b]*$/);
  });
});
