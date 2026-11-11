// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createT, en } from '../../src/i18n.js';
import { TOAST_ERROR_MS, TOAST_MAX, TOAST_MS, UNDO_MS, createToastStore } from '../../src/headless/toasts.js';
import { fakePage, manualTimers, settle } from './kit.js';

function make() {
  const timers = manualTimers();
  const page = fakePage();
  const store = createToastStore({ words: () => createT(en, 'en'), timers, page });
  return { timers, page, store };
}
type Store = ReturnType<typeof make>['store'];
const texts = (s: Store): string[] => s.getSnapshot().map((t) => t.text);
const act = { label: 'x', run: () => undefined };

describe('toast store: plain toasts', () => {
  it('shows a toast for 4 seconds, an error for 7, and one with an action for 5', async () => {
    const { timers, store } = make();
    store.push({ text: 'plain' });
    store.push({ text: 'bad', tone: 'bad' });
    store.push({ text: 'act', action: act });
    expect([TOAST_MS, TOAST_ERROR_MS, UNDO_MS]).toEqual([4000, 7000, 5000]);
    await timers.advance(3_999);
    expect(texts(store)).toEqual(['plain', 'bad', 'act']);
    await timers.advance(1);
    expect(texts(store)).toEqual(['bad', 'act']);
    await timers.advance(1_000);
    expect(texts(store)).toEqual(['bad']);
    await timers.advance(2_000);
    expect(texts(store)).toEqual([]);
    expect(timers.count()).toBe(0);
  });

  it('an explicit ms wins', async () => {
    const { timers, store } = make();
    store.push({ text: 'brief', ms: 100 });
    await timers.advance(99);
    expect(texts(store)).toEqual(['brief']);
    await timers.advance(1);
    expect(texts(store)).toEqual([]);
  });

  it('keeps at most 3; the oldest toast without an action goes first, and an Undo is pushed off only when all have one', () => {
    const { store } = make();
    store.push({ text: 'undo-1', action: act });
    for (const t of ['A', 'B', 'C']) store.push({ text: t });
    expect(TOAST_MAX).toBe(3);
    expect(texts(store)).toEqual(['undo-1', 'B', 'C']);
    const all = make();
    for (const t of ['u1', 'u2', 'u3', 'u4']) all.store.push({ text: t, action: act });
    expect(texts(all.store)).toEqual(['u2', 'u3', 'u4']);
  });

  it('ids are distinct, and dismiss removes one toast (and its timer) and ignores an unknown id', () => {
    const { timers, store } = make();
    const a = store.push({ text: 'a' });
    const b = store.push({ text: 'b' });
    expect(a).not.toBe(b);
    store.dismiss(a);
    store.dismiss(999);
    expect(texts(store)).toEqual(['b']);
    expect(timers.count()).toBe(1);
  });
});

describe('toast store: pause and resume keep what is left', () => {
  it('pausing stops the clock, resuming starts it with the rest', async () => {
    const { timers, store } = make();
    const id = store.push({ text: 'x' });
    await timers.advance(3_000);
    store.pause(id);
    await timers.advance(60_000);
    expect(texts(store)).toEqual(['x']);
    store.resume(id);
    await timers.advance(999);
    expect(texts(store)).toEqual(['x']);
    await timers.advance(1);
    expect(texts(store)).toEqual([]);
  });

  it('pause and resume twice in a row are the same as once; for an unknown id nothing happens', async () => {
    const { timers, store } = make();
    const id = store.push({ text: 'x' });
    store.resume(id);
    await timers.advance(1_000);
    store.pause(id);
    store.pause(id);
    store.resume(id);
    store.resume(id);
    store.pause(404);
    store.resume(404);
    await timers.advance(2_999);
    expect(texts(store)).toEqual(['x']);
    await timers.advance(1);
    expect(texts(store)).toEqual([]);
  });
});

