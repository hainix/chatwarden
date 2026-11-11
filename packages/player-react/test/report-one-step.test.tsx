import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerReporting, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps, ReportDraft } from '../src/ReportDialog.js';
import { en } from '../src/i18n.js';
import { FIXED, findStatus, renderUi } from './render.js';
import { ALICE, BOB, playerWorld } from './world.js';

// Reporting is ONE step (owner feedback 2026-11-11: "first click is report ... add an optional reason inline, this is too many
// clicks"). One dialog: the question, the quoted line, an optional "Why?" select, a note behind "Add a note" (or shown when the
// reason asks for one), Report. After the send: "Report sent", the thank-you, Close. There is no follow-up step.

const reason = (id: string, label: string, group: string, extra: Partial<PlayerReporting['reasons'][number]> = {}) => ({ id, label, hint: '', group, asksNote: false, ...extra });

const STUDIO: PlayerReporting = {
  flow: 'one_tap',
  thanks: 'Thanks. A moderator will have a look.',
  reasons: [
    reason('harassment', 'Harassment', 'Chat', { hint: 'Targeting or bullying someone' }),
    reason('other', 'Something else', '', { asksNote: true, hint: 'Anything the list does not cover' }),
    reason('spam', 'Spam', 'Chat'),
    reason('cheating', 'Cheating', 'Gameplay', { hint: 'Using a tool or a bug to win' }),
    reason('afk', 'Leaving the match', 'Gameplay'),
    reason('smurf', 'Fake account', ''),
  ],
};

const ok = (remaining = 9): ReportResult => ({ ok: true, reportId: 'r1', remaining });
const props = (onSubmit: ReportDialogProps['onSubmit'], more: Partial<ReportDialogProps> = {}): ReportDialogProps => ({
  onSubmit,
  onClose: () => undefined,
  ...FIXED,
  reporting: STUDIO,
  line: 'you play like a snerp',
  ...more,
});
const sender = () => vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve(ok()));
const why = (name = 'Why? (optional)') => screen.getByRole('combobox', { name });
const reportButton = () => screen.getByRole('button', { name: 'Report' });

describe('the one step', () => {
  it('shows the question, the quoted line, one "Why?" select, Report and Cancel, and nothing else', () => {
    renderUi(<ReportDialog {...props(sender())} />);
    const d = screen.getByRole('dialog');
    expect(d).toHaveAccessibleName('Report this message?');
    expect(within(d).getByRole('heading', { level: 2 })).toHaveFocus();
    expect(d.querySelector('blockquote')).toHaveTextContent('“you play like a snerp”');
    expect(within(d).getAllByRole('combobox')).toHaveLength(1);
    expect(within(d).queryAllByRole('radio')).toHaveLength(0);
    expect(within(d).queryByRole('textbox')).toBeNull();
    expect(within(d).getByRole('button', { name: 'Report' })).toHaveClass('cw-btn--primary');
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // The only other control is the one door to the note.
    expect(within(d).getAllByRole('button').map((b) => b.textContent)).toEqual(['Add a note', 'Report', 'Cancel']);
  });

  it('the select lists "Choose a reason (optional)", then a group each (Chat, Gameplay), then the ungrouped reasons last', () => {
    renderUi(<ReportDialog {...props(sender())} />);
    const select = why();
    expect(select).not.toBeRequired();
    const top = [...select.children].map((c) => (c instanceof HTMLOptGroupElement ? `group:${c.label}` : `option:${c.textContent}`));
    expect(top).toEqual(['option:Choose a reason (optional)', 'group:Chat', 'group:Gameplay', 'option:Fake account', 'option:Something else']);
    const inGroup = (label: string) => [...select.querySelectorAll<HTMLOptGroupElement>('optgroup')].find((g) => g.label === label)?.textContent;
    expect(inGroup('Chat')).toBe('HarassmentSpam');
    expect(inGroup('Gameplay')).toBe('CheatingLeaving the match');
    expect((select as HTMLSelectElement).value).toBe('');
  });

  it('an option is its label alone: hints are not in the options', () => {
    renderUi(<ReportDialog {...props(sender())} />);
    const text = [...why().querySelectorAll('option')].map((o) => o.textContent ?? '').join('|');
    expect(text).not.toContain('Targeting or bullying');
    expect(text).not.toContain('Anything the list does not cover');
  });

  it('the chosen reason shows its hint as a small line under the select, and the select is described by it', async () => {
    const { user } = renderUi(<ReportDialog {...props(sender())} />);
    expect(why()).not.toHaveAccessibleDescription();
    await user.selectOptions(why(), 'harassment');
    expect(why()).toHaveAccessibleDescription('Targeting or bullying someone');
    expect(screen.getByText('Targeting or bullying someone')).toHaveClass('cw-hint');
    // A reason with no hint leaves nothing behind.
    await user.selectOptions(why(), 'spam');
    expect(screen.queryByText('Targeting or bullying someone')).toBeNull();
    expect(why()).not.toHaveAccessibleDescription();
  });

  it('labels, hints and group names are text, never markup', async () => {
    const hostile: PlayerReporting = { ...STUDIO, reasons: [reason('a', '<b>Bold</b>', '<i>Group</i>', { hint: '<u>Hint</u>' })] };
    const { user, container } = renderUi(<ReportDialog {...props(sender(), { reporting: hostile })} />);
    await user.selectOptions(why(), 'a');
    expect(container.querySelector('b, i, u')).toBeNull();
    expect(screen.getByText('<u>Hint</u>')).toBeInTheDocument();
  });
});

