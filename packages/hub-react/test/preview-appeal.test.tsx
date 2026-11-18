import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { appealsHub, DAY, HOUR } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import type { WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The appeal card's choice and "What the player sees" (0.2.0): Keep, Make it lighter, Remove it are a radio group and nothing is sent until "Send decision".
// The panel follows the choice and the lighter picker. Against the real routes. Synthetic words only.

const SENIOR: WorldOptions = { role: 'senior', actor: 'bea@example.test' };
const decides = (w: AppealsHub): TransportRequest[] => w.sent.filter((r) => r.method === 'POST' && /^\/appeals\/[^/]+\/decide$/.test(r.path));

async function open(w: AppealsHub, appealId: string) {
  const r = renderHub(w, { path: `/appeals/${appealId}` });
  await screen.findByRole('region', { name: 'What the player said' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  const decision = screen.getByRole('region', { name: 'Your decision on this appeal' });
  const panel = await within(decision).findByRole('region', { name: 'What the player sees' });
  return { ...r, decision, panel };
}
const radio = (scope: HTMLElement, name: string): HTMLElement => within(scope).getByRole('radio', { name });
const titles = (panel: HTMLElement): string[] => [...panel.querySelectorAll('h4')].map((h) => h.textContent ?? '');

describe('the choice', () => {
  it('the three outcomes are a radio group named Decision; nothing is chosen at first and nothing is sent until Send decision', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user, decision } = await open(w, a.appealId);
    const group = within(decision).getByRole('group', { name: 'Decision' });
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['Keep the decision', 'Make it lighter', 'Remove it']);
    for (const r of within(group).getAllByRole('radio')) expect(r).not.toBeChecked();
    await user.type(within(decision).getByLabelText('Why (private)'), 'a reason');
    await user.click(radio(decision, 'Keep the decision'));
    await user.click(radio(decision, 'Remove it'));
    await user.click(radio(decision, 'Make it lighter'));
    expect(decides(w)).toEqual([]);
  });

  it('Enter in the reason box does not send', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user, decision } = await open(w, a.appealId);
    await user.click(radio(decision, 'Keep the decision'));
    await user.type(within(decision).getByLabelText('Why (private)'), 'one line{Enter}another');
    expect(decides(w)).toEqual([]);
  });

  it('with no outcome chosen, Send decision says so and sends nothing', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user, decision } = await open(w, a.appealId);
    await user.type(within(decision).getByLabelText('Why (private)'), 'a reason');
    await user.click(within(decision).getByRole('button', { name: 'Send decision' }));
    expect(within(decision).getByText('Choose what to do with this decision.')).toBeInTheDocument();
    expect(decides(w)).toEqual([]);
  });

  it.each([
    ['Keep the decision', 'uphold'],
    ['Remove it', 'revoke'],
  ] as const)('%s sends the body 0.1.9 sent (outcome, reason)', async (name, outcome) => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user, decision } = await open(w, a.appealId);
    await user.type(within(decision).getByLabelText('Why (private)'), 'The chat log is clear.');
    await user.click(radio(decision, name));
    await user.click(within(decision).getByRole('button', { name: 'Send decision' }));
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.body).toEqual({ outcome, reason: 'The chat log is clear.' });
  });

  it('Make it lighter sends the outcome, the kind and the length of the picker, and the reason', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 6 * HOUR, 24 * HOUR] } });
    const a = await w.appeal({ kind: 'chat', durationMs: 24 * HOUR });
    const { user, decision } = await open(w, a.appealId);
    await user.type(within(decision).getByLabelText('Why (private)'), 'Too long for a first offence.');
    await user.click(radio(decision, 'Make it lighter'));
    await user.selectOptions(within(decision).getByLabelText('How long'), '1h');
    await user.click(within(decision).getByRole('button', { name: 'Send decision' }));
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]?.body).toEqual({ outcome: 'reduce', reason: 'Too long for a first offence.', to: { kind: 'chat', durationMs: HOUR } });
  });
});