describe('toast store: a held action', () => {
  it('runs once when the window ends, at 5 seconds and not before', async () => {
    const { timers, store } = make();
    const run = vi.fn();
    store.hold({ text: 'Held.', run });
    await timers.advance(UNDO_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await timers.advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(texts(store)).toEqual([]);
  });

  it('Undo cancels it, calls onUndo once, and a later undo, commit and the timer do nothing', async () => {
    const { timers, store } = make();
    const run = vi.fn();
    const onUndo = vi.fn();
    const h = store.hold({ text: 'Held.', run, onUndo });
    await timers.advance(4_900);
    h.undo();
    h.undo();
    h.commit();
    await timers.advance(10_000);
    expect(run).not.toHaveBeenCalled();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(texts(store)).toEqual([]);
  });

  it('commit runs it now, once, and a later undo is too late', async () => {
    const { timers, store } = make();
    const run = vi.fn();
    const onUndo = vi.fn();
    const h = store.hold({ text: 'Held.', run, onUndo });
    h.commit();
    h.commit();
    h.undo();
    await settle();
    await timers.advance(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('is sent once whichever of the timer, a pagehide, a hidden tab and dispose comes first (and the rest are no-ops)', async () => {
    for (const first of ['timer', 'pagehide', 'hidden', 'dispose'] as const) {
      const { timers, page, store } = make();
      const run = vi.fn();
      store.hold({ text: 'Held.', run });
      if (first === 'timer') await timers.advance(UNDO_MS);
      if (first === 'pagehide') page.close();
      if (first === 'hidden') page.hide();
      if (first === 'dispose') store.dispose();
      await settle();
      expect(run, first).toHaveBeenCalledTimes(1);
      page.close();
      page.hide();
      store.dispose();
      await timers.advance(UNDO_MS * 2);
      await settle();
      expect(run, `${first} then the rest`).toHaveBeenCalledTimes(1);
    }
  });

  it('a tab that is shown again sends nothing', async () => {
    const { timers, page, store } = make();
    const run = vi.fn();
    store.hold({ text: 'Held.', run });
    page.show();
    await timers.advance(UNDO_MS - 1);
    expect(run).not.toHaveBeenCalled();
  });

  it('sends every held action on pagehide, each once, and leaves no page listener behind', async () => {
    const { page, store } = make();
    const a = vi.fn();
    const b = vi.fn();
    store.hold({ text: 'A', run: a });
    store.hold({ text: 'B', run: b });
    expect(page.listeners()).toBeGreaterThan(0);
    page.close();
    await settle();
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    expect(page.listeners()).toBe(0);
  });

  it('listens to the page only while something is held', async () => {
    const { timers, page, store } = make();
    expect(page.listeners()).toBe(0);
    store.push({ text: 'plain' });
    expect(page.listeners()).toBe(0);
    const h = store.hold({ text: 'A', run: () => undefined });
    expect(page.listeners()).toBeGreaterThan(0);
    h.undo();
    expect(page.listeners()).toBe(0);
    store.hold({ text: 'B', run: () => undefined });
    await timers.advance(UNDO_MS);
    expect(page.listeners()).toBe(0);
  });

  it('a toast pushed out by the cap still runs its held action (it was never undone)', async () => {
    const { store } = make();
    const run = vi.fn();
    // Every toast has an action, so the oldest goes: the held one is first.
    store.hold({ text: 'Held.', run });
    for (const t of ['a', 'b', 'c']) store.push({ text: t, action: act });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(texts(store)).toEqual(['a', 'b', 'c']);
  });

  it('a held action that throws or rejects is swallowed', async () => {
    const { timers, store } = make();
    store.hold({ text: 'boom', run: () => Promise.reject(new Error('no')) });
    store.hold({
      text: 'bang',
      run: () => {
        throw new Error('no');
      },
    });
    await timers.advance(UNDO_MS);
    expect(texts(store)).toEqual([]);
  });

  it('the Undo label is the catalog word, or the one given', () => {
    const { store } = make();
    store.hold({ text: 'A', run: () => undefined });
    store.hold({ text: 'B', run: () => undefined, undoLabel: 'Take back' });
    expect(store.getSnapshot().map((t) => t.action?.label)).toEqual(['Undo', 'Take back']);
    expect(store.getSnapshot().every((t) => t.held)).toBe(true);
  });

  it('a pause holds the 5 second window still too, and a dismissal sends at once', async () => {
    const { timers, store } = make();
    const run = vi.fn();
    store.hold({ text: 'Held.', run });
    const id = store.getSnapshot()[0]?.id as number;
    await timers.advance(2_000);
    store.pause(id);
    await timers.advance(60_000);
    expect(run).not.toHaveBeenCalled();
    store.dismiss(id);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('toast store: snapshots and dispose', () => {
  it('the snapshot is the same array until a toast comes or goes, and a listener is told each time', () => {
    const { store } = make();
    const listener = vi.fn();
    store.subscribe(listener);
    const empty = store.getSnapshot();
    expect(store.getSnapshot()).toBe(empty);
    const id = store.push({ text: 'a' });
    const one = store.getSnapshot();
    expect(one).not.toBe(empty);
    expect(store.getSnapshot()).toBe(one);
    store.pause(id);
    store.resume(id);
    store.dismiss(404);
    expect(store.getSnapshot()).toBe(one);
    store.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('dispose stops every timer, runs what is held once, empties the list, and is safe twice', async () => {
    const { timers, page, store } = make();
    const run = vi.fn();
    store.push({ text: 'plain' });
    store.hold({ text: 'Held.', run });
    store.dispose();
    store.dispose();
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(timers.count()).toBe(0);
    expect(page.listeners()).toBe(0);
    expect(store.getSnapshot()).toEqual([]);
  });

  it('after dispose a push shows nothing and a hold is sent at once', async () => {
    const { timers, store } = make();
    store.dispose();
    store.push({ text: 'late' });
    const run = vi.fn();
    store.hold({ text: 'late hold', run });
    await settle();
    expect(store.getSnapshot()).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(timers.count()).toBe(0);
  });
});