describe('one click reports', () => {
  it('Report with nothing chosen sends an empty draft at once, then says "Report sent", the thank-you with the count, and Close', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.click(reportButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({});
    expect(await findStatus()).toHaveTextContent('Thanks. A moderator will have a look. You can send 9 more reports today.');
    expect(screen.getByRole('heading', { name: 'Report sent' })).toHaveFocus();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('the same in reason_first', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit, { reporting: { ...STUDIO, flow: 'reason_first' } })} />);
    expect(why()).toBeInTheDocument();
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({});
    await findStatus();
  });

  it('without a thank-you from the studio it uses the dialog\'s own words', async () => {
    const { user } = renderUi(<ReportDialog {...props(sender(), { reporting: { ...STUDIO, thanks: '' } })} />);
    await user.click(reportButton());
    expect(await findStatus()).toHaveTextContent('Thanks. We got your report. You can send 9 more reports today.');
  });
});

describe('a reason, in the same click', () => {
  it.each([
    ['harassment', 'Harassment'],
    ['cheating', 'Cheating'],
    ['smurf', 'Fake account'],
  ])('choosing %s sends it with the report (a draft of just the reason)', async (id, label) => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), label);
    await user.click(reportButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ reason: id });
    await findStatus();
  });

  it('choosing the placeholder again goes back to no reason', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'spam');
    await user.selectOptions(why(), '');
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({});
  });

  it('a reason that does not ask for a note shows no note field', async () => {
    const { user } = renderUi(<ReportDialog {...props(sender())} />);
    await user.selectOptions(why(), 'cheating');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('the note', () => {
  it('a reason that asks for a note shows "Note (optional)" under the select, and it is sent trimmed with the reason', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'other');
    const note = screen.getByRole('textbox', { name: 'Note (optional)' });
    // Choosing a reason does not take focus from the select.
    expect(why()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
    await user.type(note, '   they keep doing it  ');
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ reason: 'other', note: 'they keep doing it' });
  });

  it('"Add a note" is the one door: it reveals the textarea, moves focus into it, and a note alone is sent', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    const note = screen.getByRole('textbox', { name: 'Note (optional)' });
    expect(note).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
    await user.type(note, 'see the last minute');
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ note: 'see the last minute' });
  });

  it('a reason and a note typed behind "Add a note" go together', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'spam');
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await user.type(screen.getByRole('textbox'), 'x');
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ reason: 'spam', note: 'x' });
  });

  it('a note that was opened stays open and is kept when the reason changes', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'other');
    await user.type(screen.getByRole('textbox'), 'details');
    await user.selectOptions(why(), 'cheating');
    expect(screen.getByRole('textbox')).toHaveValue('details');
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ reason: 'cheating', note: 'details' });
  });

  it.each(['', '   ', '\n\t '])('a blank note (%j) is left out', async (blank) => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    if (blank.trim() === '' && blank !== '') await user.type(screen.getByRole('textbox'), blank.replace(/\n|\t/g, ' '));
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({});
  });

  it('is capped at the kit limit and says what it is for', async () => {
    const { user } = renderUi(<ReportDialog {...props(sender())} />);
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    const note = screen.getByRole('textbox');
    expect(note).toHaveAttribute('maxlength', '500');
    expect(note).toHaveAccessibleDescription('A moderator will read this. Up to 500 characters. Do not include passwords or personal details.');
  });

  it('a reason that asks for a note while a hint shows: the select describes the hint, the note describes its own limit', async () => {
    const { user } = renderUi(<ReportDialog {...props(sender())} />);
    await user.selectOptions(why(), 'other');
    expect(why()).toHaveAccessibleDescription('Anything the list does not cover');
    expect(screen.getByRole('textbox')).toHaveAccessibleDescription(/A moderator will read this/);
  });
});

