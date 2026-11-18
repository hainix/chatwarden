import { screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { rulesCss } from './css.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The urgent chip, the row word, the strip, the "What to do" panel and the case menu under axe, in both themes. jsdom paints no
// colours, so `color-contrast` is off here; the parts add no colour token (words carry urgency, design 16), and the 360 px checks read
// the stylesheet, as the other layout tests do.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

describe.each(['light', 'dark'] as const)('axe on the urgent lane, %s theme', (theme) => {
  it('the queue with the chip and an urgent row has no violations', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Threatener', reason: 'threat' });
    await w.file({ target: 'Calm' });
    const { container } = renderHub(w, { theme });
    await screen.findByRole('button', { name: /urgent, oldest/ });
    expect(await violations(container)).toEqual([]);
  });

  it('a case with the strip and the open panel has none', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Threatener', reason: 'threat' });
    const { container } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await screen.findByRole('region', { name: 'What to do' });
    expect(await violations(container)).toEqual([]);
  });

  it('a case with the panel collapsed, and one handed off, have none', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Threatener', reason: 'threat' });
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await screen.findByRole('region', { name: 'What to do' });
    await user.click(screen.getByRole('button', { name: 'I passed this to our safety team' }));
    await screen.findByText(/Passed to the safety team by/);
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'What to do' }));
    expect(await violations(container)).toEqual([]);
  });

  it('the open case menu has none', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await user.click(await screen.findByRole('button', { name: 'More actions on this case' }));
    await screen.findByRole('button', { name: 'Mark as urgent' });
    expect(await violations(container)).toEqual([]);
  });

  it('the Simple card with the strip and the panel has none', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Threatener', reason: 'threat' });
    const { container } = renderHub(w, { theme, path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('region', { name: 'What to do' });
    expect(await violations(container)).toEqual([]);
  });
});

describe('at 360 px nothing scrolls sideways', () => {
  const css = rulesCss();
  const rule = (selector: string): string =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => (m[1] as string).split(',').map((s) => s.trim()).includes(selector))
      .map((m) => m[2])
      .join(';');

  it('the chip wraps its words and can shrink', () => {
    expect(rule('.cw-hub .cw-urgent-chip')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-urgent-chip')).toMatch(/text-align:\s*start/);
  });

  it('the strip and the panel can shrink, wrap long words and let their buttons wrap', () => {
    expect(rule('.cw-hub .cw-urgent-strip')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-whattodo')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-whattodo-text')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-whattodo-actions')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('the case menu wraps and takes its own row', () => {
    expect(rule('.cw-hub .cw-case-menu-panel')).toMatch(/min-width:\s*0/);
  });

  it('use no colour of their own: words carry urgency, the plain tokens carry the rest', () => {
    for (const s of ['.cw-hub .cw-urgent-chip', '.cw-hub .cw-urgent-strip', '.cw-hub .cw-whattodo', '.cw-hub .cw-case-menu-panel']) {
      expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
    }
  });
});
