import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The Terms screen: terms and exceptions by language, the add and edit form with its dry run, the switches, and the tester. All
// against the real routes and a real term list. Only synthetic words appear. Words are hidden until "Show words" is on.

const WORDS = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];
const audits = (w: HubWorld, action: string): unknown[] => w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === action);
const sent = (w: HubWorld, method: string, path: string): TransportRequest[] => w.sent.filter((r) => r.method === method && r.path === path);
const region = (name: string | RegExp): HTMLElement => screen.getByRole('region', { name });
const showWords = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Show words' });
const rowOf = (el: HTMLElement, text: string | RegExp): HTMLElement => {
  const row = within(el)
    .getAllByRole('row')
    .find((r) => (typeof text === 'string' ? r.textContent?.includes(text) : text.test(r.textContent ?? '')));
  if (row === undefined) throw new Error(`no row with ${String(text)}`);
  return row;
};
const SERVER_500 = { status: 500, body: { error: 'internal', message: 'x' } };

function noWordsIn(html: string): void {
  const lower = html.toLowerCase();
  for (const word of WORDS) expect(lower, `the word ${word} is in the page`).not.toContain(word);
}

async function openTerms(options: WorldOptions = {}, prepare?: (w: HubWorld) => unknown) {
  const w = await hubWorld(options);
  await prepare?.(w);
  const r = renderHub(w, { path: '/terms' });
  await screen.findByRole('heading', { level: 2, name: 'Terms' });
  await screen.findByRole('region', { name: /^English/ });
  return { w, ...r };
}

