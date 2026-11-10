import { CATEGORY_TO_RULE } from '@chatwarden/core';
import { cleanup, render, act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AiReadSlot } from '../src/case/AiRead.js';
import { HubContext } from '../src/context.js';
import type { HubContextValue } from '../src/context.js';
import { createT, en } from '../src/i18n.js';
import { renderHub } from './render.js';
import { DAY, hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The case pane as a moderator reads it: the transcript (reported line, the person's lines, blocked words masked, the margin
// boxes), the tabs, the pane beside it (record, blocked attempts, who reported), the keys, and what each open and decide costs in
// audited reads.

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];
const BLOCKED: RichLine[] = [
  { who: 'reporter', text: 'hi' },
  { who: 'target', text: 'go back to the tutorial' },
  { who: 'target', text: 'you zorbak team' },
  { who: 'bystander', text: 'that was uncalled for' },
];
const HARASSMENT_RULE = CATEGORY_TO_RULE.harassment;
const MANY: RichLine[] = [{ who: 'reporter', text: 'hello there' }, ...Array.from({ length: 7 }, (_, i): RichLine => ({ who: 'target', text: `target line ${i + 1}` }))];

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const aside = (): HTMLElement => screen.getByRole('complementary', { name: 'About this case' });
const chat = (): HTMLElement => screen.getByRole('list', { name: 'Chat lines' });
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: HubWorld): TransportRequest[] => w.sent.filter(isDecide);
const audits = (w: HubWorld, action: string): Array<{ target?: { type: string; ref?: string } }> => w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === action) as never;
const margin = (): HTMLElement[] => within(chat()).queryAllByRole('checkbox', { name: /^Show the line at/ });

async function open(w: HubWorld, id: string, options: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...options });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  return r;
}

async function tabTo(user: UserEvent, target: HTMLElement, max = 150): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (document.activeElement === target) return;
    await user.tab();
  }
  throw new Error('could not reach the control by Tab');
}
const pageHides = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });

describe('the transcript', () => {
  it('marks the reported line, tints the reported person\'s lines, and leaves the others plain', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    const lines = within(chat()).getAllByRole('listitem');
    expect(lines.map((l) => l.hasAttribute('data-reported'))).toEqual([false, true, false, false]);
    expect(lines.map((l) => l.hasAttribute('data-theirs'))).toEqual([false, true, false, true]);
    expect(within(lines[1]!).getByText('Reported line')).toBeInTheDocument();
  });

  it('puts a box in the margin of the reported person\'s lines only, ticked: the lines the player is shown', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(margin()).toHaveLength(2);
    for (const box of margin()) expect(box).toBeChecked();
    expect(screen.getByText('Shown to Mallory: 2 of 5 lines')).toBeInTheDocument();
  });

  it('a box edits the decision: untick one and only the other line is sent', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(margin()[0]!);
    expect(margin()[0]).not.toBeChecked();
    expect(screen.getByText('Shown to Mallory: 1 of 5 lines')).toBeInTheDocument();
    expect(within(panel()).getByText('1 line is shown to Mallory.')).toBeInTheDocument();
    await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Said it.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((decides(w)[0]!.body as { actions: Array<{ lineIds: string[] }> }).actions[0]!.lineIds).toEqual([f.lineIds[3]]);
  });

  it('the boxes and the editor are one choice: a line ticked in the editor is ticked in the margin', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(margin()[0]!);
    await user.click(margin()[1]!);
    expect(margin().every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    const group = within(panel()).getByRole('group', { name: 'Action 1' });
    await user.click(within(group).getByRole('checkbox', { name: /^.*another line from the target/ }));
    expect(margin()[1]).toBeChecked();
    expect(margin()[0]).not.toBeChecked();
  });

  it('at most five lines: the sixth box is off until one is unticked (a person with seven lines)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: MANY });
    const { user } = await open(w, f.id);
    expect(margin()).toHaveLength(7);
    expect(margin().filter((b) => (b as HTMLInputElement).checked)).toHaveLength(5);
    // The reported line (their first) stays in, with the latest four.
    expect(margin().map((b) => (b as HTMLInputElement).checked)).toEqual([true, false, false, true, true, true, true]);
    expect(margin().filter((b) => (b as HTMLInputElement).disabled)).toHaveLength(2);
    expect(screen.getByText('Shown to Mallory: 5 of 5 lines')).toBeInTheDocument();
    await user.click(margin()[0]!);
    expect(margin().filter((b) => (b as HTMLInputElement).disabled)).toHaveLength(0);
    await user.click(margin()[1]!);
    expect(margin().filter((b) => (b as HTMLInputElement).checked)).toHaveLength(5);
  });

  it('a note shows no lines, so under a note the boxes are gone', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    const what = within(within(panel()).getByRole('group', { name: 'Action 1' })).getByLabelText('What happens');
    await user.selectOptions(what, within(what).getByRole('option', { name: 'Note' }));
    expect(margin()).toHaveLength(0);
  });

  it('under "Not a problem" the reported person cannot be acted on, so there are no boxes', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(within(panel()).getByRole('radio', { name: 'Not a problem' }));
    expect(margin()).toHaveLength(0);
    await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
    // Back to fair: the suggestion that the dismissal took off comes back, with its lines.
    expect(margin()).toHaveLength(2);
  });
});

