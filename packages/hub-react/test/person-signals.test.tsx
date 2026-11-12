import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { MemoryStore, withMemoryAi, withMemorySignals } from '@chatwarden/store-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { DAY, HOUR, hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// The Person page's signal lines (flood control and signals, design 5.5): inside the existing Timeline panel, from `signals` on the history,
// only when the feed is on and a count is above zero. Words, never colour; nothing anywhere else in the hub changes.

afterEach(() => cleanup());

const KINDS = {
  muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
  commended: { label: 'Commended by other players', polarity: 'positive' as const },
};
const RECORD = { record: { kinds: '*', windowDays: 14 } };

async function world(feeds: Record<string, unknown> | null) {
  return hubWorld({
    store: withMemorySignals(withMemoryAi(new MemoryStore())),
    overrides: { signals: { kinds: KINDS, ...(feeds === null ? {} : { feeds }) } } as never,
  });
}

let n = 0;
/** `count` different players signal `kind` about `person`, `agoMs` ago (the last one a little later than the first). */
function mark(w: HubWorld, person: string, kind: keyof typeof KINDS, count: number, agoMs = 0, spanMs = 0): void {
  for (let i = 0; i < count; i += 1) {
    const by = `signaller-${++n}`;
    w.cw.rooms.seat(`room-${by}`, 'p1', { clientKey: by }, 'S');
    const at = w.clock.t - agoMs + (count > 1 ? Math.round((spanMs * i) / (count - 1)) : 0);
    expect(w.cw.signals.record({ kind, subject: person, by: w.cw.rooms.subjectAt(`room-${by}`, 'p1') as string, at })).toBe(true);
  }
}

