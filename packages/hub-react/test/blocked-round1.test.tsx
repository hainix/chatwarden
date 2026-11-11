import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Blocked, fix round 1: who typed a line (handle then tag), labels that tell two rows apart, and where each button sits.

const list = (): HTMLElement => screen.getByRole('region', { name: 'Blocked lines' });
const bodyRows = (): HTMLElement[] => within(list()).getAllByRole('row').slice(1);

async function openBlocked(options: WorldOptions = {}, prepare?: (w: HubWorld) => unknown) {
  const w = await hubWorld(options);
  await prepare?.(w);
  const r = renderHub(w, { path: '/blocked' });
  await screen.findByRole('heading', { level: 2, name: 'Blocked' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return { w, ...r };
}

describe('who typed it', () => {
  it('names the person by their handle and then the tag when a report names them, and by the tag alone when none does', async () => {
    const { w } = await openBlocked({}, async (x) => {
      await x.file({ target: 'Vantablob' });
      x.blockLine('Vantablob', 'you zorbak', undefined, 'key-target-Vantablob');
      x.blockLine('Stranger', 'fenrisk team');
    });
    const items = w.cw.blocked.list({ days: 7 });
    const tag = items.find((i) => i.text === 'you zorbak')!.person.slice(0, 8);
    const named = bodyRows().find((r) => r.textContent?.includes('Vantablob'))!;
    expect(within(named).getByText('Vantablob')).toHaveClass('cw-arow-who');
    expect(within(named).getByRole('link').textContent).toContain(tag);
    expect(named.textContent).toMatch(new RegExp(`Vantablob.*${tag}`));
    const unnamed = bodyRows().find((r) => !r.textContent?.includes('Vantablob'))!;
    expect(within(unnamed).queryByText('Stranger')).toBeNull();
    expect(unnamed.querySelector('.cw-arow-who')).toBeNull();
    expect(unnamed.textContent).toContain(items.find((i) => i.text === 'fenrisk team')!.person.slice(0, 8));
  });

  it('a role without history.read is sent no handle, so only the tag shows', async () => {
    await openBlocked({ permissions: { 'history.read': 'owner' } }, async (x) => {
      await x.file({ target: 'Vantablob' });
      x.blockLine('Vantablob', 'you zorbak', undefined, 'key-target-Vantablob');
    });
    expect(document.querySelector('.cw-blocked-table .cw-arow-who')).toBeNull();
  });

  it('a handle is text and breaks instead of widening the table: it is never a link target of its own', async () => {
    const w = await hubWorld();
    const items = [{ id: 'b1', at: w.now(), roomId: 'r', termId: 'syn:zorbak', term: 'zorbak', language: 'en', person: 's_person_xxxxxxxxxxxx', handle: '<b>x</b>'.repeat(30), text: 'zorbak' }];
    w.intercept.fn = (req) => (req.path === '/blocked' ? { status: 200, body: { items } } : undefined);
    renderHub(w, { path: '/blocked' });
    await screen.findByRole('region', { name: 'Blocked lines' });
    expect(list().querySelector('b')).toBeNull();
    expect(list().querySelectorAll('a')).toHaveLength(1);
  });
});

describe('labels and places', () => {
  it('every row has its own label on each button, even for two lines in the same minute: the time and the room', async () => {
    await openBlocked({}, (x) => {
      x.blockLine('Vantablob', 'you zorbak', 'room-alpha');
      x.blockLine('Kestrel', 'a vlemmo', 'room-beta');
    });
    for (const kind of [/^Show the blocked line from/, /^Add an exception for the line from/, /^View the term for the line from/]) {
      const labels = within(list()).getAllByRole('button', { name: kind }).map((b) => b.getAttribute('aria-label'));
      expect(labels, String(kind)).toHaveLength(2);
      expect(new Set(labels).size).toBe(2);
      expect(labels.join(' ')).toMatch(/room-alpha/);
      expect(labels.join(' ')).toMatch(/room-beta/);
    }
  });

  it('after Show, the Hide label names the same room', async () => {
    const { user } = await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you zorbak', 'room-alpha'));
    await user.click(within(list()).getByRole('button', { name: /^Show the blocked line from .* in room-alpha$/ }));
    expect(within(list()).getByRole('button', { name: /^Hide the blocked line from .* in room-alpha$/ })).toBeInTheDocument();
  });

  it('a line with no room is labelled by its time alone', async () => {
    const w = await hubWorld();
    const items = [{ id: 'b1', at: w.now(), roomId: '', termId: 'syn:zorbak', term: 'zorbak', language: 'en', person: 's_person_xxxxxxxxxxxx', handle: null, text: 'zorbak' }];
    w.intercept.fn = (req) => (req.path === '/blocked' ? { status: 200, body: { items } } : undefined);
    renderHub(w, { path: '/blocked' });
    const button = await screen.findByRole('button', { name: /^Show the blocked line from/ });
    expect(button.getAttribute('aria-label')).not.toMatch(/ in /);
  });

  it('Show sits in the text cell beside the masked text, and the actions cell holds only Add exception and View term, as text buttons on one line', async () => {
    await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you zorbak'));
    const cells = within(bodyRows()[0]!).getAllByRole('cell');
    const textCell = cells[4]!;
    const actions = cells[5]!;
    expect(within(textCell).getByText('Blocked words, hidden')).toBeInTheDocument();
    expect(within(textCell).getByRole('button', { name: /^Show the blocked line/ })).toBeInTheDocument();
    expect(within(actions).queryByRole('button', { name: /^Show the blocked line/ })).toBeNull();
    expect(within(actions).getAllByRole('button').map((b) => b.textContent)).toEqual(['Add exception', 'View term']);
    for (const b of within(actions).getAllByRole('button')) expect(b).toHaveClass('cw-linkbtn');
    expect(actions.querySelectorAll('.cw-row-actions')).toHaveLength(1);
  });

  it('with Show blocked words on, the text cell has no per-row Show and the actions stay', async () => {
    const { user } = await openBlocked({}, (x) => void x.blockLine('Vantablob', 'you zorbak'));
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    const cells = within(bodyRows()[0]!).getAllByRole('cell');
    expect(within(cells[4]!).queryByRole('button')).toBeNull();
    expect(within(cells[4]!).getByText('you zorbak')).toBeInTheDocument();
    expect(within(cells[5]!).getAllByRole('button')).toHaveLength(2);
  });
});
