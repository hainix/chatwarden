import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { DAY, hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The Blocked screen: the lines the term filter refused, over 1, 7 or 30 days. Words and terms are masked until shown; opening the
// list writes one `blocked.view` row, and showing a word never reads again. Against the real routes; synthetic words only.

const WORDS = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];
const audits = (w: HubWorld, action: string): unknown[] => w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === action);
const blockedReads = (w: HubWorld): TransportRequest[] => w.sent.filter((r) => r.method === 'GET' && r.path === '/blocked');
const list = (): HTMLElement => screen.getByRole('region', { name: 'Blocked lines' });
const bodyRows = (): HTMLElement[] => within(list()).getAllByRole('row').slice(1);
const SERVER_500 = { status: 500, body: { error: 'internal', message: 'x' } };

function noWordsIn(html: string): void {
  const lower = html.toLowerCase();
  for (const word of WORDS) expect(lower, `the word ${word} is in the page`).not.toContain(word);
}

async function openBlocked(options: WorldOptions = {}, prepare?: (w: HubWorld) => unknown, path = '/blocked') {
  const w = await hubWorld(options);
  await prepare?.(w);
  const r = renderHub(w, { path });
  await screen.findByRole('heading', { level: 2, name: 'Blocked' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return { w, ...r };
}

const seed = (w: HubWorld) => {
  const a = w.blockLine('Vantablob', 'you zorbak, learn to rotate');
  const b = w.blockLine('Kestrel', 'you vlemmo');
  const c = w.blockLine('Vantablob', 'fenrisk team');
  return { a, b, c };
};

describe('the list', () => {
  it('shows the last 7 days by default, newest first, with the person tag, room, and a count', async () => {
    const { w } = await openBlocked({}, seed);
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(blockedReads(w)[0]?.query).toEqual({ days: 7 });
    expect(screen.getByText('3 blocked lines')).toBeInTheDocument();
    const rows = bodyRows();
    expect(rows).toHaveLength(3);
    expect(within(list()).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Time', 'Person', 'Room', 'Term', 'Blocked text', 'Actions']);
    const items = w.cw.blocked.list({ days: 7 });
    expect(items).toHaveLength(3);
    // Newest first, as the kit sends them.
    expect(rows[0]).toHaveTextContent(items[0]!.person.slice(0, 8));
    expect(rows[0]).toHaveTextContent(items[0]!.roomId);
  });

  it('shows the person as the 8-character tag, a link to their page, and never the whole ref', async () => {
    const { w, container, router, user } = await openBlocked({}, seed);
    const person = w.cw.blocked.list({ days: 7 })[0]!.person;
    expect(person.length).toBeGreaterThan(8);
    const link = within(bodyRows()[0]!).getByRole('link');
    expect(link).toHaveTextContent(person.slice(0, 8));
    // The address carries the ref the server route needs (README, Security notes); the page text never does.
    expect(container.textContent).not.toContain(person);
    await user.click(link);
    expect(router.path).toBe(`/people/${person}`);
  });

  it('says one line in the singular, and an empty window plainly', async () => {
    await openBlocked({}, (w) => void w.blockLine('Vantablob', 'zorbak'));
    expect(screen.getByText('1 blocked line')).toBeInTheDocument();
  });

  it('an empty list says nothing was blocked and draws no table', async () => {
    await openBlocked();
    expect(screen.getByText('Nothing was blocked in this time.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Blocked lines' })).toBeNull();
  });

  it('1, 7 and 30 days ask for that window, and an old line is only in the wider windows', async () => {
    const { w, user } = await openBlocked({}, (x) => {
      x.blockLine('Vantablob', 'zorbak long ago');
      x.clock.t += 3 * DAY;
      x.blockLine('Kestrel', 'vlemmo today');
    });
    expect(screen.getByText('2 blocked lines')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Last 24 hours' }));
    await screen.findByText('1 blocked line');
    expect(blockedReads(w).map((r) => r.query?.days)).toEqual([7, 1]);
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await screen.findByText('2 blocked lines');
    expect(blockedReads(w).map((r) => r.query?.days)).toEqual([7, 1, 30]);
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a window with nothing says so', async () => {
    const { user } = await openBlocked({}, (x) => {
      x.blockLine('Vantablob', 'zorbak long ago');
      x.clock.t += 3 * DAY;
    });
    await user.click(screen.getByRole('button', { name: 'Last 24 hours' }));
    expect(await screen.findByText('Nothing was blocked in this time.')).toBeInTheDocument();
  });

  it('a list at the server\'s limit says only the newest are listed', async () => {
    const w = await hubWorld();
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `b${i}`, at: w.now() - i, roomId: 'r', termId: 'syn:zorbak', term: 'zorbak', language: 'en', person: `s_person_${i}_xxxxxxxx`, text: 'zorbak' }));
    w.intercept.fn = (req) => (req.path === '/blocked' ? { status: 200, body: { items } } : undefined);
    renderHub(w, { path: '/blocked' });
    expect(await screen.findByText(/Only the newest 500 are listed\./)).toBeInTheDocument();
  });

  it('draws the table in its own scroll box', async () => {
    await openBlocked({}, seed);
    expect(list()).toHaveClass('cw-scroll');
  });
});

