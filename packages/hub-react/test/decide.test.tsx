import { CATEGORY_TO_RULE } from '@chatwarden/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { DAY, hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The decision panel against the real routes: what it offers, what it refuses before sending, what it sends, and what it does
// with each answer.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

const MANY: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  ...Array.from({ length: 7 }, (_, i): RichLine => ({ who: 'target', text: `target line ${i + 1}` })),
];

const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const action = (n: number): HTMLElement => within(panel()).getByRole('group', { name: `Action ${n}` });
const decideButton = (): HTMLElement => within(panel()).getByRole('button', { name: 'Decide' });
const verdict = (name: string): HTMLElement => within(panel()).getByRole('radio', { name });
const live = (): HTMLElement => within(panel()).getByRole('status', { name: 'Decision updates' });
/** The ladder's outcome as the panel words it. */
const outcomeWords = (outcome: unknown): string => {
  if (outcome === 'warning') return 'Warning';
  if (outcome === 'note') return 'Note';
  if (outcome === 'none') return 'No action';
  const o = outcome as { kind: 'chat' | 'area' | 'ban'; durationMs: number | null };
  const kind = { chat: 'Chat restriction', area: 'Area restriction', ban: 'Ban' }[o.kind];
  const length = o.durationMs === null ? 'permanent' : o.durationMs === DAY ? '24 hours' : `${o.durationMs / DAY} days`;
  return `${kind}, ${length}`;
};
const ruleText = (w: HubWorld, n: number): string => `Rule ${n}: ${w.cw.rules.get(n)?.title ?? '?'}`;

/**
 * Opens the case. The bar opens pre-filled (the suggestion is already an action, with the person's own lines), and these tests
 * build their own plan, so by default they open the full editor with "Change" and take the pre-filled action off: the form starts
 * as it did before the pre-fill. `prefilled: true` leaves it as the moderator finds it.
 */
async function ready(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] & { prefilled?: boolean } = {}) {
  const { prefilled = false, ...render } = options;
  const r = renderHub(w, { path: `/reports/${id}`, ...render });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  if (!prefilled) {
    const change = within(panel()).queryByRole('button', { name: 'Change' });
    if (change !== null) await r.user.click(change);
    const remove = within(panel()).queryByRole('button', { name: 'Remove action 1' });
    if (remove !== null) await r.user.click(remove);
  }
  return r;
}

/** Presses Decide, then lets the Undo window pass at once (the page hides: a held decision is sent on the spot). */
async function sendNow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
}
async function decide(user: UserEvent): Promise<void> {
  await user.click(decideButton());
  await sendNow();
}

async function pick(user: UserEvent, select: HTMLElement, option: string | RegExp): Promise<void> {
  await user.selectOptions(select, within(select).getByRole('option', { name: option }));
}

/** Chooses the verdict, adds an action and fills it. */
async function addAction(user: UserEvent, n: number, fill: { who?: RegExp; what?: string | RegExp; rule?: string | RegExp }): Promise<HTMLElement> {
  await user.click(within(panel()).getByRole('button', { name: 'Add an action' }));
  const group = action(n);
  if (fill.who !== undefined) await pick(user, within(group).getByLabelText('Person'), fill.who);
  if (fill.what !== undefined) await pick(user, within(group).getByLabelText('What happens'), fill.what);
  if (fill.rule !== undefined) await pick(user, within(group).getByLabelText('Community Rule'), fill.rule);
  return group;
}

const reason = async (user: UserEvent, text = 'It broke the rules.'): Promise<void> => {
  await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), text);
};

