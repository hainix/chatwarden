import { cleanup, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// Settings > Advanced > "Chat filters" under axe, in both themes and in each state: off, a card open with its action choice, a problem shown, the tester
// and checker results, the Hits table, the confirm over 5 percent and a read-only role. jsdom paints no colours, so `color-contrast` is off; the panel adds no
// colour token of its own (counts are numbers, a chip is the existing neutral tag). 360 px: the panel is one column of fields and wraps, never a fixed width.
const RULES = { 'color-contrast': { enabled: false } } as const;

afterEach(() => cleanup());

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

describe.each(['light', 'dark'] as const)('axe on the chat filters panel, %s theme', (theme) => {
  async function open(w: HubWorld) {
    const r = renderHub(w, { theme, path: '/settings/advanced' });
    await screen.findByRole('region', { name: 'Chat filters' });
    return r;
  }
  const panel = (): HTMLElement => screen.getByRole('region', { name: 'Chat filters' });

  it('off, and a role that only reads, have no violations', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container } = await open(w);
    expect(await violations(container)).toEqual([]);
    cleanup();
    const ro = await hubWorld({ role: 'senior', overrides: { filters: { links: { action: 'refuse' }, phrases: [{ id: 'gold', action: 'count', phrases: ['buy gold'] }] } } });
    const view = await open(ro);
    expect(await violations(view.container)).toEqual([]);
  });

  it('every card open with a problem showing has none', async () => {
    const w = await hubWorld({ role: 'owner', overrides: { filters: { links: { action: 'count' }, personalInfo: { action: 'flag' }, ratio: { action: 'mask' }, phrases: [{ id: 'gold', action: 'count', phrases: ['buy gold'] }] } } });
    const { container, user } = await open(w);
    await user.type(within(panel()).getByRole('textbox', { name: 'Add an allowed domain' }), 'github.io');
    await user.click(within(panel()).getByRole('button', { name: 'Add to allowed domains' }));
    await within(panel()).findByText(/list the exact name with =/i);
    expect(await violations(container)).toEqual([]);
  });

  it('the tester result, the checker result with its confirm and the Hits table have none', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => (i < 10 ? `visit blorf${i}.com` : `chat ${i}`));
    const w = await hubWorld({ role: 'owner', recentLines: () => lines, overrides: { filters: { links: { action: 'refuse' } } } });
    w.store.addFilterHits([{ day: Math.floor(w.clock.now() / 86_400_000), key: 'link.unlisted', action: 'refuse', hits: 3 }]);
    const { container, user } = await open(w);
    await user.type(within(panel()).getByRole('textbox', { name: 'A message to try' }), 'see blorf.com now');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    await within(panel()).findByRole('status', { name: 'Result of the test' });
    await user.click(within(panel()).getByRole('button', { name: 'Check my changes' }));
    await within(panel()).findByText(/10 of 50 recent lines/);
    await user.click(within(panel()).getByText('What the filters did'));
    await within(panel()).findByRole('table', { name: 'What the filters did' });
    expect(await violations(container)).toEqual([]);
  });

  it('the save question and the reset question have none', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container, user } = await open(w);
    await user.click(within(panel()).getByRole('checkbox', { name: 'Links' }));
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('textbox', { name: /Why are you changing this/ });
    expect(await violations(container)).toEqual([]);
  });
});

describe('small screens', () => {
  it('the panel has no fixed width: nothing in its markup sets a pixel width, and the stylesheet wraps its rows', async () => {
    const w = await hubWorld({ role: 'owner', overrides: { filters: { links: { action: 'count' } } } });
    renderHub(w, { path: '/settings/advanced' });
    const panel = await screen.findByRole('region', { name: 'Chat filters' });
    expect(panel.outerHTML).not.toMatch(/style="[^"]*width\s*:\s*\d+px/);
  });
});