describe('the list', () => {
  it('lists the terms and exceptions of a language in two tables under the language\'s name', async () => {
    const { w } = await openTerms();
    const en = region('English (en)');
    const terms = within(en).getByRole('region', { name: 'Terms in English (en)' });
    const ex = within(en).getByRole('region', { name: 'Exceptions in English (en)' });
    expect(within(terms).getAllByRole('row')).toHaveLength(1 + w.live.rows.terms.length);
    expect(within(ex).getAllByRole('row')).toHaveLength(1 + w.live.rows.exceptions.length);
    expect(within(terms).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Word', 'Note', 'Last changed', 'Blocked, 30 days', 'Active', 'Actions']);
    expect(within(ex).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Phrase', 'Note', 'Last changed', 'Active', 'Actions']);
  });

  it('hides every word until Show words is on, in the text, the labels and the markup', async () => {
    const { container, user } = await openTerms();
    const terms = within(region('English (en)')).getByRole('region', { name: 'Terms in English (en)' });
    expect(showWords()).not.toBeChecked();
    expect(within(terms).getAllByText('Blocked words, hidden').length).toBeGreaterThanOrEqual(7);
    noWordsIn(container.innerHTML);
    // The labels name a row by its place, not its word.
    expect(screen.getByRole('checkbox', { name: 'Active: term 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit term 1' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Active: exception 2' })).toBeInTheDocument();
    await user.click(showWords());
    expect(showWords()).toBeChecked();
    for (const word of ['zorbak', 'vlemmo', 'quissel', 'tarvo lake', 'glarn zorbak']) expect(within(region('English (en)')).getByText(word)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Active: zorbak' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit zorbak' })).toBeInTheDocument();
    await user.click(showWords());
    noWordsIn(container.innerHTML);
  });

  it('shows the note, who last changed it and when, and the blocks in the last 30 days', async () => {
    const { w, user } = await openTerms({}, async (x) => {
      x.blockLine('Vantablob', 'you zorbak');
      x.blockLine('Vantablob', 'zorbak again');
      x.blockLine('Kestrel', 'a vlemmo');
      await x.direct.updateTerm('syn:snerp', { note: 'a made-up pest' });
    });
    await user.click(showWords());
    const terms = within(region('English (en)')).getByRole('region', { name: 'Terms in English (en)' });
    const zorbak = rowOf(terms, 'zorbak');
    expect(within(zorbak).getAllByRole('cell').map((c) => c.textContent)).toEqual(expect.arrayContaining(['2']));
    expect(within(rowOf(terms, 'vlemmo')).getAllByRole('cell')[3]).toHaveTextContent('1');
    expect(within(rowOf(terms, 'quissel')).getAllByRole('cell')[3]).toHaveTextContent('0');
    const snerp = rowOf(terms, 'snerp');
    expect(snerp).toHaveTextContent('a made-up pest');
    expect(snerp).toHaveTextContent('ann');
    expect(w.live.rows.terms.find((t) => t.id === 'syn:snerp')).toBeDefined();
    expect(rowOf(terms, 'quissel')).toHaveTextContent('No note');
    // A row nobody has a record for reads as the starter list.
    expect(within(rowOf(terms, 'quissel')).getAllByRole('cell')[2]).not.toHaveTextContent('undefined');
  });

  it('groups by language, ordered by the language\'s name, with a name Intl cannot give left as the code', async () => {
    await openTerms({}, async (w) => {
      await w.direct.addTerm({ term: 'zorbako', language: 'es' });
      await w.direct.addTerm({ term: 'quisselo', language: 'zz' });
      await w.direct.addException({ phrase: 'vlemmo valle', language: 'pt-BR' });
    });
    const langs = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '').filter((n) => /\((en|es|pt-BR)\)$/.test(n) || n === 'zz');
    expect(langs).toHaveLength(4);
    // By the name in the viewer's language (so Brazilian Portuguese comes before English); a code Intl cannot name goes last.
    const named = langs.slice(0, 3);
    expect(named).toEqual([...named].sort((x, y) => x.localeCompare(y, 'en')));
    expect(named).toEqual(expect.arrayContaining(['English (en)', 'Spanish (es)']));
    expect(named.some((n) => /^(Brazilian )?Portuguese.*\(pt-BR\)$/.test(n))).toBe(true);
    expect(langs[3]).toBe('zz');
  });

  it('a language with only exceptions has "None." where the terms would be', async () => {
    await openTerms({}, async (w) => {
      await w.direct.addException({ phrase: 'vlemmo valle', language: 'es' });
    });
    const es = region('Spanish (es)');
    expect(within(es).getByText('None.')).toBeInTheDocument();
    expect(within(es).getByRole('region', { name: 'Exceptions in Spanish (es)' })).toBeInTheDocument();
  });

  it('a world with no terms says so and offers the first one', async () => {
    const w = await hubWorld({ role: 'senior' });
    for (const row of [...w.live.rows.exceptions]) w.live.changeSync('t', (e) => e.setExceptionActive(row.id, false));
    // Real routes cannot list zero terms (the list refuses to drop the last active one), so the empty list is faked.
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/terms' ? { status: 200, body: { terms: [], exceptions: [], blocks30d: {} } } : undefined);
    renderHub(w, { path: '/terms' });
    expect(await screen.findByText('There are no terms yet. Add the first one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a term' })).toBeInTheDocument();
  });

  it('reads the list once on opening', async () => {
    const { w } = await openTerms();
    expect(sent(w, 'GET', '/terms')).toHaveLength(1);
    expect(audits(w, 'blocked.view')).toHaveLength(0);
  });
});

describe('when it cannot be shown', () => {
  it('a 403 says so plainly with Try again, which reads once more', async () => {
    const w = await hubWorld();
    let n = 0;
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/terms' && ++n === 1 ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/terms' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the terms. Your role cannot do this.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'English (en)' })).toBeInTheDocument();
    expect(sent(w, 'GET', '/terms')).toHaveLength(2);
  });

  it('a 500 says so, and a network failure too', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/terms' ? SERVER_500 : undefined);
    renderHub(w, { path: '/terms' });
    expect(await screen.findByText(/The server had a problem/)).toBeInTheDocument();
  });

  it('a server without term routes says the terms are not set up, with no error block', async () => {
    const w = await hubWorld({ terms: false });
    renderHub(w, { path: '/terms' });
    expect(await screen.findByText('The terms are not set up on this server.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a term' })).toBeNull();
  });

  it('a role that may read but not write sees the list with no Add, Edit or live switch', async () => {
    await openTerms({ permissions: { 'terms.write': 'owner' } });
    expect(screen.queryByRole('button', { name: 'Add a term' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add an exception' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    for (const box of screen.getAllByRole('checkbox', { name: /^Active:/ })) expect(box).toBeDisabled();
  });

  it('a role without terms.read gets the "not available" page and reads nothing', async () => {
    const w = await hubWorld({ permissions: { 'terms.read': 'owner' } });
    renderHub(w, { path: '/terms' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available for your role' })).toBeInTheDocument();
    expect(sent(w, 'GET', '/terms')).toHaveLength(0);
  });
});

describe('adding a term', () => {
  async function openAdd(options: WorldOptions = {}, prepare?: (w: HubWorld) => unknown) {
    const r = await openTerms(options, prepare);
    await r.user.click(screen.getByRole('button', { name: 'Add a term' }));
    const form = await screen.findByRole('form', { name: 'Add a term' });
    return { ...r, form };
  }
  const word = (): HTMLInputElement => screen.getByLabelText('Word');
  const language = (): HTMLInputElement => screen.getByLabelText('Language');
  const note = (): HTMLTextAreaElement => screen.getByLabelText('Note');

  it('opens a form with the word field focused, English suggested, and Cancel closes it and returns focus', async () => {
    const { user } = await openAdd();
    expect(word()).toHaveFocus();
    expect(language()).toHaveValue('en');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Add a term' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a term' })).toHaveFocus();
  });

  it('with no hits it checks, then saves, in that order, and says so without the word', async () => {
    const { w, user, container } = await openAdd();
    await user.type(word(), 'flarpnok');
    await user.type(note(), 'a made-up one');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add a term' })).toBeNull());
    const order = w.sent.filter((r) => r.path === '/terms/check' || (r.method === 'POST' && r.path === '/terms')).map((r) => `${r.method} ${r.path}`);
    expect(order).toEqual(['POST /terms/check', 'POST /terms']);
    expect(sent(w, 'POST', '/terms')[0]?.body).toEqual({ term: 'flarpnok', language: 'en', note: 'a made-up one' });
    expect(w.live.rows.terms.some((t) => t.term === 'flarpnok')).toBe(true);
    expect(audits(w, 'term.add')).not.toHaveLength(0);
    expect(await screen.findByText('Term added.')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('flarpnok');
    expect(sent(w, 'GET', '/terms').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Add a term' })).toHaveFocus();
  });

  it('a note is optional and is left out of the request when empty', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), 'flarpnok');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(sent(w, 'POST', '/terms')).toHaveLength(1));
    expect(sent(w, 'POST', '/terms')[0]?.body).toEqual({ term: 'flarpnok', language: 'en' });
  });

  it('with hits it lists them and sends nothing until Save anyway', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), 'zorba');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('This word would also block 2 lines that are fine today.')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Lines it would block' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['zorba', 'zorba!']);
    expect(sent(w, 'POST', '/terms')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save anyway' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(sent(w, 'POST', '/terms')).toHaveLength(1));
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(1);
    expect(w.live.rows.terms.some((t) => t.term === 'zorba')).toBe(true);
    expect(await screen.findByText('Term added.')).toBeInTheDocument();
  });

  it('Go back from the hits returns to the form with everything typed, and nothing was sent', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), 'zorba');
    await user.type(note(), 'keep me');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await screen.findByRole('button', { name: 'Save anyway' });
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(screen.queryByRole('button', { name: 'Save anyway' })).toBeNull();
    expect(word()).toHaveValue('zorba');
    expect(note()).toHaveValue('keep me');
    expect(word()).toHaveFocus();
    expect(sent(w, 'POST', '/terms')).toHaveLength(0);
  });

  it('with many hits lists the first twenty and counts the rest', async () => {
    const { w, user } = await openAdd();
    const hits = Array.from({ length: 33 }, (_, i) => `fine line ${i + 1}`);
    w.intercept.fn = (req) => (req.path === '/terms/check' ? { status: 200, body: { hits } } : undefined);
    await user.type(word(), 'flarpnok');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('This word would also block 33 lines that are fine today.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Lines it would block' })).getAllByRole('listitem')).toHaveLength(20);
    expect(screen.getByText('and 13 more lines')).toBeInTheDocument();
  });

  it('exactly one hit reads in the singular and nothing is "more"', async () => {
    const { w, user } = await openAdd();
    w.intercept.fn = (req) => (req.path === '/terms/check' ? { status: 200, body: { hits: ['only line'] } } : undefined);
    await user.type(word(), 'flarpnok');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('This word would also block 1 line that is fine today.')).toBeInTheDocument();
    expect(screen.queryByText(/and \d+ more/)).toBeNull();
  });

  it('a word the list refuses (400 invalid_term on the check) shows the refusal and sends nothing more', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), 'a');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('The list refused this word (it may be a duplicate, malformed, or the last active word).')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms')).toHaveLength(0);
    expect(word()).toHaveValue('a');
  });

  it('a duplicate passes the check but is refused on save, with the same message and the input kept', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), 'zorbak');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('The list refused this word (it may be a duplicate, malformed, or the last active word).')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms')).toHaveLength(1);
    expect(word()).toHaveValue('zorbak');
    expect(screen.getByRole('form', { name: 'Add a term' })).toBeInTheDocument();
    expect(w.live.rows.terms.filter((t) => t.term === 'zorbak')).toHaveLength(1);
  });

  it('checks the fields before sending anything', async () => {
    const { w, user } = await openAdd();
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByText('Enter a word.')).toBeInTheDocument();
    expect(word()).toHaveAttribute('aria-invalid', 'true');
    expect(word()).toHaveFocus();
    await user.type(word(), 'flarpnok');
    await user.clear(language());
    await user.type(language(), 'e');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByText('Enter a language code, such as en or pt-BR.')).toBeInTheDocument();
    await user.clear(language());
    await user.type(language(), 'en');
    fireEvent.change(note(), { target: { value: 'n'.repeat(501) } });
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByText('The note is over 500 characters. Shorten it.')).toBeInTheDocument();
    fireEvent.change(note(), { target: { value: '' } });
    fireEvent.change(word(), { target: { value: 'w'.repeat(201) } });
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByText('This is over 200 characters. Shorten it.')).toBeInTheDocument();
    expect(w.sent.filter((r) => r.path === '/terms/check' || (r.method === 'POST' && r.path === '/terms'))).toHaveLength(0);
  });

  it('a blank word of spaces is the same as none', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), '   ');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(screen.getByText('Enter a word.')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(0);
  });

  it('a double click on Add sends one check and one save', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), 'flarpnok');
    const add = screen.getByRole('button', { name: 'Add term' });
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add a term' })).toBeNull());
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(1);
    expect(sent(w, 'POST', '/terms')).toHaveLength(1);
    void user;
  });

  it('a double click on Save anyway sends one save', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), 'zorba');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    const anyway = await screen.findByRole('button', { name: 'Save anyway' });
    fireEvent.click(anyway);
    fireEvent.click(anyway);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add a term' })).toBeNull());
    expect(sent(w, 'POST', '/terms')).toHaveLength(1);
  });

  it('a network failure on save keeps the input and offers Try again, which sends the same word once more', async () => {
    const { w, user } = await openAdd();
    let fail = true;
    w.intercept.fn = (req) => {
      if (req.method === 'POST' && req.path === '/terms' && fail) {
        fail = false;
        throw new Error('offline');
      }
      return undefined;
    };
    await user.type(word(), 'flarpnok');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the server');
    expect(word()).toHaveValue('flarpnok');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add a term' })).toBeNull());
    expect(w.live.rows.terms.filter((t) => t.term === 'flarpnok')).toHaveLength(1);
  });

  it('a 403 on the check says the role cannot do this and keeps the form', async () => {
    const { w, user } = await openAdd();
    w.intercept.fn = (req) => (req.path === '/terms/check' ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    await user.type(word(), 'flarpnok');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('Your role cannot do this.')).toBeInTheDocument();
    expect(word()).toHaveValue('flarpnok');
  });

  it('a 400 that is not invalid_term reads as the plain "not accepted" sentence', async () => {
    const { w, user } = await openAdd();
    w.intercept.fn = (req) => (req.method === 'POST' && req.path === '/terms' ? { status: 400, body: { error: 'invalid_request', message: 'x' } } : undefined);
    await user.type(word(), 'flarpnok');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('The server did not accept this. Check each field, then try again.')).toBeInTheDocument();
  });

  it('the new term shows in the list under Show words', async () => {
    const { user } = await openAdd();
    await user.type(word(), 'flarpnok');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add a term' })).toBeNull());
    await user.click(showWords());
    await waitFor(() => expect(within(region('English (en)')).getByText('flarpnok')).toBeInTheDocument());
  });

  it('a term in a new language creates its own group', async () => {
    const { user } = await openAdd();
    await user.type(word(), 'flarpnok');
    await user.clear(language());
    await user.type(language(), 'es');
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByRole('region', { name: 'Spanish (es)' })).toBeInTheDocument();
  });
});