describe('DecisionPanel: what it shows', () => {
  it('starts with three verdicts, none chosen, no actions and an empty reason', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await ready(w, f.id);
    for (const name of ['Fair', 'Not a problem', 'Bad faith']) expect(verdict(name)).not.toBeChecked();
    expect(within(panel()).queryByRole('group', { name: /^Action / })).not.toBeInTheDocument();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('');
    expect(within(panel()).queryByRole('textbox', { name: 'Evidence for bad faith' })).not.toBeInTheDocument();
    expect(decideButton()).toBeInTheDocument();
  });

  it('describes each verdict in words', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await ready(w, f.id);
    expect(verdict('Fair')).toHaveAccessibleDescription('The report holds up. A rule was broken.');
    expect(verdict('Not a problem')).toHaveAccessibleDescription('Within the rules. Nothing is done to the reported person.');
    expect(verdict('Bad faith')).toHaveAccessibleDescription('The report was made to abuse the tool. It counts against the reporter.');
  });

  it('shows the ladder suggestion for the reported person, with its reason', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const detail = await w.client.getReport(f.id);
    await ready(w, f.id);
    const banner = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    expect(detail.suggest.outcome).toEqual({ kind: 'chat', durationMs: DAY });
    expect(within(banner).getByText('Chat restriction, 24 hours')).toBeInTheDocument();
    expect(within(banner).getByText(detail.suggest.why)).toBeInTheDocument();
  });

  it('suggests more for someone with a record', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'chat', 1);
    const detail = await w.client.getReport(f.id);
    await ready(w, f.id);
    const banner = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    expect(detail.suggest.outcome).not.toEqual({ kind: 'chat', durationMs: DAY });
    expect(within(banner).queryByText('Chat restriction, 24 hours')).not.toBeInTheDocument();
    expect(within(banner).getByText(outcomeWords(detail.suggest.outcome))).toBeInTheDocument();
  });

  it('shows a closed report\'s decision instead of the form', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.client.decide(f.id, { verdict: 'upheld', reason: 'Clear case.', actions: [{ subject: f.person, kind: 'warning', durationMs: null, rule: 1 }] });
    renderHub(w, { path: `/reports/${f.id}` });
    expect(await within(await screen.findByRole('region', { name: 'Decision' })).findByText('Actioned')).toBeInTheDocument();
    expect(within(panel()).getByText(/Decided by ann@example.test/)).toBeInTheDocument();
    expect(within(panel()).getByText('Clear case.')).toBeInTheDocument();
    expect(within(panel()).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
  });

  it('shows a bad-faith decision with its evidence', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.client.decide(f.id, { verdict: 'bad_faith', reason: 'Abuse.', evidence: 'They reported their own friend.', actions: [] });
    renderHub(w, { path: `/reports/${f.id}` });
    const p = await screen.findByRole('region', { name: 'Decision' });
    expect(await within(p).findByText('Dismissed')).toBeInTheDocument();
    expect(within(p).getByText('Bad faith')).toBeInTheDocument();
    expect(within(p).getByText('They reported their own friend.')).toBeInTheDocument();
  });

  it('a role that cannot decide reports sees why, and no form', async () => {
    const w = await hubWorld({ permissions: { 'reports.decide': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    renderHub(w, { path: `/reports/${f.id}` });
    const p = await screen.findByRole('region', { name: 'Decision' });
    expect(await within(p).findByText('Your role can read reports but not decide them.')).toBeInTheDocument();
    expect(within(p).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(p).queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
  });

  it('a role that cannot apply sanctions can still decide, with no action to add', async () => {
    const w = await hubWorld({ permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    expect(within(panel()).queryByRole('button', { name: 'Add an action' })).not.toBeInTheDocument();
    expect(within(panel()).getByText('Your role cannot apply sanctions. You can still decide the report.')).toBeInTheDocument();
    await user.click(verdict('Not a problem'));
    await reason(user, 'Fine.');
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toEqual({ verdict: 'no_action', reason: 'Fine.', actions: [] });
  });

  it('says so when the rules cannot be loaded, and loads them again on retry', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    let fail = true;
    w.intercept.fn = (req) => (fail && req.path === '/policy' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = renderHub(w, { path: `/reports/${f.id}` });
    const p = await screen.findByRole('region', { name: 'Decision' });
    expect(await within(p).findByRole('alert')).toHaveTextContent('Could not load the Community Rules.');
    fail = false;
    await user.click(within(p).getByRole('button', { name: 'Try again' }));
    expect(await within(p).findByRole('radio', { name: 'Fair' })).toBeInTheDocument();
  });
});

describe('DecisionPanel: the conduct level', () => {
  it('offers the four levels, none chosen', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await ready(w, f.id);
    const levels = within(panel()).getByRole('group', { name: 'How serious is the conduct?' });
    expect(within(levels).getAllByRole('button').map((b) => b.textContent)).toEqual(['Banter', 'Rude', 'Hostile', 'Severe']);
    for (const b of within(levels).getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'false');
  });

  it('asks the server for another level and shows its answer', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning', 1);
    const severe = await w.client.suggest(f.id, { level: 'severe' });
    const { user } = await ready(w, f.id);
    const levels = within(panel()).getByRole('group', { name: 'How serious is the conduct?' });
    await user.click(within(levels).getByRole('button', { name: 'Severe' }));
    await waitFor(() => expect(within(levels).getByRole('button', { name: 'Severe' })).toHaveAttribute('aria-pressed', 'true'));
    const asked = w.sent.filter((r) => r.method === 'POST' && r.path === `/reports/${f.id}/suggest`);
    // It names the reported person, and no rule while no action cites one.
    expect(asked.at(-1)?.body).toEqual({ level: 'severe', person: f.person });
    const banner = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    await within(banner).findByText(severe.why);
    expect(within(live()).queryByText(/./)).not.toBeNull();
  });

  it('keeps the old suggestion and says so when the level cannot be checked', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    w.intercept.fn = (req) => (req.path.endsWith('/suggest') ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const banner = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    const before = banner.textContent;
    await user.click(within(panel()).getByRole('button', { name: 'Hostile' }));
    expect(await within(banner).findByRole('alert')).toHaveTextContent('Could not update the suggestion. The server had a problem. Try again in a moment.');
    expect(banner.textContent).toContain('Chat restriction, 24 hours');
    expect(before).toContain('Chat restriction, 24 hours');
    expect(within(panel()).getByRole('button', { name: 'Hostile' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the latest pick wins when two answers cross', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const release: Array<() => void> = [];
    w.intercept.fn = (req) => {
      if (!req.path.endsWith('/suggest')) return undefined;
      return new Promise((resolve) => release.push(() => resolve(undefined)));
    };
    await user.click(within(panel()).getByRole('button', { name: 'Rude' }));
    await user.click(within(panel()).getByRole('button', { name: 'Severe' }));
    expect(release).toHaveLength(2);
    await act(async () => {
      release[1]!();
      await Promise.resolve();
    });
    await act(async () => {
      release[0]!();
      await Promise.resolve();
    });
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Severe' })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(panel()).getByRole('button', { name: 'Rude' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('"Add this action" puts the suggestion in as the reported person\'s action, under Fair, with the report\'s rule', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    // With no verdict yet, adding the action chooses "fair" (the only verdict that may act on the reported person), and says so.
    await user.click(within(panel()).getByRole('button', { name: 'Add this action' }));
    expect(verdict('Fair')).toBeChecked();
    expect(live()).toHaveTextContent('Added action 1. Your decision is fair.');
    const group = action(1);
    expect(within(group).getByLabelText('Person')).toHaveDisplayValue(/^Mallory/);
    expect(within(group).getByLabelText('What happens')).toHaveDisplayValue('Chat restriction, 24 hours');
    expect(within(group).getByLabelText('Community Rule')).toHaveValue(String(CATEGORY_TO_RULE.harassment));
  });

  it('"Add this action" twice does not double the action', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Add this action' }));
    // It is in the plan now, so there is nothing more to add; the button is gone, not a second action.
    expect(within(panel()).queryByRole('button', { name: 'Add this action' })).not.toBeInTheDocument();
    expect(within(panel()).getAllByRole('group', { name: /^Action / })).toHaveLength(1);
  });

  it('"Add this action" is not offered under a dismissal, which cannot act on the reported person, and does not flip the verdict', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(within(panel()).getByRole('radio', { name: 'Not a problem' }));
    expect(within(panel()).queryByRole('group', { name: 'The ladder suggests' })).not.toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Add this action' })).not.toBeInTheDocument();
    expect(verdict('Not a problem')).toBeChecked();
    await user.click(within(panel()).getByRole('radio', { name: 'Bad faith' }));
    expect(within(panel()).queryByRole('button', { name: 'Add this action' })).not.toBeInTheDocument();
    expect(verdict('Bad faith')).toBeChecked();
  });

  it('a permanent suggestion cannot be added by a moderator, and says who can', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'ban', 1, 30 * DAY);
    const detail = await w.client.getReport(f.id);
    expect(detail.suggest.outcome).toEqual({ kind: 'ban', durationMs: null });
    await ready(w, f.id);
    const banner = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    expect(within(banner).getByText('Ban, permanent')).toBeInTheDocument();
    expect(within(banner).queryByRole('button', { name: 'Add this action' })).not.toBeInTheDocument();
    expect(within(banner).getByText('Only a senior moderator can make this permanent.')).toBeInTheDocument();
  });

  it('a senior can add the permanent suggestion', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'ban', 1, 30 * DAY);
    const { user } = await ready(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Add this action' }));
    expect(within(action(1)).getByLabelText('What happens')).toHaveDisplayValue('Ban, permanent');
  });
});

