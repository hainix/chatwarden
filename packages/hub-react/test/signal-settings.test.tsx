import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { MemoryStore, withMemoryAi, withMemorySignals } from '@chatwarden/store-memory';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Settings > Advanced > "Signals" (flood control and signals, design 6): the declared kinds read-only, and four small forms, each off until switched on.
// The same save machinery as the pace panel. The owner edits; seniors and moderators read. Polarity is words, never colour.

afterEach(() => cleanup());

const KINDS = {
  muted_by_player: { label: 'Muted by other players', polarity: 'negative' as const },
  kicked_from_room: { label: 'Kicked from a room', polarity: 'negative' as const, weight: 2 },
  commended: { label: 'Commended by other players', polarity: 'positive' as const },
};

/** A kit with the AI available (the fake adapter) and signals declared, over a store that keeps both. */
function world(o: WorldOptions & { kinds?: boolean; ai?: boolean; store?: WorldOptions['store'] } = {}) {
  const { kinds = true, ai = false, ...rest } = o;
  return hubWorld({
    role: 'owner',
    actor: 'owen@example.test',
    store: o.store ?? withMemorySignals(withMemoryAi(new MemoryStore())),
    ...(kinds ? { overrides: { signals: { kinds: KINDS } } as never } : {}),
    ...(ai ? { ai: { level: 1 } } : {}),
    ...rest,
  });
}
type User = ReturnType<typeof renderHub>['user'];

async function open(w: HubWorld) {
  const r = renderHub(w, { path: '/settings/advanced' });
  await screen.findByRole('heading', { level: 2, name: 'Advanced' });
  await screen.findByRole('region', { name: 'Signals' });
  return r;
}
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Signals' });
const form = (name: string): HTMLElement => within(panel()).getByRole('group', { name });
const RECORD = 'Show on a person’s record';
const QUEUE = 'Put these people sooner in the queue';
const LADDER = 'Add to the suggested step';
const AI = 'Give the AI read as background';
const sw = (name: string): HTMLInputElement => within(panel()).getByRole('checkbox', { name }) as HTMLInputElement;
const within_ = (name: string) => within(form(name));
const puts = (w: HubWorld) => w.sent.filter((r) => r.method === 'PUT' && r.path === '/policy/profile');
async function days(user: User, group: HTMLElement, value: string): Promise<void> {
  const el = within(group).getByLabelText('Days to look back');
  await user.clear(el);
  if (value !== '') await user.type(el, value);
}
async function players(user: User, group: HTMLElement, value: string): Promise<void> {
  const el = within(group).getByLabelText('At least this many players');
  await user.clear(el);
  await user.type(el, value);
}
async function save(user: User, why = 'Use the counts') {
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
  await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), why);
  await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
}

