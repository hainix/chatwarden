import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { REPORT_CATEGORIES, REPORT_NOTE_MAX } from '@chatwarden/core';
import type { ReportRefusal, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps, ReportDraft } from '../src/ReportDialog.js';
import { PlayerError } from '../src/client.js';
import { createT, en } from '../src/i18n.js';
import { FIXED, findStatus, renderUi } from './render.js';
import { ALICE, BOB, CARA, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

const props = (onSubmit: ReportDialogProps['onSubmit'], more: Partial<ReportDialogProps> = {}): ReportDialogProps => ({ onSubmit, onClose: () => undefined, ...FIXED, ...more });
const ok = (remaining: number): ReportResult => ({ ok: true, reportId: 'r1', remaining });
const refused = (refused: ReportRefusal, remaining?: number): ReportResult => (remaining === undefined ? { ok: false, refused } : { ok: false, refused, remaining });
const pick = async (user: ReturnType<typeof renderUi>['user'], name: string) => user.click(screen.getByRole('radio', { name }));
const send = (user: ReturnType<typeof renderUi>['user']) => user.click(screen.getByRole('button', { name: 'Send report' }));

/** The game server's side of a report: the real kit, with `who` reporting `target` in a room both sit in. */
function realSubmit(w: PlayerWorld, o: { roomId?: string; reporter?: typeof ALICE; target?: typeof BOB; reporterSeat?: string; targetSeat?: string } = {}) {
  const roomId = o.roomId ?? 'report-room';
  const reporter = o.reporter ?? ALICE;
  const target = o.target ?? BOB;
  w.cw.rooms.seat(roomId, reporter.seat, { clientKey: reporter.key }, reporter.handle);
  w.cw.rooms.seat(roomId, target.seat, { clientKey: target.key }, target.handle);
  w.cw.chat.accept(roomId, target.seat, 'a line from the target');
  return (draft: ReportDraft) =>
    w.cw.reports.submit({
      roomId,
      reporterSeat: o.reporterSeat ?? reporter.seat,
      targetSeat: o.targetSeat ?? target.seat,
      category: draft.category,
      ...(draft.note === undefined ? {} : { note: draft.note }),
    });
}

describe('the form', () => {
  it('is a labelled modal dialog with a heading, a category picker and an optional note', () => {
    renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)))} />);
    const d = screen.getByRole('dialog');
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleName('Report a player');
    expect(within(d).getByRole('heading', { level: 2, name: 'Report a player' })).toBeInTheDocument();
    const group = within(d).getByRole('radiogroup', { name: 'What happened?' });
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual([...REPORT_CATEGORIES]);
    expect(within(group).getAllByRole('radio')).toHaveLength(6);
    expect(within(d).getByLabelText('Add a note (optional)')).toBeInstanceOf(HTMLTextAreaElement);
    expect(within(d).getByRole('button', { name: 'Send report' })).toBeInTheDocument();
    expect(within(d).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('names each category in plain words', () => {
    renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)))} />);
    const labels = screen.getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent);
    expect(labels).toEqual(['Harassment', 'Hateful language', 'Cheating', 'Spam', 'Disrupting the game', 'Something else']);
  });

  it('names the player when it is given one, as text', () => {
    renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)), { targetName: '<b>Cara</b>' })} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Report <b>Cara</b>');
    expect(screen.getByRole('dialog').querySelector('b')).toBeNull();
  });

  it('offers only the categories it is given', () => {
    renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)), { categories: ['harassment', 'cheating'] })} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('tells the player what the note is for and its limit, and caps the note at the kit limit', () => {
    renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)))} />);
    const note = screen.getByLabelText('Add a note (optional)');
    expect(note).toHaveAttribute('maxlength', String(REPORT_NOTE_MAX));
    expect(note).toHaveAccessibleDescription(`A moderator will read this. Up to ${REPORT_NOTE_MAX} characters. Do not include passwords or personal details.`);
  });

  it('sending with no category picked asks for one and sends nothing', async () => {
    const onSubmit = vi.fn(() => Promise.resolve(ok(9)));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await send(user);
    expect(onSubmit).not.toHaveBeenCalled();
    const error = screen.getByText('Choose what happened.');
    expect(error).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('radiogroup', { name: 'What happened?' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('radiogroup')).toHaveAccessibleDescription(/Choose what happened\./);
    // Picking one clears the message.
    await pick(user, 'Spam');
    expect(screen.queryByText('Choose what happened.')).toBeNull();
    expect(screen.getByRole('radiogroup')).not.toHaveAttribute('aria-invalid');
  });

  it('moves focus to the picker when it is missing, so the player can fix it with the keyboard', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)))} />);
    await send(user);
    expect(screen.getAllByRole('radio')[0]).toHaveFocus();
  });

  it('sends the chosen category, and the note trimmed', async () => {
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve(ok(9)));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await pick(user, 'Cheating');
    await user.type(screen.getByLabelText('Add a note (optional)'), '   they used a snerp hack  ');
    await send(user);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ category: 'cheating', note: 'they used a snerp hack' });
  });

  it.each(['', '   ', '\n\t '])('leaves the note out when it is blank (%j)', async (blank) => {
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve(ok(9)));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await pick(user, 'Spam');
    if (blank !== '') fireEvent.change(screen.getByLabelText('Add a note (optional)'), { target: { value: blank } });
    await send(user);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ category: 'spam' });
  });

  it('sends each category as the kit knows it', async () => {
    for (const [i, category] of REPORT_CATEGORIES.entries()) {
      const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve(ok(9)));
      const { user, unmount } = renderUi(<ReportDialog {...props(onSubmit)} />);
      await user.click(screen.getAllByRole('radio')[i] as HTMLElement);
      await send(user);
      expect(onSubmit.mock.calls[0]?.[0]).toEqual({ category });
      unmount();
    }
  });
});