describe('DecisionPanel: building the actions', () => {
  it('offers the ladder\'s presets, a note and "Something else"', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, {});
    const options = within(within(group).getByLabelText('What happens')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose', 'Warning', 'Chat restriction, 24 hours', 'Chat restriction, 7 days', 'Ban, 7 days', 'Ban, 30 days', 'Ban, permanent', 'Note', 'Something else']);
  });

  it('"Something else" adds a kind and a length', async () => {
    const w = await hubWorld({ role: 'senior' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Something else' });
    const kinds = within(within(group).getByLabelText('Kind')).getAllByRole('option').map((o) => o.textContent);
    expect(kinds).toEqual(['Chat restriction', 'Area restriction', 'Ban', 'Warning', 'Note']);
    const lengths = within(within(group).getByLabelText('Length')).getAllByRole('option').map((o) => o.textContent);
    expect(lengths).toEqual(['1 hour', '24 hours', '7 days', '30 days', 'Permanent']);
  });

  it('a warning or a note has no length to choose', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Something else' });
    expect(within(group).getByLabelText('Length')).toBeInTheDocument();
    await pick(user, within(group).getByLabelText('Kind'), 'Warning');
    expect(within(group).queryByLabelText('Length')).not.toBeInTheDocument();
    await pick(user, within(group).getByLabelText('Kind'), 'Area restriction');
    expect(within(group).getByLabelText('Length')).toBeInTheDocument();
    await pick(user, within(group).getByLabelText('Kind'), 'Note');
    expect(within(group).queryByLabelText('Length')).not.toBeInTheDocument();
  });

  it('lists the people the report names, with their role and tag', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, {});
    const names = within(within(group).getByLabelText('Person')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual([
      expect.stringMatching(/^Mallory \(reported person, .{8}\)$/),
      expect.stringMatching(/^Reporter\d+ \(reporter, .{8}\)$/),
      expect.stringMatching(/^Bystander \(other player, .{8}\)$/),
    ]);
    for (const n of names) expect(n).not.toContain(f.person);
  });

  it('the reported person cannot be picked under "Not a problem" or "Bad faith"', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    for (const name of ['Not a problem', 'Bad faith']) {
      await user.click(verdict(name));
      const group = await addAction(user, 1, {});
      const names = within(within(group).getByLabelText('Person')).getAllByRole('option').map((o) => o.textContent);
      expect(names.some((n) => /^Mallory/.test(n ?? '')), name).toBe(false);
      expect(names).toHaveLength(2);
      await user.click(within(group).getByRole('button', { name: 'Remove action 1' }));
    }
  });

  it('a new action starts on the reported person under Fair and on the reporter otherwise', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    let group = await addAction(user, 1, {});
    expect(within(group).getByLabelText('Person')).toHaveDisplayValue(/^Mallory/);
    await user.click(within(group).getByRole('button', { name: 'Remove action 1' }));
    await user.click(verdict('Bad faith'));
    group = await addAction(user, 1, {});
    expect(within(group).getByLabelText('Person')).toHaveDisplayValue(/^Reporter/);
  });

  it('moving to "Not a problem" removes the actions on the reported person, keeps the others, and says so', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await addAction(user, 1, { what: 'Warning' });
    await addAction(user, 2, { who: /^Reporter/, what: 'Note' });
    await user.click(verdict('Not a problem'));
    const groups = within(panel()).getAllByRole('group', { name: /^Action / });
    expect(groups).toHaveLength(1);
    expect(within(groups[0]!).getByLabelText('Person')).toHaveDisplayValue(/^Reporter/);
    expect(within(groups[0]!).getByLabelText('What happens')).toHaveDisplayValue('Note');
    expect(live()).toHaveTextContent('Removed 1 action on the reported person. A report that is not fair cannot act on them.');
  });

  it('removing an action renumbers the rest and announces it', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await addAction(user, 1, { what: 'Warning' });
    await addAction(user, 2, { who: /^Reporter/, what: 'Note' });
    await user.click(within(action(1)).getByRole('button', { name: 'Remove action 1' }));
    expect(within(panel()).getAllByRole('group', { name: /^Action / })).toHaveLength(1);
    expect(within(action(1)).getByLabelText('What happens')).toHaveDisplayValue('Note');
    expect(live()).toHaveTextContent('Removed action 1.');
  });

  it('puts focus somewhere sensible after an action is added and removed', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Add an action' }));
    expect(within(action(1)).getByLabelText('Person')).toHaveFocus();
    await user.click(within(action(1)).getByRole('button', { name: 'Remove action 1' }));
    expect(within(panel()).getByRole('button', { name: 'Add an action' })).toHaveFocus();
  });

  it('stops at 20 actions', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const add = within(panel()).getByRole('button', { name: 'Add an action' });
    for (let i = 0; i < 20; i += 1) await user.click(add);
    expect(within(panel()).getAllByRole('group', { name: /^Action / })).toHaveLength(20);
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(within(panel()).getByText('That is the most actions one decision can hold (20).')).toBeInTheDocument();
    await user.click(add);
    expect(within(panel()).getAllByRole('group', { name: /^Action / })).toHaveLength(20);
  });
});

