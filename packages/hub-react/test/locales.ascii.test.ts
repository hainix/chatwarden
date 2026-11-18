// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';

// Source stays ASCII (standing rule): a letter with an accent is written as a \u escape, which is the same string at run time. The shipped words are checked
// from the source files, and the two strings this once got wrong (R3 minor 1) are pinned by value.

const DIR = join(__dirname, '..', 'src', 'locales');

describe('the locale sources are ASCII', () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
    it(`${file} has no raw non-ASCII character`, () => {
      const bad = readFileSync(join(DIR, file), 'utf8')
        .split('\n')
        .map((line, i) => ({ line: i + 1, text: line }))
        .filter((l) => [...l.text].some((ch) => ch.charCodeAt(0) > 127))
        .map((l) => l.line);
      expect(bad).toEqual([]);
    });
  }

  it('the accents are still in the shipped words: the escape is the same string', () => {
    expect(es['hub.appeals.fail.reason']).toContain('decisi\u00f3n');
    expect(pt['hub.appeals.fail.reason']).toContain('n\u00e3o');
  });
});
