import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NoticeQueue } from '../src/NoticeQueue.js';
import type { NoticeQueueProps } from '../src/NoticeQueue.js';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps } from '../src/ReportDialog.js';
import { FIXED, findStatus, renderUi, SIX_REASONS } from './render.js';
import { ALICE, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';
import type { ReportResult } from '@chatwarden/core';

const props = (w: PlayerWorld, more: Partial<NoticeQueueProps> = {}): NoticeQueueProps => ({ client: w.client, now: w.now, ...FIXED, ...more });
const posts = (w: PlayerWorld) => w.sent.filter((r) => r.method === 'POST');
const gets = (w: PlayerWorld) => w.sent.filter((r) => r.method === 'GET').length;
const dialog = () => screen.findByRole('dialog');
const fail500 = (req: { method: string }) => (req.method === 'POST' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
const inside = (d: HTMLElement) => expect(d).toContainElement(document.activeElement as HTMLElement);

describe('the focus trap holds (NoticeQueue)', () => {
  function Outside(p: NoticeQueueProps) {
    return (
      <>
        <button type="button">Game menu</button>
        <NoticeQueue {...p} />
        <button type="button">Settings</button>
      </>
    );
  }

  it('a click on the backdrop keeps focus in the dialog, and Tab afterwards stays inside', async () => {
    const w = await playerWorld();
    await w.warn();
    const { container, user } = renderUi(<Outside {...props(w, { appealUrl: 'https://game.test/appeal' })} />);
    const d = await dialog();
    await user.click(container.querySelector('.cw-scrim') as HTMLElement);
    inside(d);
    await user.tab();
    inside(d);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    inside(d);
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveFocus();
  });

  it('an element outside the dialog that gets focus by script gives it back', async () => {
    const w = await playerWorld();
    await w.warn();
    renderUi(<Outside {...props(w)} />);
    const d = await dialog();
    act(() => screen.getByRole('button', { name: 'Settings' }).focus());
    inside(d);
    act(() => screen.getByRole('button', { name: 'Game menu' }).focus());
    inside(d);
  });

  it('stops guarding once the dialog is gone: an outside element can then take focus', async () => {
    const w = await playerWorld();
    await w.warn();
    const { user } = renderUi(<Outside {...props(w)} />);
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    act(() => screen.getByRole('button', { name: 'Settings' }).focus());
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveFocus();
  });
});

describe('the focus trap holds (ReportDialog)', () => {
  const ok = () => Promise.resolve<ReportResult>({ ok: true, reportId: 'r', remaining: 9 });
  const rd = (more: Partial<ReportDialogProps> = {}): ReportDialogProps => ({ onSubmit: ok, onClose: () => undefined, ...FIXED, reporting: SIX_REASONS, ...more });

  it('after choosing Spam, Shift+Tab from it goes to the last control, not out of the dialog', async () => {
    const { user } = renderUi(
      <>
        <button type="button">Game menu</button>
        <ReportDialog {...rd()} />
      </>,
    );
    await user.click(screen.getByRole('radio', { name: 'Spam' }));
    expect(screen.getByRole('radio', { name: 'Spam' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    // And forward from Cancel comes back to the checked radio, the one stop the group has.
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Spam' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Game menu' })).not.toHaveFocus();
  });

  it('with nothing chosen the first radio is the one stop of the group', async () => {
    const { user } = renderUi(<ReportDialog {...rd()} />);
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(screen.getAllByRole('radio')[0]).toHaveFocus();
  });

  it('a click on the backdrop keeps focus in the dialog, and an outside element focused by script comes back', async () => {
    const { container, user } = renderUi(
      <>
        <button type="button">Game menu</button>
        <ReportDialog {...rd()} />
      </>,
    );
    const d = screen.getByRole('dialog');
    await user.click(container.querySelector('.cw-scrim') as HTMLElement);
    inside(d);
    await user.tab();
    inside(d);
    act(() => screen.getByRole('button', { name: 'Game menu' }).focus());
    inside(d);
  });
});

describe('the hold refetches once on release, and a new notice is announced', () => {
  it('a notice that arrived while held is shown after release', async () => {
    const w = await playerWorld();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { canShow: false })} />);
    await waitFor(() => expect(w.sent).toHaveLength(1));
    await w.warn();
    rerender(<NoticeQueue {...props(w, { canShow: true })} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
    expect(gets(w)).toBe(2);
  });

  it('asks once per release, not on every render, and not at all when it never was held', async () => {
    const w = await playerWorld();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { canShow: true })} />);
    await waitFor(() => expect(w.sent).toHaveLength(1));
    rerender(<NoticeQueue {...props(w, { canShow: true, appealUrl: '/a' })} />);
    await act(async () => undefined);
    expect(gets(w)).toBe(1);
    rerender(<NoticeQueue {...props(w, { canShow: false })} />);
    rerender(<NoticeQueue {...props(w, { canShow: true })} />);
    rerender(<NoticeQueue {...props(w, { canShow: true, appealUrl: '/b' })} />);
    await waitFor(() => expect(gets(w)).toBe(2));
    await act(async () => undefined);
    expect(gets(w)).toBe(2);
  });

  it('a failed refetch on release keeps what was already loaded', async () => {
    const w = await playerWorld();
    await w.warn();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { canShow: false })} />);
    await waitFor(() => expect(w.sent).toHaveLength(1));
    w.intercept.fn = () => ({ status: 500, body: { error: 'internal', message: 'x' } });
    rerender(<NoticeQueue {...props(w, { canShow: true })} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the position line is a polite live region', async () => {
    const w = await playerWorld();
    await w.warn();
    await w.sanction(ALICE, 'ban');
    renderUi(<NoticeQueue {...props(w)} />);
    const d = await dialog();
    expect(within(d).getByText('Notice 1 of 2')).toHaveAttribute('aria-live', 'polite');
  });

  it('the live region is there with one notice too, so a second arriving is announced', async () => {
    const w = await playerWorld();
    await w.warn();
    const { rerender } = renderUi(<NoticeQueue {...props(w, { refreshKey: 0 })} />);
    const d = await dialog();
    const region = d.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(region).not.toBeNull();
    expect(region).toBeEmptyDOMElement();
    await w.sanction(ALICE, 'ban');
    rerender(<NoticeQueue {...props(w, { refreshKey: 1 })} />);
    await waitFor(() => expect(region).toHaveTextContent('Notice 1 of 2'));
    expect(d.querySelector('[aria-live="polite"]')).toBe(region);
  });
});

