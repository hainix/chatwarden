import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubContext } from '../src/context.js';
import type { HubContextValue } from '../src/context.js';
import { createT, en } from '../src/i18n.js';
import { TOAST_ERROR_MS, TOAST_HELD_MAX, TOAST_MAX, TOAST_MS, ToastProvider, UNDO_MS, useToasts } from '../src/toasts.js';
import type { Toasts } from '../src/toasts.js';

// The toast plumbing on its own: plain news, an action button, and the held action with Undo that decisions will use.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const context = { t: createT(en, 'en'), shortcuts: true } as unknown as HubContextValue;

function mount() {
  const ref: { api: Toasts | null } = { api: null };
  function Grab() {
    ref.api = useToasts();
    return null;
  }
  const view = render(
    <HubContext.Provider value={context}>
      <ToastProvider>
        <Grab />
      </ToastProvider>
    </HubContext.Provider>,
  );
  return { ...view, api: (): Toasts => ref.api as Toasts };
}
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('plain toasts', () => {
  it('shows its text in a labelled region as a status, and goes after 4 seconds', async () => {
    const { api } = mount();
    expect(TOAST_MS).toBe(4_000);
    act(() => void api().push({ text: 'You took the case.' }));
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region).toHaveTextContent('You took the case.');
    expect(screen.getByRole('status')).toHaveTextContent('You took the case.');
    await tick(3_900);
    expect(screen.getByText('You took the case.')).toBeInTheDocument();
    await tick(200);
    expect(screen.queryByText('You took the case.')).not.toBeInTheDocument();
  });

  it('an error is an alert and stays 7 seconds', async () => {
    const { api } = mount();
    expect(TOAST_ERROR_MS).toBe(7_000);
    act(() => void api().push({ text: 'Could not do that.', tone: 'bad' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not do that.');
    await tick(6_900);
    expect(screen.getByText('Could not do that.')).toBeInTheDocument();
    await tick(200);
    expect(screen.queryByText('Could not do that.')).not.toBeInTheDocument();
  });

  it('can be dismissed with its own button', async () => {
    const { api } = mount();
    act(() => void api().push({ text: 'Hello.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Hello.')).not.toBeInTheDocument();
  });

  it('dismiss(id) removes one toast and leaves the others', async () => {
    const { api } = mount();
    let first = 0;
    act(() => {
      first = api().push({ text: 'One' });
      api().push({ text: 'Two' });
    });
    act(() => api().dismiss(first));
    expect(screen.queryByText('One')).not.toBeInTheDocument();
    expect(screen.getByText('Two')).toBeInTheDocument();
  });

  it('keeps at most three on screen, dropping the oldest', async () => {
    const { api } = mount();
    expect(TOAST_MAX).toBe(3);
    act(() => {
      for (const text of ['A', 'B', 'C', 'D']) api().push({ text });
    });
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    for (const text of ['B', 'C', 'D']) expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('a toast with an action shows its button for 5 seconds, runs it once and closes', async () => {
    const { api } = mount();
    const run = vi.fn();
    act(() => void api().push({ text: 'Released.', action: { label: 'Undo', run } }));
    await tick(4_900);
    expect(screen.getByText('Released.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.queryByRole('button', { name: 'Undo' }) ?? document.body);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Released.')).not.toBeInTheDocument();
  });

  it('pauses while the pointer or focus is on it, and goes when it leaves, for the time that was left', async () => {
    const { api } = mount();
    act(() => void api().push({ text: 'Hover me.' }));
    const toast = screen.getByText('Hover me.').closest('.cw-toast') as HTMLElement;
    await tick(3_000);
    fireEvent.pointerEnter(toast);
    await tick(60_000);
    expect(screen.getByText('Hover me.')).toBeInTheDocument();
    fireEvent.pointerLeave(toast);
    await tick(900);
    expect(screen.getByText('Hover me.')).toBeInTheDocument();
    await tick(200);
    expect(screen.queryByText('Hover me.')).not.toBeInTheDocument();
  });

  it('throws outside the hub, so a missing provider is not silent', () => {
    function Lonely() {
      useToasts();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Lonely />)).toThrow(/inside <Hub>/);
    spy.mockRestore();
  });
});

describe('a held action with Undo', () => {
  it('shows an Undo button and a progress bar that runs for the 5 second window, and runs the action once when it ends', async () => {
    const { api } = mount();
    expect(UNDO_MS).toBe(5_000);
    const run = vi.fn();
    act(() => void api().hold({ text: 'Chat restricted for Alpha. Sending in 5 seconds.', run }));
    const toast = screen.getByText(/Sending in 5 seconds/).closest('.cw-toast') as HTMLElement;
    expect(toast).toHaveAttribute('data-held', 'true');
    expect(toast.querySelector('.cw-toast-bar')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    await tick(4_900);
    expect(run).not.toHaveBeenCalled();
    await tick(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Sending in 5 seconds/)).not.toBeInTheDocument();
    await tick(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('Undo cancels the action, says so through onUndo, and the action never runs', async () => {
    const { api } = mount();
    const run = vi.fn();
    const onUndo = vi.fn();
    act(() => void api().hold({ text: 'Held.', run, onUndo }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Held.')).not.toBeInTheDocument();
    await tick(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('commit() runs it at once, once; undo() after that does nothing', async () => {
    const { api } = mount();
    const run = vi.fn();
    const onUndo = vi.fn();
    let hold!: ReturnType<Toasts['hold']>;
    act(() => {
      hold = api().hold({ text: 'Held.', run, onUndo });
    });
    await act(async () => {
      hold.commit();
      hold.commit();
    });
    expect(run).toHaveBeenCalledTimes(1);
    act(() => hold.undo());
    expect(onUndo).not.toHaveBeenCalled();
    await tick(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('undo() through the handle works like the button, and a second undo does nothing', async () => {
    const { api } = mount();
    const run = vi.fn();
    const onUndo = vi.fn();
    let hold!: ReturnType<Toasts['hold']>;
    act(() => {
      hold = api().hold({ text: 'Held.', run, onUndo });
    });
    act(() => {
      hold.undo();
      hold.undo();
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    await tick(10_000);
    expect(run).not.toHaveBeenCalled();
    act(() => hold.commit());
    expect(run).not.toHaveBeenCalled();
  });

  it('is sent at once when the hub is closing: the component going away, and pagehide', async () => {
    const first = mount();
    const run1 = vi.fn();
    act(() => void first.api().hold({ text: 'Held one.', run: run1 }));
    first.unmount();
    await tick(0);
    expect(run1).toHaveBeenCalledTimes(1);

    const second = mount();
    const run2 = vi.fn();
    act(() => void second.api().hold({ text: 'Held two.', run: run2 }));
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(run2).toHaveBeenCalledTimes(1);
    second.unmount();
    await tick(10_000);
    expect(run2).toHaveBeenCalledTimes(1);
  });

  const setVisibility = (state: 'hidden' | 'visible'): void => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('is sent at once when the tab is hidden (a phone switching apps), and only once', async () => {
    const view = mount();
    const run = vi.fn();
    act(() => void view.api().hold({ text: 'Held.', run }));
    await act(async () => setVisibility('hidden'));
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility('hidden'));
    await act(async () => void window.dispatchEvent(new Event('pagehide')));
    view.unmount();
    await tick(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    setVisibility('visible');
  });

  it('a tab becoming visible again sends nothing and a hidden tab does not touch an undone action', async () => {
    const view = mount();
    const kept = vi.fn();
    const undone = vi.fn();
    act(() => void view.api().hold({ text: 'Kept.', run: kept }));
    act(() => void view.api().hold({ text: 'Undone.', run: undone }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await act(async () => setVisibility('visible'));
    expect(kept).not.toHaveBeenCalled();
    await act(async () => setVisibility('hidden'));
    expect(kept).toHaveBeenCalledTimes(1);
    expect(undone).not.toHaveBeenCalled();
    setVisibility('visible');
  });

  it('an action held when the hub unmounts is sent once, and a tab hidden afterwards does not send it again', async () => {
    const view = mount();
    const run = vi.fn();
    act(() => void view.api().hold({ text: 'Held.', run }));
    view.unmount();
    await tick(0);
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility('hidden'));
    window.dispatchEvent(new Event('pagehide'));
    await tick(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    setVisibility('visible');
  });

  it('an undone action is not sent when the hub closes', async () => {
    const view = mount();
    const run = vi.fn();
    act(() => void view.api().hold({ text: 'Held.', run }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    view.unmount();
    window.dispatchEvent(new Event('pagehide'));
    await tick(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('two held actions run on their own clocks and undo on their own', async () => {
    const { api } = mount();
    const a = vi.fn();
    const b = vi.fn();
    act(() => void api().hold({ text: 'Held A.', run: a }));
    await tick(2_000);
    act(() => void api().hold({ text: 'Held B.', run: b }));
    await tick(3_100);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    await tick(2_000);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('an action pushed off the screen by newer held toasts is still sent, not lost; news toasts do not push it off', async () => {
    const { api } = mount();
    const run = vi.fn();
    act(() => void api().hold({ text: 'Held.', run }));
    act(() => {
      for (const text of ['A', 'B', 'C', 'D']) api().push({ text, action: { label: 'Open', run: () => undefined } });
    });
    await tick(0);
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByText('Held.')).toBeInTheDocument();
    // Past the held cap the oldest hold is sent early, not lost.
    act(() => {
      for (let i = 0; i < TOAST_HELD_MAX; i += 1) api().hold({ text: `More ${i}`, run: () => undefined });
    });
    await tick(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a failing action does not crash the hub or run twice', async () => {
    const { api } = mount();
    const run = vi.fn(() => Promise.reject(new Error('boom')));
    act(() => void api().hold({ text: 'Held.', run }));
    await tick(5_100);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('takes its own Undo label', async () => {
    const { api } = mount();
    act(() => void api().hold({ text: 'Held.', run: () => undefined, undoLabel: 'Take back' }));
    expect(screen.getByRole('button', { name: 'Take back' })).toBeInTheDocument();
  });
});

describe('several held decisions', () => {
  it('shows the newest held toast in full with Undo, and one line for the earlier ones', async () => {
    const { api } = mount();
    act(() => {
      for (const text of ['Dismissing A.', 'Dismissing B.', 'Dismissing C.']) api().hold({ text, run: () => undefined });
    });
    expect(screen.getByText('Dismissing C.')).toBeInTheDocument();
    expect(screen.queryByText('Dismissing A.')).not.toBeInTheDocument();
    expect(screen.queryByText('Dismissing B.')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
    expect(document.querySelector('.cw-toast-waiting')).toHaveTextContent('2 earlier decisions waiting.');
  });

  it('says "1 earlier decision waiting." for one, and nothing at all for a single held decision', async () => {
    const { api } = mount();
    act(() => void api().hold({ text: 'Dismissing A.', run: () => undefined }));
    expect(screen.queryByText(/earlier decision/)).not.toBeInTheDocument();
    act(() => void api().hold({ text: 'Dismissing B.', run: () => undefined }));
    expect(document.querySelector('.cw-toast-waiting')).toHaveTextContent('1 earlier decision waiting.');
  });

  it('their timers keep running: the earlier decisions are sent on time though they are not drawn', async () => {
    const { api } = mount();
    const first = vi.fn();
    const second = vi.fn();
    act(() => void api().hold({ text: 'Dismissing A.', run: first }));
    await tick(1_000);
    act(() => void api().hold({ text: 'Dismissing B.', run: second }));
    await tick(UNDO_MS - 1_000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(screen.queryByText(/earlier decision/)).not.toBeInTheDocument();
    expect(screen.getByText('Dismissing B.')).toBeInTheDocument();
  });

  it('Undo on the newest brings the next one back into view, and the count follows', async () => {
    const { api } = mount();
    act(() => {
      for (const text of ['Dismissing A.', 'Dismissing B.', 'Dismissing C.']) api().hold({ text, run: () => undefined });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('Dismissing B.')).toBeInTheDocument();
    expect(document.querySelector('.cw-toast-waiting')).toHaveTextContent('1 earlier decision waiting.');
  });

  it('news toasts show beside the held one, whatever order they came', async () => {
    const { api } = mount();
    act(() => {
      api().hold({ text: 'Dismissing A.', run: () => undefined });
      api().push({ text: 'You took the case.' });
      api().hold({ text: 'Dismissing B.', run: () => undefined });
    });
    expect(screen.getByText('You took the case.')).toBeInTheDocument();
    expect(screen.getByText('Dismissing B.')).toBeInTheDocument();
    expect(document.querySelector('.cw-toast-waiting')).toHaveTextContent('1 earlier decision waiting.');
  });
});

describe('what a screen reader hears while decisions stack (M3)', () => {
  const live = (): HTMLElement => document.querySelector('[data-cw-waiting-live]') as HTMLElement;
  const line = (): HTMLElement | null => document.querySelector('.cw-toast-waiting');
  const hold = (api: () => Toasts, text: string, run: () => void = () => undefined) => act(() => void api().hold({ text, run }));

  it('one live region is always there, empty until a decision is waiting behind the newest', async () => {
    const { api } = mount();
    expect(live()).toBeInTheDocument();
    expect(live()).toHaveAttribute('aria-live', 'polite');
    expect(live()).toHaveTextContent('');
    hold(api, 'Dismissing A.');
    expect(live()).toHaveTextContent('');
    hold(api, 'Dismissing B.');
    expect(live()).toHaveTextContent('1 earlier decision waiting.');
  });

  it('announces when the count rises, and says nothing when it falls as timers end', async () => {
    const { api } = mount();
    hold(api, 'Dismissing A.');
    await tick(1_000);
    hold(api, 'Dismissing B.');
    await tick(1_000);
    hold(api, 'Dismissing C.');
    expect(live()).toHaveTextContent('2 earlier decisions waiting.');
    // A's timer ends (5 s after it was held): the count falls to 1, the region is not rewritten.
    await tick(UNDO_MS - 2_000 + 100);
    expect(line()).toHaveTextContent('1 earlier decision waiting.');
    expect(live()).toHaveTextContent('2 earlier decisions waiting.');
  });

  it('the visible line is hidden from assistive technology (the live region says it once)', async () => {
    const { api } = mount();
    hold(api, 'Dismissing A.');
    hold(api, 'Dismissing B.');
    expect(line()).toHaveAttribute('aria-hidden', 'true');
    expect(line()).not.toHaveAttribute('role');
  });

  it('a new rise after a fall is announced again, and the region empties when nothing waits', async () => {
    const { api } = mount();
    hold(api, 'Dismissing A.');
    hold(api, 'Dismissing B.');
    expect(live()).toHaveTextContent('1 earlier decision waiting.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(live()).toHaveTextContent('');
    hold(api, 'Dismissing C.');
    expect(live()).toHaveTextContent('1 earlier decision waiting.');
  });

  it('the Undo button on a held decision names its key (U) when shortcuts are on', async () => {
    const { api } = mount();
    hold(api, 'Dismissing A.');
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveAttribute('aria-keyshortcuts', 'u');
  });

  it('control: an Undo that is not a held decision names no key', async () => {
    const { api } = mount();
    act(() => void api().push({ text: 'Released.', action: { label: 'Take back', run: () => undefined } }));
    expect(screen.getByRole('button', { name: 'Take back' })).not.toHaveAttribute('aria-keyshortcuts');
  });
});

describe('shortcuts off', () => {
  it('Undo names no key when the adopter turned the shortcuts off', async () => {
    const off = { t: createT(en, 'en'), shortcuts: false } as unknown as HubContextValue;
    const ref: { api: Toasts | null } = { api: null };
    function Grab() {
      ref.api = useToasts();
      return null;
    }
    render(
      <HubContext.Provider value={off}>
        <ToastProvider>
          <Grab />
        </ToastProvider>
      </HubContext.Provider>,
    );
    act(() => void ref.api!.hold({ text: 'Dismissing A.', run: () => undefined }));
    expect(screen.getByRole('button', { name: 'Undo' })).not.toHaveAttribute('aria-keyshortcuts');
  });
});