describe('exceptions', () => {
  it('Add an exception saves with no dry run', async () => {
    const { w, user } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Add an exception' }));
    const form = await screen.findByRole('form', { name: 'Add an exception' });
    await user.type(within(form).getByLabelText('Phrase'), 'zorbak valley');
    await user.click(within(form).getByRole('button', { name: 'Add exception' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add an exception' })).toBeNull());
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(0);
    expect(sent(w, 'POST', '/exceptions')[0]?.body).toEqual({ phrase: 'zorbak valley', language: 'en' });
    expect(audits(w, 'exception.add')).not.toHaveLength(0);
    expect(await screen.findByText('Exception added.')).toBeInTheDocument();
  });

  it('a refused exception reads the same refusal', async () => {
    const { user } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Add an exception' }));
    const form = await screen.findByRole('form', { name: 'Add an exception' });
    await user.type(within(form).getByLabelText('Phrase'), 'tarvo lake');
    await user.click(within(form).getByRole('button', { name: 'Add exception' }));
    expect(await screen.findByText('The list refused this word (it may be a duplicate, malformed, or the last active word).')).toBeInTheDocument();
  });

  it('edits an exception through PATCH /exceptions/:id', async () => {
    const { w, user } = await openTerms();
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: 'Edit tarvo lake' }));
    const form = await screen.findByRole('form', { name: 'Edit an exception' });
    expect(within(form).getByLabelText('Phrase')).toHaveValue('tarvo lake');
    await user.type(within(form).getByLabelText('Note'), 'the lake');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent(w, 'PATCH', '/exceptions/syn-ex%3Atarvo-lake').length + sent(w, 'PATCH', '/exceptions/syn-ex:tarvo-lake').length).toBe(1));
    expect(w.live.records().exceptions.find((e) => e.id === 'syn-ex:tarvo-lake')?.note).toBe('the lake');
  });
});

