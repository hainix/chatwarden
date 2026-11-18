import { screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { rulesCss } from './css.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { WorldOptions } from './world.js';

// The context chip (Detailed and Simple) and the Room contexts list under axe, in both themes; the 360 px checks read the stylesheet. Words, not colour.
const RULES = { 'color-contrast': { enabled: false } } as const;
const CONTEXTS: NonNullable<NonNullable<WorldOptions['overrides']>['contexts']> = { kids: { label: 'Kids rooms', pace: { slowModeMs: 3000 }, profanity: { mode: 'refuse' } }, ranked: {} };

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

describe.each(['light', 'dark'] as const)('axe on the contexts, %s theme', (theme) => {
  it('the Room contexts list (declared, and empty) has none', async () => {
    const empty = await hubWorld();
    const a = renderHub(empty, { theme, path: '/settings/advanced' });
    await within(await screen.findByRole('region', { name: 'Room contexts' })).findByText(/No room contexts are declared/);
    expect(await violations(a.container)).toEqual([]);
    a.unmount();
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const { container } = renderHub(w, { theme, path: '/settings/advanced' });
    await within(await screen.findByRole('region', { name: 'Room contexts' })).findByRole('list', { name: 'Declared contexts' });
    expect(await violations(container)).toEqual([]);
  });

  it('the Detailed case with the chip has none', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({ tags: { context: 'kids' } });
    const { container } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await screen.findByLabelText('Room type: Kids rooms');
    expect(await violations(container)).toEqual([]);
  });

  it('the Simple card with the chip has none', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({ tags: { context: 'kids' } });
    const { container } = renderHub(w, { theme, path: `/reports/${f.id}`, mode: 'simple', stay: true });
    await screen.findByLabelText('Room type: Kids rooms');
    expect(await violations(container)).toEqual([]);
  });
});

describe('at 360 px nothing scrolls sideways', () => {
  const css = rulesCss();
  const rule = (selector: string): string =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] as string).split(',').map((x) => x.trim()).includes(selector))
      .map((m) => m[2])
      .join(';');

  it('the list can shrink and wraps long names and labels; the chip wraps too', () => {
    expect(rule('.cw-hub .cw-contexts-list')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-contexts-list')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-context')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('use no colour of their own (the chip is the existing tag)', () => {
    for (const s of ['.cw-hub .cw-contexts-list', '.cw-hub .cw-context']) expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
  });
});
