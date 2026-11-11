/**
 * The contract every store of the headless controller follows, and the one `useSyncExternalStore` (and Vue's, Svelte's and Solid's
 * own bridges) expect: `getSnapshot()` returns the same value, by identity, until something changes, and `subscribe` tells a
 * listener when it has.
 * @experimental
 */
export interface Store<T> {
  /** Calls `listener` after every change; returns the function that stops it. */
  subscribe(listener: () => void): () => void;
  /** The current value. The same object until the next change. */
  getSnapshot(): T;
}

/** @experimental */
export interface WritableStore<T> extends Store<T> {
  /** Replaces the value. Nothing is told when it is the same value (`Object.is`). */
  set(next: T): void;
  /** Replaces the value with a function of the last one. Returning the last one changes nothing. */
  update(change: (prev: T) => T): void;
}

/** @experimental */
export function createStore<T>(initial: T): WritableStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const set = (next: T): void => {
    if (Object.is(next, value)) return;
    value = next;
    // A copy: a listener may unsubscribe (or subscribe another) while it is being told.
    for (const l of [...listeners]) l();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => value,
    set,
    update: (change) => set(change(value)),
  };
}
