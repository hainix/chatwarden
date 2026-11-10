import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// Terms, fix round 1: the edit form keeps a word hidden until it is shown, focus is not taken back after a reload, and turning a
// term back on is dry-run first.

const WORDS = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn', 'zorba'];
const sent = (w: HubWorld, method: string, path: string): TransportRequest[] => w.sent.filter((r) => r.method === method && r.path === path);
const activePosts = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /^\/terms\/.+\/active$/.test(r.path));
const showWords = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Show words' });
const HIDDEN = 'Blocked words, hidden';

function noWordsIn(html: string): void {
  const lower = html.toLowerCase();
  for (const word of WORDS) expect(lower, `the word ${word} is in the page`).not.toContain(word);
}

async function openTerms(options: WorldOptions = {}, prepare?: (w: HubWorld) => unknown) {
  const w = await hubWorld(options);
  const prepared = await prepare?.(w);
  const r = renderHub(w, { path: '/terms' });
  await screen.findByRole('heading', { level: 2, name: 'Terms' });
  await screen.findByRole('region', { name: /^English/ });
  return { w, prepared, ...r };
}

describe('the edit form keeps the word hidden', () => {
  it('opens with a mask and a Show button where the word would be, language and note in the open, and no word in the page', async () => {
    const { user, container } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Edit term 7' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    expect(within(form).queryByLabelText('Word')).toBeNull();
    expect(within(form).getByText(HIDDEN)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Show the word in this form' })).toHaveFocus();
    expect(within(form).getByLabelText('Language')).toHaveValue('en');
    expect(within(form).getByLabelText('Note')).toBeInTheDocument();
    noWordsIn(container.innerHTML);
  });

  it('Show reveals the word in this form only: the input gets the focus, the screen switch stays off and the rows stay hidden', async () => {
    const { user } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Edit term 7' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    await user.click(within(form).getByRole('button', { name: 'Show the word in this form' }));
    expect(within(form).getByLabelText('Word')).toHaveValue('snerp');
    expect(within(form).getByLabelText('Word')).toHaveFocus();
    expect(within(form).queryByRole('button', { name: 'Show the word in this form' })).toBeNull();
    expect(showWords()).not.toBeChecked();
    const table = screen.getByRole('region', { name: 'Terms in English (en)' });
    expect(within(table).queryByText('snerp')).toBeNull();
    expect(within(table).getAllByText(HIDDEN).length).toBeGreaterThanOrEqual(7);
  });

  it('with Show words on the form shows the word at once, with the word focused', async () => {
    const { user } = await openTerms();
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: 'Edit snerp' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    expect(within(form).getByLabelText('Word')).toHaveValue('snerp');
    expect(within(form).getByLabelText('Word')).toHaveFocus();
    expect(within(form).queryByText(HIDDEN)).toBeNull();
  });

  it('a note-only edit saves without the word ever being shown, and sends only the note', async () => {
    const { w, user, container } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Edit term 7' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    await user.type(within(form).getByLabelText('Note'), 'nuisance');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit a term' })).toBeNull());
    expect(w.sent.find((r) => r.method === 'PATCH')?.body).toEqual({ note: 'nuisance' });
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(0);
    noWordsIn(container.innerHTML);
  });

  it('saving with nothing changed says so even though the word was never shown', async () => {
    const { w, user } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Edit term 1' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Nothing has changed.')).toBeInTheDocument();
    expect(w.sent.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('a language change checks the held word; its hits are hidden too until shown, and Save anyway works without showing', async () => {
    const { w, user, container } = await openTerms({}, (x) => x.direct.addTerm({ term: 'zorba', language: 'en' }));
    await user.click(screen.getByRole('button', { name: 'Edit term 8' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    await user.clear(within(form).getByLabelText('Language'));
    await user.type(within(form).getByLabelText('Language'), 'es');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This word would also block 2 lines that are fine today.')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms/check')[0]?.body).toEqual({ term: 'zorba', language: 'es' });
    // The lines hold the word, so they are hidden like it.
    expect(screen.queryByRole('list', { name: 'Lines it would block' })).toBeNull();
    noWordsIn(container.innerHTML);
    expect(screen.getByRole('button', { name: 'Show the lines' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(w.sent.filter((r) => r.method === 'PATCH')).toHaveLength(1));
    expect(w.sent.find((r) => r.method === 'PATCH')?.body).toEqual({ language: 'es' });
  });

  it('Show the lines lists them, and the word in the form shows with them', async () => {
    const { user } = await openTerms({}, (x) => x.direct.addTerm({ term: 'zorba', language: 'en' }));
    await user.click(screen.getByRole('button', { name: 'Edit term 8' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    await user.clear(within(form).getByLabelText('Language'));
    await user.type(within(form).getByLabelText('Language'), 'es');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await user.click(await screen.findByRole('button', { name: 'Show the lines' }));
    const list = screen.getByRole('list', { name: 'Lines it would block' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['zorba', 'zorba!']);
    expect(screen.getByLabelText('Word')).toHaveValue('zorba');
  });

  it('an exception form hides its phrase the same way, with its own Show', async () => {
    const { user, container } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Edit exception 1' }));
    const form = await screen.findByRole('form', { name: 'Edit an exception' });
    expect(within(form).queryByLabelText('Phrase')).toBeNull();
    noWordsIn(container.innerHTML);
    await user.click(within(form).getByRole('button', { name: 'Show the phrase in this form' }));
    expect(within(form).getByLabelText('Phrase')).toHaveValue('tarvo lake');
  });

  it('a new term or exception has nothing to hide: its word field is open from the start', async () => {
    const { user } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Add a term' }));
    expect(screen.getByLabelText('Word')).toHaveFocus();
    expect(screen.queryByText(HIDDEN, { selector: 'form *' })).toBeNull();
  });

  it('changing rows or closing the form puts the mask back for the next one', async () => {
    const { user } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Edit term 1' }));
    await user.click(screen.getByRole('button', { name: 'Show the word in this form' }));
    await user.click(screen.getByRole('button', { name: 'Edit term 2' }));
    const form = screen.getByRole('form', { name: 'Edit a term' });
    expect(within(form).queryByLabelText('Word')).toBeNull();
    expect(within(form).getByRole('button', { name: 'Show the word in this form' })).toBeInTheDocument();
  });
});

describe('View term takes the focus once', () => {
  it('after the handoff, toggling a switch keeps the focus on the switch, and the scroll ran once', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const w = await hubWorld();
    w.blockLine('Vantablob', 'you fenrisk');
    const { user } = renderHub(w, { path: '/blocked' });
    await user.click(await screen.findByRole('button', { name: /^View the term for the line from/ }));
    const tag = await screen.findByText('From the blocked list');
    const row = tag.closest('tr') as HTMLElement;
    await waitFor(() => expect(row).toHaveFocus());
    expect(scroll).toHaveBeenCalledTimes(1);
    const box = screen.getByRole('checkbox', { name: 'Active: term 2' });
    await user.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: term 2' })).not.toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'Active: term 2' })).toHaveFocus();
    expect(scroll).toHaveBeenCalledTimes(1);
    // The marked row's own switch behaves the same way.
    const own = screen.getByRole('checkbox', { name: 'Active: term 5' });
    await user.click(own);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: term 5' })).not.toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'Active: term 5' })).toHaveFocus();
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});

describe('turning a term back on is dry-run first', () => {
  /** A term the list holds but is off: `zorba` (it would also block two lines) or `flarpnok` (none). */
  async function withOff(word: string) {
    return openTerms({}, async (x) => {
      const { id } = await x.direct.addTerm({ term: word, language: 'en' });
      await x.direct.setTermActive(id, false);
      return id;
    });
  }
  const box = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Active: term 8' });

  it('with hits it lists them inline on that row and sends nothing until Save anyway', async () => {
    const { w, user } = await withOff('zorba');
    expect(box()).not.toBeChecked();
    await user.click(box());
    const confirm = await screen.findByRole('group', { name: 'Lines it would block' });
    expect(within(confirm).getByText('This word would also block 2 lines that are fine today.')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms/check')[0]?.body).toEqual({ term: 'zorba', language: 'en' });
    expect(activePosts(w)).toHaveLength(0);
    expect(box()).not.toBeChecked();
    // It sits under that row, in the same table.
    expect(confirm.closest('tr')?.previousElementSibling).toContainElement(box());
    await user.click(within(confirm).getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(box()).toBeChecked());
    expect(activePosts(w)).toHaveLength(1);
    expect(w.live.rows.terms.find((t) => t.term === 'zorba')?.active).toBe(true);
    expect(screen.queryByRole('group', { name: 'Lines it would block' })).toBeNull();
    expect(await screen.findByText('Switched on.')).toBeInTheDocument();
  });

  it('the lines are hidden while words are, and Show the lines or Show words lists them', async () => {
    const { user, container } = await withOff('zorba');
    await user.click(box());
    const confirm = await screen.findByRole('group', { name: 'Lines it would block' });
    expect(within(confirm).queryByRole('list')).toBeNull();
    noWordsIn(container.innerHTML);
    await user.click(within(confirm).getByRole('button', { name: 'Show the lines' }));
    expect(within(confirm).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['zorba', 'zorba!']);
  });

  it('with Show words on the lines are listed at once', async () => {
    const { user } = await withOff('zorba');
    await user.click(showWords());
    await user.click(screen.getByRole('checkbox', { name: 'Active: zorba' }));
    const confirm = await screen.findByRole('group', { name: 'Lines it would block' });
    expect(within(confirm).getAllByRole('listitem')).toHaveLength(2);
  });

  it('Go back leaves the term off, sends nothing and returns the focus to its switch', async () => {
    const { w, user } = await withOff('zorba');
    await user.click(box());
    const confirm = await screen.findByRole('group', { name: 'Lines it would block' });
    await user.click(within(confirm).getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('group', { name: 'Lines it would block' })).toBeNull();
    expect(box()).not.toBeChecked();
    expect(box()).toHaveFocus();
    expect(activePosts(w)).toHaveLength(0);
  });

  it('with no hits it checks, then switches it on, in that order, with no confirm', async () => {
    const { w, user } = await withOff('flarpnok');
    await user.click(box());
    await waitFor(() => expect(box()).toBeChecked());
    const order = w.sent.filter((r) => r.path === '/terms/check' || (r.method === 'POST' && /\/active$/.test(r.path))).map((r) => r.path.endsWith('/active') ? 'active' : 'check');
    expect(order).toEqual(['check', 'active']);
    expect(screen.queryByRole('group', { name: 'Lines it would block' })).toBeNull();
  });

  it('turning a term off never checks, and neither does an exception either way', async () => {
    const { w, user } = await openTerms();
    await user.click(screen.getByRole('checkbox', { name: 'Active: term 2' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: term 2' })).not.toBeChecked());
    await user.click(screen.getByRole('checkbox', { name: 'Active: exception 1' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: exception 1' })).not.toBeChecked());
    await user.click(screen.getByRole('checkbox', { name: 'Active: exception 1' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: exception 1' })).toBeChecked());
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(0);
  });

  it('a check the list refuses (400 invalid_term) says so and leaves the term off', async () => {
    const { w, user } = await withOff('zorba');
    w.intercept.fn = (req) => (req.path === '/terms/check' ? { status: 400, body: { error: 'invalid_term', message: 'x' } } : undefined);
    await user.click(box());
    expect(await screen.findByRole('alert')).toHaveTextContent('The list refused this word (it may be a duplicate, malformed, or the last active word).');
    expect(box()).not.toBeChecked();
    expect(activePosts(w)).toHaveLength(0);
  });

  it('a double click sends one check, and a double Save anyway sends one switch', async () => {
    const { w, user } = await withOff('zorba');
    fireEvent.click(box());
    fireEvent.click(box());
    const confirm = await screen.findByRole('group', { name: 'Lines it would block' });
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(1);
    const anyway = within(confirm).getByRole('button', { name: 'Save anyway' });
    fireEvent.click(anyway);
    fireEvent.click(anyway);
    await waitFor(() => expect(box()).toBeChecked());
    expect(activePosts(w)).toHaveLength(1);
    void user;
  });

  it('a network failure on the switch after Save anyway says so and keeps the term off', async () => {
    const { w, user } = await withOff('zorba');
    await user.click(box());
    const confirm = await screen.findByRole('group', { name: 'Lines it would block' });
    w.intercept.fn = (req) => {
      if (req.method === 'POST' && /\/active$/.test(req.path)) throw new Error('offline');
      return undefined;
    };
    await user.click(within(confirm).getByRole('button', { name: 'Save anyway' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(box()).not.toBeChecked();
  });

  it('a role that may not write has no live switch to turn on (nothing is checked)', async () => {
    const { w } = await openTerms({ permissions: { 'terms.write': 'owner' } });
    for (const b of screen.getAllByRole('checkbox', { name: /^Active:/ })) expect(b).toBeDisabled();
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(0);
  });
});
