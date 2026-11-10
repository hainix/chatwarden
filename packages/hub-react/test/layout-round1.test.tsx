import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Fix round 1, the stylesheet: every radius and space in the new screens' block is a --cw-* token, and the pieces the fixes added
// (the field label of a hidden word, the confirm row) are styled and neutral.

const css = readFileSync(join(process.cwd(), 'packages', 'hub-react', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const start = css.indexOf('.cw-hub .cw-nowrap {');
const end = css.indexOf('@media (prefers-reduced-motion');
const block = css.slice(start, end);

describe('the new screens block uses tokens for radius and space', () => {
  it('finds the block (control)', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(block).toContain('.cw-doc');
  });

  it('every border-radius, gap, padding and margin value is a var(--cw-*), 0 or auto', () => {
    const bad: string[] = [];
    for (const m of block.matchAll(/(border-radius|gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|row-gap|column-gap):\s*([^;]+);/g)) {
      const value = m[2] as string;
      // Whatever is left after the tokens, zeros and keywords must hold no length of its own.
      const rest = value.replace(/var\(--cw-[a-z0-9-]+\)/g, '').replace(/\b(0|auto|inherit)\b/g, '').replace(/[\s/]+/g, '');
      if (rest !== '') bad.push(`${m[1]}: ${value}`);
    }
    expect(bad).toEqual([]);
  });

  it('the hidden-word field label is styled like the other field labels, and the confirm row takes the whole width', () => {
    expect(css).toMatch(/\.cw-hub \.cw-field \.cw-field-label[\s\S]*?\{[^}]*font-weight:\s*var\(--cw-weight-strong\)/);
    expect(css).toMatch(/\.cw-hub \.cw-term-confirm td\s*\{[^}]*padding:\s*var\(--cw-space-3\)/);
  });

  it('adds no signal colour in the pieces this round added', () => {
    for (const sel of ['.cw-field-label', '.cw-term-confirm']) {
      for (const m of css.matchAll(new RegExp(`[^{}]*${sel.replace('.', '\\.')}[^{}]*\\{([^}]*)\\}`, 'g'))) {
        expect(m[1], sel).not.toMatch(/var\(--cw-(accent|red|yellow|live)/);
      }
    }
  });
});
