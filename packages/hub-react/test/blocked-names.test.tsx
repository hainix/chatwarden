import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { baseline, normalized } from './baseline.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// The Names choice of the Blocked screen (names, design 5.6): when `names.keepBlocked` is on, the filter row gains "Names" (GET /blocked?source=name), the
// blocked names kept as evidence, hidden until shown like a blocked line. No menu entry, nothing new in Simple. Without keepBlocked the screen's top is what
// 0.1.7 drew: byte for byte. Synthetic names only.

const keeping = (o: Record<string, unknown> = {}) => appealsHub({ names: { keepBlocked: true, ...o } });
const screenOf = (): Element => screen.getByRole('heading', { level: 2, name: 'Blocked' }).closest('.cw-screen') as Element;
const choice = (): HTMLElement => screen.getByRole('group', { name: 'Source' });
const isBlockedNames = (r: { method: string; path: string; query?: Record<string, unknown> }): boolean => r.method === 'GET' && r.path === '/blocked' && r.query?.source === 'name';

async function open(w: AppealsHub | Awaited<ReturnType<typeof hubWorld>>, mode: 'detailed' | 'simple' = 'detailed') {
  const r = renderHub(w, { path: '/blocked', mode });
  await screen.findByRole('heading', { level: 2, name: 'Blocked' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}
const keepName = (w: AppealsHub, name: string, key: string): void => {
  w.cw.names.check(name, { who: { clientKey: key } });
  w.clock.t += 1000;
};

describe('without keepBlocked the Blocked screen is what 0.1.7 drew', () => {
  it('the bar and the empty list', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/blocked' });
    await screen.findByText('Nothing was blocked in this time.');
    await expect(normalized(screenOf())).toMatchFileSnapshot(baseline('blocked-screen'));
  });

  it('with appeals on and names untouched: the same screen, and the server is never asked for names', async () => {
    const w = await appealsHub();
    renderHub(w, { path: '/blocked' });
    await screen.findByText('Nothing was blocked in this time.');
    await expect(normalized(screenOf())).toMatchFileSnapshot(baseline('blocked-screen'));
    expect(w.sent.filter(isBlockedNames)).toEqual([]);
  });

  it('a role that cannot read the settings is told by /me all the same: with keepBlocked off it shows no choice', async () => {
    const w = await appealsHub({ permissions: { 'policy.read': 'owner' } });
    await open(w);
    expect(screen.queryByRole('group', { name: 'Source' })).toBeNull();
  });

  it('opening reads no settings and writes no policy.view row, with keepBlocked off or on, with or without policy.read', async () => {
    for (const [names, permissions] of [
      [undefined, undefined],
      [{ keepBlocked: true }, undefined],
      [{ keepBlocked: true }, { 'policy.read': 'owner' }],
      [undefined, { 'policy.read': 'owner' }],
    ] as const) {
      const w = await appealsHub({ ...(names ? { names } : {}), ...(permissions ? { permissions } : {}) } as never);
      const { unmount } = await open(w);
      expect(w.sent.filter((r) => r.path.startsWith('/policy')), JSON.stringify([names, permissions])).toEqual([]);
      expect(w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === 'policy.view')).toHaveLength(0);
      unmount();
    }
  });
});

