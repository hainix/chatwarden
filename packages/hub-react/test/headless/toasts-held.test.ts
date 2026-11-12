// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createT, en } from '../../src/i18n.js';
import { TOAST_HELD_MAX, TOAST_MAX, UNDO_MS, createToastStore } from '../../src/headless/toasts.js';
import { fakePage, manualTimers, settle } from './kit.js';

// Quick decisions stack several held toasts, each with its own Undo. They are capped apart from the news toasts, so news never pushes an
// Undo off and an Undo never ends in a silent early send.

function make() {
  const timers = manualTimers();
  const page = fakePage();
  const store = createToastStore({ words: () => createT(en, 'en'), timers, page });
  return { timers, page, store };
}
const texts = (s: ReturnType<typeof make>['store']): string[] => s.getSnapshot().map((t) => t.text);
const act = { label: 'x', run: () => undefined };

describe('held toasts are capped apart from the news', () => {
  it('the constants: 3 news toasts, 10 held', () => {
    expect([TOAST_MAX, TOAST_HELD_MAX]).toEqual([3, 10]);
  });

  it('a held toast is not pushed off by news toasts', async () => {
    const { store } = make();
    const run = vi.fn();
    store.hold({ text: 'Held.', run });
    for (const t of ['a', 'b', 'c', 'd', 'e']) store.push({ text: t, action: act });
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(texts(store)).toEqual(['Held.', 'c', 'd', 'e']);
    expect(store.getSnapshot().filter((t) => t.held)).toHaveLength(1);
  });

  it('news toasts are not pushed off by held ones either: three news and ten held are all on screen', () => {
    const { store } = make();
    for (const t of ['n1', 'n2', 'n3']) store.push({ text: t });
    for (let i = 0; i < TOAST_HELD_MAX; i += 1) store.hold({ text: `h${i}`, run: () => undefined });
    expect(store.getSnapshot()).toHaveLength(3 + TOAST_HELD_MAX);
    expect(store.getSnapshot().filter((t) => !t.held).map((t) => t.text)).toEqual(['n1', 'n2', 'n3']);
  });

  it('the 11th held decision commits the oldest, which is sent once and not undone', async () => {
    const { store } = make();
    const runs = Array.from({ length: TOAST_HELD_MAX + 1 }, () => vi.fn());
    runs.forEach((run, i) => store.hold({ text: `h${i}`, run }));
    await settle();
    expect(runs[0]).toHaveBeenCalledTimes(1);
    for (const run of runs.slice(1)) expect(run).not.toHaveBeenCalled();
    expect(texts(store)).toEqual(Array.from({ length: TOAST_HELD_MAX }, (_, i) => `h${i + 1}`));
  });

  it('six decisions held inside five seconds are all still undoable', async () => {
    const { timers, store } = make();
    const runs = Array.from({ length: 6 }, () => vi.fn());
    const holds = runs.map((run, i) => store.hold({ text: `h${i}`, run }));
    await timers.advance(UNDO_MS - 1);
    expect(store.getSnapshot().filter((t) => t.held)).toHaveLength(6);
    for (const h of holds) h.undo();
    await timers.advance(UNDO_MS * 2);
    for (const run of runs) expect(run).not.toHaveBeenCalled();
    expect(texts(store)).toEqual([]);
  });

  it('each held toast keeps its own timer: they end one by one, each sent once, in the order they were held', async () => {
    const { timers, store } = make();
    const order: number[] = [];
    store.hold({ text: 'h0', run: () => void order.push(0) });
    await timers.advance(1_000);
    store.hold({ text: 'h1', run: () => void order.push(1) });
    await timers.advance(UNDO_MS - 1_000);
    expect(order).toEqual([0]);
    expect(texts(store)).toEqual(['h1']);
    await timers.advance(1_000);
    expect(order).toEqual([0, 1]);
  });

  it('plain news still caps at 3 on its own, oldest without an action first', () => {
    const { store } = make();
    store.push({ text: 'undo-1', action: act });
    for (const t of ['A', 'B', 'C']) store.push({ text: t });
    expect(texts(store)).toEqual(['undo-1', 'B', 'C']);
  });

  it('a mixed stack keeps its on-screen order (oldest first), whatever kind each toast is', () => {
    const { store } = make();
    store.hold({ text: 'h0', run: () => undefined });
    store.push({ text: 'n0' });
    store.hold({ text: 'h1', run: () => undefined });
    store.push({ text: 'n1' });
    expect(texts(store)).toEqual(['h0', 'n0', 'h1', 'n1']);
  });

  it('a pagehide sends every held decision, all ten, once', async () => {
    const { page, store } = make();
    const runs = Array.from({ length: TOAST_HELD_MAX }, () => vi.fn());
    runs.forEach((run, i) => store.hold({ text: `h${i}`, run }));
    page.close();
    await settle();
    for (const run of runs) expect(run).toHaveBeenCalledTimes(1);
  });
});
