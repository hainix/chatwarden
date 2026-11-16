// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The community list's styles, checked on the stylesheet itself (like the rest of the hub's layout rules): nothing has a width of its own and
// a row of controls wraps, so a 360 px screen never scrolls sideways. The real-browser check at 360 px is in the task report.

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('the community list styles', () => {
  it('give the new classes no fixed width and let every row of controls wrap', () => {
    const rules = [...css.matchAll(/(\.cw-hub [^{}]*\.cw-(?:share|community)[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(8);
    for (const [, selector, body] of rules) {
      expect(body, selector).not.toMatch(/(^|[;\s])(?:min-|max-)?width:\s*\d+(?:\.\d+)?(?:px|rem|em|ch)/);
    }
    for (const selector of ['cw-community-find', 'cw-share-fields']) {
      expect(css, selector).toMatch(new RegExp(`\\.cw-hub \\.${selector}[^{]*\\{[^}]*flex-wrap:\\s*wrap`));
    }
    // A long word or sentence breaks instead of pushing the page wider.
    expect(css).toMatch(/\.cw-hub \.cw-share-consent[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.cw-hub \.cw-share-payload dd[^{]*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('use only the hub\'s tokens for colour and spacing (no colour of their own)', () => {
    const start = css.indexOf('/* ---- The community list');
    const end = css.indexOf('/* ---- Close more reports at once');
    const block = css.slice(start, end);
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    for (const m of block.matchAll(/var\((--cw-[a-z0-9-]+),\s*var\((--cwd-[a-z0-9-]+)\)\)/g)) expect(m[2]).toBe(m[1]?.replace('--cw-', '--cwd-'));
  });
});