describe('with keepBlocked the filter row gains Names', () => {
  it('shows "Chat lines" (pressed) and "Names"; no menu entry is added', async () => {
    const w = await keeping();
    const { container } = await open(w);
    await waitFor(() => expect(within(choice()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Chat lines', 'Names']));
    expect(within(choice()).getByRole('button', { name: 'Chat lines' })).toHaveAttribute('aria-pressed', 'true');
    // The rail and the Simple menu name what they always did.
    const rail = within(container.querySelector('nav.cw-rail') as HTMLElement).getAllByRole('link').map((a) => a.textContent);
    expect(rail).toEqual(['Overview', 'Reports', 'Blocked', 'Terms', 'Rule gaps', 'Guide', 'Settings']);
  });

  it('Names lists the kept names, newest first, hidden until shown, with when, who and what it hit', async () => {
    const w = await keeping();
    keepName(w, 'zorbakKid', 'key-one');
    keepName(w, 'xx_zorbak_99', 'key-two');
    const { user } = await open(w);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Names' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Names' }));
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Names' })).toHaveAttribute('aria-pressed', 'true');
    expect(w.sent.filter(isBlockedNames).length).toBeGreaterThan(0);
    // Hidden: neither the name nor the word it hit is on the page.
    expect(/zorbak/i.test(table.innerHTML)).toBe(false);
    expect(within(rows[0] as HTMLElement)).toBeDefined();
    await user.click(within(rows[0] as HTMLElement).getByRole('button', { name: /^Show the blocked name/ }));
    expect(within(rows[0] as HTMLElement).getByText('xx_zorbak_99')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText('zorbakKid')).toBeNull();
    // "Show blocked words" shows them all.
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    expect(within(rows[1] as HTMLElement).getByText('zorbakKid')).toBeInTheDocument();
  });

  it('says why each was refused in words', async () => {
    const w = await keeping();
    keepName(w, 'zorbakKid', 'key-one');
    keepName(w, 'xx_zorbak_99', 'key-two');
    // The test world has no profanity filter to produce a swearing refusal: the second row is answered as one.
    w.intercept.fn = async (req) => {
      if (!isBlockedNames(req)) return undefined;
      const real = await w.direct.listBlockedNames({ days: 7 });
      return { status: 200, headers: {}, body: { items: real.items.map((i, n) => (n === 0 ? { ...i, reason: 'name_profane', termId: null, term: null, language: null } : i)) } };
    };
    const { user } = await open(w);
    await user.click(await screen.findByRole('button', { name: 'Names' }));
    await screen.findByRole('table');
    expect(screen.getAllByText('Not allowed')).toHaveLength(1);
    expect(screen.getAllByText('Swearing')).toHaveLength(1);
  });

  it('a person the kit held is a link to their page; a name checked for nobody says so', async () => {
    const w = await keeping();
    const f = await w.file({ target: 'Mallory' });
    w.cw.names.check('zorbakFan', { who: { clientKey: 'key-target-Mallory' } });
    w.cw.names.check('zorbakAnon');
    const { user } = await open(w);
    await user.click(await screen.findByRole('button', { name: 'Names' }));
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBe(3));
    expect(within(table).getByRole('link')).toHaveAttribute('href', `#/people/${f.person}`);
    expect(within(table).getByText('Not known')).toBeInTheDocument();
  });

  it('empty says so, and the time window applies to names too', async () => {
    const w = await keeping();
    const { user } = await open(w);
    await user.click(await screen.findByRole('button', { name: 'Names' }));
    expect(await screen.findByText('No blocked names were kept in this time.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await waitFor(() => expect(w.sent.some((r) => isBlockedNames(r) && r.query?.days === 30)).toBe(true));
    expect(screen.getByRole('button', { name: 'Names' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Chat lines goes back to the chat list', async () => {
    const w = await keeping();
    const { user } = await open(w);
    await user.click(await screen.findByRole('button', { name: 'Names' }));
    await user.click(screen.getByRole('button', { name: 'Chat lines' }));
    expect(await screen.findByText('Nothing was blocked in this time.')).toBeInTheDocument();
  });

  it('a failed read says so and offers to try again', async () => {
    const w = await keeping();
    keepName(w, 'zorbakKid', 'key-one');
    const { user } = await open(w);
    const names = await screen.findByRole('button', { name: 'Names' });
    w.intercept.fn = (req) => (isBlockedNames(req) ? { status: 500, headers: {}, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(names);
    const alert = await screen.findByRole('alert');
    w.intercept.fn = null;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('a flagged handle on a kept name is hidden too', async () => {
    const w = await keeping();
    await w.file({ target: 'zorbakKid' });
    w.cw.names.check('zorbakOther', { who: { clientKey: 'key-target-zorbakKid' } });
    const { user } = await open(w);
    await user.click(await screen.findByRole('button', { name: 'Names' }));
    const table = await screen.findByRole('table');
    expect(/zorbak/i.test(table.innerHTML)).toBe(false);
    expect(within(table).getAllByText('Blocked words, hidden').length).toBeGreaterThan(1);
  });
});

describe('Simple mode gets nothing new from names', () => {
  it("Simple's menu and list are unchanged with names on", async () => {
    const w = await keeping({ renames: true });
    await w.file({ target: 'Alpha' });
    const { container } = renderHub(w, { path: '/', mode: 'simple' });
    await screen.findByRole('heading', { level: 2, name: 'Cases' });
    expect(within(container.querySelector('nav.cw-snav') as HTMLElement).getAllByRole('link').map((a) => a.textContent)).toEqual(['Cases', 'Words', 'Blocked']);
    expect(container.textContent).not.toMatch(/new name|Names/);
  });
});

describe('the choice comes from /me, not from the settings', () => {
  it('a role with blocked.read but no policy.read still gets Names when keepBlocked is on', async () => {
    const w = await appealsHub({ names: { keepBlocked: true }, permissions: { 'policy.read': 'owner' } });
    await open(w);
    expect(within(choice()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Chat lines', 'Names']);
    expect(w.sent.filter((r) => r.path.startsWith('/policy'))).toEqual([]);
  });

  it('the choice is there on the first paint (no flash in after a second read)', async () => {
    const w = await keeping();
    renderHub(w, { path: '/blocked' });
    await screen.findByRole('heading', { level: 2, name: 'Blocked' });
    expect(screen.getByRole('group', { name: 'Source' })).toBeInTheDocument();
  });

  it('keepBlocked off after the page loaded is picked up from /me (the next load), never from the policy', async () => {
    const w = await appealsHub({ names: { keepBlocked: false } });
    await open(w);
    expect(screen.queryByRole('group', { name: 'Source' })).toBeNull();
    expect(w.sent.some((r) => r.method === 'GET' && r.path === '/me')).toBe(true);
  });
});
