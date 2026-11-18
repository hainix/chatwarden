import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { rulesCss } from './css.js';
import { renderHub } from './render.js';
import { HOUR, MINUTE, hubWorld } from './world.js';

// The thread, the ask form, Insights and the Desk panel under axe, in both themes; the 360 px checks read the stylesheet (jsdom has no
// layout). The parts add no colour: words say who asked and what was decided.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}
const ON = { overrides: { desk: { workflow: true, insights: true } } } as const;

describe.each(['light', 'dark'] as const)('axe on the desk, %s theme', (theme) => {
  it('the thread with entries, the add form and an over-long comment have none', async () => {
    const w = await hubWorld({ ...ON, actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    await w.direct.addComment(f.id, 'First note');
    await w.direct.escalate(f.id, { to: 'senior', note: 'Please look' });
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await user.click(await screen.findByRole('tab', { name: /^Staff comments/ }));
    await screen.findByRole('region', { name: 'Staff comments' });
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('textbox', { name: 'Add a comment' }));
    await user.paste('x'.repeat(501));
    expect(screen.getByText('Keep a comment to 500 characters or fewer.')).toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it('the case with the ask line, the open menu and the ask form have none', async () => {
    const w = await hubWorld({ ...ON, actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    const { container, user } = renderHub(w, { theme, path: `/reports/${f.id}` });
    await user.click(await screen.findByRole('button', { name: 'More actions on this case' }));
    await user.click(screen.getByRole('button', { name: 'Ask a senior to look' }));
    expect(await violations(container)).toEqual([]);
    await user.click(within(screen.getByRole('group', { name: 'Ask a senior to look' })).getByRole('button', { name: 'Send' }));
    await screen.findByText(/Asked for a look by ann/);
    expect(await violations(container)).toEqual([]);
  });

  it('the queue row word, the filter option and the Overview line have none', async () => {
    const w = await hubWorld({ ...ON, role: 'senior', actor: 'sam@example.test' });
    const f = await w.file({ target: 'Mallory', reason: 'spam' });
    await w.clientFor('ann@example.test').escalate(f.id, { to: 'senior' });
    const { container } = renderHub(w, { theme });
    await screen.findByText('1 case is waiting for a senior look');
    await screen.findByRole('checkbox', { name: 'Asked for a look' });
    expect(await violations(container)).toEqual([]);
  });

  it('Insights (full, empty, partial) has none', async () => {
    const w = await hubWorld({ ...ON });
    const a = await w.file({ target: 'A', reason: 'spam' });
    w.clock.t += 5 * MINUTE;
    await w.direct.decide(a.id, { verdict: 'no_action', actions: [] }).catch(() => undefined);
    const { container } = renderHub(w, { theme, path: '/insights' });
    await screen.findByRole('table', { name: 'Reports' });
    expect(await violations(container)).toEqual([]);
    w.intercept.fn = (req) =>
      req.path === '/insights'
        ? { status: 200, body: { days: 7, from: 0, to: HOUR, reports: { filed: 0, decided: 0, open: 0 }, decision: { decided: 0, medianMs: null, p90Ms: null }, urgent: { filed: 0, decided: 0, medianMs: null }, wait: { longestOpenMs: 0, backlog: { under1h: 0, under4h: 0, under1d: 0, under3d: 0, over3d: 0 } }, byReason: [], byOutcome: { actioned: 0, dismissed: 0, badFaith: 0 }, byRule: [], chat: null, partial: true } }
        : undefined;
    const select = screen.getByRole('combobox', { name: 'Window' });
    const user = (await import('@testing-library/user-event')).userEvent.setup();
    await user.selectOptions(select, 'Last 7 days');
    await waitFor(() => expect(screen.getByText('No reports in this window.')).toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
  });

  it('the Desk panel (editable, with a refused number, and read-only) has none', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container, user } = renderHub(w, { theme, path: '/settings/advanced' });
    await screen.findByRole('region', { name: 'The desk' });
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: 'Name a report surge on a case' }));
    await user.clear(screen.getByLabelText('Reports that make a surge'));
    await user.type(screen.getByLabelText('Reports that make a surge'), '1');
    expect(await screen.findByText('Reports must be a whole number from 3 to 100.')).toBeInTheDocument();
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

  it('the thread wraps long words and keeps comment line breaks', () => {
    expect(rule('.cw-hub .cw-thread-text')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.cw-hub .cw-thread-text')).toMatch(/white-space:\s*pre-wrap/);
    expect(rule('.cw-hub .cw-thread')).toMatch(/min-width:\s*0/);
  });

  it('the insights tables sit in a scroll box of their own and nothing is a fixed width', () => {
    expect(rule('.cw-hub .cw-insights-tables')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-insights-table')).toMatch(/max-width:\s*100%/);
  });

  it('the asked line and the ask form can shrink and wrap', () => {
    expect(rule('.cw-hub .cw-asked')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-asked')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.cw-hub .cw-case-menu-form')).toMatch(/min-width:\s*0/);
  });

  it('use no colour of their own', () => {
    for (const s of ['.cw-hub .cw-thread', '.cw-hub .cw-asked', '.cw-hub .cw-insights-table', '.cw-hub .cw-case-menu-form']) {
      expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
    }
  });
});
