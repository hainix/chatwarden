import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// (One mode per file: once the module has loaded it stays loaded.)
// A screen whose code cannot be fetched (a dropped connection, a deploy that moved the file): the hub's own error block in the
// screen's place, with Try again, and the rest of the hub (top bar, rail, queue) still works. Try again fetches it again.

const attempts = vi.hoisted(() => ({ n: 0 }));

vi.mock('../src/screens/Guide.js', async (importActual) => {
  attempts.n += 1;
  if (attempts.n === 1) throw new Error('Failed to fetch dynamically imported module');
  return importActual<typeof import('../src/screens/Guide.js')>();
});

describe('a lazy screen that fails to load', () => {
  it('shows the error block with Try again, and a retry brings the screen in (detailed)', async () => {
    attempts.n = 0;
    const w = await hubWorld({ role: 'owner' });
    const { user, router, container } = renderHub(w, { path: '/', mode: 'detailed' });
    await screen.findByRole('heading', { level: 2, name: /Overview|Cases/ });
    router.navigate('/guide');
    const alert = await screen.findByRole('alert');
    const main = screen.getByRole('main');
    expect(alert).toHaveTextContent('Could not load the guide.');
    // The moderator moved here: the error takes the focus (the heading it replaces would have) and is announced.
    await waitFor(() => expect(document.activeElement).toContainElement(alert));
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('Could not load the guide.');
    expect(alert).not.toHaveTextContent('Failed to fetch');
    // The shell around it is alive: the way to another screen is still there.
    expect(screen.getByRole('banner')).toBeTruthy();
    await user.click(within(main).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Guide' })).toBeTruthy();
    expect(within(main).queryByRole('alert')).toBeNull();
    expect(router.path).toBe('/guide');
  });
});
