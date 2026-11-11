import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProfileOverrides, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps, ReportDraft } from '../src/ReportDialog.js';
import { createT, en } from '../src/i18n.js';
import { FIXED, findStatus, renderUi } from './render.js';
import { ALICE, BOB, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

// The configurable report dialog: the three flows, rendered from the `reporting` payload of the real GET /rules, sent through the real
// kit (cw.reports.submit and cw.reports.addDetail). The reporter's reason is a hint: the kit stores it as `reportedReason`.

type Reporting = NonNullable<ProfileOverrides['reporting']>;
type Detail = Parameters<NonNullable<ReportDialogProps['onAddDetail']>>[1];

const ROOM = 'report-room';

/** The world plus the game server's two calls: submit and addDetail, as the adopter's routes would make them. */
async function setup(reporting?: Reporting) {
  const w = await playerWorld(reporting === undefined ? {} : { reporting });
  w.cw.rooms.seat(ROOM, ALICE.seat, { clientKey: ALICE.key }, ALICE.handle);
  w.cw.rooms.seat(ROOM, BOB.seat, { clientKey: BOB.key }, BOB.handle);
  w.cw.chat.accept(ROOM, BOB.seat, 'a line from the target');
  const submit = vi.fn<ReportDialogProps['onSubmit']>((draft: ReportDraft) =>
    w.cw.reports.submit({ roomId: ROOM, reporterSeat: ALICE.seat, targetSeat: BOB.seat, ...draft }),
  );
  const addDetail = vi.fn<NonNullable<ReportDialogProps['onAddDetail']>>((id: string, detail: Detail) => w.cw.reports.addDetail(id, ALICE.seat, detail));
  /** What the dialog would get from GET /rules, through the real player routes. */
  const payload = async () => (await w.client.rules()).reporting;
  const dialog = async (more: Partial<ReportDialogProps> = {}): Promise<ReportDialogProps> => {
    const reporting = await payload();
    return { onSubmit: submit, onAddDetail: addDetail, onClose: () => undefined, ...(reporting === undefined ? {} : { reporting }), ...FIXED, now: w.now, ...more };
  };
  return { w, submit, addDetail, payload, dialog, report: () => w.cw.reports.list().items };
}

const btn = (name: string | RegExp) => screen.getByRole('button', { name });
const oneReport = (w: PlayerWorld) => {
  const items = w.cw.reports.list().items;
  expect(items).toHaveLength(1);
  return items[0] as (typeof items)[number];
};

describe('GET /rules gives the dialog its reporting payload', () => {
  it('the client reads the flow, the reasons and the thank-you the real route sends', async () => {
    const { payload } = await setup();
    const r = await payload();
    expect(r?.flow).toBe('one_tap');
    expect(r?.thanks).toBe("Thanks for the report. We'll look into it.");
    expect(r?.reasons.map((x) => x.id)).toEqual(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'cheating', 'griefing', 'afk', 'other']);
    expect(r?.reasons[0]).toEqual({ id: 'harassment', label: 'Insults or harassment', hint: 'Insults, put-downs or picking on someone', group: 'Chat', asksNote: false });
  });

  it('an older server with no reporting key reads as undefined, and the rest of the answer is unchanged', async () => {
    const { w } = await setup();
    w.intercept.fn = () => ({ status: 200, body: { summary: 's', rules: [{ number: 1, title: 'T', text: 'x' }] } });
    const rules = await w.client.rules();
    expect(rules.reporting).toBeUndefined();
    expect(rules.rules).toHaveLength(1);
  });

  it.each([
    ['null', null],
    ['a string', 'one_tap'],
    ['an array', []],
    ['no reasons list', { flow: 'one_tap', thanks: 'x' }],
  ])('a reporting value that is %s reads as undefined (never a crash)', async (_name, value) => {
    const { w } = await setup();
    w.intercept.fn = () => ({ status: 200, body: { summary: 's', rules: [], reporting: value } });
    expect((await w.client.rules()).reporting).toBeUndefined();
  });

  it('keeps only the fields a player may read: a staff field the server should not send never reaches the page', async () => {
    const { w } = await setup();
    w.intercept.fn = () => ({
      status: 200,
      body: { summary: 's', rules: [], reporting: { flow: 'reason_first', thanks: 'T', reasons: [{ id: 'a', label: 'A', hint: 'h', group: 'G', asksNote: true, rules: [1, 2], enabled: true, actor: 'ann@example.test' }] } },
    });
    const r = (await w.client.rules()).reporting;
    expect(r?.reasons[0]).toEqual({ id: 'a', label: 'A', hint: 'h', group: 'G', asksNote: true });
  });

  it('drops a reason with no id or label, fills a missing hint, group and asksNote, and reads an unknown flow as one tap', async () => {
    const { w } = await setup();
    w.intercept.fn = () => ({
      status: 200,
      body: { summary: 's', rules: [], reporting: { flow: 'bogus', thanks: 5, reasons: [{ id: 'a', label: 'A' }, { id: 7, label: 'B' }, { id: 'c' }, null, 'x'] } },
    });
    const r = (await w.client.rules()).reporting;
    expect(r).toEqual({ flow: 'one_tap', thanks: '', reasons: [{ id: 'a', label: 'A', hint: '', group: '', asksNote: false }] });
  });
});

