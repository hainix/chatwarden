import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// `CaseMenu`: the case's one `...` door. It renders nothing when it has no item for the caller; it is a disclosure; Escape closes it,
// returns focus to its button and does not also leave the case. This task adds "Mark as urgent" and "Not urgent".

const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'More actions on this case' });

async function openCase(w: Awaited<ReturnType<typeof hubWorld>>, id: string, extra: Parameters<typeof renderHub>[1] = {}) {
  const view = renderHub(w, { path: `/reports/${id}`, ...extra });
  await screen.findByRole('tablist');
  return view;
}

describe('CaseMenu', () => {
  it('renders nothing when the caller has no item: no button, no wrapper', async () => {
    const w = await hubWorld({ permissions: { 'reports.urgent': 'owner' } });
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { container } = await openCase(w, f.id);
    expect(screen.queryByRole('button', { name: 'More actions on this case' })).toBeNull();
    expect(container.querySelector('.cw-case-menu')).toBeNull();
  });

  it('renders nothing on a decided case (nothing can be marked)', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    await w.direct.decide(f.id, { verdict: 'no_action', actions: [] });
    const { container } = await openCase(w, f.id);
    expect(container.querySelector('.cw-case-menu')).toBeNull();
  });

  it('is a disclosure: collapsed by default, aria-expanded toggles, the items are in a labelled group', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    const button = menuButton();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'More actions on this case' })).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'More actions on this case' });
    expect(button).toHaveAttribute('aria-controls', group.id);
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark as urgent']);
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers "Mark as urgent" on an ordinary case and "Not urgent" on an urgent one, never both', async () => {
    const w = await hubWorld();
    const calm = await w.file({ target: 'Calm', reason: 'spam' });
    const hot = await w.file({ target: 'Hot', reason: 'threat' });
    const first = await openCase(w, calm.id);
    await first.user.click(menuButton());
    expect(screen.getByRole('button', { name: 'Mark as urgent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not urgent' })).toBeNull();
    first.unmount();
    const second = await openCase(w, hot.id);
    await second.user.click(menuButton());
    expect(screen.getByRole('button', { name: 'Not urgent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as urgent' })).toBeNull();
  });

  it('Mark as urgent works for a moderator and shows in the queue at once: the row word, the chip, the strip', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    expect(document.querySelector('.cw-urgent-chip')).toBeNull();
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Mark as urgent' }));
    await waitFor(() => expect(document.querySelector('.cw-urgent-chip')).not.toBeNull());
    const row = within(screen.getByRole('region', { name: 'Open cases' })).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(row).getByText('Urgent')).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Urgent case' });
    expect((await w.direct.getReport(f.id)).report.urgent).toBe(true);
    // The menu closed after the choice and its button has the focus back.
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('Not urgent clears it', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Hot', reason: 'threat' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Not urgent' }));
    await waitFor(() => expect(document.querySelector('.cw-urgent-chip')).toBeNull());
    expect((await w.direct.getReport(f.id)).report.urgent).toBe(false);
  });

  it('a refused mark says why in words and keeps the menu closed and the case open', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    w.intercept.fn = (req) => (req.path.endsWith('/urgent') ? { status: 409, body: { error: 'already_decided', message: 'x' } } : undefined);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Mark as urgent' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('Escape closes it and returns focus to its button, and does not also leave the case', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { user, router } = await openCase(w, f.id);
    await user.click(menuButton());
    const item = screen.getByRole('button', { name: 'Mark as urgent' });
    item.focus();
    await user.keyboard('{Escape}');
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton()).toHaveFocus();
    expect(router.path).toBe(`/reports/${f.id}`);
    // The Escape did not reach the hub's own (back to the queue): focus is not on a queue row.
    expect(document.activeElement?.closest('.cw-queue-list')).toBeNull();
  });

  it('Escape with the menu closed is left to the hub', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    menuButton().focus();
    await user.keyboard('{Escape}');
    expect(document.activeElement?.closest('.cw-queue-list')).not.toBeNull();
  });

  it('is in Simple mode too', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    expect(await screen.findByRole('button', { name: 'More actions on this case' })).toBeInTheDocument();
  });

  it('a press away from the menu closes it', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Calm', reason: 'spam' });
    const { user } = await openCase(w, f.id);
    await user.click(menuButton());
    await user.click(screen.getByRole('tablist'));
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
  });
});
