import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// (One mode per file: a module that has loaded stays loaded, so the second test of a file would find the screen already in.)
// The hub on a lazy screen whose code is still on its way: the quiet skeleton shows in the place of the screen (the top bar, rail and
// queue are already there), then the screen. The Terms module is held back here until the test lets it go.

const gate = vi.hoisted(() => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { open, release };
});

vi.mock('../src/screens/Terms.js', async (importActual) => {
  await gate.open;
  return importActual<typeof import('../src/screens/Terms.js')>();
});

describe('a lazy screen that is still loading (simple)', () => {
  it('shows the skeleton in its place, with the shell around it, then the screen', async () => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { path: '/terms', mode: 'simple' });
    const main = await screen.findByRole('main');
    await waitFor(() => expect(within(main).getByRole('status')).toHaveTextContent(/^Loading$/));
    expect(main.querySelector('.cw-skel')).not.toBeNull();
    expect(screen.queryByRole('heading', { level: 2, name: 'Terms' })).toBeNull();
    gate.release();
    expect(await screen.findByRole('heading', { level: 2, name: 'Terms' })).toBeTruthy();
    expect(main.querySelector('.cw-skel')).toBeNull();
  });
});
