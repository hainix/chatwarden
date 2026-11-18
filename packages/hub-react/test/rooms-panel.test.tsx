import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { HOUR, MINUTE, hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > Advanced > "Rooms" (design 9 and 16): the rooms this server knows, a labelled radio group per room (Normal, Locked, Emergency), a duration for the two that restrict, the
// expiry as a time, the plain "This server only" line and the cap. A mode is never a sanction and always ends by itself. Real routes, real kit.

afterEach(() => cleanup());

const time = (at: number): string => new Intl.DateTimeFormat('en', { timeStyle: 'short' }).format(at);

async function lobby(options: WorldOptions = {}) {
  const w = await hubWorld(options);
  await w.file({ room: 'lobby-1', target: 'Mallory', reporter: 'Rhea' });
  await w.file({ room: 'lobby-2', target: 'Quissel', reporter: 'Tarvo' });
  return w;
}
async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Rooms' });
  await screen.findByRole('group', { name: 'Mode for lobby-1' });
  return r;
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Rooms' });
const room = (id: string): HTMLElement => within(panel()).getByRole('group', { name: `Mode for ${id}` });
const radio = (id: string, mode: 'Normal' | 'Locked' | 'Emergency'): HTMLInputElement => within(room(id)).getByRole('radio', { name: mode }) as HTMLInputElement;
const modePosts = (w: HubWorld) => w.sent.filter((r) => r.method === 'POST' && /^\/rooms\/[^/]+\/mode$/.test(r.path));

describe('the list', () => {
  it('lists the rooms with a labelled radio group each, and shows no seat id, handle or key', async () => {
    const w = await lobby();
    await open(w);
    // one labelled radio group per room, named for it (the names are what a screen reader announces: nothing of a seat or a player)
    expect(within(panel()).getAllByRole('group', { name: /^Mode for / }).map((g) => g.getAttribute('aria-label') ?? g.querySelector('legend')?.textContent).sort()).toEqual(['Mode for lobby-1', 'Mode for lobby-2']);
    for (const id of ['lobby-1', 'lobby-2']) {
      expect(within(room(id)).getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['Normal', 'Locked', 'Emergency']);
      expect(radio(id, 'Normal')).toBeChecked();
    }
    expect(within(room('lobby-1')).getByText('2 players seated')).toBeInTheDocument();
    const text = panel().textContent ?? '';
    for (const forbidden of ['Mallory', 'Quissel', 'Rhea', 'Tarvo', 'p1', 'p2', 'key-']) expect(text, forbidden).not.toContain(forbidden);
  });

  it('says in words when no room is known, and shows nothing to set', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('region', { name: 'Rooms' });
    expect(await within(panel()).findByText('No rooms are known to this server right now.')).toBeInTheDocument();
    expect(within(panel()).queryAllByRole('radio')).toEqual([]);
  });

  it('says it is this server only, and that a mode ends by itself, always', async () => {
    const w = await lobby();
    await open(w);
    expect(within(panel()).getByText(/This server only\./)).toBeInTheDocument();
    expect(within(panel()).getByText(/ends by itself/)).toBeInTheDocument();
  });

  it('shows the capped note at 500 rooms and not at 499', async () => {
    const w = await hubWorld();
    const many = (n: number) => ({ status: 200, body: { rooms: Array.from({ length: n }, (_, i) => ({ roomId: `r${i}`, tags: {}, seated: 1, mode: 'normal', until: null })) } });
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/rooms' ? many(499) : undefined);
    const a = renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('group', { name: 'Mode for r0' });
    expect(within(panel()).queryByText(/500 rooms/)).toBeNull();
    a.unmount();
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/rooms' ? many(500) : undefined);
    renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('group', { name: 'Mode for r0' });
    expect(within(panel()).getByText('Showing the 500 rooms with most players. Others are not listed.')).toBeInTheDocument();
  });

  it('a room id is text: markup in it is never made into markup', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/rooms' ? { status: 200, body: { rooms: [{ roomId: '<img src=x onerror=alert(1)>', tags: { map: '<b>x</b>' }, seated: 1, mode: 'normal', until: null }] } } : undefined);
    renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('group', { name: 'Mode for <img src=x onerror=alert(1)>' });
    expect(panel().querySelector('img, b')).toBeNull();
  });
});