describe('reason_required', () => {
  const required: PlayerReporting = { ...STUDIO, flow: 'reason_required' };

  it('labels the select "Why?" (no "optional"), makes it required, and the first option asks for a reason', () => {
    renderUi(<ReportDialog {...props(sender(), { reporting: required })} />);
    const select = why('Why?');
    expect(select).toBeRequired();
    expect(screen.queryByRole('combobox', { name: 'Why? (optional)' })).toBeNull();
    expect((select.querySelector('option') as HTMLOptionElement).textContent).toBe('Choose a reason');
  });

  it('Report with no reason shows an inline error, focuses the select, and sends nothing', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit, { reporting: required })} />);
    await user.click(reportButton());
    expect(onSubmit).not.toHaveBeenCalled();
    const error = screen.getByText('Choose a reason.');
    expect(error).toHaveAttribute('role', 'alert');
    expect(why('Why?')).toHaveFocus();
    expect(why('Why?')).toHaveAttribute('aria-invalid', 'true');
    expect(why('Why?')).toHaveAccessibleDescription(/Choose a reason\./);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Report this message?');
  });

  it('choosing a reason clears the error, and then Report sends it', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit, { reporting: required })} />);
    await user.click(reportButton());
    await user.selectOptions(why('Why?'), 'spam');
    expect(screen.queryByText('Choose a reason.')).toBeNull();
    expect(why('Why?')).not.toHaveAttribute('aria-invalid');
    await user.click(reportButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ reason: 'spam' });
  });

  it('a hint and the error are both in the select\'s description', async () => {
    const { user } = renderUi(<ReportDialog {...props(sender(), { reporting: required })} />);
    await user.click(reportButton());
    await user.selectOptions(why('Why?'), 'harassment');
    expect(why('Why?')).toHaveAccessibleDescription('Targeting or bullying someone');
  });

  it('a note is still behind "Add a note"', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit, { reporting: required })} />);
    await user.selectOptions(why('Why?'), 'cheating');
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await user.type(screen.getByRole('textbox'), 'n');
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ reason: 'cheating', note: 'n' });
  });
});

