import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { baseline, normalized } from './baseline.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { WorldOptions } from './world.js';

// The rename option of the Sanction form (names, design 5.6): "Ask for a new name (no sanction)", the last choice of "What happens", only with renames on and
// sanctions.apply. It hides the length and the IP, keeps the rule and the reason, and calls the rename route; the claim rules and the toast are a sanction's. With
// renames off the form is what 0.1.7 drew: byte for byte.

const OPTION = 'Ask for a new name (no sanction)';
const posts = (w: AppealsHub, path: RegExp): AppealsHub['sent'] => w.sent.filter((r) => r.method === 'POST' && path.test(r.path));
const renames = (w: AppealsHub) => posts(w, /^\/people\/[^/]+\/rename$/);
const sanctions = (w: AppealsHub) => posts(w, /^\/sanctions$/);
const what = (): HTMLSelectElement => screen.getByLabelText('What happens') as HTMLSelectElement;
const reason = (): HTMLTextAreaElement => screen.getByLabelText('Reason') as HTMLTextAreaElement;
const rule = (): HTMLSelectElement => screen.getByLabelText('Community Rule') as HTMLSelectElement;
const world = (o: WorldOptions & { names?: Record<string, unknown> } = {}) => appealsHub({ names: { renames: true }, ...o });