describe('blocked words', () => {
  it('are a bar, never text, until shown; the tag says why', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: BLOCKED, cite: 2 });
    await open(w, f.id);
    expect(chat().textContent).not.toContain('zorbak');
    expect(within(chat()).getByRole('img', { name: 'Blocked words, hidden' })).toBeInTheDocument();
    expect(within(chat()).getByText('Blocked')).toBeInTheDocument();
    // Nowhere else in the case does it leak either: the editor's picker, the pane beside it.
    expect(document.body.textContent).not.toContain('zorbak');
  });

  it('one line can be shown and hidden again, without touching the others', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [...BLOCKED, { who: 'target', text: 'zorbak again' }], cite: 2 });
    const { user } = await open(w, f.id);
    const buttons = within(chat()).getAllByRole('button', { name: /^Show the blocked words in the line by Mallory/ });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);
    expect(within(chat()).getByText('you zorbak team')).toBeInTheDocument();
    expect(within(chat()).queryByText('zorbak again')).toBeNull();
    const hide = within(chat()).getByRole('button', { name: /^Hide the blocked words in the line by Mallory/ });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    await user.click(hide);
    expect(chat().textContent).not.toContain('zorbak');
  });

  it('"Show blocked words" shows every blocked line, in the editor\'s picker too, and hides them again', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [...BLOCKED, { who: 'target', text: 'zorbak again' }], cite: 2 });
    const { user } = await open(w, f.id);
    const all = screen.getByRole('checkbox', { name: 'Show blocked words' });
    expect(all).not.toBeChecked();
    await user.click(all);
    expect(within(chat()).getByText('you zorbak team')).toBeInTheDocument();
    expect(within(chat()).getByText('zorbak again')).toBeInTheDocument();
    // With the whole case shown there is no per-line button to press.
    expect(within(chat()).queryByRole('button', { name: /^Show the blocked words/ })).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    expect(within(panel()).getByRole('group', { name: 'Action 1' }).textContent).toContain('you zorbak team');
    await user.click(all);
    expect(chat().textContent).not.toContain('zorbak');
    expect(within(panel()).getByRole('group', { name: 'Action 1' }).textContent).not.toContain('zorbak');
  });

  it('no switch at all when nothing in the case was blocked', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(screen.queryByRole('checkbox', { name: 'Show blocked words' })).toBeNull();
  });

  it('a new case starts hidden again', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ lines: BLOCKED, cite: 2, target: 'Alpha', reporter: 'Ra', room: 'ra' });
    const b = await w.fileRich({ lines: BLOCKED, cite: 2, target: 'Beta', reporter: 'Rb', room: 'rb' });
    const { user, router } = await open(w, a.id);
    await user.click(screen.getByRole('checkbox', { name: 'Show blocked words' }));
    expect(within(chat()).getByText('you zorbak team')).toBeInTheDocument();
    act(() => router.navigate(`/reports/${b.id}`));
    await screen.findByRole('heading', { level: 2, name: /report against Beta/ });
    expect(screen.getByRole('checkbox', { name: 'Show blocked words' })).not.toBeChecked();
    expect(chat().textContent).not.toContain('zorbak');
  });

  it('the blocked attempts in the pane beside the case are hidden the same way, and counted', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: BLOCKED, cite: 2 });
    const { user } = await open(w, f.id);
    expect(await within(aside()).findByText('1 line from Mallory was blocked.')).toBeInTheDocument();
    expect(aside().textContent).not.toContain('zorbak');
    await user.click(within(aside()).getByRole('button', { name: /^Show the blocked line from/ }));
    expect(within(aside()).getByText('you zorbak team')).toBeInTheDocument();
    await user.click(within(aside()).getByRole('button', { name: /^Hide the blocked line from/ }));
    expect(aside().textContent).not.toContain('zorbak');
  });

  it('says so when nothing from the person was blocked, and is left out for a role that may not read blocked lines', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(await within(aside()).findByText('Nothing from this player was blocked in the last 7 days.')).toBeInTheDocument();
    cleanup();
    const w2 = await hubWorld({ permissions: { 'blocked.read': 'owner' } });
    const g = await w2.fileRich({ lines: BLOCKED, cite: 2, target: 'Zed', reporter: 'Rz', room: 'rz' });
    await open(w2, g.id);
    expect(within(aside()).queryByRole('heading', { name: 'Blocked attempts, 7 days' })).toBeNull();
    expect(w2.sent.some((r) => r.path === '/blocked')).toBe(false);
  });
});

