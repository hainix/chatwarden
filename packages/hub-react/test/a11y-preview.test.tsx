import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';

// "What the player sees" under axe, in both themes, and the panel's own rules: no focusable element, the notice in English, text that wraps at 360 px.
// jsdom paints no colours (so `color-contrast` is off here; the stylesheet's contrast is computed from its tokens by the static tests) and has no layout,
// so "no sideways scroll at 360 px" is held on the stylesheet's rules for the panel (the real-browser check is in the task report).

const RULES = { 'color-contrast': { enabled: false } } as const;
const violations = async (container: HTMLElement): Promise<string[]> => {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
};

describe.each(['light', 'dark'] as const)('axe on the panel, %s theme', (theme) => {
  async function open() {
    const w = await appealsHub({ role: 'senior', names: { renames: true } });
    const f = await w.file({ target: 'Mallory' });
    await w.sanction(f.person, 'chat', 2, 24 * 3_600_000);
    const r = renderHub(w, { theme, path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    return r;
  }

  it('the Sanction form with a rename notice in the panel has no violations', async () => {
    const { container, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    const form = await screen.findByRole('region', { name: 'Sanction Mallory' });
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    const panel = await within(form).findByRole('region', { name: 'What the player sees' });
    await user.selectOptions(screen.getByLabelText('What happens'), 'rename');
    await user.selectOptions(screen.getByLabelText('Community Rule'), '7');
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 4 })).toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
  });

  it('the direct chat restriction (the chat-box line) and the note form have no violations', async () => {
    const { container, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Sanction' }));
    const form = await screen.findByRole('region', { name: 'Sanction Mallory' });
    await within(form).findByRole('region', { name: 'What the player sees' });
    await user.selectOptions(screen.getByLabelText('What happens'), 'chat');
    await waitFor(() => expect(form).toHaveTextContent('This is what the chat box shows them'));
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    const note = await screen.findByRole('region', { name: 'Add a note about Mallory' });
    await within(note).findByRole('region', { name: 'What the player sees' });
    expect(await violations(container)).toEqual([]);
  });

  it('the revoke panel has no violations', async () => {
    const { container, user } = await open();
    await user.click(within(screen.getByRole('region', { name: 'In force now' })).getAllByRole('button', { name: /^Revoke/ })[0] as HTMLElement);
    await within(screen.getByRole('form', { name: /^Revoke/ })).findByRole('region', { name: 'What the player sees' });
    expect(await violations(container)).toEqual([]);
  });
});

describe.each(['light', 'dark'] as const)('axe on the case decision, %s theme', (theme) => {
  async function openCase(options: Parameters<typeof appealsHub>[0] = {}) {
    const w = await appealsHub({ role: 'owner', names: { renames: true }, ...options });
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const r = renderHub(w, { theme, path: `/reports/${f.id}`, mode: 'detailed' });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    const bar = await screen.findByRole('region', { name: 'Decision' });
    await within(bar).findByRole('radio', { name: 'Fair' });
    return { ...r, bar };
  }

  it('the bar with the rename row ticked and the panel showing two notices has no violations', async () => {
    const { container, user, bar } = await openCase();
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    await user.click(within(bar).getByRole('checkbox', { name: 'Ask for a new name' }));
    const panel = await within(bar).findByRole('region', { name: 'What the player sees' });
    await waitFor(() => expect(within(panel).getAllByRole('heading', { level: 4 }).length).toBeGreaterThan(1));
    expect(await violations(container)).toEqual([]);
  });

  it('the bar with the off-hint (renames off, a link for the owner) has no violations', async () => {
    const { container, bar } = await openCase({ names: undefined });
    await within(bar).findByText('Asking for a new name is switched off. Turn it on in', { exact: false });
    expect(await violations(container)).toEqual([]);
  });

  it('the Simple card with its panel has no violations', async () => {
    const w = await appealsHub({ role: 'owner', names: { renames: true } });
    const f = await w.file({ target: 'Mallory' });
    const { container } = renderHub(w, { theme, path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('button', { name: /^No action needed/ });
    await within(screen.getByRole('region', { name: 'Decision' })).findByRole('region', { name: 'What the player sees' });
    expect(await violations(container)).toEqual([]);
  });
});

describe('the panel is built to wrap, not to scroll sideways (360 px)', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/(\.cw-hub \.cw-pv[^{]*)\{([^}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));

  it('the panel has rules, and the notice box lets long words wrap and can shrink', () => {
    expect(rules.length).toBeGreaterThan(10);
    const box = rules.find((r) => r.selector === '.cw-hub .cw-pv-notice');
    expect(box?.body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(box?.body).toMatch(/min-width:\s*0/);
    expect(rules.find((r) => r.selector === '.cw-hub .cw-pv')?.body).toMatch(/min-width:\s*0/);
  });

  it('no rule fixes a width wider than a phone (over 22rem), and the facts wrap', () => {
    for (const r of rules) {
      for (const m of r.body.matchAll(/(?:^|[;\s])(?:min-)?width:\s*([\d.]+)rem/g)) expect(Number(m[1]), r.selector).toBeLessThanOrEqual(22);
    }
    expect(rules.find((r) => r.selector === '.cw-hub .cw-pv-fact')?.body).toMatch(/flex-wrap:\s*wrap/);
  });

  it('a drawn button is not a control: no pointer, no focus ring rule, and the colours are the hub tokens (no new colour)', () => {
    const button = rules.find((r) => r.selector === '.cw-hub .cw-pv-btn');
    expect(button?.body).not.toMatch(/cursor:\s*pointer/);
    for (const r of rules) expect(r.body, r.selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
  });
});
