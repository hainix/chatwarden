// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../../src/headless/store.js';

describe('createStore: the subscribe/getSnapshot contract', () => {
  it('hands back the same snapshot, by identity, until something changes', () => {
    const store = createStore({ n: 1 });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    const first = store.getSnapshot();
    store.update((s) => s);
    expect(store.getSnapshot()).toBe(first);
    store.set({ n: 2 });
    expect(store.getSnapshot()).not.toBe(first);
    expect(store.getSnapshot()).toEqual({ n: 2 });
  });

  it('tells a listener on each real change, and not on a no-op', () => {
    const store = createStore(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(0);
    store.update((n) => n);
    expect(listener).not.toHaveBeenCalled();
    store.set(1);
    store.update((n) => n + 1);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops telling a listener once it has unsubscribed, and unsubscribing twice is harmless', () => {
    const store = createStore(0);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    off();
    store.set(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('lets a listener unsubscribe itself, or another, while it is being told', () => {
    const store = createStore(0);
    const seen: string[] = [];
    const offB = store.subscribe(() => seen.push('b'));
    const offA = store.subscribe(() => {
      seen.push('a');
      offA();
      offB();
    });
    store.set(1);
    store.set(2);
    // `b` was subscribed first so it is told first; both are gone from the next change on.
    expect(seen).toEqual(['b', 'a']);
  });

  it('a listener that reads the snapshot sees the new value', () => {
    const store = createStore('a');
    let read = '';
    store.subscribe(() => {
      read = store.getSnapshot();
    });
    store.set('b');
    expect(read).toBe('b');
  });
});
