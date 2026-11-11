import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { REPORT_DETAIL_WINDOW_MS } from '@chatwarden/core';
import type { ProfileOverrides, ReportDetailResult, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps, ReportDraft } from '../src/ReportDialog.js';
import { PlayerError } from '../src/client.js';
import { createT, en } from '../src/i18n.js';
import { FIXED, findStatus, renderUi } from './render.js';
import { ALICE, BOB, MINUTE, playerWorld } from './world.js';
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
  it('opens as one step: a question, the line in quotes (as text), a Report button and nothing else to fill in', async () => {
    const { dialog } = await setup();
    renderUi(<ReportDialog {...await dialog({ line: '<b>you play like a snerp</b>' })} />);
    const d = screen.getByRole('dialog');
    expect(d).toHaveAccessibleName('Report this message?');
    expect(within(d).getByRole('heading', { level: 2, name: 'Report this message?' })).toHaveFocus();
    const quote = d.querySelector('blockquote');
    expect(quote).toHaveTextContent('“<b>you play like a snerp</b>”');
    expect(quote?.querySelector('b')).toBeNull();
    expect(within(d).queryAllByRole('radio')).toHaveLength(0);
    expect(within(d).queryByRole('textbox')).toBeNull();
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

describe('one_tap: the optional reason afterwards', () => {
  async function sent(reporting?: Reporting, more: Partial<ReportDialogProps> = {}) {
    const s = await setup(reporting);
    const ui = renderUi(<ReportDialog {...await s.dialog(more)} />);
    await ui.user.click(btn('Report'));
    await findStatus();
    return { ...s, ...ui };
  }

  it('offers "Add a reason", closed, beside Close; opening it shows the reasons by group and a note', async () => {
    const { user } = await sent();
    const toggle = btn('Add a reason');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(10);
    expect(radios.at(-1)).toHaveAccessibleName('Something else');
    expect(screen.getByRole('group', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Gameplay' })).toBeInTheDocument();
    expect(screen.getByLabelText('Add a note (optional)')).toBeInstanceOf(HTMLTextAreaElement);
    expect(btn('Add to my report')).toBeInTheDocument();
    expect(btn('Close')).toBeInTheDocument();
  });

  it('a reason attaches to the same report: the kit keeps one report and its reported reason changes', async () => {
    const { user, w, addDetail } = await sent();
    const id = oneReport(w).id;
    await user.click(btn('Add a reason'));
    await user.click(screen.getByRole('radio', { name: 'Cheating' }));
    await user.click(btn('Add to my report'));
    expect(await screen.findByText('Added. Thanks.')).toBeInTheDocument();
    expect(addDetail).toHaveBeenCalledWith(id, { reason: 'cheating' });
    expect(w.cw.reports.list().items).toHaveLength(1);
    expect(w.cw.reports.get(id)?.reportedReason).toBe('cheating');
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('a reason and a note go together (trimmed), and a note alone is fine', async () => {
    const a = await sent();
    await a.user.click(btn('Add a reason'));
    await a.user.click(screen.getByRole('radio', { name: 'Something else' }));
    await a.user.type(screen.getByLabelText('Add a note (optional)'), '  they spammed my name  ');
    await a.user.click(btn('Add to my report'));
    await screen.findByText('Added. Thanks.');
    expect(a.addDetail.mock.calls[0]?.[1]).toEqual({ reason: 'other', note: 'they spammed my name' });
    expect(a.w.cw.reports.get(oneReport(a.w).id)?.note).toBe('they spammed my name');
    a.unmount();

    const b = await sent();
    await b.user.click(btn('Add a reason'));
    await b.user.type(screen.getByLabelText('Add a note (optional)'), 'just a note');
    await b.user.click(btn('Add to my report'));
    await screen.findByText('Added. Thanks.');
    expect(b.addDetail.mock.calls[0]?.[1]).toEqual({ note: 'just a note' });
    expect(b.w.cw.reports.get(oneReport(b.w).id)?.reportedReason).toBeNull();
  });

  it('adding nothing asks for a reason or a note and sends nothing', async () => {
    const { user, addDetail } = await sent();
    await user.click(btn('Add a reason'));
    await user.click(btn('Add to my report'));
    expect(addDetail).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a reason or write a note.')).toHaveAttribute('role', 'alert');
    await user.click(screen.getByRole('radio', { name: 'Spam or ads' }));
    expect(screen.queryByText('Choose a reason or write a note.')).toBeNull();
  });

  it('the toggle closes the panel again and keeps nothing sent', async () => {
    const { user, addDetail } = await sent();
    await user.click(btn('Add a reason'));
    await user.click(btn('Add a reason'));
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(addDetail).not.toHaveBeenCalled();
  });

  it('closing at any point is fine: the report was filed when the button was pressed', async () => {
    const onClose = vi.fn();
    const { user, w } = await sent(undefined, { onClose });
    await user.click(btn('Add a reason'));
    await user.click(screen.getByRole('radio', { name: 'Hate' }));
    await user.click(btn('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(w.cw.reports.list().items).toHaveLength(1);
    expect(w.cw.reports.get(oneReport(w).id)?.reportedReason).toBeNull();
  });

  it('Escape closes it with the panel open too', async () => {
    const onClose = vi.fn();
    const { user } = await sent(undefined, { onClose });
    await user.click(btn('Add a reason'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('without onAddDetail there is no "Add a reason" (the host has not wired the follow-up)', async () => {
    const s = await setup();
    const props = await s.dialog();
    const { onAddDetail: _unused, ...rest } = props;
    void _unused;
    const { user } = renderUi(<ReportDialog {...rest} />);
    await user.click(btn('Report'));
    await findStatus();
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
    expect(btn('Close')).toBeInTheDocument();
  });

  it('a result with no report id cannot take a follow-up, so it is not offered', async () => {
    const { dialog, submit } = await setup();
    submit.mockImplementationOnce(() => Promise.resolve({ ok: true, remaining: 4 } as unknown as ReportResult));
    const { user } = renderUi(<ReportDialog {...await dialog()} />);
    await user.click(btn('Report'));
    await findStatus();
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
  });

  it('with every reason switched off but "other" kept, the follow-up still offers it', async () => {
    const s = await setup({ reasons: [{ id: 'a', label: 'A', enabled: false }, { id: 'other', label: 'Something else' }] });
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Report'));
    await findStatus();
    await user.click(btn('Add a reason'));
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['other']);
  });

  it('a payload with no reasons at all offers no follow-up', async () => {
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog({ reporting: { flow: 'one_tap', thanks: 'Thanks.', reasons: [] } })} />);
    await user.click(btn('Report'));
    await findStatus();
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
  });

  describe('the follow-up window and its refusals, from the real kit', () => {
    it('in time: nine minutes later is still fine', async () => {
      const { user, w } = await sent();
      w.clock.t += 9 * MINUTE;
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      expect(await screen.findByText('Added. Thanks.')).toBeInTheDocument();
      expect(w.cw.reports.get(oneReport(w).id)?.reportedReason).toBe('hate');
    });

    it('exactly at the window is still fine and one millisecond later is too late', async () => {
      const a = await sent();
      a.w.clock.t += REPORT_DETAIL_WINDOW_MS;
      await a.user.click(btn('Add a reason'));
      await a.user.click(screen.getByRole('radio', { name: 'Hate' }));
      await a.user.click(btn('Add to my report'));
      expect(await screen.findByText('Added. Thanks.')).toBeInTheDocument();
      a.unmount();

      const b = await sent();
      b.w.clock.t += REPORT_DETAIL_WINDOW_MS + 1;
      await b.user.click(btn('Add a reason'));
      await b.user.click(screen.getByRole('radio', { name: 'Hate' }));
      await b.user.click(btn('Add to my report'));
      expect(await screen.findByRole('alert')).toHaveTextContent('It is too late to add to this report. We still have the report.');
    });

    it('a second time: the kit says it was already added, in plain words, and the panel is gone', async () => {
      const { user, w, addDetail } = await sent();
      // The first follow-up arrives some other way (a second window, a retry that the page never saw answered).
      const id = oneReport(w).id;
      await w.cw.reports.addDetail(id, ALICE.seat, { reason: 'spam' });
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      expect(await screen.findByRole('alert')).toHaveTextContent('You already added to this report.');
      expect(addDetail).toHaveBeenCalledTimes(1);
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
      expect(w.cw.reports.get(id)?.reportedReason).toBe('spam');
      expect(btn('Close')).toBeInTheDocument();
    });

    it('not the reporter: the kit refuses and the message says only the reporter can add', async () => {
      const { user, addDetail, w } = await sent();
      addDetail.mockImplementationOnce((id, detail) => w.cw.reports.addDetail(id, BOB.seat, detail));
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      expect(await screen.findByRole('alert')).toHaveTextContent('Only the player who sent a report can add to it.');
      expect(w.cw.reports.get(oneReport(w).id)?.reportedReason).toBeNull();
    });

    it('a reason the studio removed while the dialog was open: the kit says it is unknown, the report stays', async () => {
      const { user, w } = await sent();
      const layer = { reporting: { reasons: [{ id: 'harassment', label: 'Harassment' }, { id: 'other', label: 'Something else' }] } };
      expect(w.cw.policy.save(layer, { version: 0, actor: 'owner_ann', reason: 'shorter list' }).ok).toBe(true);
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Cheating' }));
      await user.click(btn('Add to my report'));
      expect(await screen.findByRole('alert')).toHaveTextContent('That reason is not available any more. Your report is still with us.');
      expect(w.cw.reports.list().items).toHaveLength(1);
    });

    it('a report that was already decided is too late', async () => {
      const { user, w } = await sent();
      const id = oneReport(w).id;
      const subject = w.cw.rooms.subjectAt(ROOM, BOB.seat);
      if (subject === null) throw new Error('no subject');
      const decided = await w.cw.decide({ reportId: id, verdict: 'upheld', actor: 'ann@example.test', reason: 'checked', actions: [{ subject, kind: 'warning', durationMs: null, rule: 1, lineIds: [] }] });
      expect(decided.ok).toBe(true);
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      expect(await screen.findByRole('alert')).toHaveTextContent('It is too late to add to this report. We still have the report.');
    });
  });

  describe('every follow-up refusal has its own plain message', () => {
    const MESSAGES: Record<Exclude<Extract<ReportDetailResult, { ok: false }>['refused'], never>, string> = {
      off: 'Adding to a report is not available right now.',
      not_found: 'We cannot find that report any more.',
      not_reporter: 'Only the player who sent a report can add to it.',
      too_late: 'It is too late to add to this report. We still have the report.',
      already_added: 'You already added to this report.',
      reason_unknown: 'That reason is not available any more. Your report is still with us.',
    };

    it('covers the six refusals, no two alike', () => {
      expect(Object.keys(MESSAGES).sort()).toEqual(['already_added', 'not_found', 'not_reporter', 'off', 'reason_unknown', 'too_late']);
      expect(new Set(Object.values(MESSAGES)).size).toBe(6);
    });

    it.each(Object.entries(MESSAGES) as Array<[keyof typeof MESSAGES, string]>)('%s', async (refused, text) => {
      const { user, addDetail } = await sent();
      addDetail.mockImplementationOnce(() => Promise.resolve({ ok: false, refused }));
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(text);
      expect(screen.queryByText('Added. Thanks.')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Thanks');
    });

    it('a refusal a newer kit adds still gets a plain message', async () => {
      const { user, addDetail } = await sent();
      addDetail.mockImplementationOnce(() => Promise.resolve({ ok: false, refused: 'future' } as unknown as ReportDetailResult));
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('We could not add that.');
      expect(alert.textContent).not.toMatch(/player\./);
    });

    it('a result that is not an object is not a success', async () => {
      const { user, addDetail } = await sent();
      addDetail.mockImplementationOnce(() => Promise.resolve(undefined as unknown as ReportDetailResult));
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      expect(await screen.findByRole('alert')).toHaveTextContent('We could not add that.');
      expect(screen.queryByText('Added. Thanks.')).toBeNull();
    });
  });

  describe('when the follow-up cannot be sent', () => {
    it('a dropped connection keeps the panel and what was chosen, and the next press sends', async () => {
      const { user, addDetail } = await sent();
      addDetail.mockImplementationOnce(() => Promise.reject(new TypeError('fetch failed')));
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      expect(await screen.findByRole('alert')).toHaveTextContent('We could not add that. Could not reach the server. Check your connection and try again.');
      expect(screen.getByRole('radio', { name: 'Hate' })).toBeChecked();
      await user.click(btn('Add to my report'));
      expect(await screen.findByText('Added. Thanks.')).toBeInTheDocument();
      expect(addDetail).toHaveBeenCalledTimes(2);
    });

    it.each([
      [401, 'You are signed out. Sign in again, then try again.'],
      [429, 'Too many requests. Try again in a moment.'],
      [500, 'The server had a problem. Try again in a moment.'],
    ])('a PlayerError %i says why and never shows the server text', async (status, text) => {
      const { user, addDetail } = await sent();
      addDetail.mockImplementationOnce(() => Promise.reject(new PlayerError({ status, code: 'x', message: 'SECRET server text' })));
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      expect(await screen.findByRole('alert')).toHaveTextContent(`We could not add that. ${text}`);
      expect(document.body.innerHTML).not.toContain('SECRET');
    });

    it('two presses in one tick send one follow-up', async () => {
      const { user, addDetail } = await sent();
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      const b = btn('Add to my report');
      act(() => {
        b.click();
        b.click();
      });
      await screen.findByText('Added. Thanks.');
      expect(addDetail).toHaveBeenCalledTimes(1);
    });

    it('Escape while the follow-up is on its way does not close it', async () => {
      const onClose = vi.fn();
      const { user, addDetail } = await sent(undefined, { onClose });
      let release: (r: ReportDetailResult) => void = () => undefined;
      addDetail.mockImplementationOnce(() => new Promise<ReportDetailResult>((resolve) => (release = resolve)));
      await user.click(btn('Add a reason'));
      await user.click(screen.getByRole('radio', { name: 'Hate' }));
      await user.click(btn('Add to my report'));
      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => release({ ok: true }));
    });
  });

  it('the page never holds the report id the follow-up uses', async () => {
    const { user, w } = await sent();
    await user.click(btn('Add a reason'));
    const id = oneReport(w).id;
    expect(document.body.innerHTML).not.toContain(id);
    expect(document.body.innerHTML).not.toContain(ROOM);
  });
});

describe('reason_first', () => {
  const FIRST: Reporting = { flow: 'reason_first' };

  it('shows the reasons in groups (a fieldset each), one radio group, with "Something else" last', async () => {
    const s = await setup(FIRST);
    renderUi(<ReportDialog {...await s.dialog({ targetName: 'Bob' })} />);
    const d = screen.getByRole('dialog');
    expect(d).toHaveAccessibleName('Report Bob');
    const outer = within(d).getByRole('radiogroup', { name: 'What happened?' });
    const chat = within(outer).getByRole('group', { name: 'Chat' });
    const play = within(outer).getByRole('group', { name: 'Gameplay' });
    expect(within(chat).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info']);
    expect(within(play).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['cheating', 'griefing', 'afk']);
    const all = screen.getAllByRole('radio');
    expect(all).toHaveLength(10);
    expect(new Set(all.map((r) => (r as HTMLInputElement).name)).size).toBe(1);
    expect(all.at(-1)).toHaveAccessibleName('Something else');
    expect(within(d).queryByRole('button', { name: 'Report' })).toBeNull();
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
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['a', 'c', 'b', 'other']);
    expect(within(screen.getByRole('group', { name: 'Zed' })).getAllByRole('radio')).toHaveLength(2);
  });

  it('shows a reason hint as its description, and the label alone as its name', async () => {
    const s = await setup(FIRST);
    renderUi(<ReportDialog {...await s.dialog()} />);
    const radio = screen.getByRole('radio', { name: 'Insults or harassment' });
    expect(radio).toHaveAccessibleDescription('Insults, put-downs or picking on someone');
  });

  it('a radio group is one Tab stop, like the old picker', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(
      <>
        <button type="button">Report player</button>
        <ReportDialog {...await s.dialog()} />
      </>,
    );
    await user.tab();
    expect(screen.getAllByRole('radio')[0]).toHaveFocus();
    await user.tab();
    expect(document.activeElement).not.toBeInstanceOf(HTMLInputElement);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    // Shift+Tab from the first control goes to the last, not out.
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('arrow keys move through the radios across the groups', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.tab();
    await user.keyboard('{ArrowDown}'.repeat(6));
    expect(screen.getByRole('radio', { name: 'Cheating' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Cheating' })).toBeChecked();
  });

  it('asks for a note only when the reason asks (here: Something else)', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Hate' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    expect(screen.getByLabelText('Add a note (optional)')).toBeInstanceOf(HTMLTextAreaElement);
    await user.click(screen.getByRole('radio', { name: 'Cheating' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a studio reason can ask for a note too', async () => {
    const s = await setup({ flow: 'reason_first', reasons: [{ id: 'cheating', label: 'Cheating', asksNote: true }, { id: 'other', label: 'Else' }] });
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(screen.getByRole('radio', { name: 'Cheating' }));
    expect(screen.getByLabelText('Add a note (optional)')).toBeInTheDocument();
  });

  it('sends the chosen reason id, which the kit keeps as the reported reason', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(screen.getByRole('radio', { name: 'Hate' }));
    await user.click(btn('Send report'));
    expect(await findStatus()).toHaveTextContent("Thanks for the report. We'll look into it.");
    expect(s.submit.mock.calls[0]?.[0]).toEqual({ reason: 'hate' });
    expect(s.w.cw.reports.get(oneReport(s.w).id)?.reportedReason).toBe('hate');
  });

  it('sends a reason and a trimmed note', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.type(screen.getByLabelText('Add a note (optional)'), '  odd thing  ');
    await user.click(btn('Send report'));
    await findStatus();
    expect(s.submit.mock.calls[0]?.[0]).toEqual({ reason: 'other', note: 'odd thing' });
  });

  it('a reason is optional: "Skip and report" files it with no reason', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Skip and report'));
    await findStatus();
    expect(s.submit.mock.calls[0]?.[0]).toEqual({});
    expect(s.w.cw.reports.get(oneReport(s.w).id)?.reportedReason).toBeNull();
  });

  it('"Send report" with nothing chosen says what to do and sends nothing; picking clears it', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Send report'));
    expect(s.submit).not.toHaveBeenCalled();
    expect(screen.getByText('Choose what happened, or skip.')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getAllByRole('radio')[0]).toHaveFocus();
    await user.click(screen.getByRole('radio', { name: 'Spam or ads' }));
    expect(screen.queryByText('Choose what happened, or skip.')).toBeNull();
  });

  it('"Skip and report" keeps a note the player already wrote, and sends no reason', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(screen.getByRole('radio', { name: 'Something else' }));
    await user.type(screen.getByLabelText('Add a note (optional)'), 'wrote this');
    await user.click(btn('Skip and report'));
    await findStatus();
    expect(s.submit.mock.calls[0]?.[0]).toEqual({ note: 'wrote this' });
  });

  it('there is no "Add a reason" after: the reason step came first', async () => {
    const s = await setup(FIRST);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(screen.getByRole('radio', { name: 'Hate' }));
    await user.click(btn('Send report'));
    await findStatus();
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
  });

  it('while sending, both buttons are busy and a second press sends nothing more', async () => {
    const s = await setup(FIRST);
    let release: (r: ReportResult) => void = () => undefined;
    s.submit.mockImplementationOnce(() => new Promise<ReportResult>((resolve) => (release = resolve)));
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Skip and report'));
    await user.click(btn('Skip and report'));
    await user.click(btn('Send report'));
    expect(s.submit).toHaveBeenCalledTimes(1);
    expect(btn('Skip and report')).toHaveAttribute('aria-busy', 'true');
    await act(async () => release({ ok: true, reportId: 'r', remaining: 3 }));
  });
});

describe('reason_required', () => {
  const REQUIRED: Reporting = { flow: 'reason_required' };

  it('is the same screen without a way to skip', async () => {
    const s = await setup(REQUIRED);
    renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.getAllByRole('radio')).toHaveLength(10);
    expect(screen.queryByRole('button', { name: 'Skip and report' })).toBeNull();
    expect(btn('Send report')).toBeInTheDocument();
  });

  it('asks for a reason when none is chosen, in its own words, and sends nothing', async () => {
    const s = await setup(REQUIRED);
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Send report'));
    expect(s.submit).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a reason.')).toHaveAttribute('role', 'alert');
    await user.click(screen.getByRole('radio', { name: 'Threats' }));
    await user.click(btn('Send report'));
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
    await user.click(screen.getByRole('radio', { name: 'Cheating' }));
    await user.click(btn('Send report'));
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
    expect(screen.queryByLabelText('Add a note (optional)')).toBeNull();
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
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('when the studio payload is given it is used as it is', async () => {
    const s = await setup({ flow: 'reason_first' });
    renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.getAllByRole('radio')).toHaveLength(10);
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
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
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
    await user.click(screen.getByRole('radio', { name: '<i>Bold</i> label' }));
    await user.click(btn('Send report'));
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

  it('one tap, then pick a reason first, then require one: the same dialog props from GET /rules follow each edit', async () => {
    const s = await setup();
    const a = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(btn('Report')).toBeInTheDocument();
    a.unmount();

    save(s.w, { flow: 'reason_first' }, 0);
    const b = renderUi(<ReportDialog {...await s.dialog()} />);
    expect(btn('Skip and report')).toBeInTheDocument();
    b.unmount();

    save(s.w, { flow: 'reason_required' }, 1);
    renderUi(<ReportDialog {...await s.dialog()} />);
    expect(screen.queryByRole('button', { name: 'Skip and report' })).toBeNull();
    expect(btn('Send report')).toBeInTheDocument();
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
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['lag_switch', 'cheating', 'other']);
    expect(within(screen.getByRole('group', { name: 'Cheating and tricks' })).getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Lag switching' })).toHaveAccessibleDescription('Cutting their own connection');
    await user.click(screen.getByRole('radio', { name: 'Lag switching' }));
    await user.click(btn('Send report'));
    expect(await findStatus()).toHaveTextContent('We have it. Thank you.');
    expect(s.w.cw.reports.get(oneReport(s.w).id)?.reportedReason).toBe('lag_switch');
  });

  it('an old adopter whose server sends the six categories still files them through the new dialog as reasons', async () => {
    const s = await setup({ flow: 'reason_first' });
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(screen.getByRole('radio', { name: 'Throwing or griefing' }));
    await user.click(btn('Send report'));
    await findStatus();
    const report = s.w.cw.reports.get(oneReport(s.w).id);
    expect(report?.reportedReason).toBe('griefing');
    expect(report?.category).toBe('disruption');
  });
});

describe('words', () => {
  it('every word of the new screens is a key in the catalog, so a translation can replace it', async () => {
    const t = createT({ ...en, 'player.report.oneTap.send': 'Melden', 'player.report.addReason': 'Grund nennen', 'player.report.thanks': 'Danke' }, 'de');
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog({ t, locale: 'de', reporting: { flow: 'one_tap', thanks: '', reasons: [{ id: 'other', label: 'Anderes', hint: '', group: '', asksNote: true }] } })} />);
    await user.click(btn('Melden'));
    expect(await findStatus()).toHaveTextContent('Danke');
    expect(btn('Grund nennen')).toBeInTheDocument();
  });

  it('waits for the follow-up button to come back to rest after a send', async () => {
    const s = await setup();
    const { user } = renderUi(<ReportDialog {...await s.dialog()} />);
    await user.click(btn('Report'));
    await findStatus();
    await waitFor(() => expect(btn('Add a reason')).not.toHaveAttribute('aria-busy'));
  });
});