describe('DecisionPanel: rules', () => {
  it('offers the rules in force, then "No rule covers this", and nothing is chosen yet for a person other than the reported one', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, {});
    const options = within(within(group).getByLabelText('Community Rule')).getAllByRole('option').map((o) => o.textContent);
    const all = w.cw.rules.all().map((r) => `Rule ${r.number}: ${r.title}`);
    expect(options).toEqual(['Choose a rule', ...all, 'No rule covers this']);
    expect(all.length).toBeGreaterThan(3);
  });

  it('starts on the rule the report\'s category maps to', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, category: 'spam' });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, {});
    expect(within(group).getByLabelText('Community Rule')).toHaveValue(String(CATEGORY_TO_RULE.spam));
  });

  it('does not list a retired rule, and does not start on it', async () => {
    const retired = CATEGORY_TO_RULE.harassment;
    if (typeof retired !== 'number') throw new Error('harassment maps to a rule');
    const w = await hubWorld({ retire: [retired] });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, {});
    const select = within(group).getByLabelText('Community Rule');
    expect(within(select).queryByRole('option', { name: new RegExp(`^Rule ${retired}:`) })).not.toBeInTheDocument();
    expect(select).toHaveValue('');
  });

  it('"No rule covers this" asks for a note, up to 500 characters', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Warning', rule: 'No rule covers this' });
    const note = within(group).getByRole('textbox', { name: 'What the rules do not cover' });
    expect(note).toBeInTheDocument();
    await user.type(note, 'Impersonating staff.');
    expect(within(group).getByText('20 of 500')).toBeInTheDocument();
    await pick(user, within(group).getByLabelText('Community Rule'), new RegExp(`^Rule ${CATEGORY_TO_RULE.harassment}:`));
    expect(within(group).queryByRole('textbox', { name: 'What the rules do not cover' })).not.toBeInTheDocument();
  });
});

describe('DecisionPanel: lines to show the player', () => {
  it('lists only the chosen person\'s own lines', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Warning' });
    const lines = within(group).getByRole('group', { name: 'Show the player these lines' });
    const boxes = within(lines).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toHaveAccessibleName(/a line from the target/);
    expect(boxes[1]).toHaveAccessibleName(/another line from the target/);
    expect(within(lines).queryByRole('checkbox', { name: /hello there/ })).not.toBeInTheDocument();
    expect(within(lines).queryByRole('checkbox', { name: /what is going on/ })).not.toBeInTheDocument();
  });

  it('changing the person changes the lines and forgets the old choice', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Warning' });
    await user.click(within(group).getByRole('checkbox', { name: /^.*a line from the target/ }));
    await pick(user, within(group).getByLabelText('Person'), /^Bystander/);
    const lines = within(group).getByRole('group', { name: 'Show the player these lines' });
    const boxes = within(lines).getAllByRole('checkbox');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toHaveAccessibleName(/what is going on/);
    expect(boxes[0]).not.toBeChecked();
    expect(within(group).getByText('0 of 5 chosen')).toBeInTheDocument();
  });

  it('allows five lines and no sixth', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: MANY });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Chat restriction, 24 hours' });
    const boxes = (): HTMLInputElement[] => within(group).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes()).toHaveLength(7);
    for (let i = 0; i < 5; i += 1) await user.click(boxes()[i]!);
    expect(within(group).getByText('5 of 5 chosen')).toBeInTheDocument();
    expect(boxes()[5]).toBeDisabled();
    expect(boxes()[6]).toBeDisabled();
    await user.click(boxes()[5]!);
    expect(boxes().filter((b) => b.checked)).toHaveLength(5);
    // The five chosen stay usable, so one can be swapped.
    expect(boxes()[0]).toBeEnabled();
    await user.click(boxes()[0]!);
    expect(within(group).getByText('4 of 5 chosen')).toBeInTheDocument();
    expect(boxes()[5]).toBeEnabled();
  });

  it('a note shows the player nothing, so offers no lines', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Warning' });
    expect(within(group).getByRole('group', { name: 'Show the player these lines' })).toBeInTheDocument();
    await pick(user, within(group).getByLabelText('What happens'), 'Note');
    expect(within(group).queryByRole('group', { name: 'Show the player these lines' })).not.toBeInTheDocument();
  });

  it('says so when the person wrote nothing in the excerpt', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }, { who: 'bystander', text: 'hm' }], cite: null });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Warning' });
    expect(within(group).getByText('Mallory wrote no lines in this excerpt.')).toBeInTheDocument();
    expect(within(group).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('marks a blocked line in the picker', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }, { who: 'target', text: 'you zorbak' }], cite: 1 });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Warning' });
    // The picker hides the blocked words as the transcript does; the tag says why.
    expect(within(group).getByRole('checkbox', { name: /Blocked words, hidden.*Blocked/ })).toBeInTheDocument();
    expect(group.textContent).not.toContain('zorbak');
  });
});