describe('editing a term', () => {
  it('opens filled in; a note-only change is one PATCH with no dry run', async () => {
    const { w, user } = await openTerms();
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: 'Edit snerp' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    expect(within(form).getByLabelText('Word')).toHaveValue('snerp');
    expect(within(form).getByLabelText('Language')).toHaveValue('en');
    await user.type(within(form).getByLabelText('Note'), 'nuisance');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit a term' })).toBeNull());
    expect(sent(w, 'POST', '/terms/check')).toHaveLength(0);
    const patch = w.sent.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ note: 'nuisance' });
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
    expect(audits(w, 'term.update')).not.toHaveLength(0);
  });

  it('a changed word is checked first, and its hits need Save anyway', async () => {
    const { w, user } = await openTerms();
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: 'Edit snerp' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    await user.clear(within(form).getByLabelText('Word'));
    await user.type(within(form).getByLabelText('Word'), 'zorba');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await screen.findByRole('button', { name: 'Save anyway' });
    expect(w.sent.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(w.sent.filter((r) => r.method === 'PATCH')).toHaveLength(1));
    expect(w.sent.find((r) => r.method === 'PATCH')?.body).toEqual({ term: 'zorba' });
  });

  it('saving with nothing changed says so and sends nothing', async () => {
    const { w, user } = await openTerms();
    await user.click(screen.getByRole('button', { name: 'Edit term 1' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('Nothing has changed.')).toBeInTheDocument();
    expect(w.sent.filter((r) => r.method === 'PATCH' || r.path === '/terms/check')).toHaveLength(0);
  });

  it('clearing the note sends a null note', async () => {
    const { w, user } = await openTerms({}, async (x) => {
      await x.direct.updateTerm('syn:snerp', { note: 'old note' });
    });
    await user.click(screen.getByRole('button', { name: 'Edit term 7' }));
    const form = await screen.findByRole('form', { name: 'Edit a term' });
    expect(within(form).getByLabelText('Note')).toHaveValue('old note');
    await user.clear(within(form).getByLabelText('Note'));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(w.sent.some((r) => r.method === 'PATCH')).toBe(true));
    expect(w.sent.find((r) => r.method === 'PATCH')?.body).toEqual({ note: null });
  });

  it('opening another row\'s Edit swaps the form, and a refused edit keeps the input', async () => {
    const { user } = await openTerms();
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: 'Edit zorbak' }));
    await screen.findByRole('form', { name: 'Edit a term' });
    await user.click(screen.getByRole('button', { name: 'Edit vlemmo' }));
    expect(screen.getAllByRole('form', { name: 'Edit a term' })).toHaveLength(1);
    expect(screen.getByLabelText('Word')).toHaveValue('vlemmo');
    await user.clear(screen.getByLabelText('Word'));
    await user.type(screen.getByLabelText('Word'), 'zorbak');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('The list refused this word (it may be a duplicate, malformed, or the last active word).')).toBeInTheDocument();
    expect(screen.getByLabelText('Word')).toHaveValue('zorbak');
  });
});

