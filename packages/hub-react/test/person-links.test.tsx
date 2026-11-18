import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The Person page's `...` menu gains "Linked accounts" (design 10): it loads the counts on demand and shows one line, with the shared-device hint. Counts only: never an id, a key or an
// address. Nothing about it is on the page until it is asked for.

const LINKS = { accounts: 3, devices: 2, merged: 1, inForceOnLinked: { ban: 1, area: 0, chat: 0 } };

async function person(links: unknown = LINKS) {
  const w = await hubWorld();
  const f = await w.file({ target: 'Mallory', reporter: 'Rhea' });
  const asked: string[] = [];
  w.intercept.fn = (req) => {
    if (req.method === 'GET' && /\/links$/.test(req.path)) {
      asked.push(req.path);
      return { status: 200, body: links };
    }
    return undefined;
  };
  return { w, f, asked };
}
async function open(w: HubWorld, ref: string) {
  const r = renderHub(w, { path: `/people/${ref}` });
  await screen.findByRole('heading', { level: 2, name: /Mallory/ });
  return r;
}
const menuButton = (): HTMLElement => screen.getByRole('button', { name: 'More about this person' });

describe('the Person menu', () => {
  it('has a ... button, and nothing about linked accounts on the page or in the network until it is asked for', async () => {
    const { w, f, asked } = await person();
    await open(w, f.person);
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/linked/i)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('offers Linked accounts, loads the counts when chosen and shows one line with the hint', async () => {
    const { w, f, asked } = await person();
    const { user } = await open(w, f.person);
    await user.click(menuButton());
    expect(asked).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Linked accounts' }));
    expect(await screen.findByText('3 accounts and 2 devices are linked to this person. 1 ban in force was placed on a linked account.')).toBeInTheDocument();
    expect(screen.getByText('A shared device can link two different people. This is a hint, not proof.')).toBeInTheDocument();
    expect(asked).toEqual([`/people/${f.person}/links`]);
  });

  it.each([
    [{ accounts: 1, devices: 1, merged: 0, inForceOnLinked: { ban: 0, area: 0, chat: 0 } }, '1 account and 1 device are linked to this person.'],
    [{ accounts: 2, devices: 0, merged: 1, inForceOnLinked: { ban: 0, area: 2, chat: 1 } }, '2 accounts are linked to this person. 2 area bans and 1 chat restriction in force were placed on a linked account.'],
    [{ accounts: 0, devices: 4, merged: 0, inForceOnLinked: { ban: 2, area: 0, chat: 0 } }, '4 devices are linked to this person. 2 bans in force were placed on a linked account.'],
  ])('says each count in its own words: %j', async (links, sentence) => {
    const { w, f } = await person(links);
    const { user } = await open(w, f.person);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Linked accounts' }));
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it('says "none linked" for zeros, and no hint about shared devices', async () => {
    const { w, f } = await person({ accounts: 0, devices: 0, merged: 0, inForceOnLinked: { ban: 0, area: 0, chat: 0 } });
    const { user } = await open(w, f.person);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Linked accounts' }));
    expect(await screen.findByText('No accounts or devices are linked to this person.')).toBeInTheDocument();
    expect(screen.queryByText(/shared device/)).toBeNull();
  });

  it('never renders an id: not the person\'s, not a key, nothing the answer might carry besides the counts', async () => {
    const { w, f } = await person({ ...LINKS, accountIds: ['acct_secret_1'], clientKeys: ['key_secret_1'], ip: '203.0.113.9', hash: 'deadbeef' });
    const { user } = await open(w, f.person);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Linked accounts' }));
    await screen.findByText(/3 accounts and 2 devices/);
    const text = document.body.textContent ?? '';
    for (const secret of ['acct_secret_1', 'key_secret_1', '203.0.113.9', 'deadbeef']) expect(text).not.toContain(secret);
    expect(text).not.toContain(f.person);
  });

  it('a failed read says so in words, and the menu offers it again', async () => {
    const { w, f } = await person();
    w.intercept.fn = (req) => (/\/links$/.test(req.path) ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    const { user } = await open(w, f.person);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Linked accounts' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server had a problem. Try again in a moment.');
    expect(screen.getByRole('button', { name: 'Linked accounts' })).toBeInTheDocument();
  });

  it('Escape closes the menu and gives the focus back to its button', async () => {
    const { w, f } = await person();
    const { user } = await open(w, f.person);
    await user.click(menuButton());
    await user.keyboard('{Escape}');
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton()).toHaveFocus();
  });

  it('uses the real route too: a person with a merged alias reads counts from the kit', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Mallory', reporter: 'Rhea' });
    const { user } = await open(w, f.person);
    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Linked accounts' }));
    await waitFor(() => expect(screen.getByText(/linked to this person|No accounts or devices/)).toBeInTheDocument());
    const region = screen.getByRole('group', { name: 'More about this person' });
    expect(within(region).getByRole('button', { name: 'Linked accounts' })).toBeInTheDocument();
  });
});

describe('without the data none of the theme renders on the Person page', () => {
  it('the page before the menu is opened has one added control: the ... button', async () => {
    const { w, f } = await person();
    const { container } = await open(w, f.person);
    const buttons = Array.from(container.querySelectorAll('.cw-screen button')).map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(buttons.filter((b) => /linked|rooms|surge/i.test(b ?? ''))).toEqual([]);
  });
});