async function open(w: HubWorld, person: string) {
  const r = renderHub(w, { path: `/people/${person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}
const timeline = (): HTMLElement => screen.getByRole('region', { name: 'Timeline' });

describe('the signal lines on the Person page', () => {
  it('show "Muted by other players: 5 (last 14 days)" style lines inside the Timeline panel, and nowhere else', async () => {
    const w = await world(RECORD);
    const f = await w.file({ target: 'Vlemmo' });
    mark(w, f.person, 'muted_by_player', 5, 2 * HOUR);
    await open(w, f.person);
    const line = await within(timeline()).findByText(/Muted by other players: 5 \(last 14 days\)/);
    expect(line).toBeInTheDocument();
    // Nowhere but the Timeline panel.
    for (const name of ['In force now', 'As a reporter']) expect(within(screen.getByRole('region', { name })).queryByText(/Muted by other players/)).toBeNull();
    expect(screen.getAllByText(/Muted by other players/)).toHaveLength(1);
  });

  it('read in words: polarity as "counts against" and "counts for", and carry no colour class', async () => {
    const w = await world(RECORD);
    const f = await w.file({ target: 'Vlemmo' });
    mark(w, f.person, 'muted_by_player', 3, HOUR);
    mark(w, f.person, 'commended', 2, HOUR);
    await open(w, f.person);
    const list = await within(timeline()).findByRole('list', { name: 'Signals from other players' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Muted by other players: 3 (last 14 days)');
    expect(items[0]).toHaveTextContent('counts against');
    expect(items[1]).toHaveTextContent('Commended by other players: 2 (last 14 days)');
    expect(items[1]).toHaveTextContent('counts for');
    for (const el of [list, ...items, ...list.querySelectorAll('*')]) expect(el.className.toString(), el.tagName).not.toMatch(/bad|warn|good|accent|red|green|yellow|blue/i);
  });

  it('say when the sources were, so five in two hours reads differently from five in twelve days', async () => {
    const quick = await world(RECORD);
    const a = await quick.file({ target: 'Vlemmo' });
    mark(quick, a.person, 'muted_by_player', 5, 2 * HOUR, HOUR);
    await open(quick, a.person);
    const first = (await within(timeline()).findByText(/Muted by other players: 5/)).closest('li') as HTMLElement;
    expect(first).toHaveTextContent(/First 2 hours ago, latest 1 hour ago/);
    cleanup();
    const slow = await world(RECORD);
    const b = await slow.file({ target: 'Vlemmo' });
    mark(slow, b.person, 'muted_by_player', 5, 12 * DAY, 11 * DAY);
    await open(slow, b.person);
    const second = (await within(timeline()).findByText(/Muted by other players: 5/)).closest('li') as HTMLElement;
    expect(second).toHaveTextContent(/First 12 days ago, latest yesterday/);
  });

  it('a window of one day reads "last day"', async () => {
    const w = await world({ record: { kinds: '*', windowDays: 1 } });
    const f = await w.file({ target: 'Vlemmo' });
    mark(w, f.person, 'muted_by_player', 2, HOUR);
    await open(w, f.person);
    expect(await within(timeline()).findByText(/Muted by other players: 2 \(last day\)/)).toBeInTheDocument();
  });

  it('with the feed off, no counts, or none above zero: nothing renders and no extra element exists', async () => {
    for (const [feeds, record] of [[null, true], [RECORD, false]] as const) {
      const w = await world(feeds);
      const f = await w.file({ target: 'Vlemmo' });
      if (record) mark(w, f.person, 'muted_by_player', 4, HOUR);
      await open(w, f.person);
      await waitFor(() => expect(within(timeline()).queryByText('Loading', { exact: false })).toBeNull());
      expect(within(timeline()).queryByRole('list', { name: 'Signals from other players' })).toBeNull();
      expect(timeline().textContent).not.toMatch(/counts (for|against)|Muted by/);
      cleanup();
    }
  });

  it('an empty array and an all-zero list draw nothing, and a malformed entry is skipped, not drawn', async () => {
    const w = await world(RECORD);
    const f = await w.file({ target: 'Vlemmo' });
    w.intercept.fn = async (req) => {
      if (req.method !== 'GET' || !/^\/people\/[^/]+\/history$/.test(req.path)) return undefined;
      const res = await w.raw({ method: 'GET', path: req.path });
      const body = JSON.parse(JSON.stringify(res.body)) as Record<string, unknown>;
      body['signals'] = [
        { kind: 'muted_by_player', label: 'Muted by other players', polarity: 'negative', distinct: 0, weight: 0, windowDays: 14, firstAt: 1, lastAt: 1 },
        { kind: 'x', label: 5, polarity: 'sideways', distinct: 'many' },
        null,
      ];
      return { ...res, body };
    };
    await open(w, f.person);
    await waitFor(() => expect(within(timeline()).queryByText('Loading', { exact: false })).toBeNull());
    expect(within(timeline()).queryByRole('list', { name: 'Signals from other players' })).toBeNull();
  });

  it('an older server that sends no signals field changes nothing on the page', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Vlemmo' });
    await open(w, f.person);
    expect(within(timeline()).queryByRole('list', { name: 'Signals from other players' })).toBeNull();
  });

  it('the lines are in the Timeline panel even when the person has no timeline entries', async () => {
    const w = await world(RECORD);
    await w.file({ target: 'Other' });
    // A person seated but never reported: their counts still read.
    w.cw.rooms.seat('pre', 'p2', { clientKey: 'key-quiet-person' }, 'Quiet');
    const quiet = w.cw.rooms.subjectAt('pre', 'p2') as string;
    mark(w, quiet, 'muted_by_player', 2, HOUR);
    await open(w, quiet);
    expect(await within(timeline()).findByText(/Muted by other players: 2/)).toBeInTheDocument();
    expect(within(timeline()).getByText('Nothing in the last 90 days.')).toBeInTheDocument();
  });
});

describe('nothing else in the hub shows signals', () => {
  it('the queue, a case and Simple mode carry no signal words', async () => {
    const w = await world({ ...RECORD, queue: { kinds: ['muted_by_player'], minDistinct: 2, windowDays: 14 } });
    const f = await w.file({ target: 'Vlemmo' });
    mark(w, f.person, 'muted_by_player', 3, HOUR);
    for (const [path, mode] of [['/reports', 'detailed'], [`/reports/${f.id}`, 'detailed'], ['/', 'simple']] as const) {
      const r = renderHub(w, { path, mode });
      await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).toBeNull());
      expect(/signal|Muted by other players|Signals from other players|boost/i.exec(r.container.textContent ?? '')?.[0] ?? null, path).toBeNull();
      expect(r.container.innerHTML, path).not.toMatch(/boosted|signal/i);
      cleanup();
    }
  });
});
