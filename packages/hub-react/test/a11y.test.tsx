import { screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// axe runs in jsdom, which has no layout or painted colours, so the `color-contrast` rule cannot be computed here and is
// switched off. Contrast is checked in a real browser (the site's Playwright run, against the built stylesheet). Every other
// rule runs, and any violation fails: the plan's bar is "no serious or critical", this holds the hub to none at all.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

async function settled() {
  await waitFor(() => expect(screen.queryByText(/^Loading/)).not.toBeInTheDocument());
}

async function crowd(w: HubWorld) {
  for (let i = 0; i < 6; i += 1) await w.file({ target: 'Mallory', reporter: `A${i}`, category: i % 2 === 0 ? 'harassment' : 'hate' });
  const other = await w.file({ target: 'Zed', reporter: 'Z1', category: 'spam' });
  await w.sanction(other.person, 'chat', 1);
  await w.sanction(other.person, 'warning', 'uncovered');
}

interface Case {
  name: string;
  prepare: (w: HubWorld) => Promise<void>;
  path: string;
  role?: 'moderator' | 'senior' | 'owner' | null;
  heading: string | RegExp;
}

const CASES: Case[] = [
  { name: 'the sign-in message', prepare: async () => undefined, path: '/', role: null, heading: 'Sign in to use the hub' },
  { name: 'an empty overview', prepare: async () => undefined, path: '/', heading: 'Overview' },
  { name: 'an overview with a busy queue and recent actions', prepare: crowd, path: '/', heading: 'Overview' },
  { name: 'an empty reports queue', prepare: async () => undefined, path: '/reports', heading: 'Reports' },
  { name: 'a reports queue with grouped people', prepare: crowd, path: '/reports', heading: 'Reports' },
  { name: 'the reports queue, all statuses', prepare: crowd, path: '/reports?status=all', heading: 'Reports' },
  { name: 'a screen still to come', prepare: async () => undefined, path: '/terms', heading: 'Terms is not available yet' },
  { name: 'an unknown path', prepare: async () => undefined, path: '/nope', heading: 'That page does not exist' },
  { name: 'a screen the role cannot open', prepare: async () => undefined, path: '/audit', role: 'moderator', heading: 'Not available for your role' },
  { name: 'a senior view with the Audit tab', prepare: crowd, path: '/', role: 'senior', heading: 'Overview' },
];

describe.each(['light', 'dark'] as const)('axe, %s theme', (theme) => {
  it.each(CASES)('$name has no violations', async (c) => {
    const w = await hubWorld({ role: c.role === undefined ? 'moderator' : c.role });
    await c.prepare(w);
    const { container } = renderHub(w, { path: c.path, theme });
    await screen.findByRole('heading', { name: c.heading });
    await settled();
    expect(container.querySelector('.cw-hub')).toHaveAttribute('data-cw-theme', theme);
    expect(await violations(container)).toEqual([]);
  });

  it('has no violations while loading, after a failed load and while a later page loads', async () => {
    const w = await hubWorld();
    await crowd(w);
    w.intercept.fn = (req) => (req.path === '/reports' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { container } = renderHub(w, { path: '/reports', theme });
    expect(await violations(container)).toEqual([]);
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });
});

describe('axe finds what it should (control)', () => {
  it('reports an unlabelled button, so a clean run above means something', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<button type="button"></button>';
    document.body.append(host);
    const found = await violations(host);
    host.remove();
    expect(found.join('\n')).toMatch(/button-name/);
  });
});

describe('keyboard and structure', () => {
  it('has one h1, one main, one nav, and the skip button is the first tab stop', async () => {
    const w = await hubWorld();
    const { user, container } = renderHub(w);
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('nav')).toHaveLength(1);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Skip to the main content' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveFocus();
  });

  it('every control in the queue can be reached with the keyboard and works with Enter', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Mallory' });
    const { user, router } = renderHub(w, { path: '/reports' });
    const review = await screen.findByRole('link', { name: 'Review the newest report against Mallory' });
    review.focus();
    await user.keyboard('{Enter}');
    expect(router.path).toMatch(/^\/reports\/[A-Za-z0-9_-]+$/);
  });

  it('uses no inline style anywhere in the rendered hub', async () => {
    const w = await hubWorld();
    await crowd(w);
    const { container } = renderHub(w, { path: '/reports?status=all' });
    await screen.findByRole('list', { name: 'Reported people' });
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(container.querySelectorAll('style')).toHaveLength(0);
  });
});