describe('the declared kinds', () => {
  it('with no declared kinds the panel says so and offers no form', async () => {
    const w = await world({ kinds: false });
    await open(w);
    expect(within(panel()).getByText(/hasn.t declared any signal kinds/i)).toBeInTheDocument();
    expect(within(panel()).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('are listed read-only with weight and polarity in words', async () => {
    const w = await world();
    await open(w);
    const list = within(panel()).getByRole('list', { name: 'Declared kinds' });
    const items = within(list).getAllByRole('listitem').filter((li) => !li.textContent?.includes('Flooded'));
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Muted by other players');
    expect(items[0]).toHaveTextContent('counts against');
    expect(items[0]).toHaveTextContent('weight 1');
    expect(items[1]).toHaveTextContent('Kicked from a room');
    expect(items[1]).toHaveTextContent('weight 2');
    expect(items[2]).toHaveTextContent('Commended by other players');
    expect(items[2]).toHaveTextContent('counts for');
    expect(within(panel()).getByText(/Declared in your game.s code/)).toBeInTheDocument();
    // Read-only: no control in the list.
    expect(within(list).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(list).queryAllByRole('textbox')).toHaveLength(0);
  });

  it('no colour class carries polarity', async () => {
    const w = await world();
    await open(w);
    for (const el of panel().querySelectorAll('*')) expect(el.className.toString(), el.tagName).not.toMatch(/bad|warn|good|red|green|yellow|blue/i);
  });
});

describe('the forms', () => {
  it('each form is off by default and saves nothing until switched on', async () => {
    const w = await world({ ai: true });
    await open(w);
    for (const name of [RECORD, QUEUE, LADDER, AI]) expect(sw(name).checked, name).toBe(false);
    for (const input of within(panel()).getAllByRole('spinbutton')) expect(input).toBeDisabled();
    expect(within(panel()).getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
    expect(puts(w)).toHaveLength(0);
  });

  it('the queue and raise choices list negative kinds only; record, notes and the AI list every kind', async () => {
    const w = await world({ ai: true });
    const { user } = await open(w);
    await user.click(sw(QUEUE));
    await user.click(sw(RECORD));
    await user.click(sw(AI));
    for (const name of [RECORD, AI]) expect(within_(name).getByRole('checkbox', { name: 'Commended by other players' })).toBeInTheDocument();
    expect(within_(QUEUE).queryByRole('checkbox', { name: 'Commended by other players' })).toBeNull();
    expect(within_(QUEUE).getByRole('checkbox', { name: 'Muted by other players' })).toBeInTheDocument();
    await user.click(sw(LADDER));
    const rule = within(form(LADDER)).getByRole('group', { name: 'Rule 1' });
    // A note may name any kind; one step higher only negative kinds.
    expect(within(rule).getByRole('checkbox', { name: 'Commended by other players' })).toBeInTheDocument();
    await user.selectOptions(within(rule).getByLabelText('What it does'), 'raise');
    expect(within(rule).queryByRole('checkbox', { name: 'Commended by other players' })).toBeNull();
    expect(within(rule).getByRole('checkbox', { name: 'Muted by other players' })).toBeInTheDocument();
  });

  it('saving sends the whole layer with signals.feeds merged and a reason', async () => {
    const w = await world();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { customDuration: false }, version: state.version, reason: 'Fewer lengths' });
    const { user } = await open(w);
    await user.click(sw(RECORD));
    await user.click(within_(RECORD).getByRole('checkbox', { name: 'All kinds' }));
    await days(user, form(RECORD), '14');
    await user.click(sw(QUEUE));
    await user.click(within_(QUEUE).getByRole('checkbox', { name: 'Muted by other players' }));
    await players(user, form(QUEUE), '5');
    await days(user, form(QUEUE), '7');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const body = puts(w)[0]!.body as { layer: Record<string, unknown>; reason: string };
    expect(body.layer).toEqual({
      customDuration: false,
      signals: { feeds: { record: { kinds: '*', windowDays: 14 }, queue: { kinds: ['muted_by_player'], minDistinct: 5, windowDays: 7 } } },
    });
    expect(body.reason).toBe('Use the counts');
    const after = await w.client.policyProfile();
    expect(Object.keys(after.effective.signals.feeds).sort()).toEqual(['queue', 'record']);
    await screen.findByText('Signals settings saved.');
  });

  it('a rule is saved with its id, kinds, players, days and effect, and the second is numbered', async () => {
    const w = await world();
    const { user } = await open(w);
    await user.click(sw(LADDER));
    const one = within(form(LADDER)).getByRole('group', { name: 'Rule 1' });
    await user.click(within(one).getByRole('checkbox', { name: 'Muted by other players' }));
    await players(user, one, '5');
    await days(user, one, '14');
    await user.click(within(form(LADDER)).getByRole('button', { name: 'Add a rule' }));
    const two = within(form(LADDER)).getByRole('group', { name: 'Rule 2' });
    await user.click(within(two).getByRole('checkbox', { name: 'Kicked from a room' }));
    await players(user, two, '3');
    await days(user, two, '30');
    await user.selectOptions(within(two).getByLabelText('What it does'), 'raise');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    const feeds = (puts(w)[0]!.body as { layer: { signals: { feeds: { ladder: Array<Record<string, unknown>> } } } }).layer.signals.feeds;
    expect(feeds.ladder).toEqual([
      { id: 'rule-1', effect: 'note', kinds: ['muted_by_player'], minDistinct: 5, windowDays: 14 },
      { id: 'rule-2', effect: 'raise', kinds: ['kicked_from_room'], minDistinct: 3, windowDays: 30 },
    ]);
    // A rule can be taken away again.
    await user.click(within(within(form(LADDER)).getByRole('group', { name: 'Rule 2' })).getByRole('button', { name: 'Remove rule' }));
    expect(within(form(LADDER)).queryByRole('group', { name: 'Rule 2' })).toBeNull();
  });

  it('the AI form is hidden when the AI is not available, and shown when it is', async () => {
    const without = await world();
    await open(without);
    expect(within(panel()).queryByRole('checkbox', { name: AI })).toBeNull();
    cleanup();
    const w = await world({ ai: true });
    await open(w);
    expect(sw(AI)).toBeInTheDocument();
  });

  it('the window cannot exceed 90 days, nor be empty or below 1, and a bad count is not saved', async () => {
    const w = await world();
    const { user } = await open(w);
    await user.click(sw(RECORD));
    await user.click(within_(RECORD).getByRole('checkbox', { name: 'All kinds' }));
    for (const bad of ['91', '0', '', '2.5']) {
      await days(user, form(RECORD), bad);
      await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
      expect(await within(form(RECORD)).findByText(/from 1 to 90/), bad).toBeInTheDocument();
      expect(within(form(RECORD)).getByLabelText('Days to look back')).toHaveAttribute('aria-invalid', 'true');
    }
    expect(puts(w)).toHaveLength(0);
    await days(user, form(RECORD), '90');
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('textbox', { name: /Why are you changing this/ })).toBeInTheDocument();
  });

  it('a form switched on with no kind chosen is not saved', async () => {
    const w = await world();
    const { user } = await open(w);
    await user.click(sw(QUEUE));
    await players(user, form(QUEUE), '3');
    await days(user, form(QUEUE), '7');
    await user.click(within(panel()).getByRole('button', { name: 'Save changes' }));
    expect(await within(form(QUEUE)).findByText(/Choose at least one kind/)).toBeInTheDocument();
    expect(puts(w)).toHaveLength(0);
  });

  it('shows what is in force: the feeds in the code, with their numbers', async () => {
    const w = await hubWorld({
      role: 'owner',
      store: withMemorySignals(withMemoryAi(new MemoryStore())),
      overrides: { signals: { kinds: KINDS, feeds: { queue: { kinds: ['muted_by_player'], minDistinct: 4, windowDays: 10 } } } } as never,
    });
    await open(w);
    expect(sw(QUEUE).checked).toBe(true);
    expect((within(form(QUEUE)).getByLabelText('At least this many players') as HTMLInputElement).value).toBe('4');
    expect((within(form(QUEUE)).getByLabelText('Days to look back') as HTMLInputElement).value).toBe('10');
    expect(within_(QUEUE).getByRole('checkbox', { name: 'Muted by other players' })).toBeChecked();
    expect(sw(RECORD).checked).toBe(false);
  });

  it('a feed switched off is saved by leaving it out, so it stays off whatever the code says', async () => {
    const w = await hubWorld({
      role: 'owner',
      store: withMemorySignals(withMemoryAi(new MemoryStore())),
      overrides: { signals: { kinds: KINDS, feeds: { queue: { kinds: ['muted_by_player'], minDistinct: 4, windowDays: 10 } } } } as never,
    });
    const { user } = await open(w);
    await user.click(sw(QUEUE));
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    expect((puts(w)[0]!.body as { layer: unknown }).layer).toEqual({ signals: { feeds: {} } });
    expect(Object.keys((await w.client.policyProfile()).effective.signals.feeds)).toEqual([]);
  });
});

describe('refusals, conflicts and reset', () => {
  it('a 400 invalid_profile with a layer path shows the field error', async () => {
    const w = await world();
    const { user } = await open(w);
    await user.click(sw(QUEUE));
    await user.click(within_(QUEUE).getByRole('checkbox', { name: 'Muted by other players' }));
    await players(user, form(QUEUE), '3');
    await days(user, form(QUEUE), '7');
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, headers: {}, body: { error: 'invalid_profile', message: 'no', path: 'layer.signals.feeds.queue.windowDays' } } : undefined);
    await save(user);
    await screen.findByText(/That setting isn't allowed/i);
    expect(within(form(QUEUE)).getByLabelText('Days to look back')).toHaveAttribute('aria-invalid', 'true');
    expect(within(form(QUEUE)).getByLabelText('Days to look back')).toHaveValue(7);
  });

  it('a 409 offers to reload, and Reload shows what the other owner saved', async () => {
    const w = await world();
    const { user } = await open(w);
    const other = w.clientFor('olga@example.test', 'owner');
    const state = await other.policyProfile();
    await other.savePolicyProfile({ layer: { signals: { feeds: { record: { kinds: '*', windowDays: 21 } } } }, version: state.version, reason: 'Record on' });
    await user.click(sw(QUEUE));
    await user.click(within_(QUEUE).getByRole('checkbox', { name: 'Muted by other players' }));
    await players(user, form(QUEUE), '3');
    await days(user, form(QUEUE), '7');
    await save(user);
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(sw(RECORD).checked).toBe(true));
    expect(sw(QUEUE).checked).toBe(false);
  });

  it('keeps what another screen saved, and reset puts the feeds back to the code while the rest stays', async () => {
    const w = await world();
    const state = await w.direct.policyProfile();
    await w.direct.savePolicyProfile({ layer: { ai: { level: 1 }, signals: { feeds: { record: { kinds: '*', windowDays: 14 } } } }, version: state.version, reason: 'Both' });
    const { user } = await open(w);
    expect(sw(RECORD).checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reset signals' }));
    await user.type(screen.getByRole('textbox', { name: /Why are you resetting this/ }), 'Back to the code');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(sw(RECORD).checked).toBe(false));
    const after = await w.client.policyProfile();
    expect(after.layer.signals).toBeUndefined();
    expect(after.layer.ai).toEqual({ level: 1 });
  });
});

