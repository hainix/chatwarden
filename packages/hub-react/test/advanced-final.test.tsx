import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { MemoryStore, withMemoryAi, withMemorySignals } from '@chatwarden/store-memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { partLoaders, resetLazyParts } from '../src/lazyParts.js';
import { paceProblems } from '../src/policy/pace.js';
import type { PaceDraft } from '../src/policy/pace.js';
import { renderHub } from './render.js';
import { DAY, hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The final round of fixes on Settings > Advanced (flood control and signals): the dropped note with no declared kinds, a panel chunk that fails to
// load, the numbers the kit itself reports (`limits`), and the smaller items of the review.

afterEach(() => cleanup());

const KINDS = {
  muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
  commended: { label: 'Commended by other players', polarity: 'positive' as const },
};
const STALE = { signals: { feeds: { queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } };

function world(o: WorldOptions & { kinds?: boolean; stale?: boolean; layer?: unknown } = {}) {
  const { kinds = true, stale = false, layer, ...rest } = o;
  const store = withMemorySignals(withMemoryAi(new MemoryStore()));
  if (layer !== undefined) store.savePolicyLayer?.(layer as never, 0);
  else if (stale) store.savePolicyLayer?.(STALE as never, 0);
  return hubWorld({ role: 'owner', actor: 'owen@example.test', store, ...(kinds ? { overrides: { signals: { kinds: KINDS } } as never } : {}), ...rest });
}
type User = ReturnType<typeof renderHub>['user'];

async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Signals' });
  return r;
}
const signals = (): HTMLElement => screen.getByRole('region', { name: 'Signals' });
const pace = (): HTMLElement => screen.getByRole('region', { name: 'Slow mode and flooding' });
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
const NOTE = { name: 'Saved settings that could not be used' };
const REMOVE = 'Remove dropped settings';

describe('FE I1: the dropped note offers the action it describes', () => {
  it('with no declared kinds, an editor gets a "Remove dropped settings" save that writes the pruned layer', async () => {
    const w = await world({ kinds: false, stale: true });
    const { user } = await open(w);
    const note = within(signals()).getByRole('status', NOTE);
    expect(note).toHaveTextContent('Put these people sooner in the queue');
    expect(within(signals()).getByText(/hasn.t declared any signal kinds/i)).toBeInTheDocument();
    await user.click(within(signals()).getByRole('button', { name: REMOVE }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Clean up after removing a kind');
    await user.click(within(signals()).getByRole('button', { name: REMOVE }));
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]!.body as { layer: Record<string, unknown>; reason: string };
    expect(body.layer).toEqual({});
    expect(body.reason).toBe('Clean up after removing a kind');
    await waitFor(() => expect(within(signals()).queryByRole('status', NOTE)).toBeNull());
    expect(within(signals()).queryByRole('button', { name: REMOVE })).toBeNull();
    expect((await w.direct.policyProfile()).dropped).toBeUndefined();
  });

  it('the repair keeps what another screen saved: the pace section goes back with the pruned layer', async () => {
    const w = await world({ kinds: false, layer: { pace: { slowModeMs: 3000 }, ...STALE } });
    const { user } = await open(w);
    await user.click(within(signals()).getByRole('button', { name: REMOVE }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Clean up');
    await user.click(within(signals()).getByRole('button', { name: REMOVE }));
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: unknown }).layer).toEqual({ pace: { slowModeMs: 3000 } });
    expect((await w.direct.policyProfile()).effective.pace.slowModeMs).toBe(3000);
  });

  it('a reader is told what to do instead: ask the owner to save, with no button', async () => {
    const w = await world({ kinds: false, stale: true, role: 'moderator', actor: 'm@example.test' });
    await open(w);
    const note = within(signals()).getByRole('status', NOTE);
    expect(note).toHaveTextContent(/ask the owner/i);
    expect(note.textContent).not.toMatch(/saving removes them/i);
    expect(within(signals()).queryByRole('button', { name: REMOVE })).toBeNull();
    expect(within(signals()).queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('nothing dropped: no repair button, with or without kinds', async () => {
    for (const kinds of [false, true]) {
      cleanup();
      const w = await world({ kinds });
      await open(w);
      expect(within(signals()).queryByRole('button', { name: REMOVE })).toBeNull();
      expect(within(signals()).queryByRole('status', NOTE)).toBeNull();
    }
  });

  it('with kinds declared the repair is the ordinary Save, as before (no second button)', async () => {
    const w = await world({ kinds: true, stale: true });
    await open(w);
    expect(within(signals()).getByRole('status', NOTE)).toBeInTheDocument();
    expect(within(signals()).queryByRole('button', { name: REMOVE })).toBeNull();
    expect(within(signals()).getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('a conflict while repairing offers Reload, and nothing is left half done', async () => {
    const w = await world({ kinds: false, stale: true });
    const { user } = await open(w);
    const other = w.clientFor('olga@example.test', 'owner');
    const state = await other.policyProfile();
    await other.savePolicyProfile({ layer: { pace: { slowModeMs: 9000 } }, version: state.version, reason: 'Slower' });
    await user.click(within(signals()).getByRole('button', { name: REMOVE }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Clean up');
    await user.click(within(signals()).getByRole('button', { name: REMOVE }));
    const alert = await within(signals()).findByRole('alert');
    expect(alert).toHaveTextContent(/someone else/i);
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});

describe('FE I2: a panel chunk that fails to load is an error with a Retry, never a blank screen', () => {
  const real = { ...partLoaders };
  beforeEach(() => resetLazyParts());
  afterEach(() => {
    Object.assign(partLoaders, real);
    resetLazyParts();
  });

  it.each([
    ['the pace panel', 'pacePanel' as const, 'Slow mode and flooding'],
    ['the signals panel', 'signalPanel' as const, 'Signals'],
  ])('%s: the screen says it could not load, and Try again loads it', async (_name, loader, region) => {
    partLoaders[loader] = () => Promise.reject(new Error('offline'));
    const w = await world();
    const { user } = renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('heading', { level: 2, name: 'Advanced' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the advanced settings.');
    expect(screen.queryByRole('region', { name: region })).toBeNull();
    Object.assign(partLoaders, real);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: region })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('region', { name: 'Slow mode and flooding' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Signals' })).toBeInTheDocument();
  });

  it('both panels failing is one error, and a second failed retry still shows it (the hint to reload after repeats is the screen\'s own)', async () => {
    partLoaders.pacePanel = () => Promise.reject(new Error('offline'));
    partLoaders.signalPanel = () => Promise.reject(new Error('offline'));
    const w = await world();
    const { user } = renderHub(w, { path: '/settings/advanced' });
    await screen.findByRole('heading', { level: 2, name: 'Advanced' });
    expect(await screen.findAllByRole('alert')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Signals' })).toBeNull();
  });

  it('the title and the intro stay, so the screen is never blank', async () => {
    partLoaders.pacePanel = () => Promise.reject(new Error('offline'));
    const w = await world();
    renderHub(w, { path: '/settings/advanced' });
    expect(await screen.findByRole('heading', { level: 2, name: 'Advanced' })).toBeInTheDocument();
    await screen.findByRole('alert');
    expect(screen.getByText(/Settings most teams never need/)).toBeInTheDocument();
  });

  it('the Person page signal lines stay silent when their chunk fails: the page renders, with no error', async () => {
    partLoaders.signalLines = () => Promise.reject(new Error('offline'));
    const w = await world({ overrides: { signals: { kinds: KINDS, feeds: { record: { kinds: '*', windowDays: 14 } } } } as never });
    const f = await w.file({ target: 'Vlemmo' });
    for (let i = 0; i < 2; i += 1) {
      const by = `signaller-${i}`;
      w.cw.rooms.seat(`room-${by}`, 'p1', { clientKey: by }, 'S');
      expect(w.cw.signals.record({ kind: 'muted_by_player', subject: f.person, by: w.cw.rooms.subjectAt(`room-${by}`, 'p1') as string })).toBe(true);
    }
    renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Muted by other players/)).toBeNull();
    expect(screen.getByRole('region', { name: 'In force now' })).toBeInTheDocument();
  });
});

describe('the numbers the kit reports (limits): the built-in limit hint and the window cap', () => {
  const BURST = 'Burst limit';
  const BURST_N = 'Messages';
  const BURST_S = 'Within seconds';
  const type = async (user: User, name: string, value: string): Promise<void> => {
    const el = within(pace()).getByLabelText(name);
    await user.clear(el);
    await user.type(el, value);
  };

  it('the hint names the kit\'s own chat rate, and is judged against it', async () => {
    const w = await world({ limits: { chatRate: { count: 10, windowMs: 8000 } } });
    const { user } = await open(w);
    await user.click(within(pace()).getByRole('checkbox', { name: BURST }));
    // 10 per 10 seconds is tighter than 10 per 8 seconds: no hint. 20 per 10 seconds is looser: the hint, with the real numbers.
    await type(user, BURST_N, '10');
    await type(user, BURST_S, '10');
    expect(within(pace()).queryByText(/built-in limit/i)).toBeNull();
    await type(user, BURST_N, '20');
    expect(within(pace()).getByText('The built-in limit of 10 messages per 8 seconds applies first, so a burst this loose rarely triggers.')).toBeInTheDocument();
  });

  it('a limit of one message per second reads in the singular', async () => {
    const w = await world({ limits: { chatRate: { count: 1, windowMs: 1000 } } });
    const { user } = await open(w);
    await user.click(within(pace()).getByRole('checkbox', { name: BURST }));
    await type(user, BURST_N, '5');
    await type(user, BURST_S, '2');
    expect(within(pace()).getByText(/built-in limit of 1 message per 1 second applies first/)).toBeInTheDocument();
  });

  it('an older server that sends no limits gets the old hint (3 messages per 5 seconds)', async () => {
    const w = await world();
    w.intercept.fn = async (req) => {
      if (req.method !== 'GET' || req.path !== '/policy/profile') return undefined;
      const res = await w.raw({ method: 'GET', path: req.path, headers: {} });
      const { limits: _gone, ...rest } = res.body as Record<string, unknown>;
      void _gone;
      return { ...res, body: rest };
    };
    const { user } = await open(w);
    await user.click(within(pace()).getByRole('checkbox', { name: BURST }));
    await type(user, BURST_N, '10');
    await type(user, BURST_S, '10');
    expect(within(pace()).getByText(/built-in limit of 3 messages per 5 seconds applies first/)).toBeInTheDocument();
  });

  it('a save keeps the numbers: the answer carries limits, so the hint stays right after it', async () => {
    const w = await world({ limits: { chatRate: { count: 10, windowMs: 8000 } } });
    const { user } = await open(w);
    await user.click(within(pace()).getByRole('checkbox', { name: BURST }));
    await type(user, BURST_N, '20');
    await type(user, BURST_S, '10');
    await user.click(within(pace()).getByRole('button', { name: 'Save changes' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Busy night');
    await user.click(within(pace()).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    await screen.findByText('Slow mode and flooding settings saved.');
    expect(within(pace()).getByText(/built-in limit of 10 messages per 8 seconds/)).toBeInTheDocument();
  });

  it('the feed window cap is the retention: 30 days kept means 31 is refused here, with the real number in the message', async () => {
    const w = await world({ signalsMs: 30 * DAY });
    const { user } = await open(w);
    const record = within(signals()).getByRole('group', { name: 'Show on a person’s record' });
    await user.click(within(record).getByRole('checkbox', { name: 'Show on a person’s record' }));
    await user.click(within(record).getByRole('checkbox', { name: 'All kinds' }));
    const days = within(record).getByLabelText('Days to look back');
    await user.clear(days);
    await user.type(days, '31');
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    expect(await within(record).findByText('Enter a whole number of days from 1 to 30.')).toBeInTheDocument();
    expect(puts(w)).toHaveLength(0);
    await user.clear(days);
    await user.type(days, '30');
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    expect(within(record).queryByText(/from 1 to 30/)).toBeNull();
  });

  it('with no limits from the server the cap stays 90', async () => {
    const w = await world();
    w.intercept.fn = async (req) => {
      if (req.method !== 'GET' || req.path !== '/policy/profile') return undefined;
      const res = await w.raw({ method: 'GET', path: req.path, headers: {} });
      const { limits: _gone, ...rest } = res.body as Record<string, unknown>;
      void _gone;
      return { ...res, body: rest };
    };
    const { user } = await open(w);
    const record = within(signals()).getByRole('group', { name: 'Show on a person’s record' });
    await user.click(within(record).getByRole('checkbox', { name: 'Show on a person’s record' }));
    await user.click(within(record).getByRole('checkbox', { name: 'All kinds' }));
    const days = within(record).getByLabelText('Days to look back');
    await user.clear(days);
    await user.type(days, '91');
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    expect(await within(record).findByText('Enter a whole number of days from 1 to 90.')).toBeInTheDocument();
  });

  it('a windowDays refusal from the server says it is the retention, not that the setting is not allowed', async () => {
    const w = await world();
    const { user } = await open(w);
    const queue = within(signals()).getByRole('group', { name: 'Put these people sooner in the queue' });
    await user.click(within(queue).getByRole('checkbox', { name: 'Put these people sooner in the queue' }));
    await user.click(within(queue).getByRole('checkbox', { name: 'Muted by other players' }));
    const players = within(queue).getByLabelText('At least this many players');
    await user.clear(players);
    await user.type(players, '3');
    const days = within(queue).getByLabelText('Days to look back');
    await user.clear(days);
    await user.type(days, '60');
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, headers: {}, body: { error: 'invalid_profile', message: 'no', path: 'layer.signals.feeds.queue.windowDays' } } : undefined);
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Longer look back');
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    expect(await within(queue).findByText('Longer than your game keeps signals. Try fewer days.')).toBeInTheDocument();
    expect(within(queue).queryByText(/isn.t allowed/i)).toBeNull();
    expect(days).toHaveAttribute('aria-invalid', 'true');
  });

  it('any other refusal keeps the generic message', async () => {
    const w = await world();
    const { user } = await open(w);
    const queue = within(signals()).getByRole('group', { name: 'Put these people sooner in the queue' });
    await user.click(within(queue).getByRole('checkbox', { name: 'Put these people sooner in the queue' }));
    await user.click(within(queue).getByRole('checkbox', { name: 'Muted by other players' }));
    const players = within(queue).getByLabelText('At least this many players');
    await user.clear(players);
    await user.type(players, '3');
    const days = within(queue).getByLabelText('Days to look back');
    await user.clear(days);
    await user.type(days, '7');
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, headers: {}, body: { error: 'invalid_profile', message: 'no', path: 'layer.signals.feeds.queue.minDistinct' } } : undefined);
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Fewer players');
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    expect(await within(queue).findByText(/isn.t allowed/i)).toBeInTheDocument();
    expect(within(queue).queryByText(/Longer than your game keeps/)).toBeNull();
  });
});

describe('FE M4: the ranges in the messages come from the checks', () => {
  const draft = (over: Partial<PaceDraft>): PaceDraft => ({ slow: false, slowSec: '', burst: false, burstLines: '', burstSec: '', dup: false, dupSec: '', ...over });

  it('each problem carries the range it is checked against, as text', () => {
    const p = paceProblems(draft({ slow: true, slowSec: '0', burst: true, burstLines: '1', burstSec: '0', dup: true, dupSec: '0' }));
    expect(p['slowSec']).toMatchObject({ key: 'hub.settings.pace.error.slow', params: { min: '0.5', max: '600' } });
    expect(p['burstLines']).toMatchObject({ key: 'hub.settings.pace.error.lines', params: { min: '2', max: '100' } });
    expect(p['burstSec']).toMatchObject({ key: 'hub.settings.pace.error.window', params: { min: '1', max: '600' } });
    expect(p['dupSec']).toMatchObject({ key: 'hub.settings.pace.error.repeat', params: { min: '1', max: '3600' } });
  });

  it('and the screen still reads them as before (no thousands separator in 3600)', async () => {
    const w = await world();
    const { user } = await open(w);
    await user.click(within(pace()).getByRole('checkbox', { name: 'Repeated messages' }));
    const el = within(pace()).getByLabelText('Seconds before the same message is allowed again');
    await user.clear(el);
    await user.type(el, '99999');
    await user.click(within(pace()).getByRole('button', { name: 'Save changes' }));
    expect(await within(pace()).findByText('Enter a number of seconds from 1 to 3600.')).toBeInTheDocument();
  });
});

describe('FE M3: the suggested values announce themselves', () => {
  it('"Use suggested values" says so in a polite status, since the form fills silently', async () => {
    const w = await world();
    const { user } = await open(w);
    await user.click(within(pace()).getByRole('button', { name: 'Use suggested values' }));
    expect(await screen.findByText('Suggested values filled in. Review them, then save.')).toBeInTheDocument();
  });
});

describe('FE M5: words for a feed or a reason the hub does not know', () => {
  it('a name like constructor or toString from a server falls back to the plain words and never throws', async () => {
    const w = await world();
    w.intercept.fn = async (req) => {
      if (req.method !== 'GET' || req.path !== '/policy/profile') return undefined;
      const res = await w.raw({ method: 'GET', path: req.path, headers: {} });
      return { ...res, body: { ...(res.body as object), dropped: [{ feed: 'constructor', reason: 'toString' }, { feed: '__proto__', reason: 'hasOwnProperty' }] } };
    };
    await open(w);
    const note = within(signals()).getByRole('status', NOTE);
    expect(within(note).getAllByText('A setting: was not valid.')).toHaveLength(2);
  });
});

describe('FE M6: the dropped entries read as plain lines', () => {
  it('one paragraph per entry, no list whose marker the notice styles away', async () => {
    const w = await world({ stale: true });
    await open(w);
    const note = within(signals()).getByRole('status', NOTE);
    expect(note.querySelector('ul')).toBeNull();
    expect(within(note).getByText('Put these people sooner in the queue: names a kind your game no longer declares.').tagName).toBe('P');
  });
});

describe('FE M8: the gaps the review named', () => {
  it('Simple\'s More menu has no Advanced entry for a role without policy.read either', async () => {
    const w = await hubWorld({ role: 'moderator', actor: 'm@example.test', permissions: { 'policy.read': 'owner' } as never });
    const { user } = renderHub(w, { mode: 'simple' });
    await screen.findByRole('region', { name: 'Open cases' });
    const nav = screen.getByRole('navigation', { name: 'Moderator hub sections' });
    await user.click(within(nav).getByRole('button', { name: 'More' }));
    const names = [...nav.querySelectorAll('.cw-snav-menu a')].map((a) => a.textContent);
    expect(names).not.toContain('Advanced');
    expect(names).not.toContain('Steps and ladder');
  });

  it('after a successful save the focus is on the Save button, not lost with the form that closed', async () => {
    const w = await world();
    const { user } = await open(w);
    const record = within(signals()).getByRole('group', { name: 'Show on a person’s record' });
    await user.click(within(record).getByRole('checkbox', { name: 'Show on a person’s record' }));
    await user.click(within(record).getByRole('checkbox', { name: 'All kinds' }));
    const days = within(record).getByLabelText('Days to look back');
    await user.clear(days);
    await user.type(days, '14');
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'Show the counts');
    await user.click(within(signals()).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Signals settings saved.');
    await waitFor(() => expect(within(signals()).getByRole('button', { name: 'Save changes' })).toHaveFocus());
  });
});
