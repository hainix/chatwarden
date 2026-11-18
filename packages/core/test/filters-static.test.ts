import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The filter modules never build a regular expression from data: no `new RegExp`, and every regular-expression literal is one of a short
// reviewed list. A new literal fails here until someone has looked at it (and at its backtracking) and added it below.

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const FILES = [`${SRC}filters.ts`, ...readdirSync(`${SRC}filters/`).filter((f) => f.endsWith('.ts')).map((f) => `${SRC}filters/${f}`)];

/** Every regular-expression literal of one source, as written. */
function literals(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) found.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * The reviewed literals. Each is a character class or a fixed word under an anchor or a single quantifier; none has a group under a
 * quantifier, so none can backtrack badly.
 */
const REVIEWED: readonly string[] = [
  // filters.ts
  '/^[\\p{L}\\p{N}_-]+$/u', // one domain label
  '/^[a-z][a-z0-9_-]{0,31}$/', // a phrase rule id
  // fold.ts
  '/\\p{L}/u', // one character is a letter
  '/\\p{N}/u', // one character is a number
  '/\\p{M}/gu', // combining marks, removed after NFD
  // links.ts
  '/^[\\p{L}\\p{N}\\p{M}]$/u', // one character of a host label outside ASCII
  // personal.ts
  '/^\\p{L}$/u', // one character outside ASCII is a letter
  // ratio.ts
  '/\\p{Extended_Pictographic}/u', // one character is an emoji or a pictograph
  // phrases.ts
  '/^[\\p{L}\\p{N}\\p{M}@$.\'\\u{ad}\\u{200b}-\\u{200f}\\u{2060}-\\u{2064}\\u{feff}]+$/u', // what a pattern word may be written with
  '/\\s+/u', // the words of a pattern
];

describe('the filter modules hold no regular expression built from data', () => {
  it('finds the modules (a control: the scan sees the files it should)', () => {
    const names = FILES.map((f) => f.slice(SRC.length));
    expect(names).toEqual(expect.arrayContaining(['filters.ts', 'filters/fold.ts', 'filters/phrases.ts', 'filters/lists.ts', 'filters/links.ts', 'filters/chars.ts']));
  });

  it('no `new RegExp` and no RegExp call anywhere', () => {
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/new\s+RegExp\s*\(/);
      expect(text, file).not.toMatch(/(^|[^.\w])RegExp\s*\(/);
    }
  });

  it('every regular-expression literal is in the reviewed list', () => {
    const unreviewed: string[] = [];
    for (const file of FILES) for (const lit of literals(file)) if (!REVIEWED.includes(lit)) unreviewed.push(`${file.slice(SRC.length)}: ${lit}`);
    expect(unreviewed).toEqual([]);
  });

  it('every reviewed literal is still used somewhere (the list does not go stale)', () => {
    const used = new Set(FILES.flatMap(literals));
    for (const lit of REVIEWED) expect(used.has(lit), lit).toBe(true);
  });

  it('no reviewed literal puts a quantifier on a group', () => {
    for (const lit of REVIEWED) expect(lit, lit).not.toMatch(/\)[+*{?]/);
  });

  it('the scan can tell a literal from a string (control)', () => {
    const probe = ts.createSourceFile('x.ts', "const a = '/x+/'; const b = /y+/u;", ts.ScriptTarget.ES2022, true);
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isRegularExpressionLiteral(n)) found.push(n.getText(probe));
      ts.forEachChild(n, visit);
    };
    visit(probe);
    expect(found).toEqual(['/y+/u']);
  });
});
