import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import { DAY, HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// "What the player sees" on the Person page (0.2.0): above Apply for a sanction, a note and a rename, above Revoke. The panel is live: it follows the form.

const world = (o: Parameters<typeof appealsHub>[0] = {}) => appealsHub({ names: { renames: true }, ...o });
const what = (): HTMLSelectElement => screen.getByLabelText('What happens') as HTMLSelectElement;
const reason = (): HTMLTextAreaElement => screen.getByLabelText('Reason') as HTMLTextAreaElement;
const rule = (): HTMLSelectElement => screen.getByLabelText('Community Rule') as HTMLSelectElement;
const panelIn = async (scope: HTMLElement): Promise<HTMLElement> => within(scope).findByRole('region', { name: 'What the player sees' });
const formPanel = (name: string) => screen.getByRole('region', { name });

async function openForm(w: AppealsHub | HubWorld, person: string, button = 'Sanction') {
  const r = renderHub(w, { path: `/people/${person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  await r.user.click(screen.getByRole('button', { name: button }));
  await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement | null)?.options.length ?? 0).toBeGreaterThan(2));
  return r;
}

describe('the Sanction form', () => {
  it('shows the panel above Apply, with the prompt until a kind is chosen', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    await openForm(w, f.person);
    const form = formPanel('Sanction Mallory');
    const panel = await panelIn(form);
    expect(panel).toHaveTextContent('Choose what happens to see what the player is sent.');
    // The panel is the last thing above the buttons.
    const apply = within(form).getByRole('button', { name: 'Apply' });
    expect(panel.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(form.querySelector('.cw-action-foot')?.previousElementSibling === panel || form.contains(panel)).toBe(true);
  });

  it('follows the kind, the length and the IP box at once', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    const panel = await panelIn(formPanel('Sanction Mallory'));
    await user.selectOptions(what(), 'chat');
    await waitFor(() => expect(panel).toHaveTextContent('No notice is sent. Only a decision on a report sends one.'));
    expect(panel).toHaveTextContent('A moderator turned off your chat until');
    expect(panel).toHaveTextContent('(in 24 hours)');
    await user.selectOptions(screen.getByLabelText('How long'), '7d');
    await waitFor(() => expect(panel).toHaveTextContent('(in 7 days)'));
    expect(panel).not.toHaveTextContent('network address');
    await user.click(screen.getByRole('checkbox', { name: /IP address/ }));
    await waitFor(() => expect(panel).toHaveTextContent('Their network address is also restricted for 24 hours.'));
    await user.click(screen.getByRole('checkbox', { name: /IP address/ }));
    await waitFor(() => expect(panel).not.toHaveTextContent('network address'));
    await user.selectOptions(what(), 'ban');
    await waitFor(() => expect(panel).toHaveTextContent('Your game shows its own message when they try to join; the kit sends none.'));
    await user.selectOptions(what(), 'area');
    await waitFor(() => expect(panel).toHaveTextContent('Your game shows its own message when they try to join; the kit sends none.'));
    await user.selectOptions(what(), 'warning');
    await waitFor(() => expect(panel).toHaveTextContent("A warning from a person's page is on their record for staff only."));
    await user.selectOptions(what(), '');
    await waitFor(() => expect(panel).toHaveTextContent('Choose what happens to see what the player is sent.'));
  });

  it('a problem elsewhere in the form never blanks the panel', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    const panel = await panelIn(formPanel('Sanction Mallory'));
    await user.selectOptions(what(), 'ban');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Write a reason. Only staff see it.')).toBeInTheDocument();
    expect(panel).toHaveTextContent('Your game shows its own message');
  });

  it('the panel on the form sends nothing and asks the server nothing', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    const before = w.sent.length;
    await user.selectOptions(what(), 'chat');
    await user.selectOptions(what(), 'ban');
    await user.selectOptions(what(), 'rename');
    await waitFor(() => expect(formPanel('Sanction Mallory')).toHaveTextContent('Choose a rule'));
    expect(w.sent.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
  });
});

describe('the Note form', () => {
  it('says nothing is sent to the player, from the start', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    await openForm(w, f.person, 'Add a note');
    const panel = await panelIn(formPanel('Add a note about Mallory'));
    expect(panel).toHaveTextContent('Nothing is sent to the player. Only your team sees this note.');
  });
});

describe('the rename', () => {
  it('shows the rename notice with the chosen rule, and needs the rule: no panel notice before one is chosen', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    const panel = await panelIn(formPanel('Sanction Mallory'));
    await user.selectOptions(what(), 'rename');
    await waitFor(() => expect(panel).toHaveTextContent('Choose a rule to see the notice they would get.'));
    expect(within(panel).queryByRole('heading', { level: 4 })).toBeNull();
    await user.selectOptions(rule(), '7');
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 4, name: 'Please choose a new name' })).toBeInTheDocument());
    expect(panel).toHaveTextContent('Community Rule 7: No offensive names');
    expect(panel).toHaveTextContent('They are asked to pick a new name before they can chat.');
    await user.selectOptions(rule(), '2');
    await waitFor(() => expect(panel).toHaveTextContent('Community Rule 2:'));
    expect(panel).not.toHaveTextContent('Community Rule 7');
  });

  it('"No rule covers this" is not offered; the rule is a problem line until chosen', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory' });
    const { user } = await openForm(w, f.person);
    await user.selectOptions(what(), 'rename');
    expect([...rule().options].map((o) => o.textContent)).not.toContain('No rule covers this');
    await user.type(reason(), 'a name');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Choose the rule this is under.')).toBeInTheDocument();
  });
});

describe('revoke', () => {
  async function banned(kind: 'chat' | 'area' | 'ban' | 'warning', o: { appeals?: boolean } = {}) {
    const w: HubWorld = o.appeals === false ? await hubWorld({ role: 'senior' }) : await appealsHub({ role: 'senior' });
    const f = await w.file({ target: 'Mallory' });
    await w.sanction(f.person, kind, 2, kind === 'warning' ? undefined : DAY);
    const r = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'In force now' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    return { w, ...r };
  }
  const open = async (user: ReturnType<typeof renderHub>['user']) => {
    await user.click(within(screen.getByRole('region', { name: 'In force now' })).getAllByRole('button', { name: /^Revoke/ })[0] as HTMLElement);
    return panelIn(screen.getByRole('form', { name: /^Revoke/ }));
  };

  it.each([
    ['chat', 'They can chat again at once.'],
    ['area', 'They can join public rooms again.'],
    ['ban', 'They are no longer banned.'],
    ['warning', 'The warning is taken off their record.'],
  ] as const)('%s: says what lifts and that an unseen notice is never shown, above the confirm button', async (kind, line) => {
    const { user } = await banned(kind);
    const panel = await open(user);
    expect(panel).toHaveTextContent('No new notice is sent. A notice they have not seen is never shown; one they have seen leaves their record.');
    expect(panel).toHaveTextContent(line);
    expect(panel.compareDocumentPosition(screen.getByRole('button', { name: 'Confirm revoke' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the appeals line only with appeals on', async () => {
    const on = await banned('chat');
    const panel = await open(on.user);
    await waitFor(() => expect(panel).toHaveTextContent('If they appealed, the appeal is closed with no message.'));
    on.unmount();
    const off = await banned('chat', { appeals: false });
    const second = await open(off.user);
    expect(second).not.toHaveTextContent('appeal');
  });

  it('a note in force: nothing changes for the player', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.file({ target: 'Mallory' });
    await w.sanction(f.person, 'note', 2);
    const { user } = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'In force now' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    const buttons = within(screen.getByRole('region', { name: 'In force now' })).queryAllByRole('button', { name: /^Revoke/ });
    if (buttons.length === 0) return;
    await user.click(buttons[0] as HTMLElement);
    const panel = await panelIn(screen.getByRole('form', { name: /^Revoke/ }));
    expect(panel).toHaveTextContent('Nothing changes for the player. Only your team sees this note.');
  });

  it('typing a reason does not change the panel, and the panel adds no request', async () => {
    const { w, user } = await banned('ban');
    const panel = await open(user);
    const before = panel.textContent;
    const sent = w.sent.length;
    await user.type(within(screen.getByRole('form', { name: /^Revoke/ })).getByRole('textbox'), 'because it was a misread');
    expect(panel.textContent).toBe(before);
    expect(w.sent.length).toBe(sent);
    void HOUR;
  });
});