describe('the keys', () => {
  it('1, 2 and 3 choose the verdict, and the caps say so', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.keyboard('2');
    expect(within(panel()).getByRole('radio', { name: 'Not a problem' })).toBeChecked();
    await user.keyboard('3');
    expect(within(panel()).getByRole('radio', { name: 'Bad faith' })).toBeChecked();
    await user.keyboard('1');
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toBeChecked();
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).toHaveAttribute('aria-keyshortcuts', '1');
    expect(within(panel()).getByRole('radio', { name: 'Bad faith' })).toHaveAttribute('aria-keyshortcuts', '3');
    expect(within(panel()).getByRole('button', { name: /^Decide and take next/ })).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
  });

  it('typing a number into the reason is typing, not a verdict', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), '123 times');
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('123 times');
    for (const name of ['Fair', 'Not a problem', 'Bad faith']) expect(within(panel()).getByRole('radio', { name })).not.toBeChecked();
  });

  it('a number with Ctrl or Cmd is the browser\'s, and 4 does nothing', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.keyboard('{Control>}1{/Control}{Meta>}2{/Meta}4');
    for (const name of ['Fair', 'Not a problem', 'Bad faith']) expect(within(panel()).getByRole('radio', { name })).not.toBeChecked();
  });

  it('with shortcuts off there are no number keys, no Ctrl+Enter and no key caps (the buttons still work)', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id, { shortcuts: false });
    await user.keyboard('1');
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).not.toBeChecked();
    expect(within(panel()).getByRole('radio', { name: 'Fair' })).not.toHaveAttribute('aria-keyshortcuts');
    expect(panel().querySelector('.cw-kbd')).toBeNull();
    await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'x{Control>}{Enter}{/Control}');
    expect(decides(w)).toHaveLength(0);
    expect(within(panel()).getByRole('button', { name: 'Decide' })).toBeInTheDocument();
  });

  it('a whole decision from the keyboard alone: a key for the verdict, Tab to the reason, type, Ctrl+Enter', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Ra', room: 'ra' });
    w.clock.t += 1000;
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Rb', room: 'rb' });
    const { user, router } = await open(w, a.id);
    await user.keyboard('1');
    const reason = within(panel()).getByRole('textbox', { name: 'Reason' });
    await tabTo(user, reason);
    await user.keyboard('Keyboard only.');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]!.body).toMatchObject({ verdict: 'upheld', reason: 'Keyboard only.', actions: [{ subject: a.person, kind: 'chat', durationMs: DAY }] });
  });

  it('Ctrl+Enter with a problem in the form does not send, and says what to fix', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('Fix 2 things before deciding.');
    expect(decides(w)).toHaveLength(0);
  });
});

describe('the pre-filled bar', () => {
  it('opens with nothing decided, the suggestion as the reported person\'s action, the report\'s rule and their lines', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    for (const name of ['Fair', 'Not a problem', 'Bad faith']) expect(within(panel()).getByRole('radio', { name })).not.toBeChecked();
    const card = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    expect(within(card).getByText('Chat restriction, 24 hours')).toBeInTheDocument();
    expect(within(card).getByLabelText('Community Rule')).toHaveValue(String(HARASSMENT_RULE));
    expect(within(card).getByText('2 lines are shown to Mallory.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Add this action' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Change' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('the suggestion has its referee card: half yellow and half red for a restriction', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(within(panel()).getByRole('group', { name: 'The ladder suggests' }).querySelector('.cw-card--restriction')).not.toBeNull();
  });

  it('a verdict and a reason are all it needs: Decide sends the suggestion with the lines', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.keyboard('1');
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Straight through.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]!.body).toEqual({
      verdict: 'upheld',
      reason: 'Straight through.',
      actions: [{ subject: f.person, kind: 'chat', durationMs: DAY, rule: HARASSMENT_RULE, lineIds: [f.lineIds[1], f.lineIds[3]] }],
    });
  });

  it('Change opens the full editor (the level picker and every field) and Done closes it', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    const change = within(panel()).getByRole('button', { name: 'Change' });
    await user.click(change);
    expect(within(panel()).getByRole('group', { name: 'How serious is the conduct?' })).toBeInTheDocument();
    const group = within(panel()).getByRole('group', { name: 'Action 1' });
    expect(within(group).getByLabelText('Person')).toBeInTheDocument();
    expect(within(group).getByLabelText('What happens')).toHaveDisplayValue('Chat restriction, 24 hours');
    await user.click(within(panel()).getByRole('button', { name: 'Done' }));
    expect(within(panel()).queryByRole('group', { name: 'How serious is the conduct?' })).toBeNull();
    expect(within(panel()).queryByLabelText('Person')).toBeNull();
    expect(within(panel()).queryByRole('group', { name: 'Action 1' })).toBeNull();
  });

  it('"Not a problem" takes the suggestion off the reported person, says so, and "Fair" puts it back', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.keyboard('2');
    expect(within(panel()).queryByRole('group', { name: 'The ladder suggests' })).toBeNull();
    expect(within(panel()).getByRole('status', { name: 'Decision updates' })).toHaveTextContent('Removed 1 action on the reported person.');
    await user.keyboard('1');
    expect(within(within(panel()).getByRole('group', { name: 'The ladder suggests' })).getByLabelText('Community Rule')).toHaveValue(String(HARASSMENT_RULE));
  });

  it('a role that cannot apply sanctions gets no action, and says so', async () => {
    const w = await hubWorld({ permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(within(panel()).queryByRole('group', { name: 'The ladder suggests' })).toBeNull();
    expect(within(panel()).getByText('Your role cannot apply sanctions. You can still decide the report.')).toBeInTheDocument();
  });

  it('a permanent suggestion is not pre-filled for a moderator, who is told who can', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'ban', 1, 30 * DAY);
    await open(w, f.id);
    const card = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    expect(within(card).getByText('Ban, permanent')).toBeInTheDocument();
    expect(within(card).getByText('Only a senior moderator can make this permanent.')).toBeInTheDocument();
    expect(within(panel()).queryByRole('group', { name: /^Action 1$/ })).toBeNull();
  });
});