describe('Close for now', () => {
  it('closes the dialog without acknowledging, and the notice is still pending on the server', async () => {
    const w = await playerWorld();
    await w.warn();
    w.intercept.fn = fail500;
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await user.click(await screen.findByRole('button', { name: 'Close for now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(w.pending()).toHaveLength(1);
    expect(posts(w)).toHaveLength(1);
  });

  it('closes the whole queue for now, not just the notice on screen', async () => {
    const w = await playerWorld();
    await w.warn();
    await w.sanction(ALICE, 'ban');
    w.intercept.fn = fail500;
    const { user } = renderUi(<NoticeQueue {...props(w)} />);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await user.click(await screen.findByRole('button', { name: 'Close for now' }));
    await act(async () => undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('comes back on the next refresh', async () => {
    const w = await playerWorld();
    await w.warn();
    w.intercept.fn = fail500;
    const { user, rerender } = renderUi(<NoticeQueue {...props(w, { refreshKey: 0 })} />);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await user.click(await screen.findByRole('button', { name: 'Close for now' }));
    w.intercept.fn = null;
    rerender(<NoticeQueue {...props(w, { refreshKey: 1 })} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('comes back after a hold cycle (canShow false then true)', async () => {
    const w = await playerWorld();
    await w.warn();
    w.intercept.fn = fail500;
    const { user, rerender } = renderUi(<NoticeQueue {...props(w, { canShow: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await user.click(await screen.findByRole('button', { name: 'Close for now' }));
    rerender(<NoticeQueue {...props(w, { canShow: false })} />);
    w.intercept.fn = null;
    rerender(<NoticeQueue {...props(w, { canShow: true })} />);
    expect(await dialog()).toHaveTextContent('You have a warning');
  });

  it('gives focus back to what had it, like any close', async () => {
    const w = await playerWorld();
    await w.warn();
    w.intercept.fn = fail500;
    const { user } = renderUi(
      <>
        <button type="button">Game menu</button>
        <NoticeQueue {...props(w)} />
      </>,
    );
    const menu = screen.getByRole('button', { name: 'Game menu' });
    menu.focus();
    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await user.click(await screen.findByRole('button', { name: 'Close for now' }));
    expect(menu).toHaveFocus();
  });

  it('is not shown before a failure', async () => {
    const w = await playerWorld();
    await w.warn();
    renderUi(<NoticeQueue {...props(w)} />);
    await dialog();
    expect(screen.queryByRole('button', { name: 'Close for now' })).toBeNull();
  });
});

describe('returnFocusTo and container', () => {
  it('focus goes to returnFocusTo() when what had it is gone', async () => {
    const w = await playerWorld();
    await w.warn();
    function Page({ showMenu }: { showMenu: boolean }) {
      return (
        <>
          {showMenu && <button type="button">Game menu</button>}
          <button type="button">Fallback</button>
          <NoticeQueue {...props(w, { returnFocusTo: () => screen.getByRole('button', { name: 'Fallback' }) })} />
        </>
      );
    }
    const { user, rerender } = renderUi(<Page showMenu />);
    screen.getByRole('button', { name: 'Game menu' }).focus();
    await dialog();
    rerender(<Page showMenu={false} />);
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Fallback' })).toHaveFocus();
  });

  it('is not used when the original element is still there', async () => {
    const w = await playerWorld();
    await w.warn();
    const fallback = vi.fn(() => null);
    const { user } = renderUi(
      <>
        <button type="button">Game menu</button>
        <NoticeQueue {...props(w, { returnFocusTo: fallback })} />
      </>,
    );
    const menu = screen.getByRole('button', { name: 'Game menu' });
    menu.focus();
    await dialog();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(menu).toHaveFocus();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a returnFocusTo that returns null or throws does not break closing', async () => {
    const w = await playerWorld();
    await w.warn();
    const a = renderUi(<NoticeQueue {...props(w, { returnFocusTo: () => null })} />);
    await dialog();
    await a.user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    a.unmount();
    await w.warn();
    const throws = () => {
      throw new Error('gone');
    };
    const b = renderUi(<NoticeQueue {...props(w, { returnFocusTo: throws })} />);
    await dialog();
    await b.user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('without returnFocusTo, focus falls to the page body when the original element is gone (documented)', async () => {
    const w = await playerWorld();
    await w.warn();
    function Page({ showMenu }: { showMenu: boolean }) {
      return (
        <>
          {showMenu && <button type="button">Game menu</button>}
          <NoticeQueue {...props(w)} />
        </>
      );
    }
    const { user, rerender } = renderUi(<Page showMenu />);
    screen.getByRole('button', { name: 'Game menu' }).focus();
    await dialog();
    rerender(<Page showMenu={false} />);
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body).toHaveFocus();
  });

  it('container: the dialog is drawn inside the given element, not where the component is', async () => {
    const w = await playerWorld();
    await w.warn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { container, user } = renderUi(<NoticeQueue {...props(w, { container: host })} />);
    const d = await dialog();
    expect(host).toContainElement(d);
    expect(container).not.toContainElement(d);
    expect(host.querySelector('.cw-player')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(host.querySelector('.cw-player')).toBeNull();
    host.remove();
  });

  it('container: ReportDialog too, and its focus rules still hold', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onClose = vi.fn();
    const { container, user } = renderUi(
      <ReportDialog {...FIXED} reporting={SIX_REASONS} container={host} onClose={onClose} onSubmit={() => Promise.resolve<ReportResult>({ ok: true, reportId: 'r', remaining: 1 })} />,
    );
    const d = screen.getByRole('dialog');
    expect(host).toContainElement(d);
    expect(container).not.toContainElement(d);
    expect(screen.getByRole('heading', { name: 'Report a player' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    host.remove();
  });
});

describe('ReportDialog: small fixes', () => {
  const ok = () => Promise.resolve<ReportResult>({ ok: true, reportId: 'r', remaining: 9 });
  const rd = (more: Partial<ReportDialogProps> = {}): ReportDialogProps => ({ onSubmit: ok, onClose: () => undefined, ...FIXED, reporting: SIX_REASONS, ...more });
  const pick = (user: ReturnType<typeof renderUi>['user'], name: string) => user.click(screen.getByRole('radio', { name }));

  it('Cancel does nothing while a report is on its way, and says it is busy', async () => {
    const onClose = vi.fn();
    let release: (r: ReportResult) => void = () => undefined;
    const { user } = renderUi(<ReportDialog {...rd({ onClose, onSubmit: () => new Promise<ReportResult>((resolve) => (release = resolve)) })} />);
    await pick(user, 'Spam');
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveAttribute('aria-disabled', 'true');
    await user.click(cancel);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => release({ ok: true, reportId: 'r', remaining: 9 }));
    await findStatus();
  });

  it('Cancel works again after a failed send', async () => {
    const onClose = vi.fn();
    const { user } = renderUi(<ReportDialog {...rd({ onClose, onSubmit: () => Promise.reject(new TypeError('x')) })} />);
    await pick(user, 'Spam');
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    await screen.findByRole('alert');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).not.toHaveAttribute('aria-disabled');
    await user.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'ok'],
    ['a number', 5],
    ['an array', []],
  ])('an onSubmit that resolves %s shows the generic error, never a crash or a thanks', async (_name, value) => {
    const { user } = renderUi(<ReportDialog {...rd({ onSubmit: () => Promise.resolve(value as unknown as ReportResult) })} />);
    await pick(user, 'Spam');
    await user.click(screen.getByRole('button', { name: 'Send report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not take that report.');
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