describe('hiding the words', () => {
  it('no blocked word, term or id reaches the page before it is shown', async () => {
    const { container } = await openBlocked({}, seed);
    expect(bodyRows()).toHaveLength(3);
    noWordsIn(container.innerHTML);
    // Two masks a row: the term and the text.
    expect(within(list()).getAllByText('Blocked words, hidden')).toHaveLength(6);
  });

  it('Show on one row shows that row\'s term and text and no other row\'s, without a new read', async () => {
    const { w, user, container } = await openBlocked({}, seed);
    const reads = blockedReads(w).length;
    const rows = bodyRows();
    await user.click(within(rows[0]!).getByRole('button', { name: /^Show the blocked line from/ }));
    expect(within(bodyRows()[0]!).getByText('fenrisk team')).toBeInTheDocument();
    expect(within(bodyRows()[0]!).getByText('fenrisk')).toBeInTheDocument();
    expect(within(bodyRows()[1]!).queryByText(/vlemmo/)).toBeNull();
    expect(container.innerHTML).not.toContain('vlemmo');
    expect(container.innerHTML).not.toContain('you zorbak');
    expect(blockedReads(w)).toHaveLength(reads);
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Hide the blocked line from/ }));
    noWordsIn(container.innerHTML);
  });

  it('Show blocked words shows every row, drops the per-row buttons, and Hide puts them back; no read in between', async () => {
    const { w, user, container } = await openBlocked({}, seed);
    const reads = blockedReads(w).length;
    const all = screen.getByRole('checkbox', { name: 'Show blocked words' });
    expect(all).not.toBeChecked();
    await user.click(all);
    for (const text of ['you zorbak, learn to rotate', 'you vlemmo', 'fenrisk team']) expect(within(list()).getByText(text)).toBeInTheDocument();
    expect(within(list()).queryAllByRole('button', { name: /^Show the blocked line/ })).toHaveLength(0);
    expect(within(list()).getAllByText('zorbak').length + within(list()).getAllByText('vlemmo').length).toBeGreaterThan(0);
    await user.click(all);
    noWordsIn(container.innerHTML);
    expect(within(list()).getAllByRole('button', { name: /^Show the blocked line/ })).toHaveLength(3);
    expect(blockedReads(w)).toHaveLength(reads);
    expect(audits(w, 'blocked.view')).toHaveLength(1);
  });

  it('the Show blocked words choice stays for the screen when the window changes', async () => {
    const { user, container } = await openBlocked({}, seed);
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await screen.findByText('3 blocked lines');
    expect(screen.getByRole('checkbox', { name: 'Show blocked words' })).toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    noWordsIn(container.innerHTML);
  });

  it('a role without terms.read sees no term at all, and the text is still masked', async () => {
    const { container } = await openBlocked({ permissions: { 'terms.read': 'owner' } }, seed);
    expect(within(list()).getAllByText('Not available')).toHaveLength(3);
    noWordsIn(container.innerHTML);
    expect(within(list()).getAllByText('Blocked words, hidden')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /^View the term/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add an exception/ })).toBeNull();
  });
});

