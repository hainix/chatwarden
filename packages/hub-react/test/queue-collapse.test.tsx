import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// At phone width the queue would sit above an open case or person, so the open pane is a scroll away. While a case or a person is
// open the queue is one disclosure row, "Open cases (N)", collapsed. The collapse is the stylesheet's (phone width only, so the
// desktop is unchanged); jsdom has no media queries, so these check the structure, the keys, and the rules written in the sheet.

const toggle = (): HTMLElement => screen.getByRole('button', { name: /^Open cases/ });
const queue = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });

async function ready() {
  await waitFor(() => expect(screen.queryByText('Loading the queue')).not.toBeInTheDocument());
}

describe('the queue as a disclosure while a case or a person is open', () => {
  it('a case: "Open cases (N)" is a collapsed disclosure and the queue is marked collapsed', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    await w.file({ target: 'Beta' });
    renderHub(w, { path: `/reports/${a.id}` });
    await ready();
    await waitFor(() => expect(toggle()).toHaveAccessibleName('Open cases (2)'));
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(queue()).toHaveAttribute('data-collapsed', 'true');
  });

  it('a person page is the same', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    renderHub(w, { path: `/people/${a.person}` });
    await ready();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(queue()).toHaveAttribute('data-collapsed', 'true');
  });

  it.each(['/', '/reports', '/actions'])('%s has no disclosure: the queue is just the queue', async (path) => {
    const w = await hubWorld();
    await w.file({ target: 'Alpha' });
    renderHub(w, { path });
    await ready();
    expect(screen.queryByRole('button', { name: /^Open cases/ })).toBeNull();
    expect(queue()).not.toHaveAttribute('data-collapsed');
  });

  it('opens and closes from the keyboard (Enter and Space)', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const { user } = renderHub(w, { path: `/reports/${a.id}` });
    await ready();
    act(() => toggle().focus());
    await user.keyboard('{Enter}');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(queue()).toHaveAttribute('data-collapsed', 'false');
    expect(toggle()).toHaveFocus();
    await user.keyboard(' ');
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(queue()).toHaveAttribute('data-collapsed', 'true');
  });

  it('Take next case still works from inside the opened queue, and the next case opens collapsed again', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    w.clock.t += 1000;
    await w.file({ target: 'Beta' });
    const { user, router } = renderHub(w, { path: `/people/${a.person}` });
    await ready();
    await user.click(toggle());
    await user.click(within(queue()).getByRole('button', { name: /^Take next case/ }));
    await waitFor(() => expect(router.path).toMatch(/^\/reports\//));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'false'));
    expect(queue()).toHaveAttribute('data-collapsed', 'true');
  });

  it('opening another case from the list collapses it again', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    await w.file({ target: 'Beta' });
    const { user, router } = renderHub(w, { path: `/reports/${a.id}` });
    await ready();
    await user.click(toggle());
    const links = within(queue()).getAllByRole('link');
    const other = links.find((l) => l.getAttribute('aria-current') !== 'true')!;
    await user.click(other);
    await waitFor(() => expect(router.path).not.toBe(`/reports/${a.id}`));
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-expanded', 'false'));
  });

  it('the open pane is not the queue: the title of the open screen takes focus on the move, as before', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const { router } = renderHub(w, { path: '/' });
    await ready();
    act(() => router.navigate(`/people/${a.person}`));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Alpha' })).toHaveFocus());
  });
});

describe('the stylesheet', () => {
  const css = readFileSync(join(process.cwd(), 'packages', 'hub-react', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const phoneAt = css.indexOf('@media (max-width: 51.1875rem)');

  it('hides the disclosure everywhere except a phone, and the collapsed queue only on a phone', () => {
    const base = css.slice(0, phoneAt);
    expect(base).toMatch(/\.cw-hub \.cw-queue-toggle\s*\{[^}]*display:\s*none/);
    expect(base).not.toMatch(/data-collapsed/);
    const phone = css.slice(phoneAt);
    expect(phone).toMatch(/\.cw-hub \.cw-queue-toggle\s*\{[^}]*display:\s*flex/);
    expect(phone).toMatch(/\.cw-queue\[data-collapsed='true'\] > :not\(\.cw-queue-toggle\)\s*\{[^}]*display:\s*none/);
  });

  it('the base rule comes before the phone override (the cascade)', () => {
    const baseRule = css.indexOf('.cw-hub .cw-queue-toggle {');
    expect(baseRule).toBeGreaterThan(-1);
    expect(baseRule).toBeLessThan(phoneAt);
  });
});
