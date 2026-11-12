import { cleanup, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetHiddenAi } from '../src/ai/hide.js';
import { aiCase, strip } from './aiHub.js';
import { rulesCss } from './css.js';

// The AI strip and its menu under axe, in both themes and in each state a moderator meets. jsdom paints no colours, so `color-contrast`
// is off here: the strip uses only the neutral tokens, whose contrast the static tests compute.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

afterEach(() => {
  forgetHiddenAi();
  cleanup();
});

describe.each(['light', 'dark'] as const)('axe on the AI strip, %s theme', (theme) => {
  it('axe: no violations, light and dark: the strip', async () => {
    const { container } = await aiCase({ level: 1, theme });
    await strip();
    expect(await violations(container)).toEqual([]);
  });

  it('with the details menu open', async () => {
    const { container, user } = await aiCase({ level: 1, theme });
    await user.click(within(await strip()).getByRole('button', { name: 'AI details' }));
    expect(screen.getByRole('group', { name: 'AI details' })).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('with the hidden line', async () => {
    const { container, user } = await aiCase({ level: 1, theme });
    await user.click(within(await strip()).getByRole('button', { name: 'AI details' }));
    await user.click(screen.getByRole('button', { name: 'Hide the AI on this case' }));
    expect(screen.getByText('The AI is hidden on this case.')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('on the Simple mode card', async () => {
    const { container } = await aiCase({ level: 1, theme, mode: 'simple' });
    await strip();
    expect(await violations(container)).toEqual([]);
  });

  it('a stale read with the menu open', async () => {
    const { container, user } = await aiCase({ level: 1, theme });
    await user.click(within(await strip()).getByRole('button', { name: 'AI details' }));
    expect(await violations(container)).toEqual([]);
  });
});

describe('at 360 px the strip wraps and nothing scrolls sideways', () => {
  const css = rulesCss();
  const rule = (selector: string): string => {
    const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => (m[1] as string).split(',').map((s) => s.trim()).includes(selector));
    return found.map((m) => m[2]).join(';');
  };

  it('the strip is a wrapping row and breaks a long word', () => {
    expect(rule('.cw-hub .cw-ai-head')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.cw-hub .cw-ai')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-ai-summary')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-ai-summary')).not.toMatch(/white-space:\s*nowrap/);
  });

  it('the strip has a dashed outline and no colour of its own', () => {
    expect(rule('.cw-hub .cw-ai')).toMatch(/border:[^;]*dashed/);
    expect(rule('.cw-hub .cw-ai')).not.toMatch(/#[0-9a-f]{3,8}|rgb|hsl|oklch/i);
    for (const s of ['.cw-hub .cw-ai', '.cw-hub .cw-ai-head', '.cw-hub .cw-ai-summary', '.cw-hub .cw-aitag', '.cw-hub .cw-aitick', '.cw-hub .cw-ai-menu']) {
      expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
    }
  });

  it('the menu is in the flow on a phone (it grows the strip, it does not float off the screen)', () => {
    expect(rule('.cw-hub .cw-ai-menu')).not.toMatch(/position:\s*absolute/);
    expect(rule('.cw-hub .cw-ai-menu')).toMatch(/min-width:\s*0/);
  });
});
