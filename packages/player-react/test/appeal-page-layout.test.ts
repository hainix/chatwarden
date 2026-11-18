// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom paints and measures nothing, so the appeal page's phone width (360 px) and its dark mode are checked as the other layout tests check them: through the rules the stylesheet
// lays it out with. The page is the one element of the kit that is a page, not a dialog, so it has a width of its own, and it takes every colour from the tokens (which carry the
// dark values), never from a colour of its own.

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/var\((--cw-[a-z0-9-]+), var\(--cwd-[a-z0-9-]+\)\)/g, 'var($1)');

/** The declarations of every rule whose selector list contains `selector` (whitespace-normalised), joined. */
function rule(selector: string): string {
  let out = '';
  for (const m of css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    if ((m[1] as string).split(',').map((x) => x.trim().replace(/\s+/g, ' ')).includes(selector)) out += m[2] as string;
  }
  return out;
}

const PAGE = ['.cw-player.cw-appeal-page', '.cw-player .cw-appeal-card', '.cw-player .cw-appeal-form'];

describe('the appeal page at 360 px', () => {
  it('is a column of its own width that never grows past the screen, with a margin on each side', () => {
    const page = rule('.cw-player.cw-appeal-page');
    expect(page).toMatch(/max-width:\s*40rem/);
    expect(page).toMatch(/margin-inline:\s*auto/);
    expect(page).toMatch(/padding:\s*var\(--cw-space-4\)/);
    expect(page).toMatch(/min-width:\s*0/);
    // No fixed width a 360 px phone cannot hold.
    for (const selector of PAGE) expect(rule(selector), selector).not.toMatch(/(^|;|\s)width:\s*\d+(px|rem)/);
  });

  it('the card and the form can shrink, and long words wrap in them', () => {
    expect(rule('.cw-player .cw-appeal-card')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-player .cw-appeal-form')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-player')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-player textarea')).toMatch(/width:\s*100%/);
    expect(rule('.cw-player textarea')).toMatch(/max-width:\s*100%/);
  });

  it('Send is as wide as the column on a phone', () => {
    expect(rule('.cw-player.cw-appeal-page .cw-actions .cw-btn')).toMatch(/inline-size:\s*100%|width:\s*100%/);
  });
});

describe('the appeal page in dark mode', () => {
  it('takes its colours from the tokens only: no colour value of its own in any rule it adds', () => {
    for (const selector of PAGE) {
      const body = rule(selector);
      expect(body, `${selector} has rules`).not.toBe('');
      expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b/i);
    }
  });

  it('the tokens it reads have dark values: the surface, the text, the border and the muted text', () => {
    const tokens = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
    for (const name of ['surface', 'surface-sunken', 'border', 'ink', 'ink-muted']) expect(tokens).toMatch(new RegExp(`--cwd-${name}: light-dark\\(#[0-9a-f]{6}, #[0-9a-f]{6}\\)`));
    expect(rule('.cw-player.cw-appeal-page')).not.toMatch(/color-scheme/);
  });
});