describe('DecisionPanel: permanent, by role', () => {
  it('a moderator is not offered permanent anywhere', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, { what: 'Something else' });
    expect(within(within(group).getByLabelText('What happens')).queryByRole('option', { name: 'Ban, permanent' })).not.toBeInTheDocument();
    // Chat restriction is the kind it starts on: permanent is fine there (only a permanent ban needs a senior, as on the server).
    expect(within(within(group).getByLabelText('Length')).getByRole('option', { name: 'Permanent' })).toBeInTheDocument();
    await pick(user, within(group).getByLabelText('Kind'), 'Area restriction');
    expect(within(within(group).getByLabelText('Length')).getByRole('option', { name: 'Permanent' })).toBeInTheDocument();
    await pick(user, within(group).getByLabelText('Kind'), 'Ban');
    expect(within(within(group).getByLabelText('Length')).queryByRole('option', { name: 'Permanent' })).not.toBeInTheDocument();
    expect(within(within(group).getByLabelText('Length')).getAllByRole('option')).toHaveLength(4);
  });

  it.each(['senior', 'owner'] as const)('a %s is offered permanent, and it goes through as null', async (role) => {
    const w = await hubWorld({ role });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await addAction(user, 1, { what: 'Ban, permanent' });
    await reason(user);
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'upheld', actions: [{ kind: 'ban', durationMs: null }] });
    expect(w.cw.sanctions.forPerson(f.person)[0]).toMatchObject({ kind: 'ban', endsAt: null });
  });

  it('a permission override changes who is offered it', async () => {
    const w = await hubWorld({ role: 'moderator', permissions: { 'sanctions.apply.ban_permanent': 'moderator' } });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    const group = await addAction(user, 1, {});
    expect(within(within(group).getByLabelText('What happens')).getByRole('option', { name: 'Ban, permanent' })).toBeInTheDocument();
  });
});

describe('DecisionPanel: refusing before sending', () => {
  it('names what is missing, sends nothing, and moves focus to the list', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await decide(user);
    const summary = await within(panel()).findByRole('alert');
    expect(summary).toHaveFocus();
    expect(within(summary).getByText('Fix 2 things before deciding.')).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: 'Choose what you decide.' })).toBeInTheDocument();
    expect(within(summary).getByRole('button', { name: 'Write a reason. Only staff see it.' })).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
  });

  it('each link in the list goes to its field', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await decide(user);
    const summary = await within(panel()).findByRole('alert');
    await user.click(within(summary).getByRole('button', { name: 'Write a reason. Only staff see it.' }));
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveFocus();
  });

  it('shows each message by its field too, linked with aria-describedby', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    const group = await addAction(user, 1, {});
    await pick(user, within(group).getByLabelText('Community Rule'), 'Choose a rule');
    await decide(user);
    const what = within(group).getByLabelText('What happens');
    expect(what).toBeInvalid();
    expect(what).toHaveAccessibleDescription(expect.stringContaining('Choose what happens.'));
    expect(within(group).getByLabelText('Community Rule')).toHaveAccessibleDescription(expect.stringContaining('Choose the rule this is under.'));
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveAccessibleDescription(expect.stringContaining('Write a reason.'));
    expect(decides(w)).toHaveLength(0);
  });

  it('bad faith needs evidence, 1 to 500 characters', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Bad faith'));
    await reason(user);
    await decide(user);
    expect(await within(panel()).findByRole('button', { name: 'Write the evidence for bad faith.' })).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
    const evidence = within(panel()).getByRole('textbox', { name: 'Evidence for bad faith' });
    expect(evidence).toBeInvalid();
    await user.click(evidence);
    await user.paste('x'.repeat(501));
    expect(within(panel()).getByText('501 of 500')).toBeInTheDocument();
    await decide(user);
    expect(await within(panel()).findByRole('button', { name: 'The evidence is over 500 characters. Shorten it.' })).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
    await user.clear(evidence);
    await user.paste('y'.repeat(500));
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'bad_faith', evidence: 'y'.repeat(500) });
  });

  it('evidence typed under bad faith is not sent once the verdict changes', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Bad faith'));
    await user.type(within(panel()).getByRole('textbox', { name: 'Evidence for bad faith' }), 'they lied');
    await user.click(verdict('Not a problem'));
    expect(within(panel()).queryByRole('textbox', { name: 'Evidence for bad faith' })).not.toBeInTheDocument();
    await reason(user, 'Fine.');
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toEqual({ verdict: 'no_action', reason: 'Fine.', actions: [] });
  });

  it('"No rule covers this" needs a note before it can be sent', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    const group = await addAction(user, 1, { what: 'Warning', rule: 'No rule covers this' });
    await reason(user);
    await decide(user);
    expect(await within(panel()).findByRole('button', { name: 'Say what the rules do not cover.' })).toBeInTheDocument();
    expect(within(group).getByRole('textbox', { name: 'What the rules do not cover' })).toBeInvalid();
    expect(decides(w)).toHaveLength(0);
    await user.type(within(group).getByRole('textbox', { name: 'What the rules do not cover' }), 'Nothing about fake staff.');
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toMatchObject({ actions: [{ rule: 'uncovered', gapNote: 'Nothing about fake staff.' }] });
    expect(await w.client.listGaps()).toMatchObject({ items: [{ status: 'open', note: 'Nothing about fake staff.' }] });
  });

  it('the reason counts its characters and refuses over 500', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Not a problem'));
    const box = within(panel()).getByRole('textbox', { name: 'Reason' });
    await user.type(box, 'Fine.');
    expect(within(panel()).getByText('5 of 500')).toBeInTheDocument();
    await user.clear(box);
    await user.click(box);
    await user.paste('z'.repeat(501));
    expect(within(panel()).getByText('501 of 500')).toBeInTheDocument();
    await decide(user);
    expect(await within(panel()).findByRole('button', { name: 'The reason is over 500 characters. Shorten it.' })).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
  });

  it('two actions of one kind for one person are refused, then fine once one changes', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await addAction(user, 1, { what: 'Warning' });
    const second = await addAction(user, 2, { what: 'Warning' });
    await reason(user);
    await decide(user);
    expect(await within(panel()).findByRole('button', { name: 'This person already has an action of this kind.' })).toBeInTheDocument();
    expect(decides(w)).toHaveLength(0);
    await pick(user, within(second).getByLabelText('What happens'), 'Chat restriction, 24 hours');
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(1);
  });

  it('the problems clear as they are fixed', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await decide(user);
    expect(await within(panel()).findByRole('alert')).toBeInTheDocument();
    await user.click(verdict('Fair'));
    await reason(user);
    expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).not.toBeInvalid();
  });
});

