import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecentActions } from '../src/pieces/RecentActions.js';
import { TermsManager } from '../src/pieces/TermsManager.js';
import { HubProvider } from '../src/provider.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The settings and admin screens load when first opened (React.lazy), not with the hub. Each still shows after navigation, in Simple
// and in Detailed, and a screen that came in by navigation takes the focus a screen always took.

const SCREENS = [
  { path: '/terms', title: 'Terms' },
  { path: '/blocked', title: 'Blocked' },
  { path: '/gaps', title: 'Rule gaps' },
  { path: '/audit', title: 'Audit' },
  { path: '/guide', title: 'Guide' },
  { path: '/actions', title: 'All actions' },
  { path: '/settings/ladder', title: 'Steps and ladder' },
  { path: '/settings/reporting', title: 'Reporting' },
] as const;

describe.each(['simple', 'detailed'] as const)('lazy screens in %s mode', (mode) => {
  it.each(SCREENS)('$path opens and shows its screen', async ({ path, title }) => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { path, mode });
    expect(await screen.findByRole('heading', { level: 2, name: title })).toBeTruthy();
  });

  it('moves between lazy screens, and back to a loaded one at once', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { router } = renderHub(w, { path: '/terms', mode });
    await screen.findByRole('heading', { level: 2, name: 'Terms' });
    router.navigate('/guide');
    await screen.findByRole('heading', { level: 2, name: 'Guide' });
    router.navigate('/terms');
    expect(await screen.findByRole('heading', { level: 2, name: 'Terms' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: 'Guide' })).toBeNull();
  });
});

describe('a lazy screen and the screen focus', () => {
  it('takes focus, and is announced, when it comes in by navigation (not only once it has loaded)', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { router, container } = renderHub(w, { path: '/', mode: 'detailed' });
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    router.navigate('/audit');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Audit' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('Audit');
  });

  it('does not take focus when the hub first opens on a lazy screen', async () => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { path: '/guide', mode: 'detailed' });
    const heading = await screen.findByRole('heading', { level: 2, name: 'Guide' });
    expect(heading).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it('a screen left before it loaded does not steal focus from the one the moderator moved to', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { router } = renderHub(w, { path: '/', mode: 'detailed' });
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    router.navigate('/gaps');
    router.navigate('/reports');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Reports' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByRole('heading', { level: 2, name: 'Rule gaps' })).toBeNull();
  });
});

describe('the pieces of the same names', () => {
  it('render their screen too, inside the piece box', async () => {
    const w = await hubWorld({ role: 'owner' });
    const { container } = render(
      <HubProvider client={w.client} mode="detailed">
        <TermsManager />
        <RecentActions />
      </HubProvider>,
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Terms' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: 'All actions' })).toBeTruthy();
    expect(container.querySelector('[data-cw-piece="TermsManager"] .cw-screen-title')).not.toBeNull();
    expect(container.querySelector('[data-cw-piece="RecentActions"] .cw-screen-title')).not.toBeNull();
  });
});
