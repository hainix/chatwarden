import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerReporting, ReportDetailResult, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps } from '../src/ReportDialog.js';
import { FIXED, renderUi } from './render.js';
import { ALICE, BOB, MINUTE, playerWorld } from './world.js';
import { REPORT_DETAIL_WINDOW_MS } from '@chatwarden/core';

// After a send the player must hear what happened: the heading says it (a question would be stale), and the thank-you is written into a
// status region that was already there. The follow-up is offered only while the kit would take it (`detailUntil`).

const ONE_TAP: PlayerReporting = { flow: 'one_tap', thanks: 'Got it. A moderator will look.', reasons: [{ id: 'other', label: 'Something else', hint: '', group: '', asksNote: true }, { id: 'hate', label: 'Hate', hint: '', group: '', asksNote: false }] };
const ok = (more: Partial<Extract<ReportResult, { ok: true }>> = {}): ReportResult => ({ ok: true, reportId: 'r1', remaining: 5, ...more });
const props = (onSubmit: ReportDialogProps['onSubmit'], more: Partial<ReportDialogProps> = {}): ReportDialogProps => ({ onSubmit, onClose: () => undefined, reporting: ONE_TAP, ...FIXED, ...more });
const press = (name: string) => screen.getByRole('button', { name });

afterEach(() => vi.useRealTimers());

describe('the heading says what happened', () => {
  it('one tap: the question becomes "Report sent", and focus is on it', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok()), { line: 'a line' })} />);
    expect(screen.getByRole('heading', { name: 'Report this message?' })).toBeInTheDocument();
    await user.click(press('Report'));
    await screen.findByText(/Got it. A moderator will look./);
    expect(screen.getByRole('heading', { level: 2, name: 'Report sent' })).toHaveFocus();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Report sent');
    expect(screen.queryByText('Report this message?')).toBeNull();
  });

  it('a refusal: "Couldn\'t send the report"', async () => {
    const refused = (): Promise<ReportResult> => Promise.resolve({ ok: false, refused: 'duplicate' });
    const { user } = renderUi(<ReportDialog {...props(refused)} />);
    await user.click(press('Report'));
    await screen.findByRole('alert');
    expect(screen.getByRole('heading', { level: 2, name: "Couldn't send the report" })).toHaveFocus();
  });

  it.each(['reason_first', 'reason_required'] as const)('%s: the same words after sending', async (flow) => {
    const reporting: PlayerReporting = { ...ONE_TAP, flow };
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok()), { reporting })} />);
    await user.click(screen.getByRole('radio', { name: 'Hate' }));
    await user.click(press('Send report'));
    await screen.findByText(/Got it. A moderator will look./);
    expect(screen.getByRole('heading', { level: 2, name: 'Report sent' })).toHaveFocus();
  });

  it('no reporting at all: the same words after the one tap', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok()), { reporting: undefined })} />);
    await user.click(press('Report'));
    await screen.findByRole('status');
    expect(screen.getByRole('heading', { level: 2, name: 'Report sent' })).toHaveFocus();
  });

  it('a dropped connection keeps the question: nothing was sent', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.reject(new TypeError('x')), { line: 'a line' })} />);
    await user.click(press('Report'));
    await screen.findByRole('alert');
    expect(screen.getByRole('heading', { level: 2, name: 'Report this message?' })).toBeInTheDocument();
  });
});

describe('the thank-you is written into a status region that was already there', () => {
  it('one status region exists from the start, empty, and the same element holds the thank-you', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok()))} />);
    const region = screen.getByRole('status');
    expect(region).toBeEmptyDOMElement();
    await user.click(press('Report'));
    await screen.findByText(/Got it. A moderator will look./);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Got it. A moderator will look. You can send 5 more reports today.');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('a refusal leaves it empty (the refusal is an alert)', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve({ ok: false, refused: 'rate', remaining: 0 }))} />);
    await user.click(press('Report'));
    await screen.findByRole('alert');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('"Added. Thanks." goes into the same region, after the thank-you', async () => {
    const onAddDetail = vi.fn<NonNullable<ReportDialogProps['onAddDetail']>>(() => Promise.resolve<ReportDetailResult>({ ok: true }));
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok()), { onAddDetail })} />);
    const region = screen.getByRole('status');
    await user.click(press('Report'));
    await screen.findByText(/Got it. A moderator will look./);
    await user.click(press('Add a reason'));
    await user.click(screen.getByRole('radio', { name: 'Hate' }));
    await user.click(press('Add to my report'));
    await screen.findByText('Added. Thanks.');
    expect(screen.getByRole('status')).toBe(region);
    expect(within(region).getByText('Added. Thanks.')).toBeInTheDocument();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'Report sent' })).toHaveFocus();
  });
});