async function openForm(w: AppealsHub | Awaited<ReturnType<typeof hubWorld>>, person: string, button = 'Sanction') {
  const r = renderHub(w, { path: `/people/${person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  await r.user.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect(rule().options.length).toBeGreaterThan(2));
  return r;
}

describe('with renames off the Sanction form is what 0.1.7 drew', () => {
  it('the form, open', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Mallory' });
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await user.click(await screen.findByRole('button', { name: 'Sanction' }));
    const form = await screen.findByRole('region', { name: 'Sanction Mallory' });
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    await expect(normalized(form)).toMatchFileSnapshot(baseline('sanction-form'));
  });

  it('and with appeals on and renames untouched (default off): the same form, byte for byte', async () => {
    const w = await appealsHub();
    const f = await w.file({ target: 'Mallory' });
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await user.click(await screen.findByRole('button', { name: 'Sanction' }));
    const form = await screen.findByRole('region', { name: 'Sanction Mallory' });
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    await expect(normalized(form)).toMatchFileSnapshot(baseline('sanction-form'));
    expect([...what().options].map((o) => o.textContent)).not.toContain(OPTION);
  });

  it('renames on but sanctions.apply raised: there is no Sanction form to open at all', async () => {
    const w = await world({ permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.file({ target: 'Mallory' });
    renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    expect(screen.queryByRole('button', { name: 'Sanction' })).toBeNull();
    expect(screen.queryByText(OPTION)).toBeNull();
  });
});

describe('the rename option', () => {
  it('is the last choice of "What happens", present with renames on and sanctions.apply', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    await openForm(w, f.person);
    const options = [...what().options].map((o) => o.textContent);
    expect(options[options.length - 1]).toBe(OPTION);
    expect(options.slice(0, -1)).toEqual(['Choose', 'Warning', 'Chat restriction', 'Area restriction', 'Ban']);
  });

  it('is not in the note form', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    await openForm(w, f.person, 'Add a note');
    expect(screen.queryByText(OPTION)).toBeNull();
  });

  it('choosing it hides the length and the IP, keeps the rule and the reason, and says no sanction is applied', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'chat');
    expect(screen.getByLabelText('How long')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /IP address/ })).toBeInTheDocument();
    await user.selectOptions(what(), 'rename');
    expect(screen.queryByLabelText('How long')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /IP address/ })).toBeNull();
    expect(rule()).toBeInTheDocument();
    expect(reason()).toBeInTheDocument();
    expect(screen.getByText('The player is asked to choose a new name. No sanction is applied.')).toBeInTheDocument();
    expect(screen.queryByText(/not sent a notice/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });

  it('choosing another kind brings the length and the IP back, with what was typed', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    await user.type(reason(), 'my words');
    await user.selectOptions(what(), 'rename');
    await user.selectOptions(what(), 'ban');
    expect(screen.getByLabelText('How long')).toBeInTheDocument();
    expect(reason().value).toBe('my words');
  });

  it('submits to the rename route with the reason and the rule, applies no sanction, and says so in a toast', async () => {
    const w = await world();
    const f = await w.file({ target: 'zorbakKid' });
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'rename');
    await user.selectOptions(rule(), '2');
    await user.type(reason(), 'A name against the rules.');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(renames(w)).toHaveLength(1));
    expect(renames(w)[0]?.path).toBe(`/people/${f.person}/rename`);
    expect(renames(w)[0]?.body).toEqual({ reason: 'A name against the rules.', rule: 2 });
    expect(sanctions(w)).toEqual([]);
    expect(await screen.findByText('Asked Blocked words, hidden to choose a new name.')).toBeInTheDocument();
    // The form closes and the page reads again: the timeline says so.
    await waitFor(() => expect(screen.queryByRole('region', { name: /^Sanction / })).toBeNull());
    expect(w.cw.names.pendingRename({ clientKey: 'key-target-zorbakKid' })).toBe(true);
    const timeline = await screen.findByRole('region', { name: 'Timeline' });
    expect(await within(timeline).findByText('Asked to choose a new name')).toBeInTheDocument();
    expect(within(timeline).getByText('Waiting for a new name')).toBeInTheDocument();
  });

  it('the rule is optional: with none chosen it is left out and the server uses its own', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'rename');
    await user.type(reason(), 'Please pick another.');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(renames(w)).toHaveLength(1));
    expect(renames(w)[0]?.body).toEqual({ reason: 'Please pick another.' });
  });

  it('a reason is required: nothing is sent and the field is marked', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'rename');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Write a reason. Only staff see it.')).toBeInTheDocument();
    expect(reason()).toHaveAttribute('aria-invalid', 'true');
    await user.type(reason(), '   ');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByText('Write a reason. Only staff see it.')).toBeInTheDocument();
    expect(renames(w)).toEqual([]);
  });

  it('a pending_rename refusal shows in words, with everything typed kept', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    await w.client.rename(f.person, { reason: 'first' });
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'rename');
    await user.type(reason(), 'second');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('They have already been asked to choose a new name and have not done it yet.');
    expect(reason().value).toBe('second');
    expect(what().value).toBe('rename');
  });

  it('a 404 (renames switched off meanwhile) and a server error say what happened and keep the form', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'rename');
    await user.type(reason(), 'a reason');
    w.intercept.fn = (req) => (/\/rename$/.test(req.path) ? { status: 404, headers: {}, body: { error: 'not_found', message: 'x' } } : undefined);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    w.intercept.fn = (req) => (/\/rename$/.test(req.path) ? { status: 500, headers: {}, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The server had a problem'));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(reason().value).toBe('a reason');
  });
});

describe('the claim gate and takeOver behave as for a sanction', () => {
  it('another moderator holds the case: the refusal names them, and a moderator has no take-over', async () => {
    const w = await world({ role: 'moderator', actor: 'ann@example.test' });
    const f = await w.file({ target: 'Mallory' });
    await w.clientFor('maya@example.test', 'moderator').claimCase(f.person);
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'rename');
    await user.type(reason(), 'a reason');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('maya is handling this player’s case, so this was not applied. What you entered is kept.');
    expect(screen.queryByRole('button', { name: 'Take over and apply' })).toBeNull();
    expect(renames(w)).toHaveLength(1);
  });

  it('a senior may take over, and the second call carries takeOver', async () => {
    const w = await world({ role: 'senior', actor: 'bea@example.test' });
    const f = await w.file({ target: 'Mallory' });
    await w.clientFor('maya@example.test', 'moderator').claimCase(f.person);
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'rename');
    await user.type(reason(), 'a reason');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(await screen.findByRole('button', { name: 'Take over and apply' }));
    await waitFor(() => expect(renames(w)).toHaveLength(2));
    expect(renames(w)[0]?.body).toEqual({ reason: 'a reason' });
    expect(renames(w)[1]?.body).toEqual({ reason: 'a reason', takeOver: true });
    expect(w.cw.audit.list({ limit: 50 }).items.some((a) => a.action === 'name.rename_required')).toBe(true);
  });
});

describe('the Person page timeline', () => {
  const timeline = (): HTMLElement => screen.getByRole('region', { name: 'Timeline' });

  it('shows "Asked to choose a new name" with its date, and that it is waiting', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    await w.client.rename(f.person, { reason: 'a name' });
    renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    const li = (await within(timeline()).findByText('Asked to choose a new name')).closest('li') as HTMLElement;
    expect(li.querySelector('time')).not.toBeNull();
    expect(li).toHaveTextContent('Waiting for a new name');
    expect(li.querySelector('.cw-card')).toBeNull();
  });

  it('once they have chosen another name it is no longer waiting', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    await w.client.rename(f.person, { reason: 'a name' });
    const real = await w.client.personHistory(f.person);
    w.intercept.fn = (req) => (/\/history$/.test(req.path) ? { status: 200, headers: {}, body: { ...real, renames: real.renames?.map((r) => ({ ...r, pending: false })) } } : undefined);
    renderHub(w, { path: `/people/${f.person}` });
    const li = (await within(await screen.findByRole('region', { name: 'Timeline' })).findByText('Asked to choose a new name')).closest('li') as HTMLElement;
    expect(li).not.toHaveTextContent('Waiting for a new name');
  });

  it('with renames off and none asked there is no entry', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Mallory' });
    renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    expect(screen.queryByText('Asked to choose a new name')).toBeNull();
  });
});