describe('the ladder of this adopter', () => {
  const cell = (kind: 'warning' | 'chat' | 'ban', durationMs: number | null, label: string) => ({ kind, durationMs, label });
  const ladder = [
    { step: 0, lowMedium: cell('chat', 3 * DAY, 'Restrict chat 3 days'), high: cell('chat', 3 * DAY, 'Restrict chat 3 days') },
    { step: 1, lowMedium: cell('chat', 3 * DAY, 'Restrict chat 3 days'), high: cell('ban', 14 * DAY, 'Ban 14 days') },
    { step: 2, lowMedium: cell('ban', 14 * DAY, 'Ban 14 days'), high: cell('ban', 14 * DAY, 'Ban 14 days') },
    { step: 3, lowMedium: cell('ban', 14 * DAY, 'Ban 14 days'), high: cell('ban', 14 * DAY, 'Ban 14 days') },
    { step: 4, lowMedium: cell('ban', 14 * DAY, 'Ban 14 days'), high: cell('ban', 14 * DAY, 'Ban 14 days') },
    { step: 5, lowMedium: cell('ban', 14 * DAY, 'Ban 14 days'), high: cell('ban', 14 * DAY, 'Ban 14 days') },
  ] as never;

  it('its length is added, pre-filled and offered in the menu, and goes through as it is', async () => {
    const w = await hubWorld({ ladder, role: 'senior' });
    const f = await w.fileRich({ lines: TALK });
    // The ladder is what comes after a first offence: this person already has a warning.
    await w.sanction(f.person, 'warning', 2);
    const detail = await w.client.getReport(f.id);
    // A record at step 1 and this category's rule read the ladder's high column: the adopter's 14-day ban.
    expect(detail.suggest.outcome).toEqual({ kind: 'ban', durationMs: 14 * DAY });
    const { user } = await open(w, f.id);
    const card = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    expect(within(card).getByText('Ban, 14d')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Change' }));
    const what = within(within(panel()).getByRole('group', { name: 'Action 1' })).getByLabelText('What happens');
    expect(what).toHaveDisplayValue('Ban, 14d');
    // The menu is the adopter's ladder (and what a first offence can suggest), not core's table: 3 days and 14 days, no 30-day ban.
    const options = within(what).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Chat restriction, 3d');
    expect(options).toContain('Ban, 14d');
    expect(options).not.toContain('Ban, 7 days');
    expect(options).not.toContain('Ban, 30 days');
    await user.keyboard('1');
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Their ladder.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect((decides(w)[0]!.body as { actions: Array<{ durationMs: number }> }).actions[0]!.durationMs).toBe(14 * DAY);
  });

  it('"Add this action" is not a dead button: with the action taken off, it adds the 14-day one', async () => {
    const w = await hubWorld({ ladder });
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning', 2);
    const { user } = await open(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    await user.click(within(panel()).getByRole('button', { name: 'Remove action 1' }));
    await user.click(within(panel()).getByRole('button', { name: 'Add this action' }));
    expect(within(within(panel()).getByRole('group', { name: 'Action 1' })).getByLabelText('What happens')).toHaveDisplayValue('Ban, 14d');
  });
});

describe('the suggestion button says why it cannot add', () => {
  it('at 20 actions: with the suggestion changed to another kind, it explains instead of doing nothing', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning', 1);
    const { user } = await open(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    await user.click(within(panel()).getByRole('button', { name: 'Remove action 1' }));
    const add = within(panel()).getByRole('button', { name: 'Add an action' });
    for (let i = 0; i < 20; i += 1) await user.click(add);
    expect(within(panel()).getAllByRole('group', { name: /^Action / })).toHaveLength(20);
    expect(within(panel()).getByText('That is the most actions one decision can hold (20).')).toBeInTheDocument();
    const suggested = (await w.client.getReport(f.id)).suggest.outcome;
    expect(suggested).not.toBe('none');
    // The suggestion is not in the plan (every action is still blank), and there is no room: the card says so.
    const card = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    expect(within(card).getByText('This decision already has 20 actions. Remove one to add this.')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Add this action' })).toBeNull();
  });
});

describe('the level picker', () => {
  it('shows the pick at once, is busy while the answer is out, and holds "Add this action" until it lands', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning', 1);
    const { user } = await open(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    await user.click(within(panel()).getByRole('button', { name: 'Remove action 1' }));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    w.intercept.fn = async (req) => {
      if (req.path.endsWith('/suggest')) await held;
      return undefined;
    };
    await user.click(within(panel()).getByRole('button', { name: 'Severe' }));
    expect(within(panel()).getByRole('button', { name: 'Severe' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(panel()).getByRole('group', { name: 'How serious is the conduct?' }).parentElement).toHaveAttribute('aria-busy', 'true');
    expect(within(panel()).getByRole('button', { name: 'Add this action' })).toHaveAttribute('aria-disabled', 'true');
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Add this action' })).toHaveAttribute('aria-disabled', 'false'));
    expect(within(panel()).getByRole('group', { name: 'How serious is the conduct?' }).parentElement).toHaveAttribute('aria-busy', 'false');
  });

  it('a failure takes the pick back', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    w.intercept.fn = (req) => (req.path.endsWith('/suggest') ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(panel()).getByRole('button', { name: 'Hostile' }));
    await within(panel()).findByText('Could not update the suggestion.');
    expect(within(panel()).getByRole('button', { name: 'Hostile' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('citing another rule on the reported person\'s action asks the ladder again, with the rule and the person', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    const card = within(panel()).getByRole('group', { name: 'The ladder suggests' });
    const rule = within(card).getByLabelText('Community Rule');
    await user.selectOptions(rule, within(rule).getByRole('option', { name: /^Rule 5:/ }));
    await waitFor(() => expect(w.sent.some((r) => r.path === `/reports/${f.id}/suggest`)).toBe(true));
    const asked = w.sent.filter((r) => r.path === `/reports/${f.id}/suggest`);
    expect(asked.at(-1)?.body).toEqual({ level: null, person: f.person, rule: 5 });
  });
});

describe('the live region', () => {
  it('says the same words twice when the same thing happens twice', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Change' }));
    await user.click(within(panel()).getByRole('button', { name: 'Remove action 1' }));
    const region = within(panel()).getByRole('status', { name: 'Decision updates' });
    await user.click(within(panel()).getByRole('button', { name: 'Add an action' }));
    expect(region).toHaveTextContent('Added action 1.');
    const first = region.firstElementChild;
    await user.click(within(panel()).getByRole('button', { name: 'Remove action 1' }));
    await user.click(within(panel()).getByRole('button', { name: 'Add an action' }));
    expect(region).toHaveTextContent('Added action 1.');
    // The text is in a new element: a screen reader announces a change, and an identical string in the same node is not one.
    expect(region.firstElementChild).not.toBe(first);
  });
});

describe('the verdict-only form (the rules cannot be read)', () => {
  it('a role without policy.read still decides: no actions, a plain hint, and a dismissal goes through', async () => {
    const w = await hubWorld({ permissions: { 'policy.read': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    expect(within(panel()).queryByRole('group', { name: 'The ladder suggests' })).toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Add an action' })).toBeNull();
    expect(within(panel()).getByText('Your role cannot read the rules, so actions are not available here. You can still decide the report.')).toBeInTheDocument();
    expect(w.sent.some((r) => r.path === '/policy')).toBe(false);
    await user.keyboard('2');
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Banter.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]!.body).toEqual({ verdict: 'no_action', reason: 'Banter.', actions: [] });
  });

  it('a rules failure shows the error with Try again and still lets a dismissal be sent; the retry brings the actions back', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    let fail = true;
    w.intercept.fn = (req) => (fail && req.path === '/policy' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = await open(w, f.id);
    expect(await within(panel()).findByText('Could not load the Community Rules.')).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Add an action' })).toBeNull();
    fail = false;
    await user.click(within(panel()).getByRole('button', { name: 'Try again' }));
    expect(await within(panel()).findByRole('group', { name: 'The ladder suggests' })).toBeInTheDocument();
    // Nothing had been touched, so the suggestion is pre-filled once the rules arrive.
    expect(within(within(panel()).getByRole('group', { name: 'The ladder suggests' })).getByLabelText('Community Rule')).toHaveValue(String(HARASSMENT_RULE));
  });

  it('a dismissal without the rules is sent when the rules never come', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    w.intercept.fn = (req) => (req.path === '/policy' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const { user } = await open(w, f.id);
    await within(panel()).findByText('Could not load the Community Rules.');
    await user.keyboard('2');
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Fine.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    expect(decides(w)[0]!.body).toEqual({ verdict: 'no_action', reason: 'Fine.', actions: [] });
  });
});

describe('saved reasons', () => {
  it('are chips: one press fills the reason, a second adds to it, and the chip is announced', async () => {
    const w = await hubWorld({ role: 'senior' });
    await w.direct.addReason({ label: 'Slur attempt', text: 'Slur attempt in match chat.' });
    await w.direct.addReason({ label: 'Repeat', text: 'Repeat after a warning.' });
    const off = await w.direct.addReason({ label: 'Retired', text: 'No longer used.' });
    await w.direct.setReasonActive(off.reason.id, false);
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    const chips = await within(panel()).findByRole('group', { name: 'Saved reasons' });
    expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['Slur attempt', 'Repeat']);
    await user.click(within(chips).getByRole('button', { name: 'Slur attempt' }));
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Slur attempt in match chat.');
    await user.click(within(chips).getByRole('button', { name: 'Repeat' }));
    expect(within(panel()).getByRole('textbox', { name: 'Reason' })).toHaveValue('Slur attempt in match chat. Repeat after a warning.');
    expect(within(panel()).getByRole('status', { name: 'Decision updates' })).toHaveTextContent('Added the saved reason Repeat.');
  });

  it('no row of chips when there are none, and none asked for by a role without reasons.read', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(within(panel()).queryByRole('group', { name: 'Saved reasons' })).toBeNull();
    const w2 = await hubWorld({ permissions: { 'reasons.read': 'owner' } });
    const g = await w2.fileRich({ lines: TALK });
    await open(w2, g.id);
    expect(w2.sent.some((r) => r.path === '/reasons')).toBe(false);
  });
});

describe('the tabs', () => {
  it('Evidence, Reports and History: arrows move between them and show their panels', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning', 1);
    const { user } = await open(w, f.id);
    const tabs = within(screen.getByRole('tablist', { name: 'Case sections' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Evidence', 'Reports (1)', 'History']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Evidence');
    tabs[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Reports (1)' })).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Reports (1)');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('History');
    expect(await within(screen.getByRole('tabpanel')).findByText('Warning')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'History' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveAttribute('aria-selected', 'true');
    // Only the open tab is in the Tab order.
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('the Reports tab lists every report in the case, and opens another one', async () => {
    const w = await hubWorld();
    const first = await w.fileRich({ lines: TALK, reporter: 'R1', room: 'r1', category: 'hate' });
    w.clock.t += 1000;
    const second = await w.fileRich({ lines: TALK, reporter: 'R2', room: 'r2', category: 'spam' });
    const { user, router } = await open(w, first.id);
    await user.click(screen.getByRole('tab', { name: 'Reports (2)' }));
    const list = screen.getByRole('list', { name: 'Reports in this case' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('This report')).toBeInTheDocument();
    await user.click(within(list).getByRole('link', { name: 'Open' }));
    await waitFor(() => expect(router.path).toBe(`/reports/${second.id}`));
  });

  it('no History tab for a role that cannot read histories, and no history read', async () => {
    const w = await hubWorld({ permissions: { 'history.read': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(screen.queryByRole('tab', { name: 'History' })).toBeNull();
    expect(within(aside()).queryByText('Who reported')).toBeNull();
    expect(w.sent.some((r) => r.path.startsWith('/people/'))).toBe(false);
  });

  it('the History tab says so when there is nothing on record', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(await within(screen.getByRole('tabpanel')).findByText('Nothing on this player’s record in the last 90 days.')).toBeInTheDocument();
  });
});

describe('the pane beside the case', () => {
  it('the record: each action with its referee card, rule, who and when; a revoked one struck out', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.sanction(f.person, 'warning', 1);
    const chat = await w.sanction(f.person, 'chat', 2, DAY);
    await w.sanction(f.person, 'note', 'uncovered');
    await w.sanction(f.person, 'ban', 3, 7 * DAY);
    await w.client.revokeSanction(chat.groupId, 'mistake');
    await open(w, f.id);
    const section = (await within(aside()).findByRole('heading', { name: 'Mallory’s record, 90 days' })).closest('section') as HTMLElement;
    const items = await within(section).findAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items.map((li) => li.querySelector('.cw-card')?.className)).toEqual([
      'cw-card cw-card--ban',
      'cw-card cw-card--note',
      'cw-card cw-card--restriction',
      'cw-card cw-card--warning',
    ]);
    const ban = items[0]!;
    expect(within(ban).getByText('Ban, 7 days')).toBeInTheDocument();
    expect(within(ban).getByText('Rule 3, by ann@example.test')).toBeInTheDocument();
    expect(within(ban).getByText('Active')).toBeInTheDocument();
    expect(within(items[1]!).getByText('No rule fits yet, by ann@example.test')).toBeInTheDocument();
    expect(items[2]).toHaveAttribute('data-state', 'revoked');
    expect(within(items[2]!).getByText('Revoked')).toBeInTheDocument();
  });

  it('says so when there is nothing on record', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await open(w, f.id);
    expect(await within(aside()).findByText('Nothing on record in the last 90 days.', { selector: '.cw-hint' })).toBeInTheDocument();
  });

  it('who reported: this report\'s reporter and everyone else who reported the person, each with a track record', async () => {
    const w = await hubWorld();
    const first = await w.fileRich({ lines: TALK, reporter: 'Rae', room: 'r1' });
    w.clock.t += 1000;
    const second = await w.fileRich({ lines: TALK, reporter: 'Kes', room: 'r2' });
    await w.client.decide(
      (await w.fileRich({ lines: TALK, reporter: 'Rae', target: 'Other', room: 'r3' })).id,
      { verdict: 'upheld', reason: 'ok', actions: [] },
    );
    await open(w, second.id);
    const list = await within(aside()).findByRole('list', { name: 'Reporters of this case' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // This report's reporter first (Kes, by handle), then the other (Rae).
    expect(within(rows[0]!).getByText('Kes')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('1 report, 0 upheld')).toBeInTheDocument();
    expect(await within(rows[1]!).findByText('2 reports, 1 upheld')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('meter', { name: '1 of 1 decided reports upheld' })).toBeInTheDocument();
    // The other reporter has no handle on this report: the short tag names them.
    expect(within(rows[1]!).getByText(/^Person \S{8}$/)).toBeInTheDocument();
    void first;
  });

  it('shows five reporters at most and counts the rest, reading only five histories', async () => {
    const w = await hubWorld();
    let last = '';
    for (let i = 0; i < 7; i += 1) {
      last = (await w.fileRich({ lines: TALK, reporter: `Rep${i}`, room: `m${i}` })).id;
      w.clock.t += 1000;
    }
    await open(w, last);
    const list = await within(aside()).findByRole('list', { name: 'Reporters of this case' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(aside()).getByText('2 more reporters are not shown.')).toBeInTheDocument();
    await waitFor(() => expect(w.sent.filter((r) => r.path.startsWith('/people/') && r.path.endsWith('/history'))).toHaveLength(6));
  });

  it('a reporter suspended from reporting, and one with bad-faith reports, are marked', async () => {
    const w = await hubWorld();
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await w.fileRich({ reporter: 'Rae', target: `T${i}`, room: `s${i}`, lines: TALK })).id);
    for (const id of ids.slice(0, 3)) await w.client.decide(id, { verdict: 'bad_faith', reason: 'lied', evidence: 'made up', actions: [] });
    await open(w, ids[3]!);
    const row = (await within(aside()).findByText('Rae', { selector: '.cw-reporter-name' })).closest('li') as HTMLElement;
    expect(await within(row).findByText('3 for bad faith.')).toBeInTheDocument();
    expect(within(row).getByText(/^Reporting is suspended until /)).toBeInTheDocument();
  });

  it('a reporter record that cannot be loaded says so and leaves the rest of the pane', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, reporter: 'Rae' });
    w.intercept.fn = (req) => (req.path === `/people/${f.reporter}/history` ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await open(w, f.id);
    expect(await within(aside()).findByText('The reporter\'s record could not be loaded.')).toBeInTheDocument();
    expect(within(aside()).getByRole('heading', { name: 'People' })).toBeInTheDocument();
  });
});

describe('what each open and each decision costs in audited reads', () => {
  it('opening a case: one read of the report, the record of the person and of the reporter, the rules once, the blocked lines once', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const before = w.cw.audit.list({ limit: 200 }).items.length;
    await open(w, f.id);
    await within(aside()).findByText(/\d reports?, \d upheld/);
    await within(aside()).findByText('Nothing from this player was blocked in the last 7 days.');
    const rows = w.cw.audit.list({ limit: 200 }).items.slice(0, w.cw.audit.list({ limit: 200 }).items.length - before);
    const count = (action: string): number => rows.filter((r) => r.action === action).length;
    expect(audits(w, 'report.view').filter((r) => r.target?.ref === f.id)).toHaveLength(1);
    expect(count('policy.view')).toBe(1);
    expect(count('history.view')).toBe(2);
    expect(count('blocked.view')).toBe(1);
    expect(w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${f.id}`)).toHaveLength(1);
    expect(w.sent.filter((r) => r.path === '/policy')).toHaveLength(1);
  });

  it('the rules are read once per session: a second case reads none, a repeated reporter none, the blocked lines none', async () => {
    const w = await hubWorld();
    const a = await w.fileRich({ lines: TALK, target: 'Alpha', reporter: 'Shared', room: 'ra' });
    const b = await w.fileRich({ lines: TALK, target: 'Beta', reporter: 'Shared', room: 'rb' });
    const { router } = await open(w, a.id);
    await within(aside()).findByText(/\d reports?, \d upheld/);
    const policy = audits(w, 'policy.view').length;
    const blocked = audits(w, 'blocked.view').length;
    const histories = audits(w, 'history.view').length;
    act(() => router.navigate(`/reports/${b.id}`));
    await screen.findByRole('heading', { level: 2, name: /report against Beta/ });
    await within(aside()).findByText(/\d reports?, \d upheld/);
    await waitFor(() => expect(audits(w, 'history.view').length).toBe(histories + 1));
    expect(audits(w, 'policy.view')).toHaveLength(policy);
    expect(audits(w, 'blocked.view')).toHaveLength(blocked);
    // Only the new person's record: the shared reporter's track record was kept.
    expect(audits(w, 'history.view').filter((r) => r.target?.ref === b.person)).toHaveLength(1);
    expect(audits(w, 'report.view').filter((r) => r.target?.ref === b.id)).toHaveLength(1);
    expect(w.sent.filter((r) => r.path === '/policy')).toHaveLength(1);
  });

  it('a decision reads nothing more about the case: no report, no history, no rules', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user } = await open(w, f.id);
    await within(aside()).findByText(/\d reports?, \d upheld/);
    const reads = (): Record<string, number> => ({
      report: audits(w, 'report.view').filter((r) => r.target?.ref === f.id).length,
      history: audits(w, 'history.view').length,
      policy: audits(w, 'policy.view').length,
      blocked: audits(w, 'blocked.view').length,
    });
    const before = reads();
    await user.keyboard('1');
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Done.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await pageHides();
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    expect(reads()).toEqual(before);
    expect(audits(w, 'report.decide')).toHaveLength(1);
    expect(w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${f.id}`)).toHaveLength(1);
    expect(w.sent.filter((r) => r.path.startsWith('/people/'))).toHaveLength(2);
  });
});

describe('the AI read slot', () => {
  const ctx = { t: createT(en, 'en') } as unknown as HubContextValue;
  const slot = (read: Parameters<typeof AiReadSlot>[0]['read']) =>
    render(
      <HubContext.Provider value={ctx}>
        <AiReadSlot read={read} />
      </HubContext.Provider>,
    );

  it('renders nothing without data', () => {
    expect(slot(null).container).toBeEmptyDOMElement();
    expect(slot(undefined).container).toBeEmptyDOMElement();
  });

  it('with a read: labelled as the AI\'s, with its level, and says it never decides', () => {
    slot({ level: 1, text: 'Severe. A blocked slur aimed at the other team.' });
    const region = screen.getByRole('region', { name: 'AI read' });
    expect(within(region).getByRole('heading', { name: 'AI read (AI level 1)' })).toBeInTheDocument();
    expect(within(region).getByText('Severe. A blocked slur aimed at the other team.')).toBeInTheDocument();
    expect(within(region).getByText('A read, never a decision. A moderator decides.')).toBeInTheDocument();
  });

  it('a case shows no AI box while no read exists', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { container } = await open(w, f.id);
    expect(container.querySelector('.cw-ai')).toBeNull();
  });
});

describe('the phone sheet', () => {
  it('starts closed with a Decide… button that opens it and a Hide that closes it', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await open(w, f.id);
    const dock = container.querySelector('.cw-dock') as HTMLElement;
    expect(dock).toHaveAttribute('data-open', 'false');
    const toggle = within(dock).getByRole('button', { name: 'Decide…' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', dock.querySelector('.cw-dock-body')!.id);
    await user.click(toggle);
    expect(dock).toHaveAttribute('data-open', 'true');
    expect(within(dock).getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(dock).getByRole('button', { name: 'Hide' }));
    expect(dock).toHaveAttribute('data-open', 'false');
  });

  it('pressing Decide with something missing opens the sheet on the list of problems', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await open(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    expect(container.querySelector('.cw-dock')).toHaveAttribute('data-open', 'true');
    expect(await within(panel()).findByRole('alert')).toHaveFocus();
  });

  it('after a decision is queued the sheet closes, so the case is in view', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { user, container } = await open(w, f.id);
    await user.click(within(panel()).getByRole('button', { name: 'Decide…' }));
    await user.keyboard('1');
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Done.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    expect(container.querySelector('.cw-dock')).toHaveAttribute('data-open', 'false');
  });
});