describe('a report that is taken', () => {
  it('thanks the player and shows how many more reports they can send today, from the real kit', async () => {
    const w = await playerWorld();
    const { user } = renderUi(<ReportDialog {...props(realSubmit(w), { targetName: 'Bob' })} />);
    await pick(user, 'Harassment');
    await send(user);
    expect(await findStatus()).toHaveTextContent('Thanks. We got your report. You can send 9 more reports today.');
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send report' })).toBeNull();
    expect(w.cw.reports.list().items).toHaveLength(1);
  });

  it.each([
    [10, 'You can send 10 more reports today.'],
    [2, 'You can send 2 more reports today.'],
    [1, 'You can send 1 more report today.'],
    [0, 'You have no more reports left today.'],
  ])('remaining %i reads "%s"', async (remaining, text) => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok(remaining)))} />);
    await pick(user, 'Spam');
    await send(user);
    expect(await findStatus()).toHaveTextContent(text);
  });

  it('never makes up a number: a result with no remaining says only thanks', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve({ ok: true, reportId: 'r' } as unknown as ReportResult))} />);
    await pick(user, 'Spam');
    await send(user);
    expect(await findStatus()).toHaveTextContent(/^Thanks\. We got your report\.$/);
  });

  it('moves focus to the heading once the form is gone, and Close calls onClose', async () => {
    const onClose = vi.fn();
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)), { onClose })} />);
    await pick(user, 'Spam');
    await send(user);
    await findStatus();
    // The question is over: the heading says what happened.
    expect(screen.getByRole('heading', { name: 'Report sent' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a result the dialog does not recognise is not shown as a success', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve({} as unknown as ReportResult))} />);
    await pick(user, 'Spam');
    await send(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not take that report.');
  });
});

