import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { appealsHub, HOUR } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { rulesCss } from './css.js';
import { renderHub } from './render.js';
import type { WorldOptions } from './world.js';

// The appeals pages under axe, in both themes, in each state a moderator meets, and a phone width (the stylesheet's rules: jsdom paints and measures nothing,
// so `color-contrast` is off here and the 360 px checks read the CSS, as the other layout tests do).
const RULES = { 'color-contrast': { enabled: false } } as const;
const SENIOR: WorldOptions = { role: 'senior', actor: 'bea@example.test' };

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

async function world(): Promise<AppealsHub> {
  const w = await appealsHub(SENIOR);
  await w.file({ target: 'Alpha' });
  return w;
}

describe.each(['light', 'dark'] as const)('axe on the appeals pages, %s theme', (theme) => {
  it('the list in the pane, and the screen beside it, have no violations', async () => {
    const w = await world();
    await w.appeal({ target: 'Mallory' });
    await w.appeal({ target: 'zorbakKid', kind: 'ban', durationMs: null });
    const { container } = renderHub(w, { theme, path: '/appeals' });
    await screen.findByRole('list', { name: 'Appeals' });
    expect(await violations(container)).toEqual([]);
  });

  it('the empty list has no violations', async () => {
    const w = await world();
    const { container } = renderHub(w, { theme, path: '/appeals' });
    await screen.findByText('No appeals are waiting.');
    expect(await violations(container)).toEqual([]);
  });

  it('the card, with a statement, what they were shown, the reason box and the three buttons', async () => {
    const w = await world();
    await w.client.addReason({ label: 'Clear joke', text: 'It was banter.' });
    const a = await w.appeal({ target: 'Mallory', statement: 'It was a joke between friends.\nWe play every day.' });
    const { container } = renderHub(w, { theme, path: `/appeals/${a.appealId}` });
    await screen.findByRole('region', { name: 'What the player said' });
    await screen.findByRole('button', { name: 'Clear joke' });
    expect(await violations(container)).toEqual([]);
  });

  it('the card with a flagged statement and name hidden, then shown', async () => {
    const w = await world();
    const a = await w.appeal({ target: 'zorbakKid', statement: 'you zorbak, a joke' });
    const { container, user } = renderHub(w, { theme, path: `/appeals/${a.appealId}` });
    await screen.findByRole('region', { name: 'What the player said' });
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    expect(await violations(container)).toEqual([]);
  });

  it('the picker, the reason message and a refusal in words', async () => {
    const w = await world();
    const a = await w.appeal({ actor: 'bea@example.test', kind: 'area', durationMs: 24 * HOUR });
    const { container, user } = renderHub(w, { theme, path: `/appeals/${a.appealId}` });
    await screen.findByRole('region', { name: 'What the player said' });
    await user.click(screen.getByRole('radio', { name: 'Make it lighter' }));
    await user.click(screen.getByRole('button', { name: 'Send decision' }));
    expect(await violations(container)).toEqual([]);
    await user.type(screen.getByLabelText('Why (private)'), 'my own decision');
    await user.click(screen.getByRole('radio', { name: 'Keep the decision' }));
    await user.click(screen.getByRole('button', { name: 'Send decision' }));
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });

  it('the decision bar with an outcome chosen: the fixed reasons group and the private reason', async () => {
    const w = await world();
    const a = await w.appeal({ target: 'Mallory', kind: 'chat', durationMs: 6 * HOUR });
    const { container, user } = renderHub(w, { theme, path: `/appeals/${a.appealId}` });
    await screen.findByRole('region', { name: 'What the player said' });
    for (const outcome of ['Keep the decision', 'Make it lighter', 'Remove it']) {
      await user.click(screen.getByRole('radio', { name: outcome }));
      await screen.findByRole('group', { name: 'What the person is shown as the reason' });
      expect(await violations(container)).toEqual([]);
    }
    await user.click(screen.getByRole('button', { name: 'Send decision' }));
    expect(await violations(container)).toEqual([]);
  });

  it('"What caused this", closed and open, for each kind of cause', async () => {
    for (const cause of [
      { source: 'term', termId: 'syn:zorbak', strikes: 3 },
      { source: 'filter', reportId: 'r1', filterKey: 'link.unlisted', decidedBy: 'human' },
      { source: 'report', reportId: 'r2', decidedBy: 'ai' },
      { source: 'other', via: 'coop' },
    ]) {
      const w = await world();
      const a = await w.appeal({ target: 'Mallory' });
      const real = await w.client.appeal(a.appealId);
      w.intercept.fn = (req) => (req.method === 'GET' && req.path === `/appeals/${a.appealId}` ? { status: 200, body: { appeal: { ...real.appeal, cause } } } : undefined);
      const { container, user, unmount } = renderHub(w, { theme, path: `/appeals/${a.appealId}` });
      await screen.findByRole('region', { name: 'What the player said' });
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByText('What caused this'));
      if (cause.source === 'term') await user.click(await screen.findByRole('button', { name: 'Show the word' }));
      expect(await violations(container), cause.source).toEqual([]);
      unmount();
    }
  });

  it('a decided appeal, read only, has no violations', async () => {
    const w = await world();
    const a = await w.appeal();
    await w.clientFor('cy@example.test', 'senior').decideAppeal(a.appealId, { outcome: 'uphold', reason: 'It stands.' });
    const { container } = renderHub(w, { theme, path: `/appeals/${a.appealId}` });
    await screen.findByText('Decided: the decision stands.');
    expect(await violations(container)).toEqual([]);
  });

  it('Simple: the quiet line and the card have no violations', async () => {
    const w = await world();
    const a = await w.appeal();
    const { container, router } = renderHub(w, { theme, path: '/', mode: 'simple' });
    await screen.findByRole('link', { name: /appeal waiting/ });
    expect(await violations(container)).toEqual([]);
    router.navigate(`/appeals/${a.appealId}`);
    await screen.findByRole('region', { name: 'What the player said' });
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Their record' })).queryByText('Loading', { exact: false })).toBeNull());
    expect(await violations(container)).toEqual([]);
  });

  it('the Person page with an appeal in its timeline has no violations', async () => {
    const w = await world();
    const a = await w.appeal({ target: 'Mallory' });
    const { container } = renderHub(w, { theme, path: `/people/${a.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await screen.findByText('Appeal: waiting for a decision');
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

  it('the statement wraps long words and keeps its line breaks', () => {
    expect(rule('.cw-hub .cw-appeal-statement')).toMatch(/white-space:\s*pre-wrap/);
    expect(rule('.cw-hub .cw-appeal-statement')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('the card and its parts can shrink, and the controls wrap', () => {
    expect(rule('.cw-hub .cw-appeal')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-appeal-pick')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-appeal-controls')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('the reasons group and "What caused this" can shrink and wrap, and use no colour of their own', () => {
    expect(rule('.cw-hub .cw-appeal-reasoncode')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-appeal-cause')).toMatch(/min-width:\s*0/);
    expect(rule('.cw-hub .cw-appeal-cause p')).toMatch(/overflow-wrap:\s*anywhere/);
    for (const s of ['.cw-hub .cw-appeal-reasoncode', '.cw-hub .cw-appeal-cause']) expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
  });

  it('uses no colour of its own: the referee card and plain tokens carry it', () => {
    for (const s of ['.cw-hub .cw-appeal', '.cw-hub .cw-appeal-statement', '.cw-hub .cw-appeal-shown', '.cw-hub .cw-appeal-controls']) {
      expect(rule(s), s).not.toMatch(/var\(--cw-(accent|bad|warn|good)/);
    }
  });
});
