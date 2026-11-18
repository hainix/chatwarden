import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { WorldOptions } from './world.js';

// M3: Settings > Advanced > "Room contexts": a read-only list (name, label, which sections each overrides), loaded when Advanced is opened. Contexts are set in code: the empty state says where, and
// there is nothing to edit. A caller without `policy.read`, and a scoped one, are not offered it. Real routes, real kit.

afterEach(() => cleanup());

const CONTEXTS: NonNullable<NonNullable<WorldOptions['overrides']>['contexts']> = {
  kids: { label: 'Kids rooms', profanity: { mode: 'refuse', add: ['snerp'] }, pace: { slowModeMs: 3000 }, chat: { minAccountAgeDays: 7 } },
  ranked: { profanity: { mode: 'allow' } },
  plain: { label: 'Plain' },
};

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Room contexts' });

describe('the list', () => {
  it('renders the name, the label and the sections each context overrides, in declaration order, and no value', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('heading', { level: 2, name: 'Advanced' });
    const list = await within(await screen.findByRole('region', { name: 'Room contexts' })).findByRole('list', { name: 'Declared contexts' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Kids rooms');
    expect(rows[0]).toHaveTextContent('kids');
    expect(rows[0]).toHaveTextContent(/Sets:\s*profanity, pace, chat/);
    expect(rows[1]).toHaveTextContent('ranked');
    expect(rows[1]).toHaveTextContent(/Sets:\s*profanity/);
    expect(rows[2]).toHaveTextContent('Plain');
    expect(rows[2]).toHaveTextContent('Only the label');
    const text = panel().textContent ?? '';
    for (const value of ['snerp', '3000', 'refuse', '7 days']) expect(text, value).not.toContain(value);
  });

  it('says that contexts are set in code, and names where to declare them when there are none', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/settings/advanced' });
    const region = await screen.findByRole('region', { name: 'Room contexts' });
    expect(await within(region).findByText(/No room contexts are declared/)).toBeInTheDocument();
    expect(within(region).getByText(/Declare one under contexts in the moderation profile in your server code/)).toBeInTheDocument();
    expect(within(region).getByText(/set in the code of your game server/)).toBeInTheDocument();
    expect(within(region).queryByRole('list', { name: 'Declared contexts' })).toBeNull();
  });

  it('has no edit control: no button, field, switch or link inside the panel', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS }, role: 'owner' });
    renderHub(w, { path: '/settings/advanced' });
    const region = await screen.findByRole('region', { name: 'Room contexts' });
    await within(region).findByRole('list', { name: 'Declared contexts' });
    expect(within(region).queryAllByRole('button')).toEqual([]);
    expect(within(region).queryAllByRole('textbox')).toEqual([]);
    expect(within(region).queryAllByRole('checkbox')).toEqual([]);
    expect(within(region).queryAllByRole('combobox')).toEqual([]);
    expect(within(region).queryAllByRole('link')).toEqual([]);
  });

  it('a name or label is text: markup in it is never made into markup', async () => {
    const w = await hubWorld({ overrides: { contexts: { kids: { label: '<b>Kids</b><img src=x onerror=alert(1)>' } } } });
    renderHub(w, { path: '/settings/advanced' });
    const region = await screen.findByRole('region', { name: 'Room contexts' });
    await within(region).findByRole('list', { name: 'Declared contexts' });
    expect(region.querySelector('b, img')).toBeNull();
    expect(region).toHaveTextContent('<b>Kids</b><img src=x onerror=alert(1)>');
  });

  it('asks the server once for the list, and a failed read is the hub\'s own error block with Try again, not a blank panel', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    w.intercept.fn = (req) => (req.path === '/policy/contexts' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/settings/advanced' });
    const region = await screen.findByRole('region', { name: 'Room contexts' });
    await within(region).findByRole('alert');
    w.intercept.fn = null;
    await user.click(within(region).getByRole('button', { name: 'Try again' }));
    await within(region).findByRole('list', { name: 'Declared contexts' });
    expect(w.sent.filter((r) => r.path === '/policy/contexts')).toHaveLength(2);
  });
});

describe('who is offered it', () => {
  it('a role below a raised policy.read is not offered it, and nothing is asked', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS }, permissions: { 'policy.read': 'owner' } });
    renderHub(w, { path: '/settings/advanced' });
    // Whatever the hub shows this role instead of the page, it settles on a screen title before the absence is checked.
    await screen.findAllByRole('heading', { level: 2 });
    expect(screen.queryByRole('region', { name: 'Room contexts' })).toBeNull();
    expect(w.sent.filter((r) => r.path === '/policy/contexts')).toEqual([]);
  });

  it('a scoped moderator has no Settings entry for it (403 by the server, hidden by can[])', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS }, role: 'senior', scope: ['creator:alice'] });
    renderHub(w, { path: '/settings/advanced' });
    await screen.findAllByRole('heading', { level: 2 });
    expect(screen.queryByRole('region', { name: 'Room contexts' })).toBeNull();
    expect(w.sent.filter((r) => r.path === '/policy/contexts')).toEqual([]);
    expect((await w.direct.me()).can['policy.read']).toBe(false);
  });
});

describe('the client', () => {
  it('HubClient.contexts() reads GET /policy/contexts', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const res = await w.direct.contexts();
    expect(res.contexts.map((c) => c.name)).toEqual(['kids', 'ranked', 'plain']);
    expect(res.contexts[0]).toEqual({ name: 'kids', label: 'Kids rooms', overrides: ['profanity', 'pace', 'chat'] });
  });
});