describe('who can see and who can edit', () => {
  it('only the owner edits; policy.read sees it read-only', async () => {
    for (const role of ['moderator', 'senior'] as const) {
      cleanup();
      const w = await hubWorld({
        role,
        actor: `${role}@example.test`,
        store: withMemorySignals(withMemoryAi(new MemoryStore())),
        overrides: { signals: { kinds: KINDS, feeds: { record: { kinds: '*', windowDays: 14 } } } } as never,
      });
      await open(w);
      expect(sw(RECORD).checked).toBe(true);
      for (const el of within(panel()).getAllByRole('checkbox')) expect(el).toBeDisabled();
      for (const el of within(panel()).getAllByRole('spinbutton')) expect(el).toBeDisabled();
      expect(within(panel()).queryByRole('button', { name: 'Save changes' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reset signals' })).toBeNull();
    }
  });

  it('says plainly that a signal never acts on its own', async () => {
    const w = await world();
    await open(w);
    expect(within(panel()).getByText('A signal never acts on its own. A person always decides.')).toBeInTheDocument();
  });
});

describe('what was dropped', () => {
  const STALE = { signals: { feeds: { record: { kinds: '*', windowDays: 14 }, queue: { kinds: ['removed_kind'], minDistinct: 3, windowDays: 7 } } } };

  async function staleWorld() {
    const store = withMemorySignals(withMemoryAi(new MemoryStore()));
    store.savePolicyLayer?.(STALE as never, 0);
    return world({ store });
  }

  it('lists what the kit dropped from the saved settings, and why, in words and with no kind or rule id', async () => {
    const w = await staleWorld();
    await open(w);
    const note = within(panel()).getByRole('status', { name: 'Saved settings that could not be used' });
    expect(note).toHaveTextContent('Put these people sooner in the queue');
    expect(note).toHaveTextContent('names a kind your game no longer declares');
    expect(note.textContent).not.toMatch(/removed_kind|unknown_kind|"queue"/);
    expect(note).toHaveTextContent(/left out|removed when you save/i);
    // What is still good stays on.
    expect(sw(RECORD).checked).toBe(true);
    expect(sw(QUEUE).checked).toBe(false);
  });

  it('the stuck-save scenario: an unrelated save goes through, and the note goes away', async () => {
    const w = await staleWorld();
    const { user } = await open(w);
    await user.click(sw(LADDER));
    const rule = within(form(LADDER)).getByRole('group', { name: 'Rule 1' });
    await user.click(within(rule).getByRole('checkbox', { name: 'Muted by other players' }));
    await players(user, rule, '5');
    await days(user, rule, '14');
    await save(user);
    await waitFor(() => expect(puts(w)).toHaveLength(1));
    await waitFor(() => expect(within(panel()).queryByRole('status', { name: 'Saved settings that could not be used' })).toBeNull());
    expect(JSON.stringify((puts(w)[0]!.body as { layer: unknown }).layer)).not.toContain('removed_kind');
  });

  it('a save that answers with a dropped list shows it (usePolicy carries dropped through a save)', async () => {
    const w = await world();
    const { user } = await open(w);
    await user.click(sw(RECORD));
    await user.click(within_(RECORD).getByRole('checkbox', { name: 'All kinds' }));
    await days(user, form(RECORD), '14');
    w.intercept.fn = async (req) => {
      if (req.method !== 'PUT') return undefined;
      const res = await w.raw({ method: 'PUT', path: req.path, headers: { 'content-type': 'application/json' }, rawBody: JSON.stringify(req.body) });
      return { ...res, body: { ...(res.body as object), dropped: [{ feed: 'ladder', reason: 'positive_kind' }] } };
    };
    await save(user);
    const note = await within(panel()).findByRole('status', { name: 'Saved settings that could not be used' });
    expect(note).toHaveTextContent('Add to the suggested step');
    expect(note).toHaveTextContent('names a kind that cannot be used for it');
  });

  it('nothing dropped: no note, and no empty list', async () => {
    const w = await world();
    await open(w);
    expect(within(panel()).queryByRole('status', { name: 'Saved settings that could not be used' })).toBeNull();
  });
});