describe('the follow-up is offered only while the kit would take it', () => {
  const at = 1_800_000_000_000;
  const withClock = (clock: { t: number }, more: Partial<ReportDialogProps> = {}) => ({ now: () => clock.t, ...more });

  it('without detailUntil (an older kit) it is offered as before', async () => {
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok()), { onAddDetail: () => Promise.resolve({ ok: true }) })} />);
    await user.click(press('Report'));
    expect(await screen.findByRole('button', { name: 'Add a reason' })).toBeInTheDocument();
  });

  it('with detailUntil in the future it is offered, and says for how long', async () => {
    const clock = { t: at };
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok({ detailUntil: at + 10 * MINUTE })), withClock(clock, { onAddDetail: () => Promise.resolve({ ok: true }) }))} />);
    await user.click(press('Report'));
    await user.click(await screen.findByRole('button', { name: 'Add a reason' }));
    expect(screen.getByText('This helps, but the moderators decide what it really is. You can add this for a few minutes after you report.')).toBeInTheDocument();
  });

  it('with detailUntil already past it is not offered at all', async () => {
    const clock = { t: at };
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok({ detailUntil: at - 1 })), withClock(clock, { onAddDetail: () => Promise.resolve({ ok: true }) }))} />);
    await user.click(press('Report'));
    await screen.findByText(/Got it. A moderator will look./);
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
  });

  it('it goes away when the time comes, with the panel open and what was typed dropped, and the report stays filed', async () => {
    const clock = { t: at };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onAddDetail = vi.fn(() => Promise.resolve<ReportDetailResult>({ ok: true }));
    const view = renderUi(<ReportDialog {...props(() => Promise.resolve(ok({ detailUntil: at + 1000 })), withClock(clock, { onAddDetail }))} />);
    await act(async () => press('Report').click());
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await act(async () => press('Add a reason').click());
    expect(screen.getAllByRole('radio').length).toBeGreaterThan(0);
    clock.t = at + 1001;
    await act(async () => void (await vi.advanceTimersByTimeAsync(1001)));
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Got it. A moderator will look.');
    expect(onAddDetail).not.toHaveBeenCalled();
    view.unmount();
  });

  it('exactly at detailUntil it is still offered (the kit takes it)', async () => {
    const clock = { t: at + 5 };
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok({ detailUntil: at + 5 })), withClock(clock, { onAddDetail: () => Promise.resolve({ ok: true }) }))} />);
    await user.click(press('Report'));
    expect(await screen.findByRole('button', { name: 'Add a reason' })).toBeInTheDocument();
  });

  it('from the real kit: detailUntil is the filing time plus the window, and the dialog uses it', async () => {
    const w = await playerWorld();
    w.cw.rooms.seat('rr', ALICE.seat, { clientKey: ALICE.key }, ALICE.handle);
    w.cw.rooms.seat('rr', BOB.seat, { clientKey: BOB.key }, BOB.handle);
    w.cw.chat.accept('rr', BOB.seat, 'a line');
    const filedAt = w.clock.t;
    const reporting = (await w.client.rules()).reporting as PlayerReporting;
    const submit = (): Promise<ReportResult> => w.cw.reports.submit({ roomId: 'rr', reporterSeat: ALICE.seat, targetSeat: BOB.seat });
    const probe = await submit();
    expect(probe.ok && probe.detailUntil).toBe(filedAt + REPORT_DETAIL_WINDOW_MS);
    // A second dialog, whose page clock is already past the window when the answer comes back.
    w.cw.rooms.seat('rr2', ALICE.seat, { clientKey: ALICE.key }, ALICE.handle);
    w.cw.rooms.seat('rr2', BOB.seat, { clientKey: BOB.key }, BOB.handle);
    const late = { t: filedAt + REPORT_DETAIL_WINDOW_MS + 1 };
    const { user } = renderUi(
      <ReportDialog
        {...props(() => w.cw.reports.submit({ roomId: 'rr2', reporterSeat: ALICE.seat, targetSeat: BOB.seat }), { reporting, ...withClock(late, { onAddDetail: () => Promise.resolve({ ok: true }) }) })}
      />,
    );
    await user.click(press('Report'));
    await screen.findByText(/./, { selector: '[role="status"] p' });
    expect(screen.queryByRole('button', { name: 'Add a reason' })).toBeNull();
  });
});