describe('the panel follows the choice', () => {
  it('nothing chosen shows the prompt', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { panel } = await open(w, a.appealId);
    expect(panel).toHaveTextContent('Choose what happens to see what the player is sent.');
  });

  it('keep shows the "kept" notice with the original reference and the rule', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'ban', durationMs: null, rule: 3 });
    const { user, decision, panel } = await open(w, a.appealId);
    await user.click(radio(decision, 'Keep the decision'));
    await waitFor(() => expect(titles(panel)).toEqual(['We looked again and kept the decision']));
    expect(panel).toHaveTextContent('A moderator read your appeal. The original decision stands.');
    expect(panel).toHaveTextContent('Community Rule 3');
    const history = await w.client.personHistory(a.person);
    const ref = history.sanctions[0]?.refCode as string;
    expect(ref).toMatch(/\S/);
    expect(panel).toHaveTextContent(ref);
    expect(panel).toHaveTextContent('The sanction stays as it was.');
  });

  it('lighter shows two notices in order, with the new end and the old one, and follows the picker', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 6 * HOUR, 24 * HOUR, 7 * DAY] } });
    const a = await w.appeal({ kind: 'ban', durationMs: 7 * DAY });
    w.clock.t += 60_000;
    const { user, decision, panel } = await open(w, a.appealId);
    await user.click(radio(decision, 'Make it lighter'));
    await user.selectOptions(within(decision).getByLabelText('What it becomes'), 'chat');
    await user.selectOptions(within(decision).getByLabelText('How long'), '24h');
    await waitFor(() => expect(titles(panel)).toEqual(['Your chat is turned off', 'We looked again and changed the decision']));
    expect(panel).toHaveTextContent('Notice 1 of 2');
    expect(panel).toHaveTextContent('Notice 2 of 2');
    expect(panel).toHaveTextContent('The first notice is withdrawn.');
    expect(panel.textContent).toMatch(/Their chat restriction now ends .+; it was .+\./);
    // A shorter length moves the new end, and (a minute after the sanction began) it has not run its course.
    await user.selectOptions(within(decision).getByLabelText('How long'), '1h');
    await waitFor(() => expect(panel).toHaveTextContent('(in 59 minutes)'));
    expect(panel).not.toHaveTextContent('has already run its course');
  });

  it('a reduction to a warning shows Acknowledge', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'chat', durationMs: 24 * HOUR });
    const { user, decision, panel } = await open(w, a.appealId);
    await user.click(radio(decision, 'Make it lighter'));
    await user.selectOptions(within(decision).getByLabelText('What it becomes'), 'warning');
    await waitFor(() => expect(titles(panel)[0]).toBe('You have a warning'));
    expect(panel).toHaveTextContent('Button: Acknowledge');
    expect(panel).toHaveTextContent('Press Acknowledge to confirm you saw this.');
  });

  it('a reduction already over shows the ended line', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 24 * HOUR] } });
    const a = await w.appeal({ kind: 'ban', durationMs: null });
    w.clock.t += 3 * DAY;
    const { user, decision, panel } = await open(w, a.appealId);
    await user.click(radio(decision, 'Make it lighter'));
    await user.selectOptions(within(decision).getByLabelText('What it becomes'), 'chat');
    await user.selectOptions(within(decision).getByLabelText('How long'), '1h');
    await waitFor(() => expect(panel).toHaveTextContent('The lighter decision has already run its course, so it is on their record as ended.'));
    expect(panel.querySelector('dt')?.parentElement?.parentElement?.textContent).toContain('Ended');
  });

  it('remove shows the "removed" notice and what lifts', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'chat', durationMs: 24 * HOUR });
    const { user, decision, panel } = await open(w, a.appealId);
    await user.click(radio(decision, 'Remove it'));
    await waitFor(() => expect(titles(panel)).toEqual(['We looked again and removed the decision']));
    expect(panel).toHaveTextContent('The sanction is removed and the first notice is withdrawn.');
    expect(panel).toHaveTextContent('They can chat again at once.');
  });

  it('the lighter picker offers only lighter kinds and the profile\'s lengths, and drives the panel', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 6 * HOUR, 24 * HOUR] } });
    const a = await w.appeal({ kind: 'area', durationMs: 24 * HOUR });
    const { user, decision, panel } = await open(w, a.appealId);
    await user.click(radio(decision, 'Make it lighter'));
    const kind = within(decision).getByLabelText('What it becomes') as HTMLSelectElement;
    expect([...kind.options].map((o) => o.textContent)).toEqual(['Warning', 'Chat restriction', 'Area restriction']);
    await user.selectOptions(kind, 'area');
    expect([...(within(decision).getByLabelText('How long') as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['1 hour', '6 hours']);
    await waitFor(() => expect(titles(panel)[0]).toBe('You cannot join public rooms'));
  });

  it('for a warning the lighter choice is not available, and says why', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal({ kind: 'warning' });
    const { decision } = await open(w, a.appealId);
    expect(radio(decision, 'Make it lighter')).toBeDisabled();
    expect(within(decision).getByText('A warning is the lightest there is.')).toBeInTheDocument();
  });
});