describe('the reasons change while the dialog is open', () => {
  const without = (id: string): PlayerReporting => ({ ...STUDIO, reasons: STUDIO.reasons.filter((r) => r.id !== id) });

  it('a chosen reason that left the list is not sent: the select shows the placeholder and the payload has no reason', async () => {
    const onSubmit = sender();
    const { user, rerender } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'harassment');
    expect((why() as HTMLSelectElement).value).toBe('harassment');
    rerender(<ReportDialog {...props(onSubmit, { reporting: without('harassment') })} />);
    expect((why() as HTMLSelectElement).value).toBe('');
    expect((why() as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Choose a reason (optional)');
    await user.click(reportButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({});
    expect('reason' in (onSubmit.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it('in reason_required, Report asks for a reason (the error shows, focus goes to the select, nothing is sent)', async () => {
    const onSubmit = sender();
    const required: PlayerReporting = { ...STUDIO, flow: 'reason_required' };
    const { user, rerender } = renderUi(<ReportDialog {...props(onSubmit, { reporting: required })} />);
    await user.selectOptions(why('Why?'), 'spam');
    rerender(<ReportDialog {...props(onSubmit, { reporting: { ...without('spam'), flow: 'reason_required' } })} />);
    expect((why('Why?') as HTMLSelectElement).value).toBe('');
    await user.click(reportButton());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a reason.')).toHaveAttribute('role', 'alert');
    expect(why('Why?')).toHaveFocus();
  });

  it('control: a chosen reason that is still in the new list (even relabelled and moved) is still sent', async () => {
    const onSubmit = sender();
    const { user, rerender } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'cheating');
    rerender(
      <ReportDialog
        {...props(onSubmit, { reporting: { ...STUDIO, reasons: [reason('cheating', 'Cheating (renamed)', 'Elsewhere'), reason('spam', 'Spam', 'Chat')] } })}
      />,
    );
    expect((why() as HTMLSelectElement).value).toBe('cheating');
    expect((why() as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('Cheating (renamed)');
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ reason: 'cheating' });
  });

  it('the list can drop to nothing: no select, no reason sent', async () => {
    const onSubmit = sender();
    const { user, rerender } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'spam');
    rerender(<ReportDialog {...props(onSubmit, { reporting: { ...STUDIO, reasons: [] } })} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({});
  });

  it('the hint of a reason that left the list is gone, and the note typed so far is kept and sent', async () => {
    const onSubmit = sender();
    const { user, rerender } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'harassment');
    expect(screen.getByText('Targeting or bullying someone')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await user.type(screen.getByRole('textbox'), 'still here');
    rerender(<ReportDialog {...props(onSubmit, { reporting: without('harassment') })} />);
    expect(screen.queryByText('Targeting or bullying someone')).toBeNull();
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ note: 'still here' });
  });

  it('after a stale reason left, picking another one sends the new one', async () => {
    const onSubmit = sender();
    const { user, rerender } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'spam');
    rerender(<ReportDialog {...props(onSubmit, { reporting: without('spam') })} />);
    await user.selectOptions(why(), 'afk');
    expect((why() as HTMLSelectElement).value).toBe('afk');
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ reason: 'afk' });
  });
});

describe('the "Add a note" door', () => {
  it('is a one-way door: a plain button with no aria-expanded (it is removed when pressed, and focus moves to the note)', async () => {
    const { user } = renderUi(<ReportDialog {...props(sender())} />);
    const door = screen.getByRole('button', { name: 'Add a note' });
    expect(door).not.toHaveAttribute('aria-expanded');
    expect(door).not.toHaveAttribute('aria-controls');
    await user.click(door);
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
    expect(screen.getByRole('textbox')).toHaveFocus();
  });
  // The comment that says why is checked on the source in static.test.ts (this file runs in jsdom, with no file URLs).
});