describe('every refusal has its own plain message', () => {
  const MESSAGES: Record<ReportRefusal, string> = {
    duplicate: 'You already reported this player here. We have your report.',
    rate: 'You have sent as many reports as you can today. You can send more tomorrow.',
    self: 'You cannot report yourself.',
    not_player: 'We cannot find that player any more. They may have left.',
    off: 'Reports are not available right now. Try again later.',
    suspended: 'You cannot send reports from this account for now.',
    reason_required: 'This report needs a reason. Close this and report again to choose one.',
    reason_unknown: 'That reason is not available any more. Close this and report again.',
  };

  it('covers every refusal the kit has, with no two alike', () => {
    expect(Object.keys(MESSAGES).sort()).toEqual(['duplicate', 'not_player', 'off', 'rate', 'reason_required', 'reason_unknown', 'self', 'suspended']);
    expect(new Set(Object.values(MESSAGES)).size).toBe(8);
  });

  it.each(Object.entries(MESSAGES) as Array<[ReportRefusal, string]>)('%s', async (refusal, text) => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(refused(refusal, refusal === 'rate' ? 0 : undefined)))} />);
    await pick(user, 'Harassment');
    await send(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    // A refusal is final: the form is gone, with a way to close, and nothing says "Thanks".
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "Couldn't send the report" })).toHaveFocus();
  });

  it('shows a refusal in the words of its own key only: the catalog has one key per refusal', () => {
    for (const r of ['duplicate', 'rate', 'self', 'not_player', 'off', 'suspended', 'reason_required', 'reason_unknown']) expect(en).toHaveProperty(`player.report.refused.${r}`);
  });

  describe('from the real kit', () => {
    it('duplicate: the same reporter reports the same player in the same room twice', async () => {
      const w = await playerWorld();
      const submit = realSubmit(w);
      await submit({ category: 'harassment' });
      const { user } = renderUi(<ReportDialog {...props(submit)} />);
      await pick(user, 'Harassment');
      await send(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.duplicate);
    });

    it('self: the target seat is the reporter own seat', async () => {
      const w = await playerWorld();
      const { user } = renderUi(<ReportDialog {...props(realSubmit(w, { targetSeat: ALICE.seat }))} />);
      await pick(user, 'Spam');
      await send(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.self);
    });

    it('not_player: the target seat has nobody in it', async () => {
      const w = await playerWorld();
      const { user } = renderUi(<ReportDialog {...props(realSubmit(w, { targetSeat: 'empty-seat' }))} />);
      await pick(user, 'Spam');
      await send(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.not_player);
    });

    it('off: the reporter is not seated in the room', async () => {
      const w = await playerWorld();
      const { user } = renderUi(<ReportDialog {...props(realSubmit(w, { reporterSeat: 'nobody-here' }))} />);
      await pick(user, 'Spam');
      await send(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.off);
    });

    it('rate: the eleventh report in a day', async () => {
      const w = await playerWorld();
      // Ten different rooms, ten reports.
      for (let i = 0; i < 10; i += 1) {
        const r = await realSubmit(w, { roomId: `rate-room-${i}` })({ category: 'spam' });
        expect(r.ok).toBe(true);
      }
      const { user } = renderUi(<ReportDialog {...props(realSubmit(w, { roomId: 'rate-room-10' }))} />);
      await pick(user, 'Spam');
      await send(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.rate);
    });

    it('a different player is a different report (no duplicate)', async () => {
      const w = await playerWorld();
      await realSubmit(w)({ category: 'spam' });
      const { user } = renderUi(<ReportDialog {...props(realSubmit(w, { target: CARA }))} />);
      await pick(user, 'Spam');
      await send(user);
      expect(await findStatus()).toHaveTextContent('You can send 8 more reports today.');
    });
  });

  it('a refusal the kit adds later still gets a plain message, not a key and not a success', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(refused('future_reason' as ReportRefusal)))} />);
    await pick(user, 'Spam');
    await send(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We could not take that report.');
    expect(alert.textContent).not.toMatch(/player\./);
  });
});

describe('when sending fails', () => {
  it('a dropped connection keeps the form and what was typed, says so, and can be sent again', async () => {
    let fail = true;
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => (fail ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(ok(9))));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await pick(user, 'Hateful language');
    await user.type(screen.getByLabelText('Add a note (optional)'), 'what they said');
    await send(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your report was not sent. Could not reach the server. Check your connection and try again.');
    expect(screen.getByRole('radio', { name: 'Hateful language' })).toBeChecked();
    expect(screen.getByLabelText('Add a note (optional)')).toHaveValue('what they said');
    expect(screen.getByRole('button', { name: 'Send report' })).not.toHaveAttribute('aria-busy');
    fail = false;
    await send(user);
    expect(await findStatus()).toHaveTextContent('Thanks.');
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1]?.[0]).toEqual({ category: 'hate', note: 'what they said' });
  });

  it.each([
    [401, 'You are signed out. Sign in again, then try again.'],
    [403, 'This account cannot do that.'],
    [429, 'Too many requests. Try again in a moment.'],
    [500, 'The server had a problem. Try again in a moment.'],
  ])('a PlayerError %i from the game server says why, and keeps the form', async (status, text) => {
    const onSubmit = () => Promise.reject(new PlayerError({ status, code: 'x', message: 'SECRET server text' }));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await pick(user, 'Spam');
    await send(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(`Your report was not sent. ${text}`);
    expect(document.body.innerHTML).not.toContain('SECRET');
    expect(screen.getByRole('radio', { name: 'Spam' })).toBeChecked();
  });

  it('a synchronous throw from onSubmit is handled the same way', async () => {
    const onSubmit = () => {
      throw new Error('boom');
    };
    const { user } = renderUi(<ReportDialog {...props(onSubmit as unknown as ReportDialogProps['onSubmit'])} />);
    await pick(user, 'Spam');
    await send(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your report was not sent.');
  });
});