describe('one_tap: the default', () => {
  it('opens as one step: a question, the line in quotes (as text), the optional reason, a Report button, and one door to a note', async () => {
    const { dialog } = await setup();
    renderUi(<ReportDialog {...await dialog({ line: '<b>you play like a snerp</b>' })} />);
    const d = screen.getByRole('dialog');
    expect(d).toHaveAccessibleName('Report this message?');
    expect(within(d).getByRole('heading', { level: 2, name: 'Report this message?' })).toHaveFocus();
    const quote = d.querySelector('blockquote');
    expect(quote).toHaveTextContent('“<b>you play like a snerp</b>”');
    expect(quote?.querySelector('b')).toBeNull();
    expect(within(d).queryAllByRole('radio')).toHaveLength(0);
    expect(within(d).getByRole('combobox', { name: 'Why? (optional)' })).toBeInTheDocument();
    expect(within(d).queryByRole('textbox')).toBeNull();
    expect(within(d).getByRole('button', { name: 'Add a note' })).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Report' })).toHaveClass('cw-btn--primary');
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('with no line the question names the player, and with neither it asks about the player', async () => {
    const { dialog } = await setup();
    const a = renderUi(<ReportDialog {...await dialog({ targetName: 'Cara' })} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Report Cara?');
    expect(a.container.querySelector('blockquote')).toBeNull();
    a.unmount();
    renderUi(<ReportDialog {...await dialog()} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Report this player?');
  });

  it('a very long line is cut for the page, with an ellipsis', async () => {
    const { dialog } = await setup();
    const { container } = renderUi(<ReportDialog {...await dialog({ line: 'x'.repeat(2000) })} />);
    const text = container.querySelector('blockquote')?.textContent ?? '';
    expect(text.length).toBeLessThan(400);
    expect(text).toContain('…');
  });

  it('one press files the report at once with no reason: the kit holds it as "no reason given", and the dialog says thanks with the studio words', async () => {
    const { w, dialog, submit } = await setup({ thanks: 'Got it. A moderator will have a look.' });
    const { user } = renderUi(<ReportDialog {...await dialog({ line: 'a line' })} />);
    await user.click(btn('Report'));
    expect(await findStatus()).toHaveTextContent('Got it. A moderator will have a look. You can send 9 more reports today.');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toEqual({});
    const report = oneReport(w);
    expect(w.cw.reports.get(report.id)?.reportedReason).toBeNull();
    expect(screen.getByRole('heading', { name: 'Report sent' })).toHaveFocus();
  });

  it('uses the default thank-you when the studio has not changed it', async () => {
    const { dialog } = await setup();
    const { user } = renderUi(<ReportDialog {...await dialog()} />);
    await user.click(btn('Report'));
    expect(await findStatus()).toHaveTextContent("Thanks for the report. We'll look into it.");
  });

  it('three presses in one tick send one report', async () => {
    const { dialog, submit, w } = await setup();
    const { user } = renderUi(<ReportDialog {...await dialog()} />);
    const b = btn('Report');
    act(() => {
      b.click();
      b.click();
      b.click();
    });
    await findStatus();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(w.cw.reports.list().items).toHaveLength(1);
    await user.click(btn('Close'));
  });

  it('a dropped connection keeps the question and sends again on the next press', async () => {
    const { dialog, submit } = await setup();
    submit.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));
    const { user } = renderUi(<ReportDialog {...await dialog()} />);
    await user.click(btn('Report'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your report was not sent. Could not reach the server.');
    expect(screen.getByRole('button', { name: 'Report' })).not.toHaveAttribute('aria-busy');
    await user.click(btn('Report'));
    expect(await findStatus()).toHaveTextContent('Thanks');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('Escape and Cancel close it before anything is sent, and Escape does nothing while a report is on its way', async () => {
    const onClose = vi.fn();
    const { dialog, submit } = await setup();
    let release: (r: ReportResult) => void = () => undefined;
    const { user } = renderUi(<ReportDialog {...await dialog({ onClose })} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(btn('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    submit.mockImplementationOnce(() => new Promise<ReportResult>((resolve) => (release = resolve)));
    await user.click(btn('Report'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => release({ ok: true, reportId: 'r', remaining: 1 }));
  });

  it('a refusal ends it with its plain message (here: the same player reported twice)', async () => {
    const { dialog } = await setup();
    const first = renderUi(<ReportDialog {...await dialog()} />);
    await first.user.click(btn('Report'));
    await findStatus();
    first.unmount();
    const { user } = renderUi(<ReportDialog {...await dialog()} />);
    await user.click(btn('Report'));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already reported this player here. We have your report.');
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
  });
});

describe('one_tap: the reason is part of the one step (real kit)', () => {
  const select = () => screen.getByRole('combobox', { name: 'Why? (optional)' });

  it('offers the studio reasons in a select, Chat and Gameplay as groups, "Something else" last, and nothing after the report but Close', async () => {
    const { dialog } = await setup();
    const { user } = renderUi(<ReportDialog {...await dialog({ line: 'a line' })} />);
    const options = [...select().querySelectorAll('option')];
    expect(options).toHaveLength(11);
    expect(options[0]).toHaveTextContent('Choose a reason (optional)');
    expect(options.at(-1)).toHaveTextContent('Something else');
    expect([...select().querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Chat', 'Gameplay']);
    await user.click(btn('Report'));
    await findStatus();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  });

  it('a reason goes in the same report: the kit keeps one report with that reported reason, and onAddDetail is never called', async () => {
    const { w, dialog, addDetail, submit } = await setup();
    const { user } = renderUi(<ReportDialog {...await dialog()} />);
    await user.selectOptions(select(), 'cheating');
    await user.click(btn('Report'));
    await findStatus();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toEqual({ reason: 'cheating' });
    expect(w.cw.reports.get(oneReport(w).id)?.reportedReason).toBe('cheating');
    expect(addDetail).not.toHaveBeenCalled();
  });

  it('a reason and a note go together (trimmed) behind "Add a note"', async () => {
    const { w, dialog, submit } = await setup();
    const { user } = renderUi(<ReportDialog {...await dialog()} />);
    await user.selectOptions(select(), 'spam');
    await user.click(btn('Add a note'));
    await user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), '  same link three times  ');
    await user.click(btn('Report'));
    await findStatus();
    expect(submit.mock.calls[0]?.[0]).toEqual({ reason: 'spam', note: 'same link three times' });
    expect(w.cw.reports.get(oneReport(w).id)?.reportedReason).toBe('spam');
  });

  it('every reason the studio lists can be chosen and is sent as its id', async () => {
    const { dialog } = await setup();
    const ids = ((await dialog()).reporting?.reasons ?? []).map((r) => r.id);
    expect(ids).toHaveLength(10);
    for (const id of ids) {
      const submit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve({ ok: true, reportId: 'r', remaining: 1 }));
      const view = renderUi(<ReportDialog {...await dialog({ onSubmit: submit })} />);
      await view.user.selectOptions(select(), id);
      await view.user.click(btn('Report'));
      await findStatus();
      expect(submit.mock.calls[0]?.[0]).toMatchObject({ reason: id });
      view.unmount();
    }
  });

  it('with every reason switched off but "other" kept, the select offers just that', async () => {
    const s = await setup({ reasons: [{ id: 'a', label: 'A', enabled: false }, { id: 'other', label: 'Something else' }] });
    renderUi(<ReportDialog {...await s.dialog()} />);
    expect([...select().querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['', 'other']);
  });

  it('a reason the studio removed while the dialog was open: the kit says it is unknown, nothing is filed', async () => {
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(s.w.cw.policy.save({ reporting: { reasons: [{ id: 'harassment', label: 'Insults' }, { id: 'other', label: 'Something else' }] } }, { version: 0, actor: 'owner_ann', reason: 'shorter' }).ok).toBe(true);
    await user.selectOptions(select(), 'cheating');
    await user.click(btn('Report'));
    expect(await screen.findByRole('alert')).toHaveTextContent('That reason is not available any more. Close this and report again.');
    expect(s.w.cw.reports.list().items).toHaveLength(0);
    expect(btn('Close')).toBeInTheDocument();
  });

  it('a dropped connection keeps the chosen reason and the note, and the next press sends them', async () => {
    const s = await setup();
    s.submit.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.selectOptions(select(), 'other');
    await user.type(screen.getByRole('textbox'), 'kept');
    await user.click(btn('Report'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your report was not sent.');
    expect(select()).toHaveValue('other');
    expect(screen.getByRole('textbox')).toHaveValue('kept');
    await user.click(btn('Report'));
    await findStatus();
    expect(s.submit.mock.calls[1]?.[0]).toEqual({ reason: 'other', note: 'kept' });
  });

  it('two presses in one tick send one report with the reason', async () => {
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.selectOptions(select(), 'afk');
    const b = btn('Report');
    act(() => {
      b.click();
      b.click();
    });
    await findStatus();
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0]?.[0]).toEqual({ reason: 'afk' });
  });

  it('Escape closes it with a note open, before anything is sent', async () => {
    const onClose = vi.fn();
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog({ onClose })} />);
    await user.click(btn('Add a note'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it('the page never holds the report id or the room', async () => {
    const { w, dialog } = await setup();
    const { user } = renderUi(<ReportDialog {...await dialog()} />);
    await user.selectOptions(select(), 'hate');
    await user.click(btn('Report'));
    await findStatus();
    expect(document.body.innerHTML).not.toContain(oneReport(w).id);
    expect(document.body.innerHTML).not.toContain(ROOM);
  });
});

describe('reason_first', () => {
  const FIRST: Reporting = { flow: 'reason_first' };
  const select = () => screen.getByRole('combobox', { name: 'Why? (optional)' });

  it('is the same single dialog as one_tap: the select with its groups, "Something else" last, Report and Cancel', async () => {
    const s = await setup(FIRST);
    renderUi(<ReportDialog {...await s.dialog({ targetName: 'Bob' })} />);
    const d = screen.getByRole('dialog');
    expect(d).toHaveAccessibleName('Report Bob?');
    const group = (label: string) => [...select().querySelectorAll<HTMLOptGroupElement>('optgroup')].find((g) => g.label === label) as HTMLOptGroupElement;
    expect([...group('Chat').querySelectorAll('option')].map((o) => o.value)).toEqual(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info']);
    expect([...group('Gameplay').querySelectorAll('option')].map((o) => o.value)).toEqual(['cheating', 'griefing', 'afk']);
    expect(select().lastElementChild).toHaveTextContent('Something else');
    expect(within(d).queryAllByRole('radio')).toHaveLength(0);
    expect(within(d).queryByRole('button', { name: 'Skip and report' })).toBeNull();
    expect(within(d).queryByRole('button', { name: 'Send report' })).toBeNull();
    expect(btn('Report')).toBeInTheDocument();
  });

  it('puts "Something else" last even when the studio lists it first, and a group appears where its first reason is', async () => {
    const s = await setup({
      flow: 'reason_first',
      reasons: [
        { id: 'other', label: 'Anything else' },
        { id: 'a', label: 'A', group: 'Zed' },
        { id: 'b', label: 'B' },
        { id: 'c', label: 'C', group: 'Zed' },
      ],
    });
    renderUi(<ReportDialog {...await s.dialog()} />);
    expect([...select().querySelectorAll('option')].map((o) => o.value)).toEqual(['', 'a', 'c', 'b', 'other']);
    expect(within(select()).getByRole('group', { name: 'Zed' })).toBeInTheDocument();
    expect(select().querySelector('optgroup')?.querySelectorAll('option')).toHaveLength(2);
  });

  it('shows a reason hint under the select as its description, and the option is the label alone', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.getByRole('option', { name: 'Insults or harassment' })).toBeInTheDocument();
    await user.selectOptions(select(), 'harassment');
    expect(select()).toHaveAccessibleDescription('Insults, put-downs or picking on someone');
  });

  it('the select is the first Tab stop, and Tab stays inside the dialog', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(
      <>
        <button type="button">Report player</button>
        <ReportDialog {...await s.dialog()} />
      </>,
    );
    await user.tab();
    expect(select()).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('asks for a note only when the reason asks (here: Something else), and keeps it open after', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.selectOptions(select(), 'hate');
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.selectOptions(select(), 'other');
    expect(screen.getByLabelText('Note (optional)')).toBeInstanceOf(HTMLTextAreaElement);
    await user.selectOptions(select(), 'cheating');
    expect(screen.getByLabelText('Note (optional)')).toBeInTheDocument();
  });

  it('a studio reason can ask for a note too', async () => {
    const s = await setup({ flow: 'reason_first', reasons: [{ id: 'cheating', label: 'Cheating', asksNote: true }, { id: 'other', label: 'Else' }] });
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.selectOptions(select(), 'cheating');
    expect(screen.getByLabelText('Note (optional)')).toBeInTheDocument();
  });

  it('sends the chosen reason id, which the kit keeps as the reported reason', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.selectOptions(select(), 'hate');
    await user.click(btn('Report'));
    expect(await findStatus()).toHaveTextContent("Thanks for the report. We'll look into it.");
    expect(s.submit.mock.calls[0]?.[0]).toEqual({ reason: 'hate' });
    expect(s.w.cw.reports.get(oneReport(s.w).id)?.reportedReason).toBe('hate');
  });

  it('sends a reason and a trimmed note', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.selectOptions(select(), 'other');
    await user.type(screen.getByLabelText('Note (optional)'), '  odd thing  ');
    await user.click(btn('Report'));
    await findStatus();
    expect(s.submit.mock.calls[0]?.[0]).toEqual({ reason: 'other', note: 'odd thing' });
  });

  it('a reason is optional: Report with nothing chosen files it with no reason', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Report'));
    await findStatus();
    expect(s.submit.mock.calls[0]?.[0]).toEqual({});
    expect(s.w.cw.reports.get(oneReport(s.w).id)?.reportedReason).toBeNull();
  });

  it('a note the player wrote without a reason is sent alone', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Add a note'));
    await user.type(screen.getByLabelText('Note (optional)'), 'wrote this');
    await user.click(btn('Report'));
    await findStatus();
    expect(s.submit.mock.calls[0]?.[0]).toEqual({ note: 'wrote this' });
  });

  it('there is no "Add a reason" after', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.selectOptions(select(), 'hate');
    await user.click(btn('Report'));
    await findStatus();
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
  });

  it('while sending, Report is busy and a second press sends nothing more', async () => {
    const s = await setup(FIRST);
    let release: (r: ReportResult) => void = () => undefined;
    s.submit.mockImplementationOnce(() => new Promise<ReportResult>((resolve) => (release = resolve)));
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Report'));
    await user.click(btn('Report'));
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(btn('Report')).toHaveAttribute('aria-busy', 'true');
    await act(async () => release({ ok: true, reportId: 'r', remaining: 3 }));
  });
});

describe('reason_required', () => {
  const REQUIRED: Reporting = { flow: 'reason_required' };
  const select = () => screen.getByRole('combobox', { name: 'Why?' });

  it('is the same dialog with a required "Why?" select and no way to skip', async () => {
    const s = await setup(REQUIRED);
    renderUi(<ReportDialog {...await s.dialog()} />);
    expect(select()).toBeRequired();
    expect(select().querySelectorAll('option')).toHaveLength(11);
    expect(screen.queryByRole('button', { name: 'Skip and report' })).toBeNull();
    expect(btn('Report')).toBeInTheDocument();
  });

  it('asks for a reason when none is chosen, in its own words, and sends nothing', async () => {
    const s = await setup(REQUIRED);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Report'));
    expect(s.submit).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a reason.')).toHaveAttribute('role', 'alert');
    expect(select()).toHaveFocus();
    await user.selectOptions(select(), 'threat');
    await user.click(btn('Report'));
    await findStatus();
    expect(s.submit.mock.calls[0]?.[0]).toEqual({ reason: 'threat' });
  });

  it('a kit that wants a reason refuses a report without one, and a stale dialog says so in plain words', async () => {
    // The dialog was opened as one tap, then the studio switched to "reason required".
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(s.w.cw.policy.save({ reporting: { flow: 'reason_required' } }, { version: 0, actor: 'owner_ann', reason: 'stricter' }).ok).toBe(true);
    await user.click(btn('Report'));
    expect(await screen.findByRole('alert')).toHaveTextContent('This report needs a reason. Close this and report again to choose one.');
    expect(s.w.cw.reports.list().items).toHaveLength(0);
  });

  it('a reason the studio switched off while the dialog was open: the kit refuses it, and the message says to start again', async () => {
    const s = await setup(REQUIRED);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    const reasons = [{ id: 'harassment', label: 'Insults or harassment' }, { id: 'other', label: 'Something else' }];
    expect(s.w.cw.policy.save({ reporting: { flow: 'reason_required', reasons } }, { version: 0, actor: 'owner_ann', reason: 'shorter' }).ok).toBe(true);
    await user.selectOptions(select(), 'cheating');
    await user.click(btn('Report'));
    expect(await screen.findByRole('alert')).toHaveTextContent('That reason is not available any more. Close this and report again.');
    expect(s.w.cw.reports.list().items).toHaveLength(0);
  });
});

describe('with no reporting payload the dialog is one tap with the default words', () => {
  // The same fallback as a failed GET /rules: there is no 0.1.1 dialog to stay compatible with.
  const none = { reporting: undefined } as const;

  it('is one tap: "Report this player?", a Report button, no reason picker and no note', async () => {
    const s = await setup();
    renderUi(<ReportDialog {...await s.dialog(none)} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Report this player?');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByLabelText('Note (optional)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
    expect(btn('Report')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send report' })).toBeNull();
  });

  it('files the report at once with an empty draft (no reason, no category), and says thanks in the catalog words', async () => {
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog(none)} />);
    await user.click(btn('Report'));
    expect(await findStatus()).toHaveTextContent('Thanks. We got your report. You can send 9 more reports today.');
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(s.submit.mock.calls[0]?.[0]).toEqual({});
    expect(Object.keys(s.submit.mock.calls[0]?.[0] ?? {})).not.toContain('category');
    expect(oneReport(s.w).id).toBeTruthy();
  });

  it('offers no "Add a reason" step afterwards (there are no reasons to offer)', async () => {
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog(none)} />);
    await user.click(btn('Report'));
    await findStatus();
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
  });

  it('is the same screen as a failed rules fetch (the one-tap fallback payload)', async () => {
    const s = await setup();
    const a = renderUi(<ReportDialog {...await s.dialog(none)} />);
    const ids = (html: string) => html.replace(/_r_[a-z0-9]+_/g, 'ID');
    const without = ids(a.container.innerHTML);
    a.unmount();
    const b = renderUi(<ReportDialog {...await s.dialog({ reporting: { flow: 'one_tap', thanks: '', reasons: [] } })} />);
    expect(ids(b.container.innerHTML)).toBe(without);
  });

  it('a categories prop is gone: passing one changes nothing', async () => {
    const s = await setup();
    const withOld = await s.dialog({ ...none, ...({ categories: ['spam'] } as object) });
    renderUi(<ReportDialog {...withOld} />);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('when the studio payload is given it is used as it is', async () => {
    const s = await setup({ flow: 'reason_first' });
    renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.getByRole('combobox').querySelectorAll('option')).toHaveLength(11);
  });
});

describe('a payload the dialog cannot trust', () => {
  const bad = (reporting: unknown) => ({ reporting: reporting as ReportDialogProps['reporting'] });

  it('an unknown flow reads as one tap', async () => {
    const s = await setup();
    renderUi(<ReportDialog {...await s.dialog(bad({ flow: 'tell_me_everything', thanks: 'T', reasons: [{ id: 'a', label: 'A', hint: '', group: '', asksNote: false }] }))} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Report this player?');
    expect(btn('Report')).toBeInTheDocument();
  });

  it('a reason flow with no usable reason cannot be answered, so it falls back to one tap', async () => {
    const s = await setup();
    for (const flow of ['reason_first', 'reason_required']) {
      const { unmount } = renderUi(<ReportDialog {...await s.dialog(bad({ flow, thanks: 'T', reasons: [] }))} />);
      expect(btn('Report')).toBeInTheDocument();
      expect(screen.queryByRole('combobox')).toBeNull();
      unmount();
    }
  });

  it('labels, hints, groups and the thank-you are text, never markup', async () => {
    const s = await setup();
    const reporting = {
      flow: 'reason_first',
      thanks: '<img src=x onerror=alert(1)> thanks',
      reasons: [{ id: 'a', label: '<i>Bold</i> label', hint: '<script>1</script>', group: '<b>Group</b>', asksNote: false }, { id: 'other', label: 'Other', hint: '', group: '', asksNote: false }],
    };
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve({ ok: true, reportId: 'r', remaining: 2 }));
    const { container, user } = renderUi(<ReportDialog {...await s.dialog({ ...bad(reporting), onSubmit })} />);
    expect(container.querySelector('i, b, script, img')).toBeNull();
    expect(screen.getByRole('group', { name: '<b>Group</b>' })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox'), 'a');
    expect(screen.getByRole('option', { name: '<i>Bold</i> label' })).toBeInTheDocument();
    await user.click(btn('Report'));
    expect(await findStatus()).toHaveTextContent('<img src=x onerror=alert(1)> thanks');
    expect(container.querySelector('img')).toBeNull();
  });

  it('a blank thank-you falls back to the catalog words', async () => {
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog(bad({ flow: 'one_tap', thanks: '   ', reasons: [] }))} />);
    await user.click(btn('Report'));
    expect(await findStatus()).toHaveTextContent('Thanks. We got your report.');
  });

  it('a staff field in the payload (rule numbers, enabled) is never shown', async () => {
    const s = await setup();
    const reporting = { flow: 'reason_first', thanks: 'T', reasons: [{ id: 'a', label: 'Insults', hint: '', group: '', asksNote: false, rules: [7777], enabled: true, actor: 'ann@example.test' }, { id: 'other', label: 'Else', hint: '', group: '', asksNote: false }] };
    const { container } = renderUi(<ReportDialog {...await s.dialog(bad(reporting))} />);
    expect(container.textContent).not.toContain('7777');
    expect(container.textContent).not.toContain('ann@example.test');
  });
});

describe('the studio edits settings and the dialog changes (real routes, real kit)', () => {
  const save = (w: PlayerWorld, reporting: Reporting, version: number) => {
    const r = w.cw.policy.save({ reporting }, { version, actor: 'owner_ann', reason: 'edit' });
    expect(r.ok).toBe(true);
  };

  it('one tap, then reason first, then reason required: the same dialog props from GET /rules follow each edit (the select turns required)', async () => {
    const s = await setup();
    const a = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(btn('Report')).toBeInTheDocument();
    a.unmount();

    save(s.w, { flow: 'reason_first' }, 0);
    const b = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.getByRole('combobox', { name: 'Why? (optional)' })).not.toBeRequired();
    expect(btn('Report')).toBeInTheDocument();
    b.unmount();

    save(s.w, { flow: 'reason_required' }, 1);
    renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.queryByRole('combobox', { name: 'Why? (optional)' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Why?' })).toBeRequired();
    expect(btn('Report')).toBeInTheDocument();
  });

  it('a renamed reason, a new group, a hint, a switched-off reason and new thank-you words all show', async () => {
    const s = await setup();
    save(
      s.w,
      {
        flow: 'reason_first',
        thanks: 'We have it. Thank you.',
        reasons: [
          { id: 'lag_switch', label: 'Lag switching', hint: 'Cutting their own connection', group: 'Cheating and tricks' },
          { id: 'cheating', label: 'Using hacks', group: 'Cheating and tricks' },
          { id: 'spam', label: 'Spam', enabled: false },
          { id: 'other', label: 'Anything else', asksNote: false },
        ],
      },
      0,
    );
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    const select = screen.getByRole('combobox');
    expect([...select.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['', 'lag_switch', 'cheating', 'other']);
    expect(within(screen.getByRole('group', { name: 'Cheating and tricks' })).getAllByRole('option')).toHaveLength(2);
    await user.selectOptions(select, 'lag_switch');
    expect(select).toHaveAccessibleDescription('Cutting their own connection');
    await user.click(btn('Report'));
    expect(await findStatus()).toHaveTextContent('We have it. Thank you.');
    expect(s.w.cw.reports.get(oneReport(s.w).id)?.reportedReason).toBe('lag_switch');
  });

  it('an old adopter whose server sends the six categories still files them through the new dialog as reasons', async () => {
    const s = await setup({ flow: 'reason_first' });
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.selectOptions(screen.getByRole('combobox'), 'griefing');
    await user.click(btn('Report'));
    await findStatus();
    const report = s.w.cw.reports.get(oneReport(s.w).id);
    expect(report?.reportedReason).toBe('griefing');
    expect(report?.category).toBe('disruption');
  });
});

describe('words', () => {
  it('every word of the new screens is a key in the catalog, so a translation can replace it', async () => {
    const t = createT({ ...en, 'player.report.oneTap.send': 'Melden', 'player.report.addNote': 'Notiz', 'player.report.why': 'Warum?', 'player.report.thanks': 'Danke' }, 'de');
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog({ t, locale: 'de', reporting: { flow: 'one_tap', thanks: '', reasons: [{ id: 'other', label: 'Anderes', hint: '', group: '', asksNote: true }] } })} />);
    await user.click(btn('Melden'));
    expect(await findStatus()).toHaveTextContent('Danke');
  });

  it('the words of the form are catalog keys too: the select label, its placeholder and the note door', async () => {
    const t = createT({ ...en, 'player.report.addNote': 'Notiz', 'player.report.why': 'Warum?', 'player.report.choose': 'Grund waehlen', 'player.report.note': 'Notiz (optional)' }, 'de');
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog({ t, locale: 'de' })} />);
    expect(screen.getByRole('combobox', { name: 'Warum?' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Grund waehlen' })).toBeInTheDocument();
    await user.click(btn('Notiz'));
    expect(screen.getByRole('textbox', { name: 'Notiz (optional)' })).toBeInTheDocument();
  });
});