describe('DecisionPanel: sending', () => {
  it('a fair decision with a warning sends the body, shows the reference code and closes the report', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await addAction(user, 1, { what: 'Warning', rule: ruleText(w, 2) });
    await reason(user, '  Said it again.  ');
    await decide(user);
    expect(await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' })).toBeInTheDocument();
    expect(decides(w)).toHaveLength(1);
    expect(decides(w)[0]!.path).toBe(`/reports/${f.id}/decide`);
    expect(decides(w)[0]!.body).toEqual({
      verdict: 'upheld',
      reason: 'Said it again.',
      actions: [{ subject: f.person, kind: 'warning', durationMs: null, rule: 2 }],
    });
    const stored = w.cw.sanctions.forPerson(f.person);
    expect(stored).toHaveLength(1);
    const results = within(panel()).getByRole('list', { name: 'Reference codes' });
    expect(within(results).getByText(`${stored[0]!.refCode} (Warning)`)).toBeInTheDocument();
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
    expect(live()).toHaveTextContent('Decided. The report is closed.');
    expect(within(panel()).queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
  });

  it('shows the report as actioned afterwards (the page reloads)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await addAction(user, 1, { what: 'Warning', rule: ruleText(w, 2) });
    await reason(user);
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    const facts = screen.getByRole('group', { name: 'About this report' });
    await within(facts).findByText('Actioned');
    expect(within(panel()).getByText('Decided. The report is closed.', { selector: 'strong' })).toBeInTheDocument();
  });

  it('moves focus to the result', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Not a problem'));
    await reason(user);
    await decide(user);
    const done = await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    await waitFor(() => expect(done.closest('[tabindex="-1"]')).toHaveFocus());
  });

  it('fair with only notes is sent as noted', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await addAction(user, 1, { what: 'Note', rule: ruleText(w, 3) });
    await reason(user);
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'noted', actions: [{ kind: 'note', durationMs: null, rule: 3 }] });
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
  });

  it('fair with a note and a warning is upheld', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await addAction(user, 1, { what: 'Note', rule: ruleText(w, 3) });
    await addAction(user, 2, { who: /^Bystander/, what: 'Warning', rule: ruleText(w, 3) });
    await reason(user);
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'upheld' });
    expect(within(panel()).getAllByRole('listitem').map((li) => /\((\w+)\)$/.exec(li.textContent ?? '')?.[1]).sort()).toEqual(['Note', 'Warning']);
  });

  it('fair with no action is upheld and says no sanction was applied', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await reason(user);
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toEqual({ verdict: 'upheld', reason: 'It broke the rules.', actions: [] });
    expect(within(panel()).getByText('No sanction was applied.')).toBeInTheDocument();
    expect(within(panel()).queryByRole('list', { name: 'Reference codes' })).not.toBeInTheDocument();
  });

  it('not a problem dismisses the report', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Not a problem'));
    await reason(user, 'Banter.');
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(w.cw.reports.get(f.id)).toMatchObject({ status: 'dismissed', badFaith: false });
  });

  it('bad faith dismisses the report with the mark and the evidence', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Bad faith'));
    await user.type(within(panel()).getByRole('textbox', { name: 'Evidence for bad faith' }), '  They reported a friend.  ');
    await reason(user, 'Abuse.');
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toEqual({ verdict: 'bad_faith', evidence: 'They reported a friend.', reason: 'Abuse.', actions: [] });
    expect(w.cw.reports.get(f.id)).toMatchObject({ status: 'dismissed', badFaith: true, badFaithEvidence: 'They reported a friend.' });
  });

  it('not a problem can still sanction the reporter', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Not a problem'));
    await addAction(user, 1, { who: /^Reporter/, what: 'Warning', rule: ruleText(w, 4) });
    await reason(user);
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'no_action', actions: [{ subject: f.reporter, kind: 'warning' }] });
    expect(w.cw.sanctions.forPerson(f.reporter)).toHaveLength(1);
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(0);
  });

  it('"Something else" sends the chosen kind and length', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    const group = await addAction(user, 1, { what: 'Something else', rule: ruleText(w, 5) });
    await pick(user, within(group).getByLabelText('Kind'), 'Area restriction');
    await pick(user, within(group).getByLabelText('Length'), '7 days');
    await reason(user);
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toMatchObject({ actions: [{ kind: 'area', durationMs: 7 * DAY, rule: 5 }] });
  });

  it('sends the chosen lines, and the player\'s notice carries them', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    const group = await addAction(user, 1, { what: 'Warning', rule: ruleText(w, 2) });
    await user.click(within(group).getByRole('checkbox', { name: /^.*another line from the target/ }));
    await reason(user);
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    const sent = decides(w)[0]!.body as { actions: Array<{ lineIds?: string[] }> };
    expect(sent.actions[0]?.lineIds).toEqual([f.lineIds[3]]);
  });

  it('trims the reason and the notes before sending', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    const group = await addAction(user, 1, { what: 'Warning', rule: 'No rule covers this' });
    await user.type(within(group).getByRole('textbox', { name: 'What the rules do not cover' }), '  odd case  ');
    await reason(user, '   because   ');
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[0]!.body).toMatchObject({ reason: 'because', actions: [{ gapNote: 'odd case' }] });
  });
});

