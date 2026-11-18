import { screen, within } from '@testing-library/react';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryNames } from '@chatwarden/store-memory';
import { describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// "Ask for a new name" is off by default (the game must block the old name first). On a name report the actions area then shows one plain line where the
// row would be: the setting is off (a link to Settings for the owner, words for everyone else), or it is on but this setup cannot release a rename (words only).

const HINT_LEAD = 'Asking for a new name is switched off. Turn it on in';
const WHERE = 'Settings, Advanced, Names';
const UNSUPPORTED = 'This setup cannot ask for a new name: its store cannot release one.';
const bar = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });

async function open(w: HubWorld, reason: string | null = 'name') {
  const f = await w.file({ target: 'Mallory', ...(reason === null ? {} : { reason }) });
  const r = renderHub(w, { path: `/reports/${f.id}` });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  return r;
}

describe('the setting is off', () => {
  it('the owner (policy.write) sees the words with "Settings, Advanced, Names" as a link to the Advanced settings', async () => {
    const w = await appealsHub({ role: 'owner' });
    await open(w);
    const hint = within(bar()).getByText(HINT_LEAD, { exact: false });
    expect(hint).toHaveTextContent(`${HINT_LEAD} ${WHERE}.`);
    const link = within(hint).getByRole('link', { name: WHERE });
    expect(link).toHaveAttribute('href', expect.stringContaining('settings/advanced'));
  });

  it.each(['moderator', 'senior'] as const)('a %s sees the same words with no link', async (role) => {
    const w = await appealsHub({ role });
    await open(w);
    const hint = within(bar()).getByText(HINT_LEAD, { exact: false });
    expect(hint).toHaveTextContent(`${HINT_LEAD} ${WHERE}.`);
    expect(within(hint).queryByRole('link')).toBeNull();
  });

  it('there is no rename row beside it', async () => {
    const w = await appealsHub({ role: 'owner' });
    await open(w);
    expect(within(bar()).queryByRole('checkbox', { name: 'Ask for a new name' })).toBeNull();
  });
});

describe('the setting is on but the store cannot release a rename', () => {
  async function unsupported(role: WorldOptions['role'] = 'owner') {
    const store = withMemoryNames(withMemoryAppeals(withMemoryAi(new MemoryStore())));
    // A store with no way to withdraw a notice: a rename could be asked and never released.
    (store as unknown as { withdrawNotice: undefined }).withdrawNotice = undefined;
    return hubWorld({ role, store, overrides: { names: { renames: true } } });
  }

  it('says so in words, with no link, even for the owner', async () => {
    const w = await unsupported();
    await open(w);
    const hint = within(bar()).getByText(UNSUPPORTED);
    expect(hint.querySelector('a')).toBeNull();
    expect(within(bar()).queryByText(HINT_LEAD, { exact: false })).toBeNull();
    expect(within(bar()).queryByRole('checkbox', { name: 'Ask for a new name' })).toBeNull();
  });
});

describe('where it is not drawn', () => {
  it('on a report of any other reason', async () => {
    const w = await appealsHub({ role: 'owner' });
    await open(w, 'harassment');
    expect(within(bar()).queryByText(HINT_LEAD, { exact: false })).toBeNull();
    expect(within(bar()).queryByText(UNSUPPORTED)).toBeNull();
  });

  it('on a report that gave no reason', async () => {
    const w = await appealsHub({ role: 'owner' });
    await open(w, null);
    expect(within(bar()).queryByText(HINT_LEAD, { exact: false })).toBeNull();
  });

  it('for a role that cannot decide', async () => {
    const w = await appealsHub({ role: 'moderator', permissions: { 'reports.decide': 'owner' } });
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    expect(await within(bar()).findByText(/cannot decide|Your role/i)).toBeInTheDocument();
    expect(within(bar()).queryByText(HINT_LEAD, { exact: false })).toBeNull();
  });

  it('for a role that decides but cannot apply sanctions (there is nothing for it to switch on)', async () => {
    const w = await appealsHub({ role: 'moderator', permissions: { 'sanctions.apply': 'owner' } });
    await open(w);
    expect(within(bar()).queryByText(HINT_LEAD, { exact: false })).toBeNull();
  });

  it('with renames on and working: the row, not the hint', async () => {
    const w = await appealsHub({ role: 'owner', names: { renames: true } });
    await open(w);
    expect(within(bar()).queryByText(HINT_LEAD, { exact: false })).toBeNull();
    expect(within(bar()).getByRole('checkbox', { name: 'Ask for a new name' })).toBeInTheDocument();
  });
});