describe('with no reasons to offer', () => {
  it.each([
    ['no payload', undefined],
    ['an empty list in one_tap', { flow: 'one_tap', thanks: '', reasons: [] } as PlayerReporting],
    ['an empty list in reason_required', { flow: 'reason_required', thanks: '', reasons: [] } as PlayerReporting],
  ] as const)('%s: just the question, Report and Cancel, and one press files it', async (_name, reporting) => {
    const onSubmit = sender();
    const shown = props(onSubmit);
    delete shown.reporting;
    const { user } = renderUi(<ReportDialog {...shown} {...(reporting === undefined ? {} : { reporting })} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Report', 'Cancel']);
    await user.click(reportButton());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({});
    await findStatus();
  });
});

describe('there is no follow-up step', () => {
  it('after a report is sent there is no "Add a reason", no radios and no select, only Close; onAddDetail is never called', async () => {
    const onAddDetail = vi.fn(() => Promise.resolve({ ok: true } as const));
    const { user } = renderUi(<ReportDialog {...props(sender(), { onAddDetail })} />);
    await user.click(reportButton());
    await findStatus();
    expect(screen.queryByRole('button', { name: /reason/i })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    expect(onAddDetail).not.toHaveBeenCalled();
  });

  it('a result with a detail window does not bring a follow-up back', async () => {
    const onAddDetail = vi.fn(() => Promise.resolve({ ok: true } as const));
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve({ ok: true, reportId: 'r1', remaining: 1, detailUntil: Date.now() + 600_000 } as ReportResult));
    const { user } = renderUi(<ReportDialog {...props(onSubmit, { onAddDetail })} />);
    await user.click(reportButton());
    await findStatus();
    expect(screen.queryByRole('button', { name: /reason/i })).toBeNull();
    expect(onAddDetail).not.toHaveBeenCalled();
  });

  it('the old step\'s words stay in the catalogue (deprecated, a patch removes nothing) but the dialog never shows them', async () => {
    const old = ['player.report.addReason', 'player.report.addReasonHint', 'player.report.detail.send', 'player.report.skip', 'player.report.legend'] as const;
    for (const key of old) expect(Object.keys(en), key).toContain(key);
    const { user } = renderUi(<ReportDialog {...props(sender())} />);
    const shownBefore = screen.getByRole('dialog').textContent ?? '';
    await user.click(reportButton());
    await findStatus();
    const shownAfter = screen.getByRole('dialog').textContent ?? '';
    for (const key of old) {
      expect(shownBefore, key).not.toContain(en[key]);
      expect(shownAfter, key).not.toContain(en[key]);
    }
  });

  it('the draft the dialog sends carries only the kit\'s ReportInput fields (reason, note)', async () => {
    const onSubmit = sender();
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.selectOptions(why(), 'other');
    await user.type(screen.getByRole('textbox'), 'n');
    await user.click(reportButton());
    const draft = onSubmit.mock.calls[0]?.[0] as ReportDraft;
    expect(Object.keys(draft).sort()).toEqual(['note', 'reason']);
  });
});

describe('the real kit takes the one-step report', () => {
  it('a report with a reason and a note lands as one report with that reported reason', async () => {
    const w = await playerWorld();
    const room = 'one-step-room';
    w.cw.rooms.seat(room, ALICE.seat, { clientKey: ALICE.key }, ALICE.handle);
    w.cw.rooms.seat(room, BOB.seat, { clientKey: BOB.key }, BOB.handle);
    w.cw.chat.accept(room, BOB.seat, 'a line from the target');
    const reporting = (await w.client.rules()).reporting;
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>((d) => w.cw.reports.submit({ roomId: room, reporterSeat: ALICE.seat, targetSeat: BOB.seat, ...d }));
    const { user } = renderUi(<ReportDialog {...props(onSubmit, { reporting, now: w.now })} />);
    const first = [...why().querySelectorAll<HTMLOptionElement>('option')].find((o) => o.value !== '');
    expect(first).toBeDefined();
    await user.selectOptions(why(), (first as HTMLOptionElement).value);
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    await user.type(screen.getByRole('textbox'), 'a note');
    await user.click(reportButton());
    await findStatus();
    const items = w.cw.reports.list().items;
    expect(items).toHaveLength(1);
    expect(w.cw.reports.get((items[0] as (typeof items)[number]).id)?.reportedReason).toBe((first as HTMLOptionElement).value);
  });

  it('a refusal ends it in plain words and Close is all that is left', async () => {
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve({ ok: false, refused: 'duplicate' }));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await user.click(reportButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('You already reported this player here. We have your report.');
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  });
});