describe('DecisionPanel: double submit, replay, conflict and failure', () => {
  async function filled(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
    const r = await ready(w, id, options);
    await r.user.click(verdict('Fair'));
    await addAction(r.user, 1, { what: 'Warning', rule: ruleText(w, 2) });
    await reason(r.user);
    return r;
  }

  it('a double click sends one decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    await user.dblClick(decideButton());
    await sendNow();
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(1);
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
    // One decision, and no read of the report afterwards (it is audited): the second click did not run anything again either.
    expect(w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${f.id}`)).toHaveLength(1);
  });

  it('two clicks in the same instant send one decision and run the aftermath once', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await filled(w, f.id);
    const button = decideButton();
    await act(async () => {
      button.click();
      button.click();
      button.click();
    });
    await sendNow();
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(1);
    expect(w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${f.id}`)).toHaveLength(1);
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
  });

  it('pressing Enter twice in a row sends one decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    decideButton().focus();
    await user.keyboard('{Enter}{Enter}');
    await sendNow();
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(1);
  });

  it('while it sends, the button says so and the form keeps its input', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    let release: () => void = () => undefined;
    w.intercept.fn = (req) => (isDecide(req) ? new Promise((resolve) => (release = () => resolve(undefined))) : undefined);
    await decide(user);
    // While it sends, the bar says so (busy), and the form is put away, not thrown away: it comes back if the send fails.
    const busy = await within(panel()).findByText('Deciding');
    expect(busy.closest('[aria-busy="true"]')).not.toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
  });

  it('the same decision already made by someone else is a success, not an error', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    const first = await w.client.decide(f.id, {
      verdict: 'upheld',
      reason: 'another moderator\'s words',
      actions: [{ subject: f.person, kind: 'warning', durationMs: null, rule: 2 }],
    });
    await decide(user);
    expect(await within(panel()).findByText('This decision was already recorded. Nothing was applied twice.', { selector: 'p' })).toBeInTheDocument();
    expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(panel()).getByText(`${first.groups[0]!.refCode} (Warning)`)).toBeInTheDocument();
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
  });

  it('a different decision made meanwhile is a conflict: it says so, reloads and shows the other decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    await w.client.decide(f.id, { verdict: 'no_action', reason: 'The other moderator saw banter.', actions: [] });
    await decide(user);
    // In an alert in the bar (the live region says it too), and focused so the keyboard is not left on a hidden form.
    const said = await within(panel()).findAllByText('Someone already decided this report.');
    expect(said.some((e) => e.closest('[role="alert"]') !== null)).toBe(true);
    await within(panel()).findByText('The other moderator saw banter.');
    expect(within(panel()).queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
    expect(w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${f.id}`).length).toBeGreaterThanOrEqual(2);
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(0);
    expect(live()).toHaveTextContent('Someone already decided this report.');
  });

  it('a network failure keeps every input and offers Try again, which sends the same decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    let down = true;
    w.intercept.fn = (req) => {
      if (isDecide(req) && down) throw new TypeError('offline');
      return undefined;
    };
    await decide(user);
    const alert = await within(panel()).findByRole('alert');
    expect(alert).toHaveTextContent('Could not reach the server. Check your connection and try again.');
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('It broke the rules.');
    expect(verdict('Fair')).toBeChecked();
    expect(within(action(1)).getByLabelText('What happens')).toHaveDisplayValue('Warning');
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    down = false;
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)).toHaveLength(2);
    expect(decides(w)[1]!.body).toEqual(decides(w)[0]!.body);
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
  });

  it('a lost answer is safe to retry: the decision landed, the retry is a replay', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    let lose = true;
    w.intercept.fn = async (req) => {
      if (isDecide(req) && lose) {
        lose = false;
        await w.handle({ method: req.method, path: req.path, query: {}, headers: {}, body: undefined, rawBody: JSON.stringify(req.body) });
        throw new TypeError('connection dropped after the server answered');
      }
      return undefined;
    };
    await decide(user);
    const alert = await within(panel()).findByRole('alert');
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(panel()).findByText('This decision was already recorded. Nothing was applied twice.', { selector: 'p' })).toBeInTheDocument();
    expect(w.cw.sanctions.forPerson(f.person)).toHaveLength(1);
  });

  it.each([
    [500, 'internal', 'The server had a problem. Try again in a moment.'],
    [403, 'forbidden', 'Your role cannot do this.'],
    [401, 'unauthorized', 'You are signed out. Sign in again to continue.'],
    [404, 'not_found', 'That no longer exists.'],
    [429, 'rate_limited', 'Too many requests. Try again in a moment.'],
    [413, 'payload_too_large', 'The decision is too large to send. Remove some actions or shorten the text.'],
    [400, 'invalid_request', 'The server did not accept this decision. Check the reason, the rules and the lines, then try again.'],
    [400, 'invalid_excerpt', 'The server did not accept the lines chosen for the player. Choose only lines this person wrote.'],
    [400, 'invalid_sanction', 'The server did not accept one of the actions. Check each action.'],
  ])('a %s (%s) is explained in the panel and keeps the input', async (status, code, message) => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    w.intercept.fn = (req) => (isDecide(req) ? { status, body: { error: code, message: 'raw server words that must not be shown' } } : undefined);
    await decide(user);
    const alert = await within(panel()).findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert).not.toHaveTextContent('raw server words');
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('It broke the rules.');
    expect(within(action(1)).getByLabelText('What happens')).toHaveDisplayValue('Warning');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('the error goes away on the next attempt', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    let fail = true;
    w.intercept.fn = (req) => (isDecide(req) && fail ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await decide(user);
    await within(panel()).findByRole('alert');
    fail = false;
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('editing after a failure sends the edited decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    let fail = true;
    w.intercept.fn = (req) => (isDecide(req) && fail ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await decide(user);
    await within(panel()).findByRole('alert');
    fail = false;
    await pick(user, within(action(1)).getByLabelText('What happens'), 'Chat restriction, 24 hours');
    await decide(user);
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(decides(w)[1]!.body).toMatchObject({ actions: [{ kind: 'chat', durationMs: DAY }] });
  });

  it('a decision made after the page was open, on a report that has since been deleted, says it is gone', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await filled(w, f.id);
    w.intercept.fn = (req) => (isDecide(req) ? { status: 404, body: { error: 'not_found', message: 'Not found.' } } : undefined);
    await decide(user);
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('That no longer exists.');
  });
});

describe('DecisionPanel: keyboard', () => {
  /** Presses Tab until `target` has focus (at most `max` presses). */
  async function tabTo(user: UserEvent, target: HTMLElement, max = 120): Promise<void> {
    for (let i = 0; i < max; i += 1) {
      if (document.activeElement === target) return;
      await user.tab();
    }
    throw new Error('could not reach the control by Tab');
  }

  it('every control can be reached by Tab, in page order, and none steals the order with a positive tabindex', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await ready(w, f.id);
    await user.click(verdict('Fair'));
    await addAction(user, 1, { what: 'Warning' });
    const controls = [...panel().querySelectorAll<HTMLElement>('input, select, textarea, button:not([disabled])')].filter((el) => el.getAttribute('aria-disabled') !== 'true');
    expect(controls.length).toBeGreaterThan(12);
    for (const el of container.querySelectorAll('[tabindex]')) expect(Number(el.getAttribute('tabindex'))).toBeLessThanOrEqual(0);
    const reached: HTMLElement[] = [];
    (document.activeElement as HTMLElement | null)?.blur();
    for (let i = 0; i < 160 && reached.length < controls.length; i += 1) {
      await user.tab();
      const now = document.activeElement as HTMLElement;
      if (panel().contains(now) && !reached.includes(now) && controls.includes(now)) reached.push(now);
    }
    // Radios are one tab stop for the group, so only the checked (or first) one is reached by Tab.
    const radios = controls.filter((c) => (c as HTMLInputElement).type === 'radio');
    const expected = controls.filter((c) => !radios.includes(c) || c === document.querySelector('input[type=radio]:checked'));
    for (const el of expected) expect(reached, el.outerHTML.slice(0, 80)).toContain(el);
  });

  it('a whole decision can be made without a pointer', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    // Verdict: Tab into the group, Space on the focused radio.
    await tabTo(user, verdict('Fair'));
    await user.keyboard(' ');
    expect(verdict('Fair')).toBeChecked();
    // Arrow keys move through the radios, as native radios do.
    await user.keyboard('{ArrowDown}');
    expect(verdict('Not a problem')).toBeChecked();
    await user.keyboard('{ArrowUp}');
    expect(verdict('Fair')).toBeChecked();
    // An action: Enter on "Add an action" moves focus into it.
    const add = within(panel()).getByRole('button', { name: 'Add an action' });
    await tabTo(user, add);
    await user.keyboard('{Enter}');
    const group = action(1);
    expect(within(group).getByLabelText('Person')).toHaveFocus();
    // The menus are native selects: reach each by Tab; a browser opens them with the keyboard (jsdom cannot, so the value is set).
    const what = within(group).getByLabelText('What happens');
    await tabTo(user, what);
    expect(what).toHaveFocus();
    await user.selectOptions(what, 'Warning');
    const rule = within(group).getByLabelText('Community Rule');
    await tabTo(user, rule);
    await user.selectOptions(rule, ruleText(w, 2));
    // A line to show, by Space.
    const line = within(group).getByRole('checkbox', { name: /^.*another line from the target/ });
    await tabTo(user, line);
    await user.keyboard(' ');
    expect(line).toBeChecked();
    // The reason, typed.
    const box = within(panel()).getByRole('textbox', { name: 'Reason' });
    await tabTo(user, box);
    await user.keyboard('Typed without a mouse.');
    // Submit with Enter on the button.
    await tabTo(user, decideButton());
    await user.keyboard('{Enter}');
    await sendNow();
    expect(await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' })).toBeInTheDocument();
    expect(decides(w)[0]!.body).toEqual({
      verdict: 'upheld',
      reason: 'Typed without a mouse.',
      actions: [{ subject: f.person, kind: 'warning', durationMs: null, rule: 2, lineIds: [f.lineIds[3]] }],
    });
  });

  it('Enter in the reason box does not submit (it is a multi-line box)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Not a problem'));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'one{Enter}two');
    expect(decides(w)).toHaveLength(0);
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('one\ntwo');
  });

  it('Enter in a text field never submits by accident (the only way is the button)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await ready(w, f.id);
    await user.click(verdict('Not a problem'));
    await reason(user, 'x');
    await user.click(verdict('Bad faith'));
    await user.type(within(panel()).getByRole('textbox', { name: 'Evidence for bad faith' }), 'e{Enter}');
    expect(decides(w)).toHaveLength(0);
  });
});