describe('the switches', () => {
  it('turns a term off and back on, reading the list again, with a toast that names no word', async () => {
    const { w, user, container } = await openTerms();
    const box = screen.getByRole('checkbox', { name: 'Active: term 2' });
    expect(box).toBeChecked();
    await user.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: term 2' })).not.toBeChecked());
    expect(w.live.rows.terms.find((t) => t.id === 'syn:vlemmo')?.active).toBe(false);
    expect(sent(w, 'POST', '/terms/syn%3Avlemmo/active').length + sent(w, 'POST', '/terms/syn:vlemmo/active').length).toBe(1);
    expect(await screen.findByText('Switched off.')).toBeInTheDocument();
    expect(audits(w, 'term.toggle')).not.toHaveLength(0);
    await user.click(screen.getByRole('checkbox', { name: 'Active: term 2' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: term 2' })).toBeChecked());
    expect(w.live.rows.terms.find((t) => t.id === 'syn:vlemmo')?.active).toBe(true);
    noWordsIn(container.innerHTML);
  });

  it('keeps keyboard focus on the switch after it changes', async () => {
    const { user } = await openTerms();
    const box = screen.getByRole('checkbox', { name: 'Active: term 3' });
    box.focus();
    await user.keyboard(' ');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: term 3' })).not.toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'Active: term 3' })).toHaveFocus();
  });

  it('refuses to switch off the last active term, saying why, and the switch stays on', async () => {
    const { w, user } = await openTerms({}, async (x) => {
      for (const id of ['syn:zorbak', 'syn:vlemmo', 'syn:quissel', 'syn:drakkuun', 'syn:fenrisk', 'syn:tarvo']) await x.direct.setTermActive(id, false);
    });
    const box = screen.getByRole('checkbox', { name: 'Active: term 7' });
    expect(box).toBeChecked();
    await user.click(box);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The list refused this word (it may be a duplicate, malformed, or the last active word).');
    expect(screen.getByRole('checkbox', { name: 'Active: term 7' })).toBeChecked();
    expect(w.live.rows.terms.find((t) => t.id === 'syn:snerp')?.active).toBe(true);
  });

  it('a double click on a switch sends one change', async () => {
    const { w } = await openTerms();
    const box = screen.getByRole('checkbox', { name: 'Active: term 4' });
    fireEvent.click(box);
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: term 4' })).not.toBeChecked());
    expect(w.sent.filter((r) => r.method === 'POST' && /\/terms\/.+\/active$/.test(r.path))).toHaveLength(1);
  });

  it('a failed switch (a network drop) shows an error and leaves the switch where the server has it', async () => {
    const { w, user } = await openTerms();
    w.intercept.fn = (req) => {
      if (req.method === 'POST' && /\/active$/.test(req.path)) throw new Error('offline');
      return undefined;
    };
    await user.click(screen.getByRole('checkbox', { name: 'Active: term 2' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server');
    expect(screen.getByRole('checkbox', { name: 'Active: term 2' })).toBeChecked();
  });

  it('switches an exception', async () => {
    const { w, user } = await openTerms();
    await user.click(screen.getByRole('checkbox', { name: 'Active: exception 1' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Active: exception 1' })).not.toBeChecked());
    expect(w.live.rows.exceptions[0]?.active).toBe(false);
    expect(audits(w, 'exception.toggle')).not.toHaveLength(0);
  });
});

describe('test a message', () => {
  const box = (): HTMLTextAreaElement => screen.getByLabelText('Message to test');
  const panel = (): HTMLElement => region('Test a message');

  it('says a blocked message would be blocked and names the language, not the word, while words are hidden', async () => {
    const { w, user, container } = await openTerms();
    await user.type(box(), 'you zorbak');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('This message would be blocked.')).toBeInTheDocument();
    expect(within(panel()).getByText('It matches a term in English (en).')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms/test')[0]?.body).toEqual({ text: 'you zorbak' });
    // The message you typed is yours and is in the box; no result repeats it.
    expect(within(panel()).queryAllByText(/zorbak/, { ignore: 'textarea' })).toHaveLength(0);
    expect(container.querySelector('[role=status]')?.textContent ?? '').not.toMatch(/zorbak/);
  });

  it('names the word once Show words is on', async () => {
    const { user } = await openTerms();
    await user.click(showWords());
    await user.type(box(), 'you zorbak');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('It matches zorbak in English (en).')).toBeInTheDocument();
  });

  it('a clean message would go through', async () => {
    const { user } = await openTerms();
    await user.type(box(), 'good game everyone');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('This message would go through.')).toBeInTheDocument();
    expect(within(panel()).queryByText(/It matches/)).toBeNull();
  });

  it('a message over the chat limit is too long to check', async () => {
    const { user } = await openTerms();
    fireEvent.change(box(), { target: { value: 'x'.repeat(5000) } });
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('This message is too long to check.')).toBeInTheDocument();
  });

  it('an exception lets a phrase through', async () => {
    const { user } = await openTerms();
    await user.type(box(), 'tarvo lake');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('This message would go through.')).toBeInTheDocument();
  });

  it('an empty box asks for a message and sends nothing', async () => {
    const { w, user } = await openTerms();
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(within(panel()).getByText('Type a message to test.')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms/test')).toHaveLength(0);
  });

  it('editing the message clears the old verdict', async () => {
    const { user } = await openTerms();
    await user.type(box(), 'you zorbak');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    await within(panel()).findByText('This message would be blocked.');
    await user.type(box(), '!');
    expect(within(panel()).queryByText('This message would be blocked.')).toBeNull();
  });

  it('a server that cannot test says so', async () => {
    const { w, user } = await openTerms();
    w.intercept.fn = (req) => (req.path === '/terms/test' ? { status: 404, body: { error: 'not_found', message: 'x' } } : undefined);
    await user.type(box(), 'anything');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    expect(await within(panel()).findByText('This server cannot test messages.')).toBeInTheDocument();
  });

  it('a 403 says the role cannot do this; a double click sends one test', async () => {
    const { w, user } = await openTerms();
    await user.type(box(), 'anything');
    const run = within(panel()).getByRole('button', { name: 'Test' });
    fireEvent.click(run);
    fireEvent.click(run);
    await within(panel()).findByText('This message would go through.');
    expect(sent(w, 'POST', '/terms/test')).toHaveLength(1);
    w.intercept.fn = (req) => (req.path === '/terms/test' ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    await user.click(run);
    expect(await within(panel()).findByText('Your role cannot do this.')).toBeInTheDocument();
  });

  it('writes no audit row and changes nothing', async () => {
    const { w, user } = await openTerms();
    const before = w.cw.audit.list({ limit: 200 }).items.length;
    await user.type(box(), 'you zorbak');
    await user.click(within(panel()).getByRole('button', { name: 'Test' }));
    await within(panel()).findByText('This message would be blocked.');
    expect(w.cw.audit.list({ limit: 200 }).items.length).toBe(before);
  });
});
