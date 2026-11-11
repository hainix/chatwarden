import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerReporting, ReportDetailResult, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps } from '../src/ReportDialog.js';
import { FIXED, renderUi } from './render.js';
import { ALICE, BOB, MINUTE, playerWorld } from './world.js';
import { REPORT_DETAIL_WINDOW_MS } from '@chatwarden/core';

// After a send the player must hear what happened: the heading says it (a question would be stale), and the thank-you is written into a
// status region that was already there. There is no follow-up step any more, whatever window the kit sends.

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
    await user.selectOptions(screen.getByRole('combobox'), 'hate');
    await user.click(press('Report'));
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

  it('the region holds the thank-you only: there is no follow-up line after it', async () => {
    const onAddDetail = vi.fn<NonNullable<ReportDialogProps['onAddDetail']>>(() => Promise.resolve<ReportDetailResult>({ ok: true }));
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok()), { onAddDetail })} />);
    const region = screen.getByRole('status');
    await user.click(press('Report'));
    await screen.findByText(/Got it. A moderator will look./);
    expect(screen.getByRole('status')).toBe(region);
    expect(within(region).getAllByText(/./)).toHaveLength(1);
    expect(screen.queryByText('Added. Thanks.')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'Report sent' })).toHaveFocus();
    expect(onAddDetail).not.toHaveBeenCalled();
  });
});

describe('a detail window from the kit never brings a follow-up step back (the dialog is one step)', () => {
  const at = 1_800_000_000_000;
  const withClock = (clock: { t: number }, more: Partial<ReportDialogProps> = {}) => ({ now: () => clock.t, ...more });
  const onAddDetail = () => Promise.resolve<ReportDetailResult>({ ok: true });

  it.each([
    ['no detailUntil (an older kit)', {}],
    ['detailUntil in the future', { detailUntil: at + 10 * MINUTE }],
    ['detailUntil exactly now', { detailUntil: at }],
    ['detailUntil already past', { detailUntil: at - 1 }],
  ])('%s: Close is all there is after the thank-you', async (_name, more) => {
    const clock = { t: at };
    const { user } = renderUi(<ReportDialog {...props(() => Promise.resolve(ok(more)), withClock(clock, { onAddDetail }))} />);
    await user.click(press('Report'));
    await screen.findByText(/Got it. A moderator will look./);
    expect(screen.queryByRole('button', { name: /reason/i })).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  });

  it('from the real kit: it still sends detailUntil (the filing time plus the window), and the dialog offers nothing more', async () => {
    const w = await playerWorld();
    w.cw.rooms.seat('rr', ALICE.seat, { clientKey: ALICE.key }, ALICE.handle);
    w.cw.rooms.seat('rr', BOB.seat, { clientKey: BOB.key }, BOB.handle);
    w.cw.chat.accept('rr', BOB.seat, 'a line');
    const filedAt = w.clock.t;
    const reporting = (await w.client.rules()).reporting as PlayerReporting;
    const probe = await w.cw.reports.submit({ roomId: 'rr', reporterSeat: ALICE.seat, targetSeat: BOB.seat });
    expect(probe.ok && probe.detailUntil).toBe(filedAt + REPORT_DETAIL_WINDOW_MS);
    w.cw.rooms.seat('rr2', ALICE.seat, { clientKey: ALICE.key }, ALICE.handle);
    w.cw.rooms.seat('rr2', BOB.seat, { clientKey: BOB.key }, BOB.handle);
    const { user } = renderUi(
      <ReportDialog {...props(() => w.cw.reports.submit({ roomId: 'rr2', reporterSeat: ALICE.seat, targetSeat: BOB.seat }), { reporting, ...withClock({ t: filedAt }, { onAddDetail }) })} />,
    );
    await user.click(press('Report'));
    await screen.findByText(/./, { selector: '[role="status"] p' });
    expect(screen.queryByRole('button', { name: /reason/i })).toBeNull();
  });
});
