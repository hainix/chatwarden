import { cleanup, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The first-run panel under axe, in both themes and in each state a person meets: the panel with nothing chosen, with a choice (and its preview), after a refused apply, and on the Simple
// home. jsdom paints no colours, so `color-contrast` is off here; the panel adds no colour token of its own.
const RULES = { 'color-contrast': { enabled: false } } as const;
const WAIT = { timeout: 4000 };

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

afterEach(() => cleanup());

describe.each(['light', 'dark'] as const)('axe on the first-run panel, %s theme', (theme) => {
  it('with nothing chosen, with a choice and its preview, and for the creator choice, has none', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container, user } = renderHub(w, { theme });
    await screen.findByRole('heading', { level: 2, name: 'What kind of game is this?' }, WAIT);
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('radio', { name: 'Games for kids or teens' }));
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('radio', { name: 'Creator and streaming communities' }));
    expect(within(screen.getByRole('region', { name: 'What kind of game is this?' })).getByText(/Protect the creator/)).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('arrow keys move the choice', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { user } = renderHub(w, { theme });
    await screen.findByRole('heading', { level: 2, name: 'What kind of game is this?' }, WAIT);
    const radios = screen.getAllByRole('radio');
    radios[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(radios[1]).toBeChecked();
    expect(radios[1]).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(radios[3]).toBeChecked();
  });

  it('after a refused apply (the conflict message and its Reload) has none', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container, user } = renderHub(w, { theme });
    await screen.findByRole('heading', { level: 2, name: 'What kind of game is this?' }, WAIT);
    await user.click(screen.getByRole('radio', { name: 'Games for kids or teens' }));
    w.cw.policy.save({ pace: { slowModeMs: 2000 } }, { version: 0, actor: 'x', reason: 'seed' });
    await user.click(screen.getByRole('button', { name: 'Use these principles' }));
    await screen.findByRole('alert', undefined, WAIT);
    expect(await violations(container)).toEqual([]);
  });

  it('on the Simple home has none', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container, user } = renderHub(w, { theme, mode: 'simple' });
    await screen.findByRole('heading', { level: 2, name: 'What kind of game is this?' }, WAIT);
    await user.click(screen.getByRole('radio', { name: 'Social or casual games, with mixed ages' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Social or casual games, with mixed ages' })).toBeChecked());
    expect(await violations(container)).toEqual([]);
  });
});
