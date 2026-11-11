import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The Steps and ladder screen on a phone. jsdom has no layout, so this checks the structure the stylesheet lays out (the ladder grid and
// the preview each in a scroll box of their own) and the rules written in the stylesheet; a real browser checks the pixels (the
// screenshots in the task report measure that the page itself never scrolls sideways at 360px).

const css = readFileSync(join(process.cwd(), 'packages', 'hub-react', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string): string => {
  const lines = css.split('\n');
  const at = lines.findIndex((l) => l.trim() === `${selector} {`);
  if (at < 0) return '';
  return lines.slice(at + 1, lines.findIndex((l, n) => n > at && l.includes('}'))).join('\n');
};

describe('the ladder grid on a phone', () => {
  it('is drawn in a scroll box of its own, and so is the preview', async () => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { path: '/settings/ladder' });
    const grid = await screen.findByRole('region', { name: 'The ladder grid' });
    expect(grid).toHaveClass('cw-scroll');
    expect(grid.querySelector('table')).not.toBeNull();
    const preview = await screen.findByRole('region', { name: 'Preview of suggestions' }, { timeout: 4000 });
    expect(preview).toHaveClass('cw-scroll');
    // Six steps and a header, two columns and the step.
    expect(within(grid).getAllByRole('row')).toHaveLength(7);
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(3);
  });

  it('the scroll box scrolls on its own and is never wider than the pane', () => {
    expect(rule('.cw-hub .cw-scroll')).toMatch(/overflow:\s*auto/);
    expect(rule('.cw-hub .cw-scroll')).toMatch(/max-width:\s*100%/);
  });

  it('every cell has a floor no wider than a phone, so the grid scrolls instead of squeezing', () => {
    const cell = /\.cw-hub \.cw-grid td,\n\.cw-hub \.cw-grid th\[scope='col'\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(Number(/min-width:\s*([\d.]+)rem/.exec(cell)?.[1])).toBeGreaterThan(0);
    expect(Number(/min-width:\s*([\d.]+)rem/.exec(cell)?.[1])).toBeLessThanOrEqual(22);
  });

  it('the panels, the rows of fields and the length boxes can shrink and wrap', () => {
    for (const sel of ['.cw-hub .cw-settings-part', '.cw-hub .cw-settings-body']) expect(css, sel).toMatch(new RegExp(`${sel.replace(/\./g, '\\.')}[,\\s{][^}]*min-width:\\s*0`));
    for (const sel of ['.cw-hub .cw-lchips', '.cw-hub .cw-length-row']) expect(css, sel).toContain(sel);
    expect(rule('.cw-hub .cw-lchips')).toMatch(/flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.cw-hub \.cw-length-row,[^{]*\{[^}]*flex-wrap:\s*wrap/);
  });

  it('adds no phone-only rule: nothing here needs the cascade order to win', () => {
    const phone = /@media \(max-width: 51\.1875rem\)\s*\{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? '';
    expect(phone).not.toMatch(/cw-(settings|lchip|grid|length|kl|savebar|confirm)/);
  });

  it('colours nothing of its own: the card, and the red of a refused field, are the only colours', () => {
    for (const sel of ['.cw-settings', '.cw-lchip', '.cw-grid td', '.cw-confirm', '.cw-savebar', '.cw-length-row']) {
      expect(rule(`.cw-hub ${sel}`), sel).not.toMatch(/var\(--cw-(accent|red|yellow|live)/);
    }
  });
});
