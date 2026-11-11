import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// A lazy screen that arrives late must not take the focus from where the moderator has put it meanwhile (the command bar, a filter,
// the queue, the page's own controls). It takes it only when focus is still nowhere (the page, or the main area).

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

describe('a lazy screen that arrives after the moderator moved focus elsewhere', () => {
  it('leaves focus where it is, and does not announce itself', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { router, container } = renderHub(w, { path: '/', mode: 'detailed' });
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    router.navigate('/terms');
    await screen.findByText(/^Loading$/);
    // The moderator reaches for something else while the code is on its way.
    const other = container.querySelector<HTMLElement>('.cw-skip');
    expect(other).not.toBeNull();
    act(() => other?.focus());
    expect(other).toHaveFocus();
    gate.release();
    const heading = await screen.findByRole('heading', { level: 2, name: 'Terms' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(heading).not.toHaveFocus();
    expect(other).toHaveFocus();
    expect(container.querySelector('[aria-live="polite"]')).not.toHaveTextContent('Terms');
  });

  it('and a screen reached after it (loaded now) still takes focus as always: the skipped one did not leave the flag armed', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { router } = renderHub(w, { path: '/terms', mode: 'detailed' });
    await screen.findByRole('heading', { level: 2, name: 'Terms' });
    router.navigate('/reports');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Reports' });
    await waitFor(() => expect(heading).toHaveFocus());
  });
});
