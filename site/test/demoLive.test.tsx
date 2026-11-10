// N1 from the Task 2 re-review: two announcements in one tick must keep distinct keys, and Reset must clear the live region.
// N2: after an automatic pane switch the focused heading is brought into view.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Demo from '../src/demo/Demo';
import { KitEngine } from '../src/demo/kitEngine';

function stubMatchMedia(stacked: boolean, reduced = false) {
  window.matchMedia = ((q: string) => ({
    matches: /reduced-motion/.test(q) ? reduced : /max-width/.test(q) ? stacked : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

async function setup(opts: { stacked?: boolean; reduced?: boolean } = {}) {
  stubMatchMedia(opts.stacked ?? true, opts.reduced ?? false);
  const user = userEvent.setup();
  render(<Demo engine={new KitEngine()} scripted={false} />);
  await screen.findByText("uninstall the game, you're hopeless");
  return { user };
}

const live = () => screen.getByTestId('demo-live');
const lines = () => [...live().querySelectorAll('p')].map((p) => p.textContent ?? '');
/** Reports Bo's rude line with the keyboard only; on a phone the tour then moves to the moderator pane and moves focus. */
async function reportByKeyboard(user: ReturnType<typeof userEvent.setup>) {
  screen.getByRole('button', { name: /report bo's line: uninstall/i }).focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('dialog');
  await user.keyboard(' ');
  screen.getByRole('button', { name: /send report/i }).focus();
  await user.keyboard('{Enter}');
}
const tourNext = () => within(screen.getByRole('region', { name: /guided tour/i })).getByRole('button', { name: /^next$/i });

beforeEach(() => stubMatchMedia(true));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('live region announcements (stacked layout)', () => {
  it('keeps both announcements of one tick, each once, with no duplicate-key warning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { user } = await setup();
    await user.click(tourNext()); // step 2
    await user.click(tourNext()); // step 3: "Tour step 3" and "Showing the moderator view" in the same tick
    await waitFor(() => expect(lines().some((l) => /moderator view/i.test(l))).toBe(true));
    const got = lines();
    expect(got.filter((l) => /^Tour step 3 of 4/.test(l))).toHaveLength(1);
    expect(got.filter((l) => /moderator view/i.test(l))).toHaveLength(1);
    expect(new Set(got).size).toBe(got.length);
    const keyWarnings = err.mock.calls.filter((c) => /same key|unique "key"/i.test(String(c[0]) + String(c[1] ?? '')));
    expect(keyWarnings).toEqual([]);
  });

  it('keeps the last announcements distinct through a whole tour', async () => {
    const { user } = await setup();
    for (let i = 0; i < 4; i++) await user.click(tourNext());
    const got = lines();
    expect(got.length).toBeLessThanOrEqual(4);
    expect(new Set(got).size).toBe(got.length);
    expect(got.some((l) => /tour done/i.test(l))).toBe(true);
  });

  it('Reset clears every stale line and leaves only the reset message', async () => {
    const { user } = await setup();
    for (let i = 0; i < 3; i++) await user.click(tourNext());
    expect(lines().length).toBeGreaterThan(1);
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await waitFor(() => expect(lines()).toEqual(['Demo reset. The lobby is back to the start.']));
  });

  it('announcing again after a Reset still starts clean (a second full tour is as tidy as the first)', async () => {
    const { user } = await setup();
    for (let i = 0; i < 3; i++) await user.click(tourNext());
    await user.click(screen.getByRole('button', { name: /reset demo/i }));
    await waitFor(() => expect(lines()).toHaveLength(1));
    for (let i = 0; i < 3; i++) await user.click(tourNext());
    const got = lines();
    expect(new Set(got).size).toBe(got.length);
    expect(got.filter((l) => /^Tour step 3 of 4/.test(l))).toHaveLength(1);
  });
});

describe('after an automatic pane switch the focused heading is brought into view', () => {
  function spyScroll() {
    const calls: Array<{ el: Element; arg: ScrollIntoViewOptions | undefined }> = [];
    Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
      calls.push({ el: this, arg: typeof arg === 'object' ? arg : undefined });
    };
    return calls;
  }

  it('scrolls the new pane heading into view with block "nearest"', async () => {
    const calls = spyScroll();
    const { user } = await setup();
    await reportByKeyboard(user);
    await waitFor(() => expect(document.activeElement?.id).toBe('pane-mod-title'));
    const last = calls[calls.length - 1];
    expect(last?.el.id).toBe('pane-mod-title');
    expect(last?.arg?.block).toBe('nearest');
    expect(last?.arg?.behavior).toBe('instant');
  });

  it('jumps instantly (a smooth scroll is cut short by the pane swap), which is also what reduced motion wants', async () => {
    const calls = spyScroll();
    const { user } = await setup({ reduced: true });
    await reportByKeyboard(user);
    await waitFor(() => expect(document.activeElement?.id).toBe('pane-mod-title'));
    expect(calls[calls.length - 1]?.arg?.behavior).toBe('instant');
  });

  it('brings it into view once more after the pane swap has settled, if focus is still there', async () => {
    const calls = spyScroll();
    const { user } = await setup();
    await reportByKeyboard(user);
    await waitFor(() => expect(document.activeElement?.id).toBe('pane-mod-title'));
    const first = calls.length;
    await waitFor(() => expect(calls.length).toBeGreaterThan(first), { timeout: 3000 });
    expect(calls[calls.length - 1]?.el.id).toBe('pane-mod-title');
  });

  it('does not pull the page back if focus has moved on by then', async () => {
    const calls = spyScroll();
    const { user } = await setup();
    await reportByKeyboard(user);
    await waitFor(() => expect(document.activeElement?.id).toBe('pane-mod-title'));
    const first = calls.length;
    (screen.getByRole('button', { name: /my record/i }) as HTMLElement).focus();
    await new Promise((r) => setTimeout(r, 900));
    expect(calls.length).toBe(first);
  });

  describe('the settle re-scroll never fights the user', () => {
    async function switched() {
      const calls = spyScroll();
      const { user } = await setup();
      await reportByKeyboard(user);
      await waitFor(() => expect(document.activeElement?.id).toBe('pane-mod-title'));
      return { calls, count: calls.length };
    }
    const idle = () => new Promise((r) => setTimeout(r, 900));

    it('a wheel event before the timer cancels it', async () => {
      const { calls, count } = await switched();
      fireEvent.wheel(window, { deltaY: 400 });
      await idle();
      expect(calls.length).toBe(count);
    });
    it.each([
      ['touchstart', (): Event => new Event('touchstart', { bubbles: true })],
      ['pointerdown', (): Event => new Event('pointerdown', { bubbles: true })],
    ])('a %s before the timer cancels it', async (_name, make) => {
      const { calls, count } = await switched();
      window.dispatchEvent(make());
      await idle();
      expect(calls.length).toBe(count);
    });
    it.each(['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' ', 'Home', 'End'])('the scroll key %j before the timer cancels it', async (key) => {
      const { calls, count } = await switched();
      fireEvent.keyDown(window, { key });
      await idle();
      expect(calls.length).toBe(count);
    });
    it('a key that does not scroll (a letter) does not cancel it', async () => {
      const { calls, count } = await switched();
      fireEvent.keyDown(window, { key: 'x' });
      await waitFor(() => expect(calls.length).toBeGreaterThan(count), { timeout: 3000 });
    });
    it('without any input the settle still happens (control)', async () => {
      const { calls, count } = await switched();
      await waitFor(() => expect(calls.length).toBeGreaterThan(count), { timeout: 3000 });
    });
    it('removes its listeners once it has fired, and on unmount', async () => {
      const add = vi.spyOn(window, 'addEventListener');
      const remove = vi.spyOn(window, 'removeEventListener');
      const { calls, count } = await switched();
      const added = add.mock.calls.filter((c) => ['wheel', 'touchstart', 'pointerdown'].includes(String(c[0]))).length;
      expect(added).toBeGreaterThanOrEqual(3);
      await waitFor(() => expect(calls.length).toBeGreaterThan(count), { timeout: 3000 });
      const removed = remove.mock.calls.filter((c) => ['wheel', 'touchstart', 'pointerdown'].includes(String(c[0]))).length;
      expect(removed).toBeGreaterThanOrEqual(3);
    });
    it('unmounting before the timer stops it', async () => {
      const calls = spyScroll();
      const { user } = await setup();
      await reportByKeyboard(user);
      await waitFor(() => expect(document.activeElement?.id).toBe('pane-mod-title'));
      const count = calls.length;
      cleanup();
      await idle();
      expect(calls.length).toBe(count);
    });
  });

  it('focuses without letting the browser jump first (preventScroll)', async () => {
    spyScroll();
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const { user } = await setup();
    await reportByKeyboard(user);
    await waitFor(() => expect(document.activeElement?.id).toBe('pane-mod-title'));
    const onHeading = focusSpy.mock.calls.filter((_c, i) => focusSpy.mock.contexts[i] === document.getElementById('pane-mod-title'));
    expect(onHeading.length).toBeGreaterThan(0);
    expect(onHeading[0]?.[0]).toEqual({ preventScroll: true });
  });

  it('does not scroll when focus was left on a still-visible control (the tour Next button)', async () => {
    const calls = spyScroll();
    const { user } = await setup();
    await user.click(tourNext());
    await user.click(tourNext());
    expect(calls).toEqual([]);
  });

  it('does not scroll on a wide screen, where there is no pane switch', async () => {
    const calls = spyScroll();
    const { user } = await setup({ stacked: false });
    await reportByKeyboard(user);
    expect(calls).toEqual([]);
  });
});
