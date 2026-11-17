import { screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetCare, setCare } from '../src/care.js';
import { rulesCss } from './css.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The hidden case, the opened case, the break note and the Your own view panel under axe, in both themes; focus after opening; the 360 px checks read the stylesheet. The parts add no
// colour: a button and plain words.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

beforeEach(() => {
  resetCare();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});
afterEach(() => resetCare());

describe.each(['light', 'dark'] as const)('axe on the careful view, %s theme', (theme) => {
  it('a hidden case and the same case opened have none', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ note: 'a note' });
    setCare({ hideExcerpts: true });
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: /^Show the chat/ }));
    expect(await violations(container)).toEqual([]);
  });

  it('the Simple card, hidden and opened, has none', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({});
    setCare({ hideExcerpts: true });
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('button', { name: /^Show the chat/ });
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: /^Show the chat/ }));
    expect(await violations(container)).toEqual([]);
  });

  it('the break note on a case has none', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({});
    setCare({ hideExcerpts: true, countOpened: true, breakAfter: 1 });
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await user.click(await screen.findByRole('button', { name: /^Show the chat/ }));
    await screen.findByText(/A short break may help/);
    expect(await violations(container)).toEqual([]);
  });

  it('the Your own view panel (off, and with counting and a break chosen) has none', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container, user } = renderHub(w, { theme, path: '/settings/advanced' });
    const region = await screen.findByRole('region', { name: 'Your own view' });
    expect(await violations(container)).toEqual([]);
    await user.click(within(region).getByRole('checkbox', { name: 'Count what I opened' }));
    await user.selectOptions(within(region).getByRole('combobox', { name: 'Offer a break' }), 'After 10 excerpts');
    expect(within(region).getByText('Opened today: 0')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });
});

describe('the panel', () => {
  it('is first in Advanced and loads no data of its own; it says in one sentence what it is and is not', async () => {
    const w = await hubWorld({ role: 'moderator' });
    renderHub(w, { path: '/settings/advanced' });
    const region = await screen.findByRole('region', { name: 'Your own view' });
    const pace = await screen.findByRole('region', { name: 'Slow mode and flooding' });
    expect(region.compareDocumentPosition(pace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(region).getByText('This hides text in your browser. It is care, not protection.')).toBeInTheDocument();
    expect(within(region).getByRole('checkbox', { name: 'Hide excerpts until I open them' })).not.toBeChecked();
    expect(within(region).getByRole('checkbox', { name: 'Count what I opened' })).not.toBeChecked();
    expect(within(region).queryByText(/Opened today/)).toBeNull();
    // Nothing of it was asked of the server.
    expect(w.sent.filter((r) => /care|excerpt/i.test(JSON.stringify(r)))).toEqual([]);
  });
});

describe('at 360 px nothing scrolls sideways', () => {
  const css = rulesCss();
  const rule = (selector: string): string =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] as string).split(',').map((s) => s.trim()).includes(selector))
      .map((m) => m[2])
      .join(';');

  it('the show button wraps its words, and the break note can shrink', () => {
    expect(rule('.cw-hub .cw-hidden-excerpt')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-break-note')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-break-note')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('use no colour of their own', () => {
    for (const s of ['.cw-hub .cw-hidden-excerpt', '.cw-hub .cw-break-note', '.cw-hub .cw-care']) {
      expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
    }
  });
});