describe('Review Focus 1: the statement and the private reason never reach the panel', () => {
  it('the statement the player wrote and the reason typed are in no part of the panel, for every choice', async () => {
    const w = await appealsHub({ ...SENIOR, overrides: { durations: [HOUR, 6 * HOUR, 24 * HOUR] } });
    const a = await w.appeal({ kind: 'chat', durationMs: 24 * HOUR, statement: 'SENTINEL-STATEMENT-fenrisk I was only joking around' });
    const { user, decision, panel } = await open(w, a.appealId);
    await user.type(within(decision).getByLabelText('Why (private)'), 'SENTINEL-REASON-quissel');
    const everything = (): string => [panel.textContent ?? '', ...[...panel.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((at) => at.value))].join('\n');
    for (const name of ['Keep the decision', 'Make it lighter', 'Remove it']) {
      await user.click(radio(decision, name));
      await waitFor(() => expect(panel.querySelector('h4')).not.toBeNull());
      for (const secret of ['SENTINEL-STATEMENT-fenrisk', 'SENTINEL-REASON-quissel', a.appealId, a.person, 'mod_ann']) expect(everything(), `${name}: ${secret}`).not.toContain(secret);
    }
  });
});

describe('refusals and the way back', () => {
  it.each([
    ['same_decider', 'You made the original decision, so someone else has to decide this appeal.', false],
    ['already_decided', 'Someone else has already decided this appeal.', true],
    ['gone', 'The sanction is gone, so this appeal is closed.', true],
  ] as const)('%s shows in words and keeps what was typed; a decided appeal settles the card and returns to the list', async (code, words, settles) => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user, decision, router } = await open(w, a.appealId);
    w.intercept.fn = (req) => (req.method === 'POST' && /\/decide$/.test(req.path) ? { status: 409, body: { error: code, message: 'x' } } : undefined);
    await user.type(within(decision).getByLabelText('Why (private)'), 'my reason');
    await user.click(radio(decision, 'Keep the decision'));
    await user.click(within(decision).getByRole('button', { name: 'Send decision' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(within(decision).getByLabelText('Why (private)')).toHaveValue('my reason');
    if (settles) {
      expect(within(decision).queryByRole('button', { name: 'Send decision' })).toBeNull();
      expect(within(decision).queryByRole('region', { name: 'What the player sees' })).toBeNull();
      await user.click(within(decision).getByRole('button', { name: 'Back to the list' }));
      expect(router.path).toBe('/appeals');
    } else {
      expect(radio(decision, 'Keep the decision')).toBeChecked();
      expect(within(decision).getByRole('button', { name: 'Send decision' })).toBeInTheDocument();
    }
  });

  it('there is no claim chrome and no Undo hold', async () => {
    const w = await appealsHub(SENIOR);
    const a = await w.appeal();
    const { user, decision, router } = await open(w, a.appealId);
    await user.type(within(decision).getByLabelText('Why (private)'), 'fine');
    await user.click(radio(decision, 'Keep the decision'));
    await user.click(within(decision).getByRole('button', { name: 'Send decision' }));
    await waitFor(() => expect(router.path).toBe('/appeals'));
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(decides(w)).toHaveLength(1);
  });
});
