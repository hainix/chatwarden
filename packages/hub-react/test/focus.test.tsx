import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

async function queue(w: HubWorld, people: number, each: number) {
  for (let p = 0; p < people; p += 1) {
    for (let r = 0; r < each; r += 1) await w.file({ target: `Target${p}`, reporter: `Rep${p}x${r}` });
  }
}

describe('focus and announcements when the screen changes', () => {
  it('does not take focus on the first load', async () => {
    const w = await hubWorld();
    renderHub(w);
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    expect(document.body).toHaveFocus();
  });

  it('moves focus to the new screen heading when a tab is used, and says which screen it is', async () => {
    const w = await hubWorld();
    const { user, container } = renderHub(w);
    await screen.findByRole('heading', { level: 2, name: 'Overview' });
    await user.click(screen.getByRole('link', { name: 'Reports' }));
    const heading = await screen.findByRole('heading', { level: 2, name: 'Reports' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('Reports');
    await user.click(screen.getByRole('link', { name: 'Overview' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Overview' })).toHaveFocus();
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('Overview');
  });

  it('moves focus after Review opens a report page', async () => {
    const w = await hubWorld();
    await w.file({ target: 'Mallory' });
    const { user } = renderHub(w, { path: '/reports' });
    await user.click(await screen.findByRole('link', { name: 'Review the newest report against Mallory' }));
    expect(await screen.findByRole('heading', { level: 2, name: /^(Report|Insults or harassment report against Mallory)$/ })).toHaveFocus();
  });

  it('keeps focus on the status button when only the query changes', async () => {
    const w = await hubWorld();
    const { user, router } = renderHub(w, { path: '/reports' });
    await screen.findByRole('heading', { level: 2, name: 'Reports' });
    const group = screen.getByRole('group', { name: 'Report status' });
    const all = within(group).getByRole('button', { name: 'All' });
    all.focus();
    await user.keyboard('{Enter}');
    expect(router.path).toBe('/reports?status=all');
    await waitFor(() => expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('group', { name: 'Report status' })).toBe(group);
    expect(within(group).getByRole('button', { name: 'All' })).toHaveFocus();
  });

  it('keeps the screen mounted across a query change, and moves focus for another report', async () => {
    const w = await hubWorld();
    const { router } = renderHub(w, { path: '/reports' });
    const heading = await screen.findByRole('heading', { level: 2, name: 'Reports' });
    act(() => router.navigate('/reports?status=dismissed'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismissed' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('heading', { level: 2, name: 'Reports' })).toBe(heading);
    expect(heading).not.toHaveFocus();
    act(() => router.navigate('/reports/abc'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Report' })).toHaveFocus();
    const first = screen.getByRole('heading', { level: 2, name: 'Report' });
    act(() => router.navigate('/reports/def'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Report' })).not.toBe(first));
    expect(screen.getByRole('heading', { level: 2, name: 'Report' })).toHaveFocus();
  });
});

describe('focus while paging the queue', () => {
  it('keeps focus on Load more while pages remain, and moves it to the count when the list ends', async () => {
    const w = await hubWorld();
    await queue(w, 6, 20); // 120 reports: pages of 50, 50, 20
    const { user } = renderHub(w, { path: '/reports' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument());
    const more = screen.getByRole('button', { name: 'Load more' });
    more.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('Showing 100 reports.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Load more' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('Showing 120 reports.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByText('Showing 120 reports.')).toHaveFocus();
  });

  it('does not lose focus while the next page loads, and ignores a click meanwhile', async () => {
    const w = await hubWorld();
    await queue(w, 3, 20);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { user } = renderHub(w, { path: '/reports' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument());
    w.intercept.fn = async (req) => {
      if (req.path === '/reports' && req.query?.cursor !== undefined) await gate;
      return undefined;
    };
    screen.getByRole('button', { name: 'Load more' }).focus();
    await user.keyboard('{Enter}');
    const busy = await screen.findByRole('button', { name: 'Loading more reports' });
    expect(busy).toHaveFocus();
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    await user.click(busy);
    await act(async () => release());
    await waitFor(() => expect(screen.getByText('Showing 60 reports.')).toBeInTheDocument());
    expect(w.sent.filter((r) => r.path === '/reports' && r.query?.cursor !== undefined)).toHaveLength(1);
  });
});