describe('double submit', () => {
  it('three clicks in one tick send one report', async () => {
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve(ok(9)));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await pick(user, 'Spam');
    const button = screen.getByRole('button', { name: 'Send report' });
    act(() => {
      button.click();
      button.click();
      button.click();
    });
    await findStatus();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('while the report is on its way: busy, not disabled (focus stays), and Enter sends nothing more', async () => {
    let release: (r: ReportResult) => void = () => undefined;
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => new Promise<ReportResult>((resolve) => (release = resolve)));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await pick(user, 'Spam');
    const button = screen.getByRole('button', { name: 'Send report' });
    await user.click(button);
    await user.click(button);
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveFocus();
    await act(async () => release(ok(9)));
    await findStatus();
  });

  it('the guard is cleared after a failure', async () => {
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.reject(new TypeError('x')));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await pick(user, 'Spam');
    await send(user);
    await screen.findByRole('alert');
    await send(user);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });

  it('the guard is cleared after a refusal, and Close is the only thing left to do', async () => {
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve(refused('duplicate')));
    const { user } = renderUi(<ReportDialog {...props(onSubmit)} />);
    await pick(user, 'Spam');
    await send(user);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Send report' })).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('unmounting while the report is on its way does not throw or warn', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release: (r: ReportResult) => void = () => undefined;
    const { user, unmount } = renderUi(<ReportDialog {...props(() => new Promise<ReportResult>((resolve) => (release = resolve)))} />);
    await pick(user, 'Spam');
    await send(user);
    unmount();
    await act(async () => release(ok(9)));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('focus and closing', () => {
  function Page({ open, ...p }: ReportDialogProps & { open: boolean }) {
    return (
      <>
        <button type="button">Report player</button>
        {open && <ReportDialog {...p} />}
        <button type="button">Settings</button>
      </>
    );
  }

  it('focus goes to the heading when it opens, and back to the button that opened it when it closes', async () => {
    const onClose = vi.fn();
    const base = props(() => Promise.resolve(ok(9)), { onClose });
    const { user, rerender } = renderUi(<Page {...base} open={false} />);
    const opener = screen.getByRole('button', { name: 'Report player' });
    await user.click(opener);
    expect(opener).toHaveFocus();
    rerender(<Page {...base} open />);
    const heading = screen.getByRole('heading', { name: 'Report a player' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    rerender(<Page {...base} open={false} />);
    expect(opener).toHaveFocus();
  });

  it('keeps Tab inside: forward from Cancel wraps to the first radio, Shift+Tab from the heading to Cancel', async () => {
    const { user } = renderUi(
      <>
        <button type="button">Report player</button>
        <ReportDialog {...props(() => Promise.resolve(ok(9)))} />
      </>,
    );
    const radios = screen.getAllByRole('radio');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    // The heading has focus; Shift+Tab goes to the last control, not out of the dialog.
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(radios[0]).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Report player' })).not.toHaveFocus();
  });

  it('Escape closes, and so does Cancel', async () => {
    const onClose = vi.fn();
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)), { onClose })} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a click on the backdrop does not close it (a half-written note is not lost by a stray click)', async () => {
    const onClose = vi.fn();
    const { container } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)), { onClose })} />);
    fireEvent.mouseDown(container.querySelector('.cw-scrim') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape while a report is on its way does not close it (the result would be lost)', async () => {
    const onClose = vi.fn();
    let release: (r: ReportResult) => void = () => undefined;
    const { user } = renderUi(<ReportDialog {...props(() => new Promise<ReportResult>((resolve) => (release = resolve)), { onClose })} />);
    await pick(user, 'Spam');
    await send(user);
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => release(ok(9)));
  });
});

describe('words and theme', () => {
  it('takes every word from t, and its theme and className from props', async () => {
    const t = createT({ ...en, 'player.report.title': 'Spieler melden', 'player.report.send': 'Melden' }, 'de');
    const { container } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok(9)), { t, locale: 'de', theme: 'dark', className: 'q' })} />);
    expect(screen.getByRole('heading', { name: 'Spieler melden' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Melden' })).toBeInTheDocument();
    const root = container.querySelector('.cw-player') as HTMLElement;
    expect(root).toHaveAttribute('data-cw-theme', 'dark');
    expect(root).toHaveClass('q');
  });
});
