import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The panes, as the page lays them out. jsdom has no layout, so this checks the structure the stylesheet lays out (the classes
// and data attributes, and the order of the panes) and the breakpoints written in the stylesheet itself. A real browser checks
// the pixels: three panes from 75rem (1200px), two from 51.25rem (820px), stacked below, no sideways scroll down to 360px.

const css = readFileSync(join(process.cwd(), 'packages', 'hub-react', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first `@media (query) { ... }` block, matching braces. */
function media(query: string): string {
  const start = css.indexOf(`@media (${query})`);
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

describe('the pane structure', () => {
  it('lays out rail, queue and a work column with the case and its panel, in that order', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const { container } = renderHub(w, { path: `/reports/${a.id}` });
    await screen.findByRole('complementary', { name: 'About this case' });
    const body = container.querySelector('.cw-body') as HTMLElement;
    expect(body).toHaveAttribute('data-queue', 'true');
    expect(body).toHaveAttribute('data-case', 'true');
    const kids = [...body.children].map((c) => c.className);
    expect(kids).toEqual(['cw-rail', 'cw-queue', 'cw-work']);
    const work = body.querySelector('.cw-work') as HTMLElement;
    expect([...work.children].map((c) => c.tagName)).toEqual(['MAIN', 'ASIDE']);
  });

  it('has no case panel on a screen that is not a case, so the work column is one pane', async () => {
    const w = await hubWorld();
    const { container } = renderHub(w);
    await screen.findByRole('region', { name: 'Open cases' });
    expect(container.querySelector('.cw-body')).toHaveAttribute('data-case', 'false');
    expect(container.querySelector('.cw-ctx')).toBeNull();
  });

  it('a role that cannot read reports gets two columns: no queue pane, rail and work', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'reports.read': 'owner' } });
    const { container } = renderHub(w);
    await waitFor(() => expect(container.querySelector('.cw-body')).not.toBeNull());
    const body = container.querySelector('.cw-body') as HTMLElement;
    expect(body).toHaveAttribute('data-queue', 'false');
    expect([...body.children].map((c) => c.className)).toEqual(['cw-rail', 'cw-work']);
    expect(within(body).queryByRole('region', { name: 'Open cases' })).toBeNull();
  });

  it('the top bar comes before the body, then the live regions and windows are outside the panes', async () => {
    const w = await hubWorld();
    const { container } = renderHub(w);
    await screen.findByRole('region', { name: 'Open cases' });
    const root = container.querySelector('.cw-hub') as HTMLElement;
    const order = [...root.children].map((c) => c.className || c.tagName);
    expect(order.indexOf('cw-top')).toBeLessThan(order.indexOf('cw-body'));
    expect(root.querySelector('.cw-body .cw-toasts')).toBeNull();
  });
});

describe('the breakpoints in the stylesheet', () => {
  it('three panes from 75rem (1200px): the case and its panel side by side, each scrolling on its own', () => {
    const three = media('min-width: 75rem');
    expect(three).toMatch(/\.cw-body\[data-case='true'\] \.cw-work\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) var\(--cw-context-width\)/);
    expect(three).toMatch(/overflow-y:\s*auto/);
  });

  it('the body is rail, queue and work as columns, from the layout tokens', () => {
    expect(css).toMatch(/\.cw-hub \.cw-body\[data-queue='true'\]\s*\{[^}]*grid-template-columns:\s*var\(--cw-nav-width\) var\(--cw-queue-width\) minmax\(0, 1fr\)/);
  });

  it('two panes between 51.25rem (820px) and 75rem: the case panel is not a third column', () => {
    // Nothing outside the 75rem block turns the work column into a grid, so below it the case panel stacks under the case.
    const outside = css.replace(media('min-width: 75rem'), '');
    expect(outside).not.toMatch(/\.cw-work\s*\{[^}]*display:\s*grid/);
  });

  it('stacked below 820px: the page grows, the body is a block, the queue list is a short scroll box', () => {
    const phone = media('max-width: 51.1875rem');
    expect(phone).toMatch(/\.cw-hub\s*\{[^}]*height:\s*auto/);
    expect(phone).toMatch(/\.cw-body,\s*\.cw-hub \.cw-body\[data-queue='true'\]\s*\{[^}]*display:\s*block/);
    expect(phone).toMatch(/\.cw-queue-list\s*\{[^}]*max-height:\s*20rem/);
  });

  it('the breakpoints meet without a gap: 51.1875rem and 51.25rem are one pixel apart at 16px', () => {
    expect(51.25 * 16).toBe(820);
    expect(51.1875 * 16).toBe(819);
  });

  it('nothing is a fixed width wider than a phone outside a min-width query or min()', () => {
    // At 360px a rem width over 22rem would make the page scroll sideways.
    const base = css
      .replace(/@media \(min-width[^)]*\)\s*\{/g, '@@')
      .replace(/@container[^{]*min-width[^{]*\{/g, '@@')
      .split('\n')
      .filter((line) => /^\s*(min-)?width:\s*[\d.]+rem/.test(line) && !line.includes('min('));
    const wide = base.filter((line) => Number(/([\d.]+)rem/.exec(line)?.[1]) > 22);
    expect(wide).toEqual([]);
  });

  it('every pane can shrink: the grid children set min-width 0 and the case pane is a size container', () => {
    expect(css).toMatch(/\.cw-hub \.cw-work\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.cw-hub \.cw-main\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.cw-hub \.cw-queue\s*\{[^}]*min-width:\s*0/);
  });

  it('the report page opens its own columns by the width of the case pane, not of the window', () => {
    expect(css).toMatch(/@container cwmain \(min-width: 64rem\)\s*\{[^}]*\.cw-cols--report/);
    expect(media('min-width: 75rem') + media('max-width: 51.1875rem')).not.toMatch(/cw-cols--report/);
  });
});