describe('what opening it costs', () => {
  it('opening writes exactly one blocked.view; each change of window writes one more; Show never does', async () => {
    const { w, user } = await openBlocked({}, seed);
    expect(audits(w, 'blocked.view')).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    expect(audits(w, 'blocked.view')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Last 24 hours' }));
    await screen.findByText(/blocked lines?|Nothing was blocked/);
    await waitFor(() => expect(audits(w, 'blocked.view')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    await waitFor(() => expect(audits(w, 'blocked.view')).toHaveLength(3));
    // Pressing the window already showing does not read again.
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    expect(audits(w, 'blocked.view')).toHaveLength(3);
    expect(blockedReads(w)).toHaveLength(3);
  });

  it('a double click on a window button reads once', async () => {
    const { w } = await openBlocked({}, seed);
    const day = screen.getByRole('button', { name: 'Last 24 hours' });
    fireEvent.click(day);
    fireEvent.click(day);
    await waitFor(() => expect(blockedReads(w)).toHaveLength(2));
    expect(audits(w, 'blocked.view')).toHaveLength(2);
  });

  it('opening reads no other audited thing (no report, record or rules)', async () => {
    const { w } = await openBlocked({}, seed);
    for (const other of ['policy.view', 'history.view']) expect(audits(w, other), other).toHaveLength(0);
    expect(audits(w, 'report.view').filter((r) => (r as { target?: unknown }).target !== undefined)).toHaveLength(0);
  });
});

describe('when it cannot be shown', () => {
  it('a 403 says so plainly with Try again, which reads once more', async () => {
    const w = await hubWorld();
    let n = 0;
    w.intercept.fn = (req) => (req.path === '/blocked' && ++n === 1 ? { status: 403, body: { error: 'forbidden', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: '/blocked' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the blocked lines. Your role cannot do this.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing was blocked in this time.')).toBeInTheDocument();
    expect(blockedReads(w)).toHaveLength(2);
  });

  it('a 500 says the server had a problem', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.path === '/blocked' ? SERVER_500 : undefined);
    renderHub(w, { path: '/blocked' });
    expect(await screen.findByText(/The server had a problem/)).toBeInTheDocument();
  });

  it('a role that cannot read blocked lines gets the "not available" page, reads nothing and writes no audit row', async () => {
    const w = await hubWorld({ permissions: { 'blocked.read': 'owner' } });
    renderHub(w, { path: '/blocked' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Not available for your role' })).toBeInTheDocument();
    expect(blockedReads(w)).toHaveLength(0);
    expect(audits(w, 'blocked.view')).toHaveLength(0);
  });
});

describe('from a blocked line to the terms', () => {
  it('Add exception opens the exception form on Terms, filled in with the line and its language, and no text is in the address', async () => {
    const { w, user, router, container } = await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you zorbak lake'));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Add an exception for the line from/ }));
    const form = await screen.findByRole('form', { name: 'Add an exception' });
    expect(router.path).toBe('/terms');
    // The line is held but not shown: a mask and a Show button for this form, and no word anywhere in the markup.
    expect(within(form).queryByLabelText('Phrase')).toBeNull();
    expect(within(form).getByText('Blocked words, hidden')).toBeInTheDocument();
    noWordsIn(container.innerHTML);
    expect(screen.getByRole('checkbox', { name: 'Show words' })).not.toBeChecked();
    await user.click(within(form).getByRole('button', { name: 'Show the phrase in this form' }));
    // Showing it in the form is not the screen's Show words.
    expect(screen.getByRole('checkbox', { name: 'Show words' })).not.toBeChecked();
    expect(within(form).getByLabelText('Phrase')).toHaveValue('you zorbak lake');
    expect(within(form).getByLabelText('Language')).toHaveValue('en');
    expect(screen.getByText('Filled in from a blocked line. Cut it down to the phrase that should be allowed.')).toBeInTheDocument();
    expect(w.sent.filter((r) => r.method === 'POST')).not.toContainEqual(expect.objectContaining({ path: '/exceptions' }));
  });

  it('saving the prefilled form adds the exception once', async () => {
    const { w, user } = await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you zorbak lake'));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Add an exception for the line from/ }));
    const form = await screen.findByRole('form', { name: 'Add an exception' });
    await user.click(within(form).getByRole('button', { name: 'Show the phrase in this form' }));
    const phrase = within(form).getByLabelText('Phrase');
    fireEvent.change(phrase, { target: { value: 'zorbak lake' } });
    await user.click(within(form).getByRole('button', { name: 'Add exception' }));
    await waitFor(() => expect(w.sent.filter((r) => r.method === 'POST' && r.path === '/exceptions')).toHaveLength(1));
    expect(w.live.rows.exceptions.some((e) => e.phrase === 'zorbak lake')).toBe(true);
  });

  it('the prefilled line can be saved as it is without ever showing it, and the word is in no label, toast or address', async () => {
    const { w, user, router, container } = await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you zorbak lake'));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Add an exception for the line from/ }));
    const form = await screen.findByRole('form', { name: 'Add an exception' });
    await user.click(within(form).getByRole('button', { name: 'Add exception' }));
    await waitFor(() => expect(w.sent.filter((r) => r.method === 'POST' && r.path === '/exceptions')).toHaveLength(1));
    expect(w.sent.find((r) => r.path === '/exceptions')?.body).toEqual({ phrase: 'you zorbak lake', language: 'en' });
    expect(await screen.findByText('Exception added.')).toBeInTheDocument();
    expect(router.path).toBe('/terms');
    noWordsIn(container.innerHTML);
  });

  it('with Show words on, the prefilled form shows its phrase at once', async () => {
    const { user } = await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you zorbak lake'));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Add an exception for the line from/ }));
    await screen.findByRole('form', { name: 'Add an exception' });
    await user.click(screen.getByRole('checkbox', { name: 'Show words' }));
    expect(within(screen.getByRole('form', { name: 'Add an exception' })).getByLabelText('Phrase')).toHaveValue('you zorbak lake');
  });

  it('a line over 200 characters is cut to what the server accepts', async () => {
    const w = await hubWorld();
    const items = [{ id: 'b1', at: w.now(), roomId: 'r', termId: 'syn:zorbak', term: 'zorbak', language: 'en', person: 's_person_xxxxxxxxxxxx', text: `zorbak ${'y'.repeat(300)}` }];
    w.intercept.fn = (req) => (req.path === '/blocked' ? { status: 200, body: { items } } : undefined);
    const { user } = renderHub(w, { path: '/blocked' });
    await user.click(await screen.findByRole('button', { name: /^Add an exception for the line from/ }));
    const form = await screen.findByRole('form', { name: 'Add an exception' });
    await user.click(within(form).getByRole('button', { name: 'Show the phrase in this form' }));
    expect((within(form).getByLabelText('Phrase') as HTMLInputElement).value).toHaveLength(200);
  });

  it('the form is not reopened the next time Terms is opened', async () => {
    const { user } = await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you zorbak lake'));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^Add an exception for the line from/ }));
    await screen.findByRole('form', { name: 'Add an exception' });
    await user.click(screen.getByRole('link', { name: 'Blocked' }));
    await screen.findByRole('region', { name: 'Blocked lines' });
    await user.click(screen.getByRole('link', { name: 'Terms' }));
    await screen.findByRole('region', { name: /^English/ });
    expect(screen.queryByRole('form', { name: 'Add an exception' })).toBeNull();
  });

  it('View term opens Terms with that term marked, its word still hidden', async () => {
    const { user, router } = await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you fenrisk'));
    await user.click(within(bodyRows()[0]!).getByRole('button', { name: /^View the term for the line from/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Terms' })).toBeInTheDocument();
    expect(router.path).toBe('/terms');
    const tag = await screen.findByText('From the blocked list');
    const row = tag.closest('tr') as HTMLElement;
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveFocus();
    expect(within(row).queryByText('fenrisk')).toBeNull();
    expect(within(row).getByText('Blocked words, hidden')).toBeInTheDocument();
    expect(screen.getAllByText('From the blocked list')).toHaveLength(1);
  });

  it('a role that may not write terms is offered View term but not Add exception', async () => {
    await openBlocked({ permissions: { 'terms.write': 'owner' } }, (x) => void x.blockLine('Vantablob', 'zorbak'));
    expect(screen.getByRole('button', { name: /^View the term/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add an exception/ })).toBeNull();
  });
});