describe('choosing a mode', () => {
  it('Locked asks for a duration (15 minutes, 30 minutes by default, 1 hour, 4 hours) and sends it on confirm', async () => {
    const w = await lobby();
    const { user } = await open(w);
    await user.click(radio('lobby-1', 'Locked'));
    const select = within(room('lobby-1')).getByRole('combobox', { name: 'How long' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['15 minutes', '30 minutes', '1 hour', '4 hours']);
    expect(select).toHaveValue('1800000');
    await user.selectOptions(select, '1 hour');
    await user.click(within(room('lobby-1')).getByRole('button', { name: 'Lock the room' }));
    await waitFor(() => expect(modePosts(w)).toHaveLength(1));
    expect(modePosts(w)[0]?.path).toBe('/rooms/lobby-1/mode');
    expect(modePosts(w)[0]?.body).toEqual({ mode: 'locked', forMs: HOUR });
    await waitFor(() => expect(radio('lobby-1', 'Locked')).toBeChecked());
    expect(within(room('lobby-1')).getByText(`Locked until ${time(w.now() + HOUR)}`)).toBeInTheDocument();
    // The kit really holds it.
    expect(w.cw.rooms.mode('lobby-1').mode).toBe('locked');
  });

  it('Emergency asks for a duration too, and says what it does in one line', async () => {
    const w = await lobby();
    const { user } = await open(w);
    await user.click(radio('lobby-2', 'Emergency'));
    expect(within(room('lobby-2')).getByText(/Slow mode is on and new accounts can only read/)).toBeInTheDocument();
    await user.click(within(room('lobby-2')).getByRole('button', { name: 'Start emergency mode' }));
    await waitFor(() => expect(modePosts(w)).toHaveLength(1));
    expect(modePosts(w)[0]?.body).toEqual({ mode: 'emergency', forMs: 30 * MINUTE });
    await waitFor(() => expect(radio('lobby-2', 'Emergency')).toBeChecked());
  });

  it('Cancel changes nothing: no request, the control is back on what it was', async () => {
    const w = await lobby();
    const { user } = await open(w);
    await user.click(radio('lobby-1', 'Locked'));
    await user.click(within(room('lobby-1')).getByRole('button', { name: 'Cancel' }));
    expect(modePosts(w)).toEqual([]);
    expect(radio('lobby-1', 'Normal')).toBeChecked();
    expect(within(room('lobby-1')).queryByRole('combobox', { name: 'How long' })).toBeNull();
    expect(w.cw.rooms.mode('lobby-1').mode).toBe('normal');
  });

  it('Normal needs no confirmation: it is immediate, and clears a lock at once', async () => {
    const w = await lobby();
    w.cw.rooms.setMode('lobby-1', 'locked', { forMs: HOUR });
    const { user } = await open(w);
    expect(radio('lobby-1', 'Locked')).toBeChecked();
    await user.click(radio('lobby-1', 'Normal'));
    await waitFor(() => expect(modePosts(w)).toHaveLength(1));
    expect(modePosts(w)[0]?.body).toEqual({ mode: 'normal' });
    expect(within(room('lobby-1')).queryByRole('combobox', { name: 'How long' })).toBeNull();
    await waitFor(() => expect(radio('lobby-1', 'Normal')).toBeChecked());
    expect(w.cw.rooms.mode('lobby-1').mode).toBe('normal');
  });

  it('a mode already on is shown with its expiry, and choosing the other restricting mode replaces it after a confirm', async () => {
    const w = await lobby();
    w.cw.rooms.setMode('lobby-1', 'locked', { forMs: 15 * MINUTE });
    const { user } = await open(w);
    expect(within(room('lobby-1')).getByText(`Locked until ${time(w.now() + 15 * MINUTE)}`)).toBeInTheDocument();
    await user.click(radio('lobby-1', 'Emergency'));
    await user.click(within(room('lobby-1')).getByRole('button', { name: 'Start emergency mode' }));
    await waitFor(() => expect(w.cw.rooms.mode('lobby-1').mode).toBe('emergency'));
  });
});

describe('time and failure', () => {
  it('a mode that expired on the server reads Normal at the next refresh', async () => {
    const w = await lobby();
    w.cw.rooms.setMode('lobby-1', 'locked', { forMs: 60_000 });
    const { user } = await open(w);
    expect(radio('lobby-1', 'Locked')).toBeChecked();
    w.clock.t += 5 * MINUTE;
    await user.click(within(panel()).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(radio('lobby-1', 'Normal')).toBeChecked());
    expect(within(room('lobby-1')).queryByText(/until/)).toBeNull();
  });

  it('a failed save keeps the control on its old value and says why in words', async () => {
    const w = await lobby();
    const { user } = await open(w);
    w.intercept.fn = (req) => (req.method === 'POST' && req.path === '/rooms/lobby-1/mode' ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await user.click(radio('lobby-1', 'Locked'));
    await user.click(within(room('lobby-1')).getByRole('button', { name: 'Lock the room' }));
    expect(await within(room('lobby-1')).findByRole('alert')).toHaveTextContent('The server had a problem. Try again in a moment.');
    expect(radio('lobby-1', 'Normal')).toBeChecked();
    expect(w.cw.rooms.mode('lobby-1').mode).toBe('normal');
  });

  it('a refusal for a length the kit does not take says so, in words', async () => {
    const w = await lobby();
    const { user } = await open(w);
    w.intercept.fn = (req) => (req.method === 'POST' && req.path === '/rooms/lobby-1/mode' ? { status: 400, body: { error: 'invalid_value', message: 'x' } } : undefined);
    await user.click(radio('lobby-1', 'Locked'));
    await user.click(within(room('lobby-1')).getByRole('button', { name: 'Lock the room' }));
    expect(await within(room('lobby-1')).findByRole('alert')).toHaveTextContent('That length is not allowed.');
    expect(radio('lobby-1', 'Normal')).toBeChecked();
  });

  it('a failed read of the list says so and offers to try again', async () => {
    const w = await lobby();
    w.intercept.fn = (req) => (req.method === 'GET' && req.path === '/rooms' ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('region', { name: 'Rooms' });
    expect(await within(panel()).findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('who sees it', () => {
  it('a role that may read but not manage sees each room\'s mode as text, with no radios and no buttons', async () => {
    const w = await lobby({ permissions: { 'rooms.manage': 'owner' } });
    w.cw.rooms.setMode('lobby-1', 'locked', { forMs: HOUR });
    renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('region', { name: 'Rooms' });
    await within(panel()).findByText(`lobby-1`);
    expect(within(panel()).queryAllByRole('radio')).toEqual([]);
    expect(within(panel()).getByText(`Locked until ${time(w.now() + HOUR)}`)).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Lock the room' })).toBeNull();
  });

  it('without rooms.read there is no panel and the list is never asked for', async () => {
    const w = await lobby({ permissions: { 'rooms.read': 'owner' } });
    renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('heading', { level: 2, name: 'Advanced' });
    await screen.findByRole('region', { name: 'Safety and urgent cases' });
    expect(screen.queryByRole('region', { name: 'Rooms' })).toBeNull();
    expect(w.sent.filter((r) => r.path === '/rooms')).toEqual([]);
  });

  it('is a lazy part: the Advanced screen asks for its code, a case does not', async () => {
    const { partLoaders, resetLazyParts } = await import('../src/lazyParts.js');
    resetLazyParts();
    const asked: string[] = [];
    const real = { ...partLoaders };
    (partLoaders as Record<string, () => unknown>)['roomsPanel'] = () => {
      asked.push('roomsPanel');
      return (real as Record<string, () => unknown>)['roomsPanel']?.();
    };
    try {
      const w = await lobby();
      const f = await w.file({ room: 'lobby-3' });
      const view = renderHub(w, { path: `/reports/${f.id}` });
      await screen.findByRole('tablist');
      expect(asked).toEqual([]);
      view.unmount();
      renderHub(w, { path: '/settings/advanced' });
      await waitFor(() => expect(asked).toEqual(['roomsPanel']));
    } finally {
      Object.assign(partLoaders, real);
    }
  });
});
